import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-auth';
import { rateLimitExceeded } from '@/lib/rate-limit';
import type { ConceptPayload, ConceptType } from '@/lib/concept-types';
import { geminiApiKey } from '@/lib/gemini-config';
import { withGeminiModelFallback } from '@/lib/gemini-fallback';

const TRANSCRIPT_MAX = 50_000;

function normalizeType(t: unknown): ConceptType {
  return t === 'main' || t === 'concept' || t === 'detail' ? t : 'concept';
}

function assignIdsAndParents(raw: ConceptPayload[]): ConceptPayload[] {
  const used = new Set<string>();
  const withIds = raw.map((c, i) => {
    let id = (c.id && String(c.id).trim()) || `c${i + 1}`;
    let n = 0;
    while (used.has(id)) {
      n += 1;
      id = `c${i + 1}_${n}`;
    }
    used.add(id);
    const parent = c.parent === undefined || c.parent === '' ? null : String(c.parent).trim() || null;
    return { ...c, id, parent };
  });

  const idSet = new Set(withIds.map((c) => c.id));
  const mains = withIds.filter((c) => c.type === 'main');

  return withIds.map((c) => {
    let parent = c.parent ?? null;
    if (parent && !idSet.has(parent)) {
      parent = mains[0]?.id ?? null;
    }
    if (!parent && c.type !== 'main' && mains.length > 0) {
      parent = mains[0].id;
    }
    return { ...c, parent };
  });
}

function parseConceptsJson(content: string | null): ConceptPayload[] {
  if (!content?.trim()) return [];
  let text = content.trim();
  if (text.startsWith('```')) {
    const parts = text.split('```');
    text = (parts[1] ?? parts[0]).trim();
    if (text.toLowerCase().startsWith('json')) {
      text = text.slice(4).trim();
    }
  }
  try {
    const parsed = JSON.parse(text) as { concepts?: unknown };
    if (!Array.isArray(parsed.concepts)) return [];
    const raw = parsed.concepts
      .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
      .map((c): ConceptPayload => {
        const t = normalizeType(c.type);
        const parentRaw = c.parent;
        const parent =
          parentRaw === null || parentRaw === undefined
            ? null
            : typeof parentRaw === 'string'
              ? parentRaw.trim() || null
              : null;
        return {
          id: typeof c.id === 'string' ? c.id.trim() : undefined,
          label: String(c.label ?? '').trim() || 'Concept',
          type: t,
          explanation: typeof c.explanation === 'string' ? c.explanation : undefined,
          parent,
        };
      })
      .filter((c) => c.label.length > 0);

    return assignIdsAndParents(raw);
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (rateLimitExceeded(`transcript:${user.id}`, 30, 60_000)) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { transcript } = body as { transcript?: unknown };

    if (!transcript || typeof transcript !== 'string') {
      return NextResponse.json({ error: 'Transcript is required' }, { status: 400 });
    }

    if (transcript.length > TRANSCRIPT_MAX) {
      return NextResponse.json(
        { error: `Transcript too long (max ${TRANSCRIPT_MAX} characters)` },
        { status: 400 }
      );
    }

    const apiKey = geminiApiKey();

    if (!apiKey) {
      return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });
    }

    const result = await withGeminiModelFallback(apiKey, async (modelName, genAI) => {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: `You extract key concepts from lecture transcripts. Respond with a single JSON object (no markdown):
{"concepts":[{"id":"c1","label":"short phrase","type":"main|concept|detail","explanation":"optional brief text","parent":null or "c1"}]}
Rules:
- Each concept MUST have a unique "id" (c1, c2, …).
- "type" must be exactly: main, concept, or detail.
- "parent" is the parent's "id", or null for root topics (type "main" roots use parent null).
- Non-main concepts MUST have "parent" set to the id of the concept they support (usually a main or intermediate concept).
- Prefer 3–8 concepts per segment; labels 2–6 words, domain-specific when possible.`,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.5,
          maxOutputTokens: 1200,
        },
      });
      return model.generateContent(`Transcript segment:\n${transcript.slice(0, 12000)}`);
    });
    const content = result.response.text();
    let concepts = parseConceptsJson(content ?? null);

    if (concepts.length === 0) {
      concepts = [
        {
          id: 'c1',
          label: transcript.slice(0, 50).trim() || 'Segment',
          type: 'concept',
          explanation: transcript.slice(0, 500),
          parent: null,
        },
      ];
    }

    return NextResponse.json({ concepts });
  } catch (error) {
    console.error('Error processing transcript:', error);
    return NextResponse.json({ error: 'Failed to process transcript' }, { status: 500 });
  }
}
