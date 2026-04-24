'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import ReactFlow, { Node, Edge, Controls, Background } from 'reactflow';
import 'reactflow/dist/style.css';
import ReactMarkdown from 'react-markdown';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import NeuralNetworkBackground from '@/components/NeuralNetworkBackground';
import { getSession, SavedSession } from '@/lib/sessions-service';
import { authFetch } from '@/lib/auth-fetch';

export default function SessionPage() {
  const router = useRouter();
  const params = useParams();
  const sessionId = params.id as string;

  const [session, setSession] = useState<SavedSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([
    {
      role: 'assistant',
      content: 'Ask me anything about this session. I can help you understand the concepts and answer questions about the transcript.'
    }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Load session data
  useEffect(() => {
    async function loadSession() {
      setLoading(true);
      const data = await getSession(sessionId);
      if (data) {
        setSession(data);
        
        // Set nodes and edges from saved data
        if (Array.isArray(data.mind_map_nodes)) {
          setNodes(data.mind_map_nodes);
        }
        if (Array.isArray(data.mind_map_edges)) {
          setEdges(data.mind_map_edges);
        }
      }
      setLoading(false);
    }

    if (sessionId) {
      loadSession();
    }
  }, [sessionId]);

  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = chatInput.trim();
    if (!value) return;

    // Ensure we have session context (TypeScript: avoid possibly null)
    if (!session) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'No session context available yet. Please refresh and try again.' },
      ]);
      return;
    }

    // Add user message
    const newMessages = [
      ...chatMessages,
      { role: 'user' as const, content: value },
    ];
    setChatMessages(newMessages);
    setChatInput('');
    setIsSending(true);

    try {
      const { title, transcript } = session;
      const res = await authFetch('/api/gemini-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          transcript,
          title,
        })
      });

      if (!res.ok) {
        let errDetails = 'Chat request failed';
        try {
          const errJson = await res.json();
          errDetails = errJson?.details || errJson?.error || errDetails;
        } catch {}
        throw new Error(errDetails);
      }

      const data = await res.json();
      const reply = data.reply || 'I had trouble generating a response. Please try again.';

      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: reply },
      ]);
    } catch (error) {
      const message = (error as any)?.message || 'Unknown error';
      console.error('Sketch chat client error:', message);
      const friendly =
        message.includes('Gemini API key') || message.includes('not configured')
          ? 'Gemini API key is missing. Add GEMINI_API_KEY to .env.local and restart the dev server.'
          : `Sorry, I ran into an issue: ${message}`;
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: friendly },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  // Auto-scroll chat to the latest message
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [chatMessages]);

  // Format date helper
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  if (loading) {
    return (
      <ProtectedRoute>
        <NeuralNetworkBackground />
        <div className="relative z-10 w-full min-h-screen bg-transparent flex items-center justify-center">
          <div className="text-center">
            <div className="w-12 h-12 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
            <p className="text-foreground-muted">Loading session...</p>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  if (!session) {
    return (
      <ProtectedRoute>
        <NeuralNetworkBackground />
        <div className="relative z-10 w-full min-h-screen bg-transparent flex items-center justify-center">
          <div className="text-center">
            <p className="text-foreground-muted mb-4">Session not found</p>
            <Link href="/library" className="text-primary hover:text-primary-dark">
              Back to Library
            </Link>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  return (
    <ProtectedRoute>
      <NeuralNetworkBackground />
      <div className="relative z-10 w-full min-h-screen bg-transparent overflow-hidden animate-fade-in-down">
        {/* Header */}
        <header className="absolute top-0 left-0 right-0 z-20 px-6 py-6 opacity-0 animate-fade-in-down [animation-delay:0.1s] [animation-fill-mode:forwards]">
          <div className="flex items-center gap-4">
            <Link
              href="/library"
              className="px-4 py-2 rounded-xl glass text-foreground-muted hover:text-foreground transition-all duration-300 text-sm font-medium flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </Link>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-display font-bold text-foreground mt-0.5">{session.title}</h1>
              <p className="text-sm font-light text-foreground-muted mt-2">{formatDate(session.created_at)}</p>
            </div>
          </div>
        </header>

        {/* Main Layout */}
        <div className="flex h-screen w-full pt-20">
          {/* LEFT SIDE - Transcript (1/3) and Chat (2/3) */}
          <div className="w-1/2 flex flex-col gap-6 p-6 overflow-hidden">
            {/* Transcript Section - Top Third */}
            <div className="h-1/3 card overflow-hidden flex flex-col opacity-0 animate-fade-in-up [animation-delay:0.2s] [animation-fill-mode:forwards]">
              <div className="px-6 py-4 border-b border-surface-border bg-background-secondary">
                <h2 className="text-sm font-display font-bold text-foreground uppercase tracking-wider">Session Transcript</h2>
                <p className="text-xs text-foreground-muted mt-1">Full session text</p>
              </div>
              <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
                <p className="text-sm text-foreground-muted leading-relaxed whitespace-pre-wrap break-words">
                  {session.transcript || 'No transcript available'}
                </p>
              </div>
            </div>

            {/* Chat Section - Bottom 2/3 */}
            <div className="h-2/3 card flex flex-col overflow-hidden opacity-0 animate-fade-in-up [animation-delay:0.3s] [animation-fill-mode:forwards]">
              <div className="px-6 py-4 border-b border-surface-border bg-background-secondary">
                <h2 className="text-sm font-display font-bold text-foreground uppercase tracking-wider">Session Chat</h2>
                <p className="text-xs text-foreground-muted mt-1">Ask questions about this session</p>
              </div>

              {/* Messages */}
              <div
                ref={messagesContainerRef}
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
                {isSending && (
                  <div className="flex justify-start">
                    <div className="max-w-[75%] rounded-xl px-4 py-2.5 text-sm bg-background-secondary text-foreground border border-surface-border opacity-80 animate-pulse">
                      Assistant is thinking...
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
                    placeholder="Ask about this session..."
                    disabled={isSending}
                  />
                  <button
                    type="submit"
                    className="px-5 py-2.5 rounded-xl btn-primary text-sm font-medium disabled:opacity-70 disabled:cursor-not-allowed"
                    disabled={isSending}
                  >
                    Send
                  </button>
                </form>
              </div>
            </div>
          </div>

          {/* RIGHT SIDE - Mind Map */}
          <div className="w-1/2 flex flex-col p-6 overflow-hidden opacity-0 animate-fade-in-down [animation-delay:0.2s] [animation-fill-mode:forwards]">
            <div className="flex-1 card overflow-hidden flex flex-col">
              <div className="px-6 py-4 border-b border-surface-border bg-background-secondary">
                <h2 className="text-sm font-display font-bold text-foreground uppercase tracking-wider">Concept Sketch</h2>
                <p className="text-xs text-foreground-muted mt-1">
                  Concepts captured from this session
                </p>
              </div>
              
              <div className="flex-1 overflow-hidden relative">
                {nodes.length > 0 ? (
                  <ReactFlow 
                    nodes={nodes} 
                    edges={edges}
                    fitView
                  >
                    <Background />
                    <Controls />
                  </ReactFlow>
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <p className="text-foreground-muted">No mind map available</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
