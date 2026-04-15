import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing GEMINI_API_KEY' }, { status: 500 });
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('List models upstream error:', response.status, errorText);
      return NextResponse.json({ error: 'API request failed' }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json({ models: data.models });
  } catch (error) {
    const message = (error as Error)?.message || 'Unknown error';
    console.error('List models error:', message);
    return NextResponse.json({ error: 'Failed to list models' }, { status: 500 });
  }
}
