import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { getAuthenticatedUser } from '@/lib/api-auth';
import { rateLimitExceeded } from '@/lib/rate-limit';

const MODEL_NAME = 'gemini-flash-latest';
const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_TITLE_CHARS = 500;

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (rateLimitExceeded(`gemini:${user.id}`, 40, 60_000)) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing GEMINI_API_KEY' }, { status: 500 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { messages, transcript, title } = body as {
      messages?: unknown;
      transcript?: unknown;
      title?: unknown;
    };

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Invalid messages payload' }, { status: 400 });
    }

    if (messages.length > MAX_MESSAGES) {
      return NextResponse.json({ error: 'Too many messages' }, { status: 400 });
    }

    for (const m of messages) {
      if (!m || typeof m !== 'object') {
        return NextResponse.json({ error: 'Invalid message entry' }, { status: 400 });
      }
      const msg = m as { content?: unknown };
      if (typeof msg.content !== 'string' || msg.content.length > MAX_MESSAGE_CHARS) {
        return NextResponse.json({ error: 'Invalid message content' }, { status: 400 });
      }
    }

    const safeTitle =
      typeof title === 'string' ? title.slice(0, MAX_TITLE_CHARS) : 'Untitled session';
    const safeTranscript = typeof transcript === 'string' ? transcript : '';

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      ],
      systemInstruction:
        'You are Sketch Discussion, a concise, helpful assistant summarizing and clarifying lecture concepts captured in transcripts and mind maps.',
    });

    const history = messages
      .map((m: { role: string; content: string }) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const context = `Session title: ${safeTitle}\nTranscript excerpt (may be truncated):\n${safeTranscript.slice(0, 4000)}`;

    const prompt = `${context}\n\nConversation so far:\n${history}\n\nRespond clearly and concisely, with actionable explanations if asked.`;

    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    });

    const reply = result.response.text();

    return NextResponse.json({ reply });
  } catch (error) {
    const message = (error as Error)?.message || 'Unknown error';
    console.error('Gemini chat error:', message);
    const exposeDetails = process.env.NODE_ENV === 'development';
    return NextResponse.json(
      {
        error: 'Failed to generate response',
        ...(exposeDetails ? { details: message } : {}),
      },
      { status: 500 }
    );
  }
}
