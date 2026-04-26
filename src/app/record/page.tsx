'use client';

import { useEffect, useRef, useState, useCallback, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ReactFlow, { Node, Edge } from 'reactflow';
import 'reactflow/dist/style.css';
import ReactMarkdown from 'react-markdown';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Room, RoomEvent, DataPacket_Kind, RemoteParticipant, LocalParticipant, ConnectionState } from 'livekit-client';
import { saveSession } from '@/lib/sessions-service';
import { useAuth } from '@/lib/auth-context';
import NeuralNetworkBackground from '@/components/NeuralNetworkBackground';
import { findSimilarConcept } from '@/lib/concept-dedup';
import { authFetch } from '@/lib/auth-fetch';
import type { ConceptPayload } from '@/lib/concept-types';
import { buildMindMapLayout } from '@/lib/mind-map-layout';

type ConceptData = ConceptPayload;

type SpeechRecognitionResultEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
};

type WindowWithSpeech = Window & {
  SpeechRecognition?: new () => BrowserSpeechRecognition;
  webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
};

function getNodePlainLabel(node: Node): string {
  const d = node.data as { plainLabel?: string; label?: unknown };
  if (typeof d.plainLabel === 'string' && d.plainLabel.trim()) return d.plainLabel.trim();
  if (typeof d.label === 'string') return d.label.trim();
  const ch = (d.label as { props?: { children?: unknown[] } })?.props?.children;
  const first = Array.isArray(ch) ? ch[0] : null;
  const text = (first as { props?: { children?: string } })?.props?.children;
  return typeof text === 'string' ? text.trim() : '';
}

function createRecordCenterFlowNode(): Node {
  return {
    id: 'center',
    data: { label: 'Lecture', plainLabel: 'Lecture' },
    position: { x: 250, y: 200 },
    style: {
      background: 'linear-gradient(135deg, #14b8a6 0%, #0d9488 100%)',
      color: '#0c0f14',
      border: 'none',
      borderRadius: '50%',
      width: 100,
      height: 100,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '14px',
      fontWeight: 'bold',
      boxShadow: '0 0 30px rgba(20, 184, 166, 0.4)',
    },
  };
}

interface AgentMessage {
  type: 'agent_ready' | 'concepts' | 'transcript';
  data: {
    concepts?: ConceptData[];
    transcript?: string;
    message?: string;
    timestamp?: string;
  };
}

function isLiveKitConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  return typeof url === 'string' && url.trim().length > 0;
}

/** LiveKit worker identity often contains `agent`; name may include `smartsketch-worker`. */
function remoteParticipantLooksLikeAgent(identity: string | undefined): boolean {
  if (!identity) return false;
  const id = identity.toLowerCase();
  return id.includes('agent') || id.includes('smartsketch-worker');
}

function roomHasAgentLikeParticipant(room: Room): boolean {
  const remotes = Array.from(room.remoteParticipants.values());
  for (let i = 0; i < remotes.length; i++) {
    if (remoteParticipantLooksLikeAgent(remotes[i].identity)) return true;
  }
  return false;
}

function debugLog(hypothesisId: string, location: string, message: string, data: Record<string, unknown>) {
  void hypothesisId;
  void location;
  void message;
  void data;
}

const DEBUG_DEMO_TRANSCRIPT = [
  'Welcome everyone. Today we are building a systems-level understanding of photosynthesis and why it is central to life on Earth.',
  'Photosynthesis converts light energy into chemical energy stored in carbohydrates. The process happens primarily in chloroplasts, which contain the thylakoid membrane system and the stroma.',
  'In the light-dependent reactions, photons excite chlorophyll in photosystem II and photosystem I. This excitation drives electron transport through membrane protein complexes.',
  'As electrons move through the electron transport chain, proton pumping creates an electrochemical gradient across the thylakoid membrane.',
  'ATP synthase uses that proton motive force to produce ATP from ADP and inorganic phosphate, while NADP+ is reduced to NADPH.',
  'Water splitting replenishes electrons in photosystem II and releases oxygen as a byproduct, which is critical for aerobic organisms.',
  'The Calvin cycle occurs in the stroma and uses ATP and NADPH to convert carbon dioxide into glyceraldehyde-3-phosphate, often abbreviated as G3P.',
  'Rubisco catalyzes carbon fixation by attaching CO2 to ribulose-1,5-bisphosphate. This forms unstable intermediates that are converted into 3-phosphoglycerate.',
  'The cycle includes fixation, reduction, and regeneration phases. Regeneration is essential because it recreates RuBP so the cycle can continue.',
  'Environmental constraints such as heat stress and low CO2 can increase photorespiration, which lowers photosynthetic efficiency.',
  'C4 and CAM pathways are adaptive strategies that reduce photorespiration in specific climates by changing when or where CO2 is concentrated.',
  'As a final synthesis, remember the core flow: light energy drives ATP and NADPH production, and those molecules power carbon fixation into sugars that fuel growth and metabolism.',
  'From an ecosystem perspective, primary producers that photosynthesize form the base of most food webs. Net primary productivity links solar capture to biomass available to herbivores and decomposers.',
  'When we measure photosynthesis in the field, we often compare gross versus net rates. Respiration in the dark uses some of the carbon fixed in daylight, so net carbon gain reflects the balance of both processes.',
  'Stomatal conductance is a major control point: plants must open pores to take in CO2 but risk water loss. Guard cells integrate light, humidity, and hormone signals to tune aperture through the day.',
  'Chlorophyll fluorescence is sometimes used as a non-invasive probe of photosystem health. High yield under steady light can indicate efficient light use, while stress often shifts that signature.',
  'In agriculture, breeders care about canopy light interception and leaf nitrogen allocation to Rubisco. Small improvements in quantum yield or stress tolerance can translate to meaningful yield gains.',
  'Looking ahead, understanding photosynthesis also informs bio-inspired solar strategies and debates about enhancing crop efficiency, though engineering trade-offs between growth, defense, and stress remain complex.',
].join(' ');

export default function RecordPage() {
  const { user } = useAuth();
  const userRef = useRef(user);
  userRef.current = user;
  const videoRef = useRef<HTMLVideoElement>(null);
  const roomRef = useRef<Room | null>(null);
  /** Bumped on each full reconnect so stale `room.connect()` resolutions cannot flip React state. */
  const liveKitConnectGenerationRef = useRef(0);
  const liveKitConnectInFlightRef = useRef(false);
  /** True only while `await room.connect(...)` is in flight (outer `finally` can clear inFlight too early for guards). */
  const liveKitAwaitingRoomConnectRef = useRef(false);
  /** React 18 dev Strict Mode runs mount→unmount→mount; avoid tearing down LiveKit on the first synthetic unmount. */
  const recordPageMountGenerationRef = useRef(0);
  const strictCleanupDisconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When `/api/livekit/token` returns 429, avoid hammering the server in a tight reconnect loop. */
  const liveKitTokenRetryAfterMsRef = useRef(0);
  /** First time we were connected without agent; used so brief disconnect/reconnect does not reset the 25s grace window. */
  const waitingForAgentSinceMsRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [permissionError, setPermissionError] = useState<string>('');
  const [cameraError, setCameraError] = useState(false);
  const [micError, setMicError] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [showFlowBoard, setShowFlowBoard] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<{
    role: 'user' | 'assistant';
    content: string;
  }[]>([]);
  const [recordingEnded, setRecordingEnded] = useState(false);
  const [isChatSending, setIsChatSending] = useState(false);
  const [showHomeModal, setShowHomeModal] = useState(false);
  const [homeModalMode, setHomeModalMode] = useState<'active' | 'ended'>('active');
  const [recordingTitle, setRecordingTitle] = useState('');
  const [recordingTitleError, setRecordingTitleError] = useState('');
  const [demoTranscriptLoading, setDemoTranscriptLoading] = useState(false);

  // Audio recording state
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const isTracksPausedRef = useRef(false);

  // Unique session ID for this recording (used for room name)
  const sessionIdRef = useRef<string>(`session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);

  // LiveKit state
  const [liveKitConnected, setLiveKitConnected] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  /** When LiveKit is configured but the Python agent never joins, allow local-only recording after a grace period. */
  const [allowStartWithoutAgent, setAllowStartWithoutAgent] = useState(false);
  const [transcripts, setTranscripts] = useState<string[]>([]);
  const [transcriptModal, setTranscriptModal] = useState<{ title: string; body: string } | null>(null);
  const [transcriptModalMounted, setTranscriptModalMounted] = useState(false);

  const router = useRouter();

  // React Flow nodes and edges - will be updated by agent
  const [nodes, setNodes] = useState<Node[]>([createRecordCenterFlowNode()]);

  const [edges, setEdges] = useState<Edge[]>([]);

  /** All concepts merged across batches (stable ids + parents) for tree relayout. */
  const accumulatedConceptsRef = useRef<ConceptPayload[]>([]);
  const nodeCounterRef = useRef(0);
  const nodesRef = useRef<Node[]>([]);
  const localSttBufferRef = useRef('');
  const localSttIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    setTranscriptModalMounted(true);
  }, []);

  useEffect(() => {
    if (!transcriptModal) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTranscriptModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [transcriptModal]);

  // Merge concepts across batches, then apply shared tree layout (no overlapping radial fan).
  const addConceptsToMap = useCallback((concepts: ConceptData[]) => {
    // #region agent log H3
    fetch('http://127.0.0.1:7632/ingest/36dc6992-f772-466f-a02b-fd70ac711c4b', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': '119102',
      },
      body: JSON.stringify({
        sessionId: '119102',
        runId: 'demo-debug',
        hypothesisId: 'H3',
        location: 'record/page.tsx:addConceptsToMap:entry',
        message: 'client received concepts for map',
        data: {
          incomingCount: concepts.length,
          incomingLabelsSample: concepts.slice(0, 10).map((c) => c.label),
          existingNodeCount: nodesRef.current.length,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    // #region agent log H3
    debugLog('H3', 'record/page.tsx:addConceptsToMap:entry', 'addConceptsToMap called', {
      conceptsCount: concepts.length,
      sampleLabels: concepts.slice(0, 3).map((c) => c.label),
      existingNodeCount: nodesRef.current.length,
    });
    // #endregion

    const accumulated = accumulatedConceptsRef.current;
    const existingForDedup = accumulated.map((c) => ({ id: c.id as string, label: c.label }));
    const batchMapping = new Map<string, string>();
    const newAcc: ConceptPayload[] = [...accumulated];

    const sortedConcepts = [...concepts].sort((a, b) => {
      const order = { main: 0, concept: 1, detail: 2 };
      return order[a.type] - order[b.type];
    });

    let added = 0;
    sortedConcepts.forEach((concept, idx) => {
      const agentKey = (concept.id && String(concept.id).trim()) || `__idx${idx}`;

      const similarNodeId = findSimilarConcept(concept.label, existingForDedup, 0.75);
      if (similarNodeId) {
        batchMapping.set(agentKey, similarNodeId);
        console.log(`[DEDUP] Merged "${concept.label}" with existing "${similarNodeId}"`);
        return;
      }

      const stableId = `n${++nodeCounterRef.current}`;
      batchMapping.set(agentKey, stableId);
      existingForDedup.push({ id: stableId, label: concept.label });

      const rawParent = concept.parent && String(concept.parent).trim();
      let parentId: string | null = null;
      if (rawParent) {
        if (batchMapping.has(rawParent)) {
          parentId = batchMapping.get(rawParent)!;
        } else if (accumulated.some((c) => c.id === rawParent)) {
          parentId = rawParent;
        } else {
          parentId = null;
        }
      }

      newAcc.push({
        ...concept,
        id: stableId,
        parent: parentId ?? undefined,
      });
      added++;
    });

    accumulatedConceptsRef.current = newAcc;

    const { nodes: layoutNodes, edges: layoutEdges } = buildMindMapLayout(
      newAcc,
      {
        mode: 'external-root',
        rootId: 'center',
        lectureAnchor: { x: 250, y: 200, height: 100, gapAfter: 40 },
      },
      'record'
    );

    setNodes([createRecordCenterFlowNode(), ...layoutNodes]);
    setEdges(layoutEdges);
    // #region agent log H3
    fetch('http://127.0.0.1:7632/ingest/36dc6992-f772-466f-a02b-fd70ac711c4b', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': '119102',
      },
      body: JSON.stringify({
        sessionId: '119102',
        runId: 'demo-debug',
        hypothesisId: 'H3',
        location: 'record/page.tsx:addConceptsToMap:exit',
        message: 'map update computed',
        data: {
          addedCount: added,
          totalAccumulatedConcepts: newAcc.length,
          layoutNodeCount: layoutNodes.length,
          layoutEdgeCount: layoutEdges.length,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    // #region agent log H3
    debugLog('H3', 'record/page.tsx:addConceptsToMap:exit', 'addConceptsToMap completed', {
      newNodes: added,
      totalConcepts: newAcc.length,
      dedupedOrSkipped: Math.max(0, concepts.length - added),
    });
    // #endregion
  }, []);

  const injectDebugTranscript = useCallback(async (text: string, opts?: { fastMode?: boolean }) => {
    const transcript = (text || '').trim();
    debugLog('H5', 'record/page.tsx:injectDebugTranscript:start', 'debug transcript injection started', {
      transcriptChars: transcript.length,
      fastMode: !!opts?.fastMode,
    });
    if (!transcript) return;

    const response = await authFetch('/api/process-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, fastMode: !!opts?.fastMode }),
    });
    const data = (await response.json().catch(() => ({}))) as { concepts?: ConceptData[]; error?: string };

    debugLog('H5', 'record/page.tsx:injectDebugTranscript:response', 'debug transcript injection response', {
      ok: response.ok,
      conceptsCount: Array.isArray(data.concepts) ? data.concepts.length : 0,
      error: typeof data.error === 'string' ? data.error : null,
    });

    if (response.ok && Array.isArray(data.concepts) && data.concepts.length > 0) {
      addConceptsToMap(data.concepts);
      setShowFlowBoard(true);
    }
    setTranscripts((prev) => [...prev, transcript]);
  }, [addConceptsToMap]);

  const handleLoadDemoTranscript = useCallback(async () => {
    if (demoTranscriptLoading) return;
    setDemoTranscriptLoading(true);
    try {
      const w = window as Window & {
        __smartsketchDebugInjectTranscript?: (
          text: string,
          opts?: { fastMode?: boolean }
        ) => Promise<void>;
        __smartsketchDebugDemoTranscript?: string;
      };
      const injectedTranscript = w.__smartsketchDebugDemoTranscript ?? DEBUG_DEMO_TRANSCRIPT;

      if (typeof w.__smartsketchDebugInjectTranscript === 'function') {
        await w.__smartsketchDebugInjectTranscript(injectedTranscript, { fastMode: true });
      } else {
        await injectDebugTranscript(injectedTranscript, { fastMode: true });
      }
    } finally {
      setDemoTranscriptLoading(false);
    }
  }, [demoTranscriptLoading, injectDebugTranscript]);

  // Handle messages from the agent
  const handleAgentMessage = useCallback((message: AgentMessage) => {
    console.log('[AGENT MESSAGE]', message);

    switch (message.type) {
      case 'agent_ready':
        setAgentReady(true);
        console.log('Agent is ready and listening!');
        break;

      case 'concepts':
        // #region agent log H1
        debugLog('H1', 'record/page.tsx:handleAgentMessage:concepts', 'agent concepts message received', {
          conceptsCount: message.data.concepts?.length ?? 0,
          hasTranscript: !!message.data.transcript,
        });
        // #endregion
        if (message.data.concepts && message.data.concepts.length > 0) {
          // Add all concepts at once to properly handle parent-child relationships
          addConceptsToMap(message.data.concepts);
        }
        break;

      case 'transcript':
        if (message.data.transcript) {
          setTranscripts((prev) => [...prev, message.data.transcript!]);
        }
        break;
    }
  }, [addConceptsToMap]);

  const handleAgentMessageRef = useRef(handleAgentMessage);
  handleAgentMessageRef.current = handleAgentMessage;

  // Connect to LiveKit room (without publishing tracks)
  const connectToLiveKit = useCallback(async () => {
    console.log('[LiveKit] Starting connection process...');
    // #region agent log H6
    debugLog('H6', 'record/page.tsx:connectToLiveKit:start', 'connectToLiveKit invoked', {
      hasRoomRef: !!roomRef.current,
      roomState: roomRef.current?.state ?? null,
      liveKitConfigured: isLiveKitConfigured(),
      inFlight: liveKitConnectInFlightRef.current,
    });
    // #endregion

    if (liveKitConnectInFlightRef.current) {
      // #region agent log H6
      debugLog('H6', 'record/page.tsx:connectToLiveKit:skip', 'connect skipped because another connect is in flight', {
        roomState: roomRef.current?.state ?? null,
      });
      // #endregion
      return;
    }
    liveKitConnectInFlightRef.current = true;

    try {
      const existing = roomRef.current;
      if (existing) {
        const st = existing.state;
        // Do not tear down the client while LiveKit is connecting or reconnecting — that
        // caused overlapping connects to abort with "Client initiated disconnect".
        if (st === ConnectionState.Connected) {
          console.log('[LiveKit] Already connected, skipping connection');
          setLiveKitConnected(true);
          setAgentReady(true);
          return;
        }
        if (
          st === ConnectionState.Connecting ||
          st === ConnectionState.Reconnecting ||
          st === ConnectionState.SignalReconnecting
        ) {
          setLiveKitConnected(true);
          return;
        }
      }

      // Cleanup any existing connection first (only when disconnected or no room)
      if (roomRef.current) {
        console.log('[LiveKit] Cleaning up existing connection...');
        try {
          await roomRef.current.disconnect();
        } catch (e) {
          console.log('[LiveKit] Error disconnecting existing room:', e);
        }
        roomRef.current = null;
      }

      // Fetch token from our API with unique room name
      const roomName = `smartsketch-${sessionIdRef.current}`;
      const u = userRef.current;
      const username = u?.id ? `student-${u.id.slice(0, 8)}` : `student-${Date.now()}`;
      console.log('[LiveKit] Fetching token for room:', roomName, 'user:', username);
      const response = await authFetch(
        `/api/livekit/token?room=${encodeURIComponent(roomName)}&username=${encodeURIComponent(username)}`
      );
      console.log('[LiveKit] API response status:', response.status, response.statusText);
      // #region agent log H6
      debugLog('H6', 'record/page.tsx:connectToLiveKit:token', 'livekit token response', {
        status: response.status,
        ok: response.ok,
        roomName,
      });
      // #endregion
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[LiveKit] API error response:', errorText);
        if (response.status === 429) {
          const retryMs = 15_000;
          liveKitTokenRetryAfterMsRef.current = Date.now() + retryMs;
          // #region agent log H11
          debugLog('H11', 'record/page.tsx:connectToLiveKit:token429', 'livekit token rate limited; backing off', {
            retryMs,
            roomName,
          });
          // #endregion
        }
        throw new Error(`Failed to fetch LiveKit token: ${response.status} ${errorText}`);
      }

      liveKitTokenRetryAfterMsRef.current = 0;
      
      const data = await response.json();
      console.log('[LiveKit] API response data:', data);
      const { token } = data;
      
      if (!token) {
        console.error('[LiveKit] No token in response:', data);
        throw new Error('Token missing from API response');
      }
      
      console.log('[LiveKit] Token received successfully');

      const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL?.trim();
      console.log('[LiveKit] LiveKit URL:', livekitUrl);
      if (!livekitUrl) {
        console.warn('NEXT_PUBLIC_LIVEKIT_URL not set, skipping LiveKit connection');
        return;
      }

      liveKitConnectGenerationRef.current += 1;
      const connectGen = liveKitConnectGenerationRef.current;

      // Create and connect to room with better connection options
      console.log('[LiveKit] Creating room instance...');
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        // Reconnection settings
        disconnectOnPageLeave: false,
      });
      roomRef.current = room;

      // Listen for data messages from the agent
      room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant | LocalParticipant, kind?: DataPacket_Kind, topic?: string) => {
        console.log('[LiveKit] Data received:', { topic, payloadSize: payload.length, participant: participant?.name });
        // #region agent log H1
        debugLog('H1', 'record/page.tsx:RoomEvent.DataReceived', 'livekit data received', {
          topic: topic ?? null,
          payloadSize: payload.length,
          participant: participant?.identity ?? participant?.name ?? null,
        });
        // #endregion
        
        // Log raw payload for debugging
        try {
          const decoded = new TextDecoder().decode(payload);
          console.log('[LiveKit] Raw payload:', decoded);
        } catch (e) {
          console.log('[LiveKit] Could not decode payload as string');
        }
        
        if (topic === 'smartsketch') {
          try {
            const message: AgentMessage = JSON.parse(new TextDecoder().decode(payload));
            console.log('[LiveKit] Parsed message:', message);
            // #region agent log H1
            debugLog('H1', 'record/page.tsx:RoomEvent.DataReceived:parsed', 'smartsketch payload parsed', {
              type: message.type,
              conceptsCount: message.data?.concepts?.length ?? 0,
              hasTranscript: !!message.data?.transcript,
            });
            // #endregion
            // If we receive any message from agent, it's ready
            console.log('[LiveKit] Agent is ready (received data message)');
            setAgentReady(true);
            handleAgentMessageRef.current(message);
          } catch (e) {
            console.error('[LiveKit] Failed to parse agent message:', e);
            // #region agent log H1
            debugLog('H1', 'record/page.tsx:RoomEvent.DataReceived:parseError', 'smartsketch payload parse failed', {
              error: e instanceof Error ? e.message : String(e),
            });
            // #endregion
          }
        } else {
          console.log('[LiveKit] Data received on unexpected topic:', topic, '(expected: smartsketch)');
        }
      });

      // Connect to room (but don't publish tracks yet)
      console.log('[LiveKit] Connecting to room...');
      liveKitAwaitingRoomConnectRef.current = true;
      try {
        await room.connect(livekitUrl, token, {
          autoSubscribe: true,
        });
      } finally {
        liveKitAwaitingRoomConnectRef.current = false;
      }
      if (connectGen !== liveKitConnectGenerationRef.current || roomRef.current !== room) {
        // #region agent log H7
        debugLog('H7', 'record/page.tsx:connectToLiveKit:aborted', 'connect aborted after room.connect (stale generation or room ref replaced)', {
          connectGen,
          currentGen: liveKitConnectGenerationRef.current,
          roomRefMatches: roomRef.current === room,
        });
        // #endregion
        try {
          await room.disconnect();
        } catch {
          /* ignore */
        }
        if (roomRef.current === room) {
          roomRef.current = null;
        }
        return;
      }
      console.log('[LiveKit] ✅ Connected to LiveKit room:', room.name);
      // #region agent log H6
      debugLog('H6', 'record/page.tsx:connectToLiveKit:connected', 'room connected', {
        room: room.name,
      });
      // #endregion
      setLiveKitConnected(true);
      console.log('[LiveKit] State updated - liveKitConnected set to true');

      if (roomHasAgentLikeParticipant(room)) {
        console.log('[LiveKit] Agent already in room (participant scan), setting agentReady to true');
        setAgentReady(true);
      }

      // Listen for participant joined events (to detect when agent joins)
      room.on(RoomEvent.ParticipantConnected, (participant) => {
        console.log('[LiveKit] Participant connected:', participant.identity);
        // #region agent log H6
        debugLog('H6', 'record/page.tsx:RoomEvent.ParticipantConnected', 'participant connected', {
          identity: participant.identity ?? null,
        });
        // #endregion
        if (remoteParticipantLooksLikeAgent(participant.identity)) {
          console.log('[LiveKit] Agent participant detected, setting agentReady to true');
          setAgentReady(true);
        }
      });

      // Listen for disconnection events to properly update state
      room.on(RoomEvent.Disconnected, (reason) => {
        console.log('[LiveKit] Room disconnected, reason:', reason);
        // #region agent log H6
        debugLog('H6', 'record/page.tsx:RoomEvent.Disconnected', 'room disconnected', {
          reason: String(reason ?? ''),
        });
        // #endregion
        setLiveKitConnected(false);
        setAgentReady(false);
      });

      // Listen for reconnection events
      room.on(RoomEvent.Reconnecting, () => {
        console.log('[LiveKit] Room reconnecting...');
      });

      room.on(RoomEvent.Reconnected, () => {
        console.log('[LiveKit] Room reconnected');
        setLiveKitConnected(true);
        const r = roomRef.current;
        if (r && roomHasAgentLikeParticipant(r)) {
          console.log('[LiveKit] Agent present after reconnect, setting agentReady to true');
          setAgentReady(true);
        }
      });

      // Listen for track events to debug issues
      room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
        console.log('[LiveKit] Track unpublished:', publication.trackSid, 'by', participant.identity);
      });

      room.on(RoomEvent.LocalTrackUnpublished, (publication, participant) => {
        console.log('[LiveKit] Local track unpublished:', publication.trackSid);
      });

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        console.log('[LiveKit] Participant disconnected:', participant.identity);
        if (remoteParticipantLooksLikeAgent(participant.identity)) {
          console.warn('[LiveKit] Agent disconnected!');
          setAgentReady(false);
        }
      });

      room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        console.log('[LiveKit] Connection quality changed:', quality, 'for', participant.identity);
      });

    } catch (error) {
      console.error('[LiveKit] ❌ Connection error:', error);
      // #region agent log H6
      debugLog('H6', 'record/page.tsx:connectToLiveKit:error', 'connectToLiveKit failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // #endregion
      const failedRoom = roomRef.current;
      if (failedRoom) {
        try {
          await failedRoom.disconnect();
        } catch {
          /* ignore */
        }
        if (roomRef.current === failedRoom) {
          roomRef.current = null;
        }
      }
      setLiveKitConnected(false);
      setAgentReady(false);
      setAllowStartWithoutAgent(true);
    } finally {
      liveKitConnectInFlightRef.current = false;
      // #region agent log H6
      debugLog('H6', 'record/page.tsx:connectToLiveKit:finally', 'connectToLiveKit finished', {
        inFlight: liveKitConnectInFlightRef.current,
        liveKitConnectedState: roomRef.current?.state ?? null,
      });
      // #endregion
    }
  }, []);

  // Store cloned tracks for LiveKit (so we don't lose the original stream when LiveKit unpublishes)
  const clonedTracksRef = useRef<MediaStreamTrack[]>([]);

  // Publish tracks to LiveKit (called when recording starts)
  // Returns true if successful, false if failed
  const publishTracksToLiveKit = useCallback(async (mediaStream: MediaStream): Promise<boolean> => {
    console.log('[Publish] Starting track publication...');
    // #region agent log H8
    debugLog('H8', 'record/page.tsx:publishTracksToLiveKit:start', 'publishTracksToLiveKit invoked', {
      hasRoom: !!roomRef.current,
      roomState: roomRef.current?.state ?? null,
      audioTracks: mediaStream.getAudioTracks().length,
      videoTracks: mediaStream.getVideoTracks().length,
    });
    // #endregion

    // Helper to check if room is connected (avoids TypeScript narrowing issues)
    const isConnected = () => roomRef.current?.state === ConnectionState.Connected;

    // If room doesn't exist or is disconnected, try to reconnect
    if (!roomRef.current || !isConnected()) {
      console.log('[Publish] Room not connected, attempting to reconnect...');
      // #region agent log H8
      debugLog('H8', 'record/page.tsx:publishTracksToLiveKit:reconnect', 'room missing or not connected; calling connectToLiveKit', {
        hasRoom: !!roomRef.current,
        roomState: roomRef.current?.state ?? null,
      });
      // #endregion

      // Try to reconnect
      await connectToLiveKit();

      // Wait a bit for connection to establish
      let attempts = 0;
      while (!isConnected() && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }

      if (!isConnected()) {
        console.error('[Publish] ❌ Failed to reconnect to room');
        // #region agent log H8
        debugLog('H8', 'record/page.tsx:publishTracksToLiveKit:reconnectFailed', 'reconnect wait exhausted; still not connected', {
          hasRoom: !!roomRef.current,
          roomState: roomRef.current?.state ?? null,
        });
        // #endregion
        return false;
      }

      console.log('[Publish] ✅ Reconnected successfully');
    }

    console.log('[Publish] Room state:', roomRef.current?.state);

    console.log('[Publish] Getting tracks from stream...');

    // Extra null check after reconnection attempt
    if (!roomRef.current) {
      console.error('[Publish] ❌ Room reference is null');
      return false;
    }

    try {
      // IMPORTANT: Clone tracks before publishing to LiveKit
      // When LiveKit unpublishes tracks, it stops them - cloning prevents this from killing the original stream
      const audioTrack = mediaStream.getAudioTracks()[0];
      const videoTrack = mediaStream.getVideoTracks()[0];

      console.log('[Publish] Original audio track:', audioTrack?.id, 'enabled:', audioTrack?.enabled);
      console.log('[Publish] Original video track:', videoTrack?.id, 'enabled:', videoTrack?.enabled);

      // Stop any previously cloned tracks
      clonedTracksRef.current.forEach(track => {
        track.stop();
        console.log('[Publish] Stopped old cloned track:', track.kind);
      });
      clonedTracksRef.current = [];

      if (audioTrack) {
        const clonedAudio = audioTrack.clone();
        // Monitor track state
        clonedAudio.onended = () => {
          console.warn('[Track] Cloned audio track ended unexpectedly');
        };
        clonedTracksRef.current.push(clonedAudio);
        console.log('[Publish] Publishing cloned audio track:', clonedAudio.id);
        await roomRef.current.localParticipant.publishTrack(clonedAudio);
        console.log('[Publish] ✅ Published cloned audio track');
      }

      if (videoTrack) {
        const clonedVideo = videoTrack.clone();
        // Monitor track state
        clonedVideo.onended = () => {
          console.warn('[Track] Cloned video track ended unexpectedly');
        };
        clonedTracksRef.current.push(clonedVideo);
        console.log('[Publish] Publishing cloned video track:', clonedVideo.id);
        await roomRef.current.localParticipant.publishTrack(clonedVideo);
        console.log('[Publish] ✅ Published cloned video track');
      }

      return true;
    } catch (error) {
      console.error('[Publish] ❌ Failed to publish tracks:', error);
      // #region agent log H8
      debugLog('H8', 'record/page.tsx:publishTracksToLiveKit:error', 'publishTracksToLiveKit failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // #endregion
      return false;
    }
  }, [connectToLiveKit]);

  // Disconnect from LiveKit
  const disconnectFromLiveKit = useCallback(async () => {
    console.log('[LiveKit] Disconnecting from room...');
    const r = roomRef.current;
    const rs = r?.state ?? null;
    const midConnect =
      liveKitConnectInFlightRef.current ||
      liveKitAwaitingRoomConnectRef.current ||
      rs === ConnectionState.Connecting ||
      rs === ConnectionState.Reconnecting ||
      rs === ConnectionState.SignalReconnecting;
    // #region agent log H13
    debugLog('H13', 'record/page.tsx:disconnectFromLiveKit:decision', 'disconnectFromLiveKit guard', {
      hasRoom: !!r,
      roomState: rs,
      connectInFlight: liveKitConnectInFlightRef.current,
      awaitingRoomConnect: liveKitAwaitingRoomConnectRef.current,
      willSkip: midConnect,
    });
    // #endregion

    // If we're mid-connect, disconnecting here surfaces as "Client initiated disconnect" on the in-flight connect.
    if (midConnect) {
      // #region agent log H11
      debugLog('H11', 'record/page.tsx:disconnectFromLiveKit:skipped', 'skipped disconnect during connect/reconnect', {
        roomState: rs,
        connectInFlight: liveKitConnectInFlightRef.current,
        awaitingRoomConnect: liveKitAwaitingRoomConnectRef.current,
      });
      // #endregion
      return;
    }

    // Stop all cloned tracks first
    clonedTracksRef.current.forEach(track => {
      track.stop();
      console.log('[LiveKit] Stopped cloned track:', track.kind);
    });
    clonedTracksRef.current = [];

    if (roomRef.current) {
      try {
        // Remove all event listeners to prevent memory leaks
        roomRef.current.removeAllListeners();

        // Disconnect from room - this is async, must await it
        await roomRef.current.disconnect();
        console.log('[LiveKit] ✅ Disconnected from room');
      } catch (error) {
        console.error('[LiveKit] Error during disconnect:', error);
      }

      roomRef.current = null;
      setLiveKitConnected(false);
      setAgentReady(false);
      waitingForAgentSinceMsRef.current = null;
    }
    // #region agent log H7
    debugLog('H7', 'record/page.tsx:disconnectFromLiveKit:end', 'disconnectFromLiveKit finished', {
      hasRoom: !!roomRef.current,
    });
    // #endregion
  }, []);

  useEffect(() => {
    // #region agent log H12
    debugLog('H12', 'record/page.tsx:permissionsEffect:start', 'permissions effect started', {
      hasStreamRef: !!streamRef.current,
    });
    // #endregion
    if (strictCleanupDisconnectTimerRef.current) {
      clearTimeout(strictCleanupDisconnectTimerRef.current);
      strictCleanupDisconnectTimerRef.current = null;
    }
    recordPageMountGenerationRef.current += 1;

    const requestPermissions = async () => {
      if (streamRef.current) {
        return;
      }
      console.log('[Permissions] Requesting camera and microphone access...');
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: true,
        });

        console.log('[Permissions] Access granted, setting stream');
        streamRef.current = mediaStream;
        setStream(mediaStream);
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
        }
        setHasPermission(true);
        setPermissionError('');

      } catch (error) {
        setHasPermission(false);
        const err = error as DOMException;

        if (err.name === 'NotAllowedError') {
          setPermissionError(
            'Camera and microphone permissions were denied. Please enable them in your browser settings to continue.'
          );
        } else if (err.name === 'NotFoundError') {
          setPermissionError(
            'No camera or microphone device found. Please check your hardware.'
          );
          if (!navigator.mediaDevices.enumerateDevices) {
            setCameraError(true);
          } else {
            setMicError(true);
          }
        } else if (err.name === 'NotReadableError') {
          setPermissionError(
            'Camera or microphone is already in use by another application.'
          );
        } else {
          setPermissionError(
            'Failed to access camera and microphone. Please try again.'
          );
        }
      }
    };

    requestPermissions();

    return () => {
      console.log('[Cleanup] Component unmounting, cleaning up resources...');
      // #region agent log H12
      debugLog('H12', 'record/page.tsx:permissionsEffect:cleanup', 'permissions effect cleanup invoked', {
        hasStreamRef: !!streamRef.current,
      });
      // #endregion
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => {
          track.stop();
          console.log('[Cleanup] Stopped track:', track.kind);
        });
        streamRef.current = null;
      }
    };
  }, []);

  // LiveKit teardown on unmount only (decoupled from media stream updates so we do not abort in-flight `room.connect`).
  useEffect(() => {
    return () => {
      const gen = ++recordPageMountGenerationRef.current;
      const isDev = process.env.NODE_ENV !== 'production';
      const shouldDeferDisconnect =
        isDev &&
        gen === 1 &&
        (liveKitConnectInFlightRef.current ||
          liveKitAwaitingRoomConnectRef.current ||
          roomRef.current?.state === ConnectionState.Connecting ||
          roomRef.current?.state === ConnectionState.Reconnecting ||
          roomRef.current?.state === ConnectionState.SignalReconnecting);

      if (strictCleanupDisconnectTimerRef.current) {
        clearTimeout(strictCleanupDisconnectTimerRef.current);
        strictCleanupDisconnectTimerRef.current = null;
      }

      if (shouldDeferDisconnect) {
        // #region agent log H10
        debugLog('H10', 'record/page.tsx:livekitUnmount:deferDisconnect', 'deferring LiveKit disconnect (likely React StrictMode remount)', {
          gen,
          roomState: roomRef.current?.state ?? null,
          connectInFlight: liveKitConnectInFlightRef.current,
          awaitingRoomConnect: liveKitAwaitingRoomConnectRef.current,
        });
        // #endregion
        strictCleanupDisconnectTimerRef.current = setTimeout(() => {
          strictCleanupDisconnectTimerRef.current = null;
          if (recordPageMountGenerationRef.current !== gen) {
            // #region agent log H10
            debugLog('H10', 'record/page.tsx:livekitUnmount:deferDisconnect:cancelled', 'skipped deferred disconnect after remount', {
              gen,
              currentGen: recordPageMountGenerationRef.current,
            });
            // #endregion
            return;
          }
          void disconnectFromLiveKit();
        }, 0);
        return;
      }

      void disconnectFromLiveKit();
    };
  }, [disconnectFromLiveKit]);

  // Local-only: no LiveKit URL — treat as ready to record once camera/mic work.
  useEffect(() => {
    if (stream && !isLiveKitConfigured()) {
      setAgentReady(true);
    }
  }, [stream]);

  // Connect to LiveKit when stream is available and LiveKit is configured
  useEffect(() => {
    console.log('[Connection Check] stream:', !!stream, 'liveKitConnected:', liveKitConnected);
    if (stream && isLiveKitConfigured() && !liveKitConnected) {
      const now = Date.now();
      if (now < liveKitTokenRetryAfterMsRef.current) {
        // #region agent log H11
        debugLog('H11', 'record/page.tsx:connectEffect:backoff', 'skipping connectToLiveKit during token backoff', {
          waitMs: liveKitTokenRetryAfterMsRef.current - now,
        });
        // #endregion
        return;
      }
      console.log('[Connection] Initiating LiveKit connection...');
      connectToLiveKit();
    }
  }, [stream, liveKitConnected, connectToLiveKit]);

  // If LiveKit is on but the agent never signals ready, allow starting (local audio + mind map without agent).
  // Grace deadline is anchored in a ref so brief disconnect/reconnect does not keep resetting the 25s timer.
  useEffect(() => {
    if (!isLiveKitConfigured() || agentReady) {
      waitingForAgentSinceMsRef.current = null;
      setAllowStartWithoutAgent(false);
      return;
    }
    if (!liveKitConnected) {
      return;
    }
    if (waitingForAgentSinceMsRef.current === null) {
      waitingForAgentSinceMsRef.current = Date.now();
    }
    const elapsed = Date.now() - waitingForAgentSinceMsRef.current;
    const remaining = Math.max(0, 25000 - elapsed);
    if (remaining === 0) {
      setAllowStartWithoutAgent(true);
      return;
    }
    const id = window.setTimeout(() => {
      console.warn('[LiveKit] Agent not ready after 25s; allowing recording without agent.');
      setAllowStartWithoutAgent(true);
    }, remaining);
    return () => clearTimeout(id);
  }, [liveKitConnected, agentReady]);

  const canStartRecording =
    !isLiveKitConfigured() || (liveKitConnected && (agentReady || allowStartWithoutAgent));

  /** Browser STT + /api/process-transcript when LiveKit agent path is unavailable (no LiveKit URL or grace-period fallback). */
  useEffect(() => {
    const useBrowserStt = !isLiveKitConfigured() || allowStartWithoutAgent;
    if (!isRecording || isPaused || !stream || !useBrowserStt) {
      if (localSttIntervalRef.current) {
        clearInterval(localSttIntervalRef.current);
        localSttIntervalRef.current = null;
      }
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.stop();
        } catch {
          /* ignore */
        }
        speechRecognitionRef.current = null;
      }
      return;
    }

    const w = window as WindowWithSpeech;
    const ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!ctor) {
      console.warn('[local STT] SpeechRecognition not available in this browser');
      return;
    }

    const rec = new ctor();
    speechRecognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    rec.onresult = (event: SpeechRecognitionResultEvent) => {
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalText += event.results[i][0].transcript;
        }
      }
      const t = finalText.trim();
      if (t) {
        localSttBufferRef.current = `${localSttBufferRef.current} ${t}`.trim();
      }
    };

    rec.onerror = (ev: { error: string }) => {
      console.warn('[local STT]', ev.error);
    };

    try {
      rec.start();
    } catch (e) {
      console.warn('[local STT] start failed', e);
    }

    localSttIntervalRef.current = setInterval(async () => {
      const text = localSttBufferRef.current.trim();
      // #region agent log H2
      debugLog('H2', 'record/page.tsx:localSTT:tick', 'local STT interval tick', {
        bufferedChars: text.length,
        willSend: text.length >= 50,
      });
      // #endregion
      if (text.length < 50) return;
      try {
        const response = await authFetch('/api/process-transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: text }),
        });
        if (response.ok) {
          const data = (await response.json()) as { concepts?: ConceptData[] };
          // #region agent log H2
          debugLog('H2', 'record/page.tsx:localSTT:response', 'process-transcript response received', {
            ok: response.ok,
            conceptsCount: Array.isArray(data.concepts) ? data.concepts.length : 0,
          });
          // #endregion
          if (Array.isArray(data.concepts) && data.concepts.length > 0) {
            addConceptsToMap(data.concepts);
          }
          localSttBufferRef.current = '';
        }
      } catch (err) {
        console.error('[local STT] process-transcript error', err);
      }
    }, 10000);

    return () => {
      if (localSttIntervalRef.current) {
        clearInterval(localSttIntervalRef.current);
        localSttIntervalRef.current = null;
      }
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      speechRecognitionRef.current = null;
    };
  }, [isRecording, isPaused, stream, allowStartWithoutAgent, addConceptsToMap]);

  useEffect(() => {
    // #region agent log H4
    debugLog('H4', 'record/page.tsx:useEffect:renderState', 'render state update', {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      isRecording,
      liveKitConnected,
      agentReady,
      allowStartWithoutAgent,
    });
    // #endregion
  }, [nodes.length, edges.length, isRecording, liveKitConnected, agentReady, allowStartWithoutAgent]);

  useEffect(() => {
    const w = window as Window & {
      __smartsketchDebugInjectTranscript?: (
        text: string,
        opts?: { fastMode?: boolean }
      ) => Promise<void>;
      __smartsketchDebugInjectDemoTranscript?: () => Promise<void>;
      __smartsketchDebugDemoTranscript?: string;
    };

    w.__smartsketchDebugInjectTranscript = (text: string, opts?: { fastMode?: boolean }) =>
      injectDebugTranscript(text, opts);
    w.__smartsketchDebugDemoTranscript = DEBUG_DEMO_TRANSCRIPT;
    w.__smartsketchDebugInjectDemoTranscript = async () => {
      await injectDebugTranscript(DEBUG_DEMO_TRANSCRIPT);
    };

    return () => {
      delete w.__smartsketchDebugInjectTranscript;
      delete w.__smartsketchDebugInjectDemoTranscript;
      delete w.__smartsketchDebugDemoTranscript;
    };
  }, [injectDebugTranscript]);

  const handleChatSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const value = chatInput.trim();
      if (!value || isChatSending) return;

      const newMessages = [...chatMessages, { role: 'user' as const, content: value }];
      setChatMessages(newMessages);
      setChatInput('');
      setIsChatSending(true);

      try {
        const transcript = transcripts.join(' ');
        const title = recordingTitle.trim() || 'Untitled session';
        const res = await authFetch('/api/gemini-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: newMessages,
            transcript,
            title,
          }),
        });

        if (!res.ok) {
          let errDetails = 'Chat request failed';
          try {
            const errJson = await res.json();
            errDetails = errJson?.details || errJson?.error || errDetails;
          } catch {
            /* ignore */
          }
          throw new Error(errDetails);
        }

        const data = await res.json();
        const reply = data.reply || 'I had trouble generating a response. Please try again.';
        setChatMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
      } catch (error) {
        const message = (error as Error)?.message || 'Unknown error';
        console.error('Session chat error:', message);
        const friendly =
          message.includes('Gemini API key') || message.includes('not configured')
            ? 'Gemini API key is missing. Add GEMINI_API_KEY to .env.local and restart the dev server.'
            : `Sorry, I ran into an issue: ${message}`;
        setChatMessages((prev) => [...prev, { role: 'assistant', content: friendly }]);
      } finally {
        setIsChatSending(false);
      }
    },
    [chatInput, chatMessages, transcripts, recordingTitle, isChatSending]
  );

  const handleStartRecording = async () => {
    if (isLiveKitConfigured() && !liveKitConnected) {
      console.warn('[Start Recording] Blocked: LiveKit not connected yet');
      return;
    }
    if (stream) {
      // #region agent log H8
      debugLog('H8', 'record/page.tsx:handleStartRecording', 'handleStartRecording entered', {
        liveKitConnected,
        agentReady,
        allowStartWithoutAgent,
        hasRoom: !!roomRef.current,
        roomState: roomRef.current?.state ?? null,
      });
      // #endregion
      console.log('[Start Recording] Stream available, beginning recording...');
      console.log('[Start Recording] Video tracks:', stream.getVideoTracks().length);
      console.log('[Start Recording] Audio tracks:', stream.getAudioTracks().length);
      
      setIsRecording(true);
      setIsPaused(false);
      setRecordingEnded(false);
      setShowFlowBoard(true);

      // Ensure video is still playing
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        console.log('[Start Recording] Video element set');
      }

      // Start audio recording
      try {
        const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.start();
        console.log('Audio recording started');
      } catch (error) {
        console.error('Failed to start audio recording:', error);
      }

      // Reset mind map
      setNodes([createRecordCenterFlowNode()]);
      setEdges([]);
      nodeCounterRef.current = 0;
      accumulatedConceptsRef.current = [];
      setTranscripts([]);
      localSttBufferRef.current = '';

      // Publish tracks to LiveKit (will reconnect if needed)
      console.log('[Start Recording] Publishing tracks to LiveKit...');
      const published = await publishTracksToLiveKit(stream);

      if (!published) {
        console.error('[Start Recording] Failed to publish tracks, but continuing with local recording');
        // Recording will continue locally even if LiveKit fails
        // The mind map won't update but audio will still be recorded
      } else {
        console.log('[Start Recording] Tracks published successfully');
      }
    }
  };

  const handlePauseRecording = async () => {
    console.log('[Pause] Pausing recording...');
    
    // Stop audio recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      console.log('[Pause] Audio recording paused');
    }

    // Unpublish tracks so agent doesn't transcribe during pause
    if (roomRef.current && roomRef.current.state === ConnectionState.Connected) {
      try {
        const publications = Array.from(roomRef.current.localParticipant.trackPublications.values());
        console.log('[Pause] Unpublishing', publications.length, 'tracks...');
        
        for (const publication of publications) {
          if (publication.track) {
            await roomRef.current.localParticipant.unpublishTrack(publication.track);
            console.log('[Pause] Unpublished track:', publication.track.kind);
          }
        }
        
        isTracksPausedRef.current = true;
        console.log('[Pause] ✅ Tracks paused - no transcript collection during pause');
      } catch (error) {
        console.error('[Pause] Error unpublishing tracks:', error);
      }
    }

    setIsPaused(true);
  };

  const handleResumeRecording = async () => {
    console.log('[Resume] Starting resume process...');
    if (stream) {
      // Republish tracks first to resume transcription
      if (isTracksPausedRef.current) {
        console.log('[Resume] Republishing tracks to LiveKit...');
        const published = await publishTracksToLiveKit(stream);
        if (published) {
          isTracksPausedRef.current = false;
          console.log('[Resume] ✅ Tracks resumed - transcript collection resumed');
        } else {
          console.error('[Resume] ❌ Failed to republish tracks, transcription may not work');
        }
      }

      // Restart audio recording with same stream
      try {
        console.log('[Resume] Creating new MediaRecorder...');
        const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        mediaRecorderRef.current = mediaRecorder;

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.start();
        console.log('[Resume] ✅ Audio recording resumed');
      } catch (error) {
        console.error('[Resume] ❌ Failed to resume audio recording:', error);
      }
    } else {
      console.error('[Resume] ❌ No stream available');
    }

    console.log('[Resume] Setting isPaused to false');
    setIsPaused(false);
  };

  const handleStopRecording = () => {
    setShowConfirmation(true);
  };

  const confirmStopRecording = async () => {
    // #region agent log H7
    debugLog('H7', 'record/page.tsx:confirmStopRecording:start', 'confirmStopRecording invoked', {
      hasRoom: !!roomRef.current,
      roomState: roomRef.current?.state ?? null,
      liveKitConnected,
    });
    // #endregion
    // Stop audio recording if still recording (might be paused)
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      console.log('Audio recording stopped');
    }

    // Disconnect LiveKit room to end agent session
    // MUST await this so agent has time to disconnect
    console.log('[Confirm Stop] Disconnecting from LiveKit...');
    await disconnectFromLiveKit();
    console.log('[Confirm Stop] ✅ Disconnected, showing save options');

    setIsRecording(false);
    setIsPaused(false);
    setShowChat(true);
    setChatMessages((prev) =>
      prev.length
        ? prev
        : [
            {
              role: 'assistant',
              content: 'Recording ended. Ask anything about this session while we process it.'
            },
          ]
    );
    setRecordingEnded(true);
    setShowConfirmation(false);
  };

  const cancelStopRecording = () => {
    setShowConfirmation(false);
  };

  return (
    <ProtectedRoute>
      <NeuralNetworkBackground />
      <div className="relative z-10 flex h-screen w-full flex-col overflow-hidden bg-transparent">
        {/* Back Button - Top Left */}
        <div className="absolute top-6 left-6 z-20">
          <button
            onClick={() => {
              setShowHomeModal(true);
              setHomeModalMode(isRecording ? 'active' : recordingEnded ? 'ended' : 'active');
              setRecordingTitleError('');
            }}
            className="px-4 py-2 rounded-xl glass text-foreground-muted hover:text-foreground transition-all duration-300 text-sm font-medium flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            {isRecording || recordingEnded ? 'Return Home' : 'Back'}
          </button>
        </div>

        {/* Connection Status - Top Right */}
        {isRecording && (
          <div className="absolute top-6 right-6 z-20 flex items-center gap-3">
            {liveKitConnected ? (
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary/10 border border-primary/20">
                <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
                <span className="text-primary text-sm font-medium">
                  {agentReady ? 'Agent Connected' : 'Python agent pending…'}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent/10 border border-accent/20">
                <div className="w-2 h-2 bg-accent rounded-full" />
                <span className="text-accent text-sm font-medium">Local Recording</span>
              </div>
            )}
          </div>
        )}

        {/* Main Layout: Recording on Left, Flow Board on Right */}
        <div className="flex min-h-0 flex-1 w-full">
          {/* LEFT SIDE - Recording Interface */}
          <div
            className={`flex flex-col items-center px-4 pt-20 transition-all duration-500 min-h-0 ${showFlowBoard ? 'w-1/2' : 'w-full'} ${
              showChat ? 'h-full justify-start overflow-hidden' : 'justify-center'
            }${showChat && showFlowBoard ? ' pb-[max(1rem,env(safe-area-inset-bottom,0px))]' : ''}`}
          >
            {showChat ? (
              <div className="flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-6 animate-fade-in-up">
                <div className="shrink-0 text-center">
                  <h1 className="text-3xl font-display font-bold text-foreground mb-2">Session Chat</h1>
                  <p className="text-foreground-muted">Ask questions about your session</p>
                  <button
                    onClick={async () => {
                      console.log('[New Recording] Resetting state for new recording...');
                      // Generate new session ID for new room
                      sessionIdRef.current = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                      console.log('[New Recording] New session ID:', sessionIdRef.current);

                      // Reset all recording-related state
                      setAllowStartWithoutAgent(false);
                      setShowChat(false);
                      setRecordingEnded(false);
                      setShowFlowBoard(false);
                      setChatMessages([]);
                      setTranscripts([]);
                      setTranscriptModal(null);
                      setNodes([createRecordCenterFlowNode()]);
                      setEdges([]);
                      nodeCounterRef.current = 0;
                      accumulatedConceptsRef.current = [];
                      audioChunksRef.current = [];
                      isTracksPausedRef.current = false;

                      // Reconnect to LiveKit with new session ID
                      if (stream) {
                        console.log('[New Recording] Reconnecting to LiveKit...');
                        await connectToLiveKit();
                      } else {
                        console.log('[New Recording] No stream, requesting permissions again...');
                        // Request new permissions if stream was lost
                        try {
                          const mediaStream = await navigator.mediaDevices.getUserMedia({
                            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                            audio: true,
                          });
                          setStream(mediaStream);
                          if (videoRef.current) {
                            videoRef.current.srcObject = mediaStream;
                          }
                        } catch (error) {
                          console.error('[New Recording] Failed to get media:', error);
                        }
                      }
                    }}
                    className="mt-4 px-6 py-2.5 rounded-xl btn-primary font-semibold"
                  >
                    Start New Recording
                  </button>
                </div>

                {/* Session transcript: same width/style as pre–See-more strip (max-w-2xl column + p-4 tinted box) */}
                {transcripts.length > 0 && (
                  <div className="shrink-0 w-full rounded-xl bg-primary/5 border border-primary/10 p-4 overflow-hidden">
                    <div className="flex items-center gap-2 min-h-0">
                      <span className="shrink-0 text-xs font-display font-bold text-foreground uppercase tracking-wider">
                        Session Transcript
                      </span>
                      <p className="min-w-0 flex-1 text-sm text-foreground-muted leading-tight truncate">
                        {transcripts.join(' ').trim()}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setTranscriptModal({
                            title: 'Full transcript',
                            body: transcripts.join(' ').trim(),
                          })
                        }
                        className="shrink-0 text-xs font-semibold text-primary hover:text-primary-dark transition-colors whitespace-nowrap"
                      >
                        See more
                      </button>
                    </div>
                  </div>
                )}

                {/* Chat container — fills space between header/transcript and input */}
                <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-3 custom-scrollbar">
                    {chatMessages.length === 0 && (
                      <div className="text-sm text-foreground-muted text-center py-8">No messages yet. Start the conversation.</div>
                    )}
                    {chatMessages.map((msg, idx) => (
                      <div
                        key={idx}
                        className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[75%] rounded-xl px-4 py-2.5 text-sm message-pop ${
                            msg.role === 'user'
                              ? 'bg-gradient-to-r from-primary to-primary-dark text-background'
                              : 'bg-background-secondary text-foreground border border-surface-border'
                          }`}
                        >
                          {msg.role === 'assistant' ? (
                            <div className="prose prose-sm prose-invert max-w-none [&_p]:mb-2 [&_ul]:mb-2 [&_ol]:mb-2 [&_li]:mb-1 [&_code]:bg-black/40 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-foreground [&_pre]:bg-black/40 [&_pre]:text-foreground [&_pre]:p-2 [&_pre]:rounded [&_strong]:text-primary [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs">
                              <ReactMarkdown>{msg.content}</ReactMarkdown>
                            </div>
                          ) : (
                            msg.content
                          )}
                        </div>
                      </div>
                    ))}
                    {isChatSending && (
                      <div className="flex justify-start">
                        <div className="max-w-[75%] rounded-xl px-4 py-2.5 text-sm bg-background-secondary text-foreground border border-surface-border opacity-80 animate-pulse">
                          Assistant is thinking...
                        </div>
                      </div>
                    )}
                  </div>
                  <form className="shrink-0 border-t border-surface-border p-4 flex gap-3" onSubmit={handleChatSubmit}>
                    <input
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      className="flex-1 px-4 py-2.5 rounded-xl input-field text-sm"
                      placeholder="Type your question..."
                      disabled={isChatSending}
                    />
                    <button
                      type="submit"
                      className="px-5 py-2.5 rounded-xl btn-primary text-sm disabled:opacity-70 disabled:cursor-not-allowed"
                      disabled={isChatSending}
                    >
                      Send
                    </button>
                  </form>
                </div>
              </div>
            ) : hasPermission === null ? (
              <div className="text-center animate-fade-in-down">
                <div className="w-12 h-12 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
                <h1 className="text-3xl font-display font-bold text-foreground mb-3">
                  Requesting Permissions
                </h1>
                <p className="text-foreground-muted">
                  Please allow access to your camera and microphone
                </p>
              </div>
            ) : hasPermission && !permissionError ? (
              <div className="w-full max-w-xl space-y-6 animate-fade-in-down">
                <div className="text-center">
                  <h1 className="text-3xl font-display font-bold text-foreground mb-2">
                    {!isRecording && 'Ready to Record'}
                    {isRecording && !isPaused && 'Recording in Progress'}
                    {isRecording && isPaused && 'Recording Paused'}
                  </h1>
                  <p className="text-foreground-muted">
                    {!isRecording && 'Check your camera position and audio quality'}
                  </p>
                </div>

                {/* Video Preview */}
                <div className="relative w-full rounded-2xl overflow-hidden shadow-card border border-surface-border">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full aspect-video object-cover bg-background-secondary"
                  />
                  {isRecording && (
                    <div className="absolute top-4 right-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/90 backdrop-blur-sm">
                      <div className="w-2.5 h-2.5 bg-white rounded-full animate-pulse" />
                      <span className="text-white font-semibold text-sm">REC</span>
                    </div>
                  )}
                </div>

                {/* Controls */}
                <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4">
                  {!isRecording ? (
                    <button
                      onClick={handleStartRecording}
                      disabled={!canStartRecording}
                      className={`px-8 py-3 rounded-xl font-semibold flex items-center gap-2 transition-all duration-300 ${
                        canStartRecording
                          ? 'btn-primary'
                          : 'bg-surface-border text-foreground-muted cursor-not-allowed opacity-60'
                      }`}
                    >
                      {canStartRecording ? (
                        <>
                          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="10" />
                          </svg>
                          Start Recording
                        </>
                      ) : (
                        <>
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          {isLiveKitConfigured() && !liveKitConnected
                            ? 'Connecting to LiveKit…'
                            : 'Waiting for Python agent…'}
                        </>
                      )}
                    </button>
                  ) : (
                    <>
                      {!isPaused ? (
                        <button
                          onClick={handlePauseRecording}
                          className="px-6 py-3 rounded-xl bg-accent/10 border border-accent/20 text-accent hover:bg-accent/20 transition-colors font-semibold flex items-center gap-2"
                        >
                          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <rect x="6" y="4" width="4" height="16" rx="1" />
                            <rect x="14" y="4" width="4" height="16" rx="1" />
                          </svg>
                          Pause
                        </button>
                      ) : (
                        <button
                          onClick={handleResumeRecording}
                          className="px-6 py-3 rounded-xl bg-accent/10 border border-accent/20 text-accent hover:bg-accent/20 transition-colors font-semibold flex items-center gap-2"
                        >
                          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                          Resume
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleLoadDemoTranscript()}
                        disabled={demoTranscriptLoading}
                        className="px-6 py-3 rounded-xl glass border border-surface-border text-foreground-muted hover:text-foreground hover:border-primary/30 transition-colors font-semibold text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {demoTranscriptLoading ? 'Loading demo…' : 'Load demo transcript'}
                      </button>
                      <button
                        onClick={handleStopRecording}
                        className="px-6 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors font-semibold flex items-center gap-2"
                      >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                          <rect x="6" y="6" width="12" height="12" rx="2" />
                        </svg>
                        Stop
                      </button>
                    </>
                  )}
                </div>

                <p className="text-center text-sm text-foreground-muted">
                  {!isLiveKitConfigured()
                    ? 'Local mode: recording works without LiveKit. Mind map updates require the Python agent if you add LiveKit later.'
                    : !liveKitConnected
                      ? 'Connecting to LiveKit… Start Recording stays disabled until the room is connected.'
                      : canStartRecording
                        ? agentReady
                          ? 'LiveKit connected. AI agent ready — click Start Recording to begin.'
                          : 'LiveKit connected. Starting without agent: you can record; the mind map may not update until the Python agent is running.'
                        : 'LiveKit connected. Waiting for the Python agent… Start unlocks automatically after 25s if the agent never joins.'}
                </p>
              </div>
            ) : (
              <div className="w-full max-w-xl animate-fade-in-down">
                <div className="card p-8 border-red-500/20">
                  <div className="text-center mb-6">
                    <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                      <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                    </div>
                    <h1 className="text-2xl font-display font-bold text-foreground mb-2">
                      Permission Required
                    </h1>
                    <p className="text-foreground-muted">{permissionError}</p>
                  </div>

                  {(cameraError || micError) && (
                    <div className="mb-6 flex justify-center gap-4">
                      {cameraError && (
                        <span className="px-3 py-1 rounded-full bg-red-500/10 text-red-400 text-sm">Camera not detected</span>
                      )}
                      {micError && (
                        <span className="px-3 py-1 rounded-full bg-red-500/10 text-red-400 text-sm">Microphone not detected</span>
                      )}
                    </div>
                  )}

                  <div className="bg-background-secondary rounded-xl p-5 mb-6">
                    <h3 className="font-semibold text-foreground mb-3">How to fix this:</h3>
                    <ol className="list-decimal list-inside space-y-2 text-foreground-muted text-sm">
                      <li>Check your browser&apos;s permission settings</li>
                      <li>Look for a camera/microphone icon in the address bar</li>
                      <li>Click it and select &quot;Allow&quot; for this site</li>
                      <li>Refresh the page and try again</li>
                    </ol>
                  </div>

                  <div className="flex gap-4 justify-center">
                    <button
                      onClick={() => window.location.reload()}
                      className="px-6 py-2.5 rounded-xl btn-primary font-semibold"
                    >
                      Try Again
                    </button>
                    <Link
                      href="/home"
                      className="px-6 py-2.5 rounded-xl glass text-foreground-muted hover:text-foreground transition-colors font-semibold"
                    >
                      Go Back
                    </Link>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* RIGHT SIDE - React Flow Board */}
          <div
            className={`flex min-h-0 overflow-hidden transition-all duration-700 ease-out ${
              showFlowBoard
                ? `h-full w-1/2 opacity-100${showChat ? '' : ' items-center justify-center'}`
                : 'w-0 opacity-0'
            }`}
          >
            {showFlowBoard && (
              <div
                className={
                  showChat
                    ? 'flex h-full min-h-0 w-full flex-col px-6 pt-20 pb-[max(1rem,env(safe-area-inset-bottom,0px))]'
                    : 'flex h-full min-h-0 w-full items-center justify-center p-6'
                }
              >
                <div
                  className={
                    showChat
                      ? 'card flex min-h-0 w-full flex-1 flex-col overflow-hidden'
                      : 'flex h-full w-full flex-col overflow-hidden card'
                  }
                >
                  <div className="px-6 py-4 border-b border-surface-border bg-background-secondary">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-lg font-display font-bold text-foreground">Live Processing</h2>
                        <p className="text-sm text-foreground-muted">
                          {agentReady
                            ? 'Concepts appear as AI processes speech'
                            : allowStartWithoutAgent
                              ? 'Recording without agent — mind map may stay static until the agent runs'
                              : liveKitConnected
                                ? 'LiveKit connected — waiting for Python agent…'
                                : 'Connecting to LiveKit…'}
                        </p>
                      </div>
                      {agentReady && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10">
                          <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
                          <span className="text-xs text-primary font-medium">Live</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 bg-background">
                    <ReactFlow
                      nodes={nodes}
                      edges={edges}
                      fitView
                      attributionPosition="bottom-left"
                    />
                  </div>
                  {/* Latest transcript: no scroll; See more opens modal */}
                  {transcripts.length > 0 && (
                    <div className="shrink-0 border-t border-surface-border bg-background-secondary px-3 py-2 flex items-center gap-2 min-h-0">
                      <span className="shrink-0 text-xs font-display font-bold text-foreground-muted uppercase tracking-wider">
                        Latest
                      </span>
                      <p className="min-w-0 flex-1 text-sm text-foreground leading-tight truncate">
                        {transcripts[transcripts.length - 1]}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setTranscriptModal({
                            title: 'Latest transcript',
                            body: transcripts[transcripts.length - 1]?.trim() ?? '',
                          })
                        }
                        className="shrink-0 text-xs font-semibold text-primary hover:text-primary-dark transition-colors whitespace-nowrap"
                      >
                        See more
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Confirmation Modal */}
        {showConfirmation && (
          <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in-scale">
            <div className="card p-8 max-w-md w-full mx-4">
              <h2 className="text-2xl font-display font-bold text-foreground mb-3">
                End Recording?
              </h2>
              <p className="text-foreground-muted mb-6">
                Are you sure you want to end this session? Your recording will be saved.
              </p>
              <div className="flex gap-4 justify-end">
                <button
                  onClick={cancelStopRecording}
                  className="px-5 py-2.5 rounded-xl glass text-foreground-muted hover:text-foreground transition-colors font-semibold"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmStopRecording}
                  className="px-5 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white transition-colors font-semibold"
                >
                  End Session
                </button>
              </div>
            </div>
          </div>
        )}

      {/* Return Home Modal */}
      {showHomeModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 animate-fade-in-down">
          <div className="bg-white rounded-lg p-6 w-full max-w-lg shadow-lg animate-fade-in-down space-y-4">
            {homeModalMode === 'active' ? (
              <>
                <h2 className="text-xl font-bold text-gray-900">Leave and return home?</h2>
                <p className="text-gray-700">
                  The current recording will be lost if you leave now. Are you sure you want to return home?
                </p>
                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => setShowHomeModal(false)}
                    className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      console.log('[Leave Button] Stopping camera and disconnecting agent...');
                      if (stream) {
                        stream.getTracks().forEach((track) => {
                          track.stop();
                          console.log('[Leave Button] Stopped track:', track.kind);
                        });
                      }
                      await disconnectFromLiveKit();
                      router.push('/home');
                    }}
                    className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                  >
                    Leave
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-xl font-bold text-gray-900">Save recording before leaving?</h2>
                <p className="text-gray-700">Would you like to save your recording before returning home?</p>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700" htmlFor="recording-title">
                    Recording title
                  </label>
                  <input
                    id="recording-title"
                    value={recordingTitle}
                    onChange={(e) => setRecordingTitle(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-medium text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="e.g. Lecture 1 - Intro"
                  />
                  {recordingTitleError && (
                    <p className="text-sm text-red-600">{recordingTitleError}</p>
                  )}
                </div>
                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => setShowHomeModal(false)}
                    className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      console.log('[Leave Without Saving] Stopping camera and disconnecting agent...');
                      if (stream) {
                        stream.getTracks().forEach((track) => {
                          track.stop();
                          console.log('[Leave Without Saving] Stopped track:', track.kind);
                        });
                      }
                      await disconnectFromLiveKit();
                      router.push('/home');
                    }}
                    className="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors"
                  >
                    Skip Saving
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!recordingTitle.trim()) {
                        setRecordingTitleError('Please enter a title before saving.');
                        return;
                      }
                      setRecordingTitleError('');
                      
                      // Save to Supabase
                      if (user?.id) {
                        const fullTranscript = transcripts.join(' ');
                        
                        // Create audio blob from chunks
                        let audioBlob: Blob | undefined;
                        console.log('[Save Button] Audio chunks count:', audioChunksRef.current.length);
                        if (audioChunksRef.current.length > 0) {
                          audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                          console.log('[Save Button] Audio blob created, size:', audioBlob.size, 'bytes');
                        } else {
                          console.warn('[Save Button] No audio chunks collected!');
                        }
                        
                        const result = await saveSession(
                          user.id,
                          recordingTitle,
                          fullTranscript,
                          nodes,
                          edges,
                          audioBlob
                        );
                        
                        if (!result.success) {
                          setRecordingTitleError(`Failed to save: ${result.error}`);
                          return;
                        }
                        
                        console.log('[RecordPage] Session saved with ID:', result.sessionId);
                      }
                      
                      // CRITICAL: Stop camera and disconnect agent before navigating away
                      console.log('[Save Button] Stopping camera and disconnecting agent...');
                      if (stream) {
                        stream.getTracks().forEach((track) => {
                          track.stop();
                          console.log('[Save Button] Stopped track:', track.kind);
                        });
                      }
                      await disconnectFromLiveKit();
                      
                      setShowHomeModal(false);
                      router.push('/home');
                    }}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Save & Return
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

        {transcriptModalMounted &&
          transcriptModal &&
          createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto overscroll-contain bg-background/80 p-4 backdrop-blur-sm animate-fade-in-scale"
              role="dialog"
              aria-modal="true"
              aria-labelledby="record-transcript-modal-title"
              onClick={() => setTranscriptModal(null)}
            >
              <div
                className="card my-auto flex max-h-[min(85dvh,85vh)] w-full max-w-2xl flex-col overflow-hidden shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex shrink-0 items-center justify-between gap-4 border-b border-surface-border bg-background-secondary px-6 py-4">
                  <h2 id="record-transcript-modal-title" className="text-lg font-display font-bold text-foreground">
                    {transcriptModal.title}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setTranscriptModal(null)}
                    className="rounded-xl px-4 py-2 text-sm font-semibold glass text-foreground-muted transition-colors hover:text-foreground"
                  >
                    Close
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
                  <p className="text-sm leading-relaxed text-foreground-muted break-words whitespace-pre-wrap">
                    {transcriptModal.body}
                  </p>
                </div>
              </div>
            </div>,
            document.body
          )}
    </div>
    </ProtectedRoute>
  );
}
