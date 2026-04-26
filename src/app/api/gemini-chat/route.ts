import type { Content } from '@google/generative-ai';
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-auth';
import { rateLimitExceeded } from '@/lib/rate-limit';
import { geminiApiKey } from '@/lib/gemini-config';
import { withGeminiModelFallback } from '@/lib/gemini-fallback';

export const runtime = 'nodejs';

const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_TITLE_CHARS = 500;

export async function POST(req: NextRequest) {
  try {
    const runId = `gemini-chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const postDebugLog = (hypothesisId: string, location: string, message: string, data: Record<string, unknown>) => {
      // #region agent log H-chat-route
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
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (rateLimitExceeded(`sketch-chat:${user.id}`, 40, 60_000)) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const apiKey = geminiApiKey();
    if (!apiKey) {
      return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });
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

    const chatContents: Content[] = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') {
        return NextResponse.json({ error: 'Invalid message entry' }, { status: 400 });
      }
      const msg = m as { role?: unknown; content?: unknown };
      if (typeof msg.content !== 'string' || msg.content.length > MAX_MESSAGE_CHARS) {
        return NextResponse.json({ error: 'Invalid message content' }, { status: 400 });
      }
      const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : null;
      if (!role) {
        return NextResponse.json({ error: 'Invalid message role' }, { status: 400 });
      }
      chatContents.push({
        role: role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }

    const safeTitle =
      typeof title === 'string' ? title.slice(0, MAX_TITLE_CHARS) : 'Untitled session';
    const safeTranscript = typeof transcript === 'string' ? transcript : '';
    postDebugLog('H3', 'gemini-chat:input', 'chat request sanitized', {
      messagesCount: chatContents.length,
      transcriptChars: safeTranscript.length,
      titleChars: safeTitle.length,
    });

    const systemContent = `You are Sketch Discussion, a concise, helpful assistant summarizing and clarifying lecture concepts captured in transcripts and mind maps.

Session title: ${safeTitle}
Transcript excerpt (may be truncated):
${safeTranscript.slice(0, 4000)}

Respond clearly and concisely, with actionable explanations if asked.`;

    const result = await withGeminiModelFallback(apiKey, async (modelName, genAI) => {
      postDebugLog('H1', 'gemini-chat:model-create', 'creating model instance', {
        modelName,
      });
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemContent,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024,
        },
      });
      postDebugLog('H3', 'gemini-chat:model-generate', 'calling generateContent', {
        modelName,
        contentTurns: chatContents.length,
      });
      return model.generateContent({ contents: chatContents });
    });
    const reply =
      result.response.text()?.trim() ||
      'I had trouble generating a response. Please try again.';

    return NextResponse.json({ reply });
  } catch (error) {
    const message = (error as Error)?.message || 'Unknown error';
    // #region agent log H-chat-route
    fetch('http://127.0.0.1:7632/ingest/36dc6992-f772-466f-a02b-fd70ac711c4b', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': '119102',
      },
      body: JSON.stringify({
        sessionId: '119102',
        runId: 'gemini-chat-catch',
        hypothesisId: 'H2',
        location: 'gemini-chat:catch',
        message: 'gemini chat route failed',
        data: {
          errorMessage: message,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    console.error('Sketch chat (Gemini) error:', message);
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
