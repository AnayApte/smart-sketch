import { GoogleGenerativeAI, GoogleGenerativeAIFetchError } from '@google/generative-ai';

/** Must match `DEFAULT_GEMINI_MODEL` in `gemini-config.ts` (primary when `GEMINI_MODEL` is unset). */
const DEFAULT_GEMINI_PRIMARY = 'gemini-2.0-flash';

/**
 * Used when `GEMINI_MODEL_CHAIN` / `GEMINI_MODEL_FALLBACKS` are unset.
 * IDs must exist on generativelanguage.googleapis.com v1beta for `generateContent`
 * (see https://ai.google.dev/gemini-api/docs/models — avoid unlisted preview IDs).
 */
const FREE_TIER_DEFAULT_TAIL = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.0-flash',
];

function parseCommaModels(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function dedupeModels(models: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/**
 * Ordered list of model IDs to try (first = preferred).
 * - `GEMINI_MODEL_CHAIN=model-a,model-b` → use exactly that order (full control).
 * - Otherwise: `GEMINI_MODEL` (or default) first, then `GEMINI_MODEL_FALLBACKS`, then built-in tail models not already listed.
 */
export function geminiModelChain(): string[] {
  const chainEnv = process.env.GEMINI_MODEL_CHAIN?.trim();
  if (chainEnv) {
    return dedupeModels(parseCommaModels(chainEnv));
  }

  const primary =
    (process.env.GEMINI_MODEL || DEFAULT_GEMINI_PRIMARY).trim() || DEFAULT_GEMINI_PRIMARY;
  const extra = parseCommaModels(process.env.GEMINI_MODEL_FALLBACKS);
  const tail = FREE_TIER_DEFAULT_TAIL.filter((m) => m !== primary && !extra.includes(m));
  return dedupeModels([primary, ...extra, ...tail]);
}

export function isGeminiRateLimitOrQuotaError(err: unknown): boolean {
  if (err instanceof GoogleGenerativeAIFetchError) {
    if (err.status === 429) return true;
    // Transient capacity / overload at Google (session chat would otherwise surface raw 503).
    if (err.status === 503) return true;
    if (err.status === 403) {
      const t = `${err.statusText} ${err.message}`.toLowerCase();
      if (t.includes('quota') || t.includes('rate') || t.includes('exhaust')) return true;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes('resource_exhausted') ||
    lower.includes('resource exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('service unavailable') ||
    lower.includes('high demand') ||
    /\b429\b/.test(lower) ||
    /\b503\b/.test(lower)
  );
}

export function isGeminiModelUnavailableError(err: unknown): boolean {
  if (err instanceof GoogleGenerativeAIFetchError && err.status === 404) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes('not found') ||
    lower.includes('is not found for api version') ||
    lower.includes('not supported for generatecontent') ||
    lower.includes('model not found')
  );
}

export async function withGeminiModelFallback<T>(
  apiKey: string,
  run: (modelName: string, genAI: GoogleGenerativeAI) => Promise<T>
): Promise<T> {
  const runId = `chat-fallback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const postDebugLog = (
    hypothesisId: string,
    location: string,
    message: string,
    data: Record<string, unknown>
  ) => {
    // #region agent log H-chat-fallback
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
  const genAI = new GoogleGenerativeAI(apiKey);
  const models = geminiModelChain();
  postDebugLog('H1', 'gemini-fallback:chain', 'gemini model chain resolved', {
    models,
  });
  if (models.length === 0) {
    throw new Error('No Gemini models configured');
  }
  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    const name = models[i];
    postDebugLog('H1', 'gemini-fallback:attempt', 'attempting model', {
      index: i,
      name,
      total: models.length,
    });
    try {
      const result = await run(name, genAI);
      postDebugLog('H4', 'gemini-fallback:success', 'model succeeded', {
        index: i,
        name,
      });
      return result;
    } catch (e) {
      lastError = e;
      const canTryNext =
        i < models.length - 1 &&
        (isGeminiRateLimitOrQuotaError(e) || isGeminiModelUnavailableError(e));
      postDebugLog('H2', 'gemini-fallback:error', 'model attempt failed', {
        index: i,
        name,
        canTryNext,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      if (canTryNext) {
        console.warn(`[Gemini] Model "${name}" unavailable (quota/rate/overload); trying "${models[i + 1]}"…`);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}
