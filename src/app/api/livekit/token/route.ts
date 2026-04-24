import {
  AccessToken,
  AgentDispatchClient,
  RoomAgentDispatch,
  RoomConfiguration,
} from 'livekit-server-sdk';
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-auth';
import { SMARTSKETCH_AGENT_NAME } from '@/lib/livekit-agent';
import { rateLimitExceeded } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const ROOM_MAX = 128;
const USER_MAX = 64;
const ROOM_PATTERN = /^[a-zA-Z0-9._-]+$/;
const USER_PATTERN = /^[a-zA-Z0-9._@-]+$/;

function sanitizeRoom(name: string | null): string | null {
  const raw = (name ?? 'lecture-room').trim();
  if (raw.length === 0 || raw.length > ROOM_MAX || !ROOM_PATTERN.test(raw)) return null;
  return raw;
}

function sanitizeUsername(name: string | null): string | null {
  const raw = (name ?? 'participant').trim();
  if (raw.length === 0 || raw.length > USER_MAX || !USER_PATTERN.test(raw)) return null;
  return raw;
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (rateLimitExceeded(`livekit:${user.id}`, 60, 60_000)) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const roomName = sanitizeRoom(request.nextUrl.searchParams.get('room'));
    const participantName = sanitizeUsername(request.nextUrl.searchParams.get('username'));
    if (!roomName || !participantName) {
      return NextResponse.json(
        { error: 'Invalid room or username (allowed: letters, numbers, ._- and @ for username)' },
        { status: 400 }
      );
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      return NextResponse.json({ error: 'LiveKit credentials not configured' }, { status: 500 });
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: participantName,
      ttl: '2h',
    });

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    // Dispatch our Python worker when this JWT creates the room (first participant).
    // See https://docs.livekit.io/agents/server/agent-dispatch/
    at.roomConfig = new RoomConfiguration({
      agents: [
        new RoomAgentDispatch({
          agentName: SMARTSKETCH_AGENT_NAME,
        }),
      ],
    });

    const token = await at.toJwt();

    // Explicit dispatch works even when the room already exists (JWT roomConfig
    // only runs on first room creation — see LiveKit agent dispatch docs).
    const livekitHost = (process.env.LIVEKIT_URL ?? process.env.NEXT_PUBLIC_LIVEKIT_URL ?? '').trim();
    if (livekitHost) {
      try {
        const dispatchClient = new AgentDispatchClient(livekitHost, apiKey, apiSecret);
        await dispatchClient.createDispatch(roomName, SMARTSKETCH_AGENT_NAME);
      } catch (err) {
        console.error('[livekit/token] createDispatch failed (roomConfig may still dispatch on new room):', err);
      }
    }

    return NextResponse.json({ token, room: roomName });
  } catch (error) {
    console.error('Error generating LiveKit token:', error);
    return NextResponse.json({ error: 'Failed to generate token' }, { status: 500 });
  }
}
