'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { LiveKitRoom, VideoTrack, AudioTrack } from '@livekit/components-react';

interface LiveKitCaptureProps {
  isActive: boolean;
  onConceptExtracted: (concept: any) => void;
}

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

export default function LiveKitCapture({ isActive, onConceptExtracted }: LiveKitCaptureProps) {
  const [token, setToken] = useState<string>('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>('');
  const [speechSupported, setSpeechSupported] = useState(false);
  const transcriptBufferRef = useRef<string>('');
  const processingTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleTranscript = useCallback(async (text: string) => {
    transcriptBufferRef.current += ' ' + text;

    if (!processingTimerRef.current) {
      processingTimerRef.current = setInterval(async () => {
        const currentTranscript = transcriptBufferRef.current.trim();

        if (currentTranscript.length > 50) {
          try {
            const response = await fetch('/api/process-transcript', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ transcript: currentTranscript }),
            });

            if (response.ok) {
              const { concepts } = await response.json();
              concepts.forEach((concept: unknown) => onConceptExtracted(concept));
              transcriptBufferRef.current = '';
            }
          } catch (err) {
            console.error('Error processing transcript:', err);
          }
        }
      }, 10000);
    }
  }, [onConceptExtracted]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as WindowWithSpeech;
    const ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    setSpeechSupported(typeof ctor !== 'undefined');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !isActive || !token) return;
    if (!(process.env.NEXT_PUBLIC_LIVEKIT_URL || '').trim()) return;

    const w = window as WindowWithSpeech;
    const ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!ctor) return;

    const rec = new ctor();
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
      if (t) void handleTranscript(t);
    };

    rec.onerror = (ev: { error: string }) => {
      console.warn('[SpeechRecognition]', ev.error);
    };

    try {
      rec.start();
    } catch (e) {
      console.warn('[SpeechRecognition] start failed', e);
    }

    return () => {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    };
  }, [isActive, token, handleTranscript]);

  useEffect(() => {
    if (isActive && !token) {
      fetchToken();
    }

    return () => {
      if (processingTimerRef.current) {
        clearInterval(processingTimerRef.current);
        processingTimerRef.current = null;
      }
    };
  }, [isActive, token]);

  const fetchToken = async () => {
    setConnecting(true);
    setError('');
    
    try {
      const response = await fetch('/api/livekit/token?room=lecture-room&username=presenter');
      
      if (!response.ok) {
        throw new Error('Failed to fetch token');
      }

      const data = await response.json();
      setToken(data.token);
    } catch (err) {
      setError('Failed to connect to LiveKit. Please check your configuration.');
      console.error('Token fetch error:', err);
    } finally {
      setConnecting(false);
    }
  };

  const simulateTranscript = () => {
    // Simulated transcript for demo purposes
    const sampleTranscripts = [
      'Today we will discuss React components',
      'Components are the building blocks of React applications',
      'There are two types: functional and class components',
      'State management is crucial in React',
      'Hooks allow us to use state in functional components'
    ];
    
    let index = 0;
    const interval = setInterval(() => {
      if (index < sampleTranscripts.length) {
        handleTranscript(sampleTranscripts[index]);
        index++;
      } else {
        clearInterval(interval);
      }
    }, 5000);

    return () => clearInterval(interval);
  };

  if (!isActive) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-100 rounded-lg">
        <div className="text-center">
          <div className="text-6xl mb-4">🎥</div>
          <p className="text-gray-600">Click &quot;Start Session&quot; to begin</p>
        </div>
      </div>
    );
  }

  if (connecting) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-100 rounded-lg">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Connecting to LiveKit...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-red-50 rounded-lg border border-red-200">
        <div className="text-center p-4">
          <div className="text-4xl mb-4">⚠️</div>
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={fetchToken}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Retry Connection
          </button>
          <div className="mt-4 text-sm text-gray-600">
            <p>For demo purposes, click below to simulate:</p>
            <button
              onClick={simulateTranscript}
              className="mt-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
            >
              Simulate Lecture Transcript
            </button>
          </div>
        </div>
      </div>
    );
  }

  const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || '';

  if (!livekitUrl || !token) {
    return (
      <div className="flex items-center justify-center h-full bg-yellow-50 rounded-lg border border-yellow-200">
        <div className="text-center p-4">
          <div className="text-4xl mb-4">⚙️</div>
          <p className="text-yellow-700 mb-2">LiveKit not configured</p>
          <p className="text-sm text-gray-600 mb-4">Configure your .env.local file to enable live capture</p>
          <button
            onClick={simulateTranscript}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
          >
            Simulate Lecture Transcript
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <LiveKitRoom
        serverUrl={livekitUrl}
        token={token}
        connect={true}
        audio={true}
        video={true}
        className="h-full"
      >
        <div className="grid grid-cols-1 gap-4 h-full">
          <div className="bg-black rounded-lg overflow-hidden">
            <VideoTrack />
          </div>
          <div className="bg-gray-800 rounded-lg p-2">
            <AudioTrack />
          </div>
        </div>
        <div className="mt-2 text-center space-y-1">
          <span className="inline-block bg-red-600 text-white px-3 py-1 rounded-full text-sm">
            🔴 Live
          </span>
          <p className="text-xs text-gray-500">
            {speechSupported
              ? 'Browser captions on — speech is sent for concept extraction every ~10s.'
              : 'Browser speech recognition not available — use “Simulate Lecture Transcript” or Chrome/Edge.'}
          </p>
        </div>
      </LiveKitRoom>
    </div>
  );
}
