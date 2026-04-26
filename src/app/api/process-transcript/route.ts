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
const DEFAULT_MAX_OUTPUT_TOKENS = 1200;
const FAST_MAX_OUTPUT_TOKENS = 900;
const DEFAULT_SEGMENT_CONCURRENCY = 1;
const FAST_SEGMENT_CONCURRENCY = 2;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: safeConcurrency }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await mapper(items[current]);
    }
  });

  await Promise.all(workers);
  return results;
}

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

    const { transcript, fastMode } = body as { transcript?: unknown; fastMode?: unknown };

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
    const useFastMode = fastMode === true;
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const postDebugLog = (hypothesisId: string, location: string, message: string, data: Record<string, unknown>) => {
      // #region agent log H-api
      fetch('http://127.0.0.1:7632/ingest/36dc6992-f772-466f-a02b-fd70ac711c4b', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Debug-Session-Id': '119102',
        },
        body: JSON.stringify({
          sessionId: '119102',
          runId,
          hypothesisId,
          location,
          message,
          data,
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    };
    postDebugLog('H1', 'process-transcript:input', 'process-transcript request received', {
      transcriptChars: transcript.length,
      useFastMode,
    });

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
          maxOutputTokens: useFastMode ? FAST_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS,
        },
      });
      const segments = splitTranscriptIntoSegments(
        transcript,
        useFastMode
          ? {
              targetWords: 190,
              overlapRatio: 0.1,
              maxSegments: 12,
            }
          : undefined
      );
      postDebugLog('H4', 'process-transcript:segments', 'segments created', {
        count: segments.length,
        sampleChars: segments.slice(0, 3).map((s) => s.text.length),
        useFastMode,
      });
      const truncatedSegments = segments.map((s) => ({
        ...s,
        text: s.text.slice(0, SEGMENT_CHAR_LIMIT),
      }));

      const extractedSegments = await mapWithConcurrency(
        truncatedSegments,
        useFastMode ? FAST_SEGMENT_CONCURRENCY : DEFAULT_SEGMENT_CONCURRENCY,
        async (segment) => {
          const concepts = await extractSegmentConcepts(
            model as { generateContent: (prompt: string) => Promise<{ response: { text: () => string } }> },
            segment.text,
            segment.index,
            truncatedSegments.length
          );
          return asSegmentedConcepts(concepts, segment.index);
        }
      );
      const extractedBySegment: Array<ConceptPayload & { segmentIndex: number }> = extractedSegments.flat();
      postDebugLog('H1', 'process-transcript:extracted', 'segment extraction complete', {
        extractedCount: extractedBySegment.length,
        extractedBySegmentSizes: extractedSegments.map((arr) => arr.length).slice(0, 12),
      });

      const merged = mergeSegmentConcepts(extractedBySegment);
      postDebugLog('H2', 'process-transcript:merged', 'mergeSegmentConcepts result', {
        mergedCount: merged.length,
        mergedLabelsSample: merged.slice(0, 8).map((c) => c.label),
      });
      const responseText = JSON.stringify({ concepts: merged });
      return {
        response: {
          text: () => responseText,
        },
      };
    });
    const content = result.response.text();
    let concepts = parseConceptsJson(content ?? null);
    postDebugLog('H1', 'process-transcript:parsed', 'parsed concept JSON', {
      parsedCount: concepts.length,
      parsedLabelsSample: concepts.slice(0, 8).map((c) => c.label),
    });

    if (concepts.length === 0) {
      postDebugLog('H1', 'process-transcript:fallback', 'fallbackConceptsFromTranscript used', {
        reason: 'parsedCount=0',
      });
      concepts = fallbackConceptsFromTranscript(transcript);
    }
    postDebugLog('H2', 'process-transcript:response', 'returning concepts to client', {
      responseCount: concepts.length,
      responseIdsSample: concepts.slice(0, 8).map((c) => c.id ?? null),
      responseLabelsSample: concepts.slice(0, 8).map((c) => c.label),
    });

    return NextResponse.json({ concepts });
  } catch (error) {
    console.error('Error processing transcript:', error);
    return NextResponse.json({ error: 'Failed to process transcript' }, { status: 500 });
  }
}
