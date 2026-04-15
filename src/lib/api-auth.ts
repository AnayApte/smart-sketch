import { NextRequest } from 'next/server';
import { createClient, type User } from '@supabase/supabase-js';

function getSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/**
 * Validates Supabase JWT from Authorization: Bearer <access_token>.
 * Use on API routes that must not be anonymously callable.
 */
export async function getAuthenticatedUser(request: NextRequest): Promise<User | null> {
  const env = getSupabaseEnv();
  if (!env) return null;

  const authHeader = request.headers.get('authorization');
  const token =
    authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) return null;

  const supabase = createClient(env.url, env.anonKey);
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}
