import { lookup } from 'node:dns/promises';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    return NextResponse.json(
      { ok: false as const, message: 'Supabase is not configured on the server.' },
      { status: 500 }
    );
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return NextResponse.json(
      { ok: false as const, message: 'NEXT_PUBLIC_SUPABASE_URL is not a valid URL.' },
      { status: 500 }
    );
  }

  try {
    await lookup(hostname);
  } catch {
    return NextResponse.json(
      {
        ok: false as const,
        name: 'ConfigurationError',
        message: `Cannot resolve Supabase host "${hostname}". Open the Supabase dashboard → Settings → API, copy the exact "Project URL" into NEXT_PUBLIC_SUPABASE_URL in .env.local, then restart the dev server.`,
      },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false as const, message: 'Invalid JSON body.' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const firstName = typeof b.firstName === 'string' ? b.firstName.trim() : '';
  const lastName = typeof b.lastName === 'string' ? b.lastName.trim() : '';

  if (!email || !password) {
    return NextResponse.json(
      { ok: false as const, message: 'Email and password are required.' },
      { status: 400 }
    );
  }

  const supabase = createClient(url, anonKey);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        first_name: firstName || undefined,
        last_name: lastName || undefined,
      },
    },
  });

  if (error) {
    return NextResponse.json(
      {
        ok: false as const,
        message: error.message,
        name: error.name,
      },
      { status: 400 }
    );
  }

  const session = data.session;
  return NextResponse.json({
    ok: true as const,
    session:
      session != null
        ? {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
          }
        : null,
  });
}
