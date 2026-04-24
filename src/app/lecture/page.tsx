'use client';

import { useState } from 'react';
import LiveKitCapture from '@/components/LiveKitCapture';
import MindMapVisualization from '@/components/MindMapVisualization';
import Link from 'next/link';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import type { ConceptPayload } from '@/lib/concept-types';

export default function LecturePage() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [conceptData, setConceptData] = useState<ConceptPayload[]>([]);

  const handleStartSession = () => {
    setIsSessionActive(true);
  };

  const handleStopSession = () => {
    setIsSessionActive(false);
  };

  const handleConceptExtracted = (concept: ConceptPayload) => {
    setConceptData((prev) => [...prev, concept]);
  };

  return (
    <ProtectedRoute>
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <Link href="/" className="text-2xl font-bold text-blue-600">
            Smart Sketch
          </Link>
          <div className="flex items-center gap-4">
            {!isSessionActive ? (
              <button
                onClick={handleStartSession}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors"
              >
                Start Session
              </button>
            ) : (
              <button
                onClick={handleStopSession}
                className="px-6 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 transition-colors"
              >
                Stop Session
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto p-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-[calc(100vh-100px)]">
          {/* Video/Audio Capture Panel */}
          <div className="bg-white rounded-lg shadow-md p-4">
            <h2 className="text-xl font-semibold mb-4 text-gray-800">
              Live Lecture Capture
            </h2>
            <LiveKitCapture
              isActive={isSessionActive}
              onConceptExtracted={handleConceptExtracted}
            />
          </div>

          {/* Mind Map Visualization Panel */}
          <div className="bg-white rounded-lg shadow-md p-4">
            <h2 className="text-xl font-semibold mb-4 text-gray-800">
              Visual Mind Map
            </h2>
            <MindMapVisualization concepts={conceptData} />
          </div>
        </div>
      </div>
    </div>
    </ProtectedRoute>
  );
}
