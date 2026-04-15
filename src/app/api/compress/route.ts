import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { join } from 'path';
import { getAuthenticatedUser } from '@/lib/api-auth';
import { rateLimitExceeded } from '@/lib/rate-limit';

const TEXT_MAX = 500_000;

const COMPRESS_TIMEOUT_MS = 60_000;

function runCompressScript(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(process.cwd(), 'scripts', 'compress.py');
    const child = spawn('python3', [scriptPath, '--stdin'], {
      cwd: process.cwd(),
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('compress timeout'));
    }, COMPRESS_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `compress exited with ${code}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(text, 'utf8');
    child.stdin.end();
  });
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (rateLimitExceeded(`compress:${user.id}`, 20, 60_000)) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { text } = body as { text?: unknown };
    if (typeof text !== 'string') {
      return NextResponse.json({ error: 'text must be a string' }, { status: 400 });
    }
    if (text.length > TEXT_MAX) {
      return NextResponse.json({ error: `text too long (max ${TEXT_MAX})` }, { status: 400 });
    }

    const stdout = await runCompressScript(text);
    const result = JSON.parse(stdout) as unknown;
    return NextResponse.json(result);
  } catch (error) {
    console.error('Compression error:', error);
    return NextResponse.json({ error: 'Compression failed' }, { status: 500 });
  }
}
