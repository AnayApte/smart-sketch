'use client';

import { useCallback, useEffect, useMemo } from 'react';
import ReactFlow, {
  Node,
  Edge,
  addEdge,
  Connection,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  MiniMap,
  BackgroundVariant,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { ConceptPayload } from '@/lib/concept-types';
import { buildMindMapLayout } from '@/lib/mind-map-layout';

interface MindMapVisualizationProps {
  concepts: ConceptPayload[];
}

export default function MindMapVisualization({ concepts }: MindMapVisualizationProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  const layoutData = useMemo(() => {
    if (!concepts || concepts.length === 0) {
      return { nodes: [], edges: [] };
    }
    return buildMindMapLayout(concepts, { mode: 'session-card' }, 'library');
  }, [concepts]);

  useEffect(() => {
    if (!concepts || concepts.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }

    setNodes(layoutData.nodes);
    setEdges(layoutData.edges);
  }, [concepts, layoutData, setNodes, setEdges]);

  if (!concepts || concepts.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-background rounded-lg border border-surface-border">
        <div className="text-center">
          <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-10 h-10 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
              />
            </svg>
          </div>
          <p className="text-foreground font-display font-semibold text-lg">Mind Map</p>
          <p className="text-foreground-muted text-sm mt-2 max-w-xs mx-auto">
            Concepts will appear here as the lecture progresses
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-background rounded-lg border border-surface-border overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodesDraggable={true}
        fitView
        attributionPosition="bottom-right"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.05)" />
        <Controls />
        <MiniMap
          nodeColor={(node) => {
            if (node.style?.background) {
              const bg = node.style.background as string;
              if (bg.includes('14b8a6')) return '#14b8a6';
              if (bg.includes('f59e0b')) return '#f59e0b';
              return '#1a1f2b';
            }
            return '#1a1f2b';
          }}
          maskColor="rgba(12, 15, 20, 0.8)"
          style={{ background: '#12161e', border: '1px solid rgba(255,255,255,0.08)' }}
        />
      </ReactFlow>
    </div>
  );
}
