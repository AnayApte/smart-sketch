import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

if (!supabaseUrl || !supabaseAnonKey) {
  if (typeof window !== 'undefined') {
    console.error(
      '[smart-sketch] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local.'
    );
  }
}

/**
 * Browser Supabase client. Requires NEXT_PUBLIC_SUPABASE_* in .env.local (see .env.example).
 * Do not embed real keys in source — use environment variables only.
 */
export const supabase = createClient(
  supabaseUrl ?? 'https://missing-env.supabase.co',
  supabaseAnonKey ?? 'missing-env-anon-key'
);
