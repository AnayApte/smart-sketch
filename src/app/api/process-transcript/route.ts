import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-auth';
import { rateLimitExceeded } from '@/lib/rate-limit';
import type { ConceptPayload } from '@/lib/concept-types';
import { geminiApiKey } from '@/lib/gemini-config';
import { withGeminiModelFallback } from '@/lib/gemini-fallback';
import {
  fallbackConceptsFromTranscript,
  hierarchySystemInstruction,
  hierarchyUserPrompt,
  mergeSegmentConcepts,
  parseConceptsJson,
  repairConceptHierarchy,
  splitTranscriptIntoSegments,
  validateConceptHierarchy,
} from '@/lib/transcript-concept-extraction';

const TRANSCRIPT_MAX = 50_000;
const SEGMENT_CHAR_LIMIT = 1400;

function asSegmentedConcepts(concepts: ConceptPayload[], segmentIndex: number) {
  return concepts.map((c) => ({ ...c, segmentIndex }));
}

async function extractSegmentConcepts(
  model: { generateContent: (prompt: string) => Promise<{ response: { text: () => string } }> },
  segmentText: string,
  segmentIndex: number,
  totalSegments: number
): Promise<ConceptPayload[]> {
  const firstPrompt = hierarchyUserPrompt(segmentText, segmentIndex, totalSegments);
  const first = await model.generateContent(firstPrompt);
  const firstText = first.response.text();
  let concepts = repairConceptHierarchy(parseConceptsJson(firstText), segmentIndex);
  const firstValidation = validateConceptHierarchy(concepts);
  if (firstValidation.valid) {
    return concepts;
  }

  const repairPrompt = `Your previous output was invalid for strict hierarchy JSON.
Return ONLY valid JSON object for the same segment.
Fix these issues:
${firstValidation.errors.map((e) => `- ${e}`).join('\n')}

Original segment:
${segmentText}

Invalid output to repair:
${firstText}`;
  const second = await model.generateContent(repairPrompt);
  const secondText = second.response.text();
  concepts = repairConceptHierarchy(parseConceptsJson(secondText), segmentIndex);
  return concepts;
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
        systemInstruction: hierarchySystemInstruction(),
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.3,
          maxOutputTokens: 1200,
        },
      });
      const segments = splitTranscriptIntoSegments(transcript);
      const truncatedSegments = segments.map((s) => ({
        ...s,
        text: s.text.slice(0, SEGMENT_CHAR_LIMIT),
      }));

      const extractedBySegment: Array<ConceptPayload & { segmentIndex: number }> = [];
      for (const segment of truncatedSegments) {
        const concepts = await extractSegmentConcepts(
          model as { generateContent: (prompt: string) => Promise<{ response: { text: () => string } }> },
          segment.text,
          segment.index,
          truncatedSegments.length
        );
        extractedBySegment.push(...asSegmentedConcepts(concepts, segment.index));
      }

      const merged = mergeSegmentConcepts(extractedBySegment);
      const responseText = JSON.stringify({ concepts: merged });
      return {
        response: {
          text: () => responseText,
        },
      };
    });
    const content = result.response.text();
    let concepts = parseConceptsJson(content ?? null);

    if (concepts.length === 0) {
      concepts = fallbackConceptsFromTranscript(transcript);
    }

    return NextResponse.json({ concepts });
  } catch (error) {
    console.error('Error processing transcript:', error);
    return NextResponse.json({ error: 'Failed to process transcript' }, { status: 500 });
  }
}
