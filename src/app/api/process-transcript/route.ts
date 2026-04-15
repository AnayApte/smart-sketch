import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getAuthenticatedUser } from '@/lib/api-auth';
import { rateLimitExceeded } from '@/lib/rate-limit';

type Concept = {
  label: string;
  type: 'main' | 'concept' | 'detail';
  explanation?: string;
};

const TRANSCRIPT_MAX = 50_000;

function parseConceptsJson(content: string | null): Concept[] {
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
    return parsed.concepts
      .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
      .map((c): Concept => {
        const t = c.type === 'main' || c.type === 'concept' || c.type === 'detail' ? c.type : 'concept';
        return {
          label: String(c.label ?? '').trim() || 'Concept',
          type: t,
          explanation: typeof c.explanation === 'string' ? c.explanation : undefined,
        };
      })
      .filter((c) => c.label.length > 0);
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

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You extract key concepts from lecture transcripts. Respond with a single JSON object of this exact shape (no markdown, no extra keys):
{"concepts":[{"label":"short phrase","type":"main|concept|detail","explanation":"optional brief text"}]}
Rules:
- "type" must be exactly one of: main, concept, detail
- Prefer 3–8 concepts per segment
- Labels are 2–6 words, domain-specific when possible`,
        },
        {
          role: 'user',
          content: `Transcript segment:\n${transcript.slice(0, 12000)}`,
        },
      ],
      temperature: 0.5,
      max_tokens: 800,
    });

    const content = completion.choices[0]?.message?.content;
    let concepts = parseConceptsJson(content ?? null);

    if (concepts.length === 0) {
      concepts = [
        {
          label: transcript.slice(0, 50).trim() || 'Segment',
          type: 'concept',
          explanation: transcript.slice(0, 500),
        },
      ];
    }

    return NextResponse.json({ concepts });
  } catch (error) {
    console.error('Error processing transcript:', error);
    return NextResponse.json({ error: 'Failed to process transcript' }, { status: 500 });
  }
}
