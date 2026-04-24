import { GoogleGenerativeAI, GoogleGenerativeAIFetchError } from '@google/generative-ai';

/** Must match `DEFAULT_GEMINI_MODEL` in `gemini-config.ts` (primary when `GEMINI_MODEL` is unset). */
const DEFAULT_GEMINI_PRIMARY = 'gemini-2.0-flash';

/** Used when `GEMINI_MODEL_CHAIN` / `GEMINI_MODEL_FALLBACKS` are unset: try stronger Flash first, then higher-RPM / older models. */
const FREE_TIER_DEFAULT_TAIL = [
  'gemini-2.5-flash',
  'gemini-3-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
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
    /\b429\b/.test(lower)
  );
}

export async function withGeminiModelFallback<T>(
  apiKey: string,
  run: (modelName: string, genAI: GoogleGenerativeAI) => Promise<T>
): Promise<T> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const models = geminiModelChain();
  if (models.length === 0) {
    throw new Error('No Gemini models configured');
  }
  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    const name = models[i];
    try {
      return await run(name, genAI);
    } catch (e) {
      lastError = e;
      const canTryNext = i < models.length - 1 && isGeminiRateLimitOrQuotaError(e);
      if (canTryNext) {
        console.warn(`[Gemini] Model "${name}" hit quota/rate limit; trying "${models[i + 1]}"…`);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}
