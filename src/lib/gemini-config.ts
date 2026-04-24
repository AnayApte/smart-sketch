import { geminiModelChain } from '@/lib/gemini-fallback';

/** Default when `GEMINI_MODEL` is unset. Override in `.env.local` if needed. */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

/** First model in the configured chain (see `GEMINI_MODEL_CHAIN` / fallbacks in `gemini-fallback.ts`). */
export function geminiModel(): string {
  const chain = geminiModelChain();
  return chain[0] ?? DEFAULT_GEMINI_MODEL;
}

export function geminiApiKey(): string | undefined {
  const k = process.env.GEMINI_API_KEY?.trim();
  return k || undefined;
}
