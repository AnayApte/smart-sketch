'use client';

import { useEffect, useRef, useState, useCallback, type FormEvent } from 'react';
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

// Types for agent messages
interface ConceptData {
  id?: string;  // Unique ID from agent (e.g., "c1", "c2")
  label: string;
  type: 'main' | 'concept' | 'detail';
  explanation?: string;
  parent?: string | null;  // Parent concept ID, or null for main topics
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

export default function RecordPage() {
  const { user } = useAuth();
  const videoRef = useRef<HTMLVideoElement>(null);
  const roomRef = useRef<Room | null>(null);

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
  const chatMessagesRef = useRef<HTMLDivElement | null>(null);
  const [showHomeModal, setShowHomeModal] = useState(false);
  const [homeModalMode, setHomeModalMode] = useState<'active' | 'ended'>('active');
  const [recordingTitle, setRecordingTitle] = useState('');
  const [recordingTitleError, setRecordingTitleError] = useState('');

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

  const router = useRouter();

  // React Flow nodes and edges - will be updated by agent
  const [nodes, setNodes] = useState<Node[]>([
    {
      id: 'center',
      data: { label: 'Lecture' },
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
    },
  ]);

  const [edges, setEdges] = useState<Edge[]>([]);

  // Track node positions by ID for parent-child positioning
  const nodePositionsRef = useRef<Map<string, { x: number; y: number; childCount: number }>>(
    new Map([['center', { x: 250, y: 200, childCount: 0 }]])
  );
  const nodeCounterRef = useRef(0);

  // Add multiple concepts to the mind map with proper hierarchy
  const addConceptsToMap = useCallback((concepts: ConceptData[]) => {
    // Colors based on concept type
    const colors = {
      main: { bg: 'linear-gradient(135deg, #14b8a6 0%, #0d9488 100%)', border: '#0d9488', text: '#0c0f14' },
      concept: { bg: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', border: '#d97706', text: '#0c0f14' },
      detail: { bg: 'linear-gradient(135deg, #1a1f2b 0%, #12161e 100%)', border: 'rgba(255,255,255,0.1)', text: '#f0f2f5' },
    };

    const newNodes: Node[] = [];
    const newEdges: Edge[] = [];

    // Build map of existing nodes by label for deduplication
    const existingNodesByLabel = new Map<string, string>();
    setNodes((prevNodes) => {
      prevNodes.forEach((node) => {
        if (node.id !== 'center') {
          // Extract label from node data
          const nodeLabel = typeof node.data.label === 'string' ? node.data.label : node.data.label?.props?.children?.[0]?.props?.children || '';
          if (nodeLabel) {
            existingNodesByLabel.set(nodeLabel, node.id);
          }
        }
      });
      return prevNodes;
    });

    // Map of original concept IDs to canonical (deduplicated) IDs
    const conceptIdMapping = new Map<string, string>();

    // Sort concepts: main topics first, then concepts, then details
    // This ensures parents are created before children
    const sortedConcepts = [...concepts].sort((a, b) => {
      const order = { main: 0, concept: 1, detail: 2 };
      return order[a.type] - order[b.type];
    });

    sortedConcepts.forEach((concept) => {
      const agentId = concept.id || `concept-${nodeCounterRef.current}`;

      // Check if a similar concept already exists
      const similarNodeId = findSimilarConcept(
        concept.label,
        Array.from(existingNodesByLabel.entries()).map(([label, id]) => ({ id, label })),
        0.75 // 75% similarity threshold
      );

      if (similarNodeId) {
        // Map this concept to the existing similar one
        conceptIdMapping.set(agentId, similarNodeId);
        console.log(`[DEDUP] Merged "${concept.label}" with existing "${similarNodeId}"`);
        return;
      }

      // Check if we already have this exact node ID
      if (nodePositionsRef.current.has(agentId) || similarNodeId) {
        console.log(`[DEDUP] Skipped duplicate: ${agentId}`);
        return;
      }

      nodeCounterRef.current += 1;
      const nodeId = agentId;

      // Map new concept ID
      conceptIdMapping.set(agentId, nodeId);

      // Determine parent node ID (use mapped ID if parent was deduplicated)
      let parentId = 'center';
      if (concept.parent) {
        parentId = conceptIdMapping.get(concept.parent) || concept.parent;
      } else if (concept.type === 'main') {
        parentId = 'center';
      }

      // Get parent position
      const parentPos = nodePositionsRef.current.get(parentId) || { x: 250, y: 200, childCount: 0 };

      // Calculate position based on parent and hierarchy level
      let x: number, y: number;
      const childIndex = parentPos.childCount;

      if (concept.type === 'main') {
        // Main topics spread horizontally from center
        const angle = (childIndex * Math.PI / 3) - Math.PI / 2; // Start from top
        const radius = 180;
        x = parentPos.x + radius * Math.cos(angle);
        y = parentPos.y + radius * Math.sin(angle);
      } else if (concept.type === 'concept') {
        // Concepts branch outward from their parent
        const baseAngle = Math.atan2(parentPos.y - 200, parentPos.x - 250);
        const spread = Math.PI / 4; // 45 degree spread
        const angle = baseAngle + (childIndex - parentPos.childCount / 2) * spread;
        const radius = 140;
        x = parentPos.x + radius * Math.cos(angle);
        y = parentPos.y + radius * Math.sin(angle);
      } else {
        // Details branch from their parent concept
        const baseAngle = Math.atan2(parentPos.y - 200, parentPos.x - 250);
        const spread = Math.PI / 5;
        const angle = baseAngle + (childIndex - 0.5) * spread;
        const radius = 100;
        x = parentPos.x + radius * Math.cos(angle);
        y = parentPos.y + radius * Math.sin(angle);
      }

      // Update parent's child count
      parentPos.childCount++;

      // Store this node's position
      nodePositionsRef.current.set(nodeId, { x, y, childCount: 0 });

      const color = colors[concept.type] || colors.concept;

      // Create node with explanation in data
      newNodes.push({
        id: nodeId,
        data: {
          label: (
            <div className="text-center">
              <div className="font-semibold">{concept.label}</div>
              {concept.explanation && (
                <div className="text-xs opacity-75 mt-1 line-clamp-2">{concept.explanation}</div>
              )}
            </div>
          ),
        },
        position: { x, y },
        draggable: true,
        style: {
          background: color.bg,
          color: color.text,
          border: `1px solid ${color.border}`,
          borderRadius: concept.type === 'main' ? '16px' : '12px',
          padding: concept.type === 'main' ? '14px 20px' : '10px 14px',
          fontSize: concept.type === 'main' ? '14px' : '12px',
          fontWeight: concept.type === 'main' ? '600' : '500',
          maxWidth: concept.type === 'detail' ? '120px' : '160px',
          boxShadow: concept.type === 'main'
            ? '0 0 30px rgba(20, 184, 166, 0.3)'
            : '0 4px 20px rgba(0, 0, 0, 0.3)',
          cursor: 'grab',
        },
      });

      // Create edge to parent
      const edgeColor = concept.type === 'main' ? '#14b8a6' : concept.type === 'concept' ? '#f59e0b' : '#4b5563';
      newEdges.push({
        id: `edge-${nodeId}`,
        source: parentId,
        target: nodeId,
        type: 'smoothstep',
        animated: concept.type === 'main',
        style: { stroke: edgeColor, strokeWidth: concept.type === 'main' ? 2 : 1.5 },
      });
    });

    if (newNodes.length > 0) {
      setNodes((prev) => [...prev, ...newNodes]);
      setEdges((prev) => [...prev, ...newEdges]);
    }
  }, []);

  // Handle messages from the agent
  const handleAgentMessage = useCallback((message: AgentMessage) => {
    console.log('[AGENT MESSAGE]', message);

    switch (message.type) {
      case 'agent_ready':
        setAgentReady(true);
        console.log('Agent is ready and listening!');
        break;

      case 'concepts':
        if (message.data.concepts && message.data.concepts.length > 0) {
          // Add all concepts at once to properly handle parent-child relationships
          addConceptsToMap(message.data.concepts);
        }
        if (message.data.transcript) {
          setTranscripts((prev) => [...prev, message.data.transcript!]);
        }
        break;

      case 'transcript':
        if (message.data.transcript) {
          setTranscripts((prev) => [...prev, message.data.transcript!]);
        }
        break;
    }
  }, [addConceptsToMap]);

  // Connect to LiveKit room (without publishing tracks)
  const connectToLiveKit = useCallback(async () => {
    console.log('[LiveKit] Starting connection process...');
    
    // If already connected, don't reconnect
    if (roomRef.current && roomRef.current.state === ConnectionState.Connected) {
      console.log('[LiveKit] Already connected, skipping connection');
      setAgentReady(true);
      return;
    }
    
    // Cleanup any existing connection first
    if (roomRef.current) {
      console.log('[LiveKit] Cleaning up existing connection...');
      try {
        await roomRef.current.disconnect();
      } catch (e) {
        console.log('[LiveKit] Error disconnecting existing room:', e);
      }
      roomRef.current = null;
    }
    
    try {
      // Fetch token from our API with unique room name
      const roomName = `smartsketch-${sessionIdRef.current}`;
      const username = user?.id ? `student-${user.id.slice(0, 8)}` : `student-${Date.now()}`;
      console.log('[LiveKit] Fetching token for room:', roomName, 'user:', username);
      const response = await authFetch(
        `/api/livekit/token?room=${encodeURIComponent(roomName)}&username=${encodeURIComponent(username)}`
      );
      console.log('[LiveKit] API response status:', response.status, response.statusText);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[LiveKit] API error response:', errorText);
        throw new Error(`Failed to fetch LiveKit token: ${response.status} ${errorText}`);
      }
      
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
            // If we receive any message from agent, it's ready
            console.log('[LiveKit] Agent is ready (received data message)');
            setAgentReady(true);
            handleAgentMessage(message);
          } catch (e) {
            console.error('[LiveKit] Failed to parse agent message:', e);
          }
        } else {
          console.log('[LiveKit] Data received on unexpected topic:', topic, '(expected: smartsketch)');
        }
      });

      // Connect to room (but don't publish tracks yet)
      console.log('[LiveKit] Connecting to room...');
      await room.connect(livekitUrl, token, {
        autoSubscribe: true,
      });
      console.log('[LiveKit] ✅ Connected to LiveKit room:', room.name);
      setLiveKitConnected(true);
      console.log('[LiveKit] State updated - liveKitConnected set to true');

      // Listen for participant joined events (to detect when agent joins)
      room.on(RoomEvent.ParticipantConnected, (participant) => {
        console.log('[LiveKit] Participant connected:', participant.identity);
        if (participant.identity?.includes('agent')) {
          console.log('[LiveKit] Agent participant detected, setting agentReady to true');
          setAgentReady(true);
        }
      });

      // Listen for disconnection events to properly update state
      room.on(RoomEvent.Disconnected, (reason) => {
        console.log('[LiveKit] Room disconnected, reason:', reason);
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
        if (participant.identity?.includes('agent')) {
          console.warn('[LiveKit] Agent disconnected!');
          setAgentReady(false);
        }
      });

      room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        console.log('[LiveKit] Connection quality changed:', quality, 'for', participant.identity);
      });

    } catch (error) {
      console.error('[LiveKit] ❌ Connection error:', error);
      setLiveKitConnected(false);
      setAgentReady(false);
      setAllowStartWithoutAgent(true);
    }
  }, [handleAgentMessage]);

  // Store cloned tracks for LiveKit (so we don't lose the original stream when LiveKit unpublishes)
  const clonedTracksRef = useRef<MediaStreamTrack[]>([]);

  // Publish tracks to LiveKit (called when recording starts)
  // Returns true if successful, false if failed
  const publishTracksToLiveKit = useCallback(async (mediaStream: MediaStream): Promise<boolean> => {
    console.log('[Publish] Starting track publication...');

    // Helper to check if room is connected (avoids TypeScript narrowing issues)
    const isConnected = () => roomRef.current?.state === ConnectionState.Connected;

    // If room doesn't exist or is disconnected, try to reconnect
    if (!roomRef.current || !isConnected()) {
      console.log('[Publish] Room not connected, attempting to reconnect...');

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
      return false;
    }
  }, [connectToLiveKit]);

  // Disconnect from LiveKit
  const disconnectFromLiveKit = useCallback(async () => {
    console.log('[LiveKit] Disconnecting from room...');

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
    }
  }, []);

  useEffect(() => {
    const requestPermissions = async () => {
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
      if (stream) {
        stream.getTracks().forEach((track) => {
          track.stop();
          console.log('[Cleanup] Stopped track:', track.kind);
        });
      }
      disconnectFromLiveKit();
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
      console.log('[Connection] Initiating LiveKit connection...');
      connectToLiveKit();
    }
  }, [stream, liveKitConnected, connectToLiveKit]);

  // If LiveKit is on but the agent never signals ready, allow starting (local audio + mind map without agent).
  useEffect(() => {
    if (!isLiveKitConfigured() || !liveKitConnected || agentReady) {
      setAllowStartWithoutAgent(false);
      return;
    }
    const id = window.setTimeout(() => {
      console.warn('[LiveKit] Agent not ready after 25s; allowing recording without agent.');
      setAllowStartWithoutAgent(true);
    }, 25000);
    return () => clearTimeout(id);
  }, [liveKitConnected, agentReady]);

  const canStartRecording = agentReady || allowStartWithoutAgent || !isLiveKitConfigured();

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
          let errDetails = 'Gemini request failed';
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
        console.error('Gemini chat error:', message);
        const friendly = message.includes('Missing GEMINI_API_KEY')
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
    if (stream) {
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
      setNodes([{
        id: 'center',
        data: { label: 'Lecture' },
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
      }]);
      setEdges([]);
      nodeCounterRef.current = 0;
      nodePositionsRef.current = new Map([['center', { x: 250, y: 200, childCount: 0 }]]);
      setTranscripts([]);

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
      <div className="relative z-10 w-full min-h-screen bg-transparent overflow-hidden">
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
                  {agentReady ? 'Agent Connected' : 'Connecting...'}
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
        <div className="flex h-screen w-full">
          {/* LEFT SIDE - Recording Interface */}
          <div className={`flex flex-col items-center justify-center px-4 pt-20 transition-all duration-500 ${showFlowBoard ? 'w-1/2' : 'w-full'}`}>
            {showChat ? (
              <div className="w-full max-w-2xl space-y-6 animate-fade-in-up">
                <div className="text-center">
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
                      setNodes([{
                        id: 'center',
                        data: { label: 'Lecture' },
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
                      }]);
                      setEdges([]);
                      nodeCounterRef.current = 0;
                      nodePositionsRef.current = new Map([['center', { x: 250, y: 200, childCount: 0 }]]);
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

                {/* Transcripts preview */}
                {transcripts.length > 0 && (
                  <div className="rounded-xl bg-primary/5 border border-primary/10 p-4 max-h-32 overflow-y-auto custom-scrollbar">
                    <h3 className="text-xs font-semibold text-primary mb-2 uppercase tracking-wider">Session Transcript</h3>
                    <p className="text-sm text-foreground-muted">{transcripts.join(' ')}</p>
                  </div>
                )}

                {/* Chat container */}
                <div className="card h-[60vh] flex flex-col">
                  <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 custom-scrollbar">
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
                          {msg.content}
                        </div>
                      </div>
                    ))}
                  </div>
                  <form className="border-t border-surface-border p-4 flex gap-3" onSubmit={handleChatSubmit}>
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
                <div className="flex justify-center gap-4">
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
                          Connecting to AI...
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
                    : canStartRecording
                      ? agentReady
                        ? 'AI agent ready. Click Start Recording to begin.'
                        : 'Starting without agent: you can record locally; the mind map may not update until the agent is running.'
                      : liveKitConnected
                        ? 'Waiting for the Python agent… If it does not connect, Start will unlock automatically.'
                        : 'Connecting to LiveKit...'}
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
            className={`transition-all duration-700 ease-out overflow-hidden flex items-center justify-center ${
              showFlowBoard ? 'w-1/2 opacity-100' : 'w-0 opacity-0'
            }`}
          >
            {showFlowBoard && (
              <div className="w-full h-full flex items-center justify-center p-6">
                <div className="w-full h-full card overflow-hidden flex flex-col">
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
                                ? 'Waiting for agent...'
                                : 'Connect LiveKit to see real-time concepts'}
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
                  {/* Live transcript preview */}
                  {transcripts.length > 0 && (
                    <div className="px-4 py-3 border-t border-surface-border bg-background-secondary max-h-24 overflow-y-auto custom-scrollbar">
                      <p className="text-xs text-foreground-muted font-medium mb-1 uppercase tracking-wider">Latest transcript</p>
                      <p className="text-sm text-foreground">{transcripts[transcripts.length - 1]}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Post-Recording Chat Section */}
          {recordingEnded && (
            <div className="w-full h-full card overflow-hidden flex flex-col opacity-0 animate-fade-in-up [animation-delay:0.2s] [animation-fill-mode:forwards]">
              <div className="px-6 py-4 border-b border-surface-border bg-background-secondary">
                <h2 className="text-lg font-display font-bold text-foreground">Sketch Discussion</h2>
                <p className="text-xs text-foreground-muted mt-1">Ask questions about your recording</p>
              </div>

              {/* Messages */}
              <div
                ref={chatMessagesRef}
                className="flex-1 overflow-y-auto custom-scrollbar px-4 py-3 space-y-3"
              >
                {chatMessages.length === 0 && (
                  <div className="text-xs text-foreground-muted text-center py-8">No messages yet. Start the conversation.</div>
                )}
                {chatMessages.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[75%] rounded-xl px-4 py-2.5 text-sm opacity-0 animate-fade-in-up [animation-fill-mode:forwards] ${
                        msg.role === 'user'
                          ? 'bg-gradient-to-r from-primary to-primary-dark text-background'
                          : 'bg-background-secondary text-foreground border border-surface-border'
                      }`}
                      style={{ animationDelay: `${idx * 50}ms` }}
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
                      Gemini is thinking...
                    </div>
                  </div>
                )}
              </div>

              {/* Input Form */}
              <div className="border-t border-surface-border p-4 bg-background-secondary">
                <form className="flex gap-3" onSubmit={handleChatSubmit}>
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    className="flex-1 px-4 py-2.5 rounded-xl input-field text-sm"
                    placeholder="Ask about this recording..."
                    disabled={isChatSending}
                  />
                  <button
                    type="submit"
                    className="px-5 py-2.5 rounded-xl btn-primary text-sm font-medium disabled:opacity-70 disabled:cursor-not-allowed"
                    disabled={isChatSending}
                  >
                    Send
                  </button>
                </form>
              </div>
            </div>
          )}
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
    </div>
    </ProtectedRoute>
  );
}
