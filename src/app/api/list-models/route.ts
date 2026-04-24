import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-auth';
import { geminiApiKey } from '@/lib/gemini-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type GeminiModelsResponse = {
  models?: Array<{
    name?: string;
    displayName?: string;
    description?: string;
    supportedGenerationMethods?: string[];
  }>;
};

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const apiKey = geminiApiKey();
    if (!apiKey) {
      return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Gemini list models HTTP error:', res.status, text.slice(0, 500));
      return NextResponse.json({ error: 'Failed to list models' }, { status: 502 });
    }

    const data = (await res.json()) as GeminiModelsResponse;
    const raw = data.models ?? [];
    const models = raw
      .filter((m) =>
        (m.supportedGenerationMethods ?? []).some((method) => method === 'generateContent')
      )
      .map((m) => {
        const name = m.name ?? '';
        const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
        return {
          id,
          displayName: m.displayName ?? id,
          description: m.description ?? null,
        };
      });

    return NextResponse.json({ models });
  } catch (error) {
    const message = (error as Error)?.message || 'Unknown error';
    console.error('List models error:', message);
    return NextResponse.json({ error: 'Failed to list models' }, { status: 500 });
  }
}
