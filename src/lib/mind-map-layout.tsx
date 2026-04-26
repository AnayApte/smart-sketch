'use client';

import type { ReactNode } from 'react';
import type { Node, Edge } from 'reactflow';
import type { ConceptPayload } from '@/lib/concept-types';
import { cleanMindMapNode } from '@/lib/mind-map-node-clean';

export const MAP_ROOT_ID = '__map_root__';

export type MindMapLayoutRoot =
  | { mode: 'session-card' }
  | {
      mode: 'external-root';
      rootId: string;
      /** Lecture node is top-left (x,y) with height; topics align under its visual center. */
      lectureAnchor: { x: number; y: number; height: number; gapAfter: number };
    };

export type MindMapEdgeVariant = 'library' | 'record';

function estimateNodeWidth(concept: ConceptPayload): number {
  const labelLength = concept.label.length;
  if (concept.type === 'main') {
    return Math.max(120, Math.min(200, labelLength * 8 + 40));
  }
  if (concept.type === 'concept') {
    return Math.max(100, Math.min(180, labelLength * 7 + 30));
  }
  return Math.max(80, Math.min(160, labelLength * 6 + 25));
}

function sortChildIds(childIds: string[], concepts: ConceptPayload[]): string[] {
  return [...childIds].sort((a, b) => {
    const la = concepts.find((c) => (c.id || c.label) === a)?.label ?? '';
    const lb = concepts.find((c) => (c.id || c.label) === b)?.label ?? '';
    return la.localeCompare(lb, undefined, { sensitivity: 'base' });
  });
}

function getNodeStyle(type: string): Record<string, string | number> {
  switch (type) {
    case 'main':
      return {
        background: 'linear-gradient(135deg, #14b8a6 0%, #0d9488 100%)',
        color: '#0c0f14',
        border: 'none',
        borderRadius: '12px',
        padding: '12px 24px',
        fontSize: '16px',
        fontWeight: 'bold',
        boxShadow: '0 0 30px rgba(20, 184, 166, 0.3)',
      };
    case 'concept':
      return {
        background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
        color: '#0c0f14',
        border: 'none',
        borderRadius: '10px',
        padding: '10px 18px',
        fontSize: '14px',
        fontWeight: '600',
        boxShadow: '0 4px 20px rgba(245, 158, 11, 0.25)',
      };
    default:
      return {
        background: '#1a1f2b',
        color: '#f0f2f5',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: '8px',
        padding: '8px 14px',
        fontSize: '12px',
        fontWeight: '500',
        boxShadow: '0 4px 15px rgba(0, 0, 0, 0.2)',
      };
  }
}

function recordEdgeStyle(targetType: ConceptPayload['type']): {
  stroke: string;
  strokeWidth: number;
  animated: boolean;
} {
  if (targetType === 'main') {
    return { stroke: '#14b8a6', strokeWidth: 2, animated: true };
  }
  if (targetType === 'concept') {
    return { stroke: '#f59e0b', strokeWidth: 1.5, animated: false };
  }
  return { stroke: '#4b5563', strokeWidth: 1.5, animated: false };
}

function translateNodes(nodes: Node[], tx: number, ty: number): Node[] {
  return nodes.map((n) => ({
    ...n,
    position: { x: n.position.x + tx, y: n.position.y + ty },
  }));
}

/**
 * Hierarchical tree layout for concept mind maps (used by library preview and live record).
 */
export function buildMindMapLayout(
  concepts: ConceptPayload[],
  layoutRoot: MindMapLayoutRoot,
  edgeVariant: MindMapEdgeVariant = 'library'
): { nodes: Node[]; edges: Edge[] } {
  if (!concepts || concepts.length === 0) {
    return { nodes: [], edges: [] };
  }

  const newNodes: Node[] = [];
  const newEdges: Edge[] = [];
  const childrenByParent = new Map<string, string[]>();
  const widthCache = new Map<string, number>();

  concepts.forEach((concept) => {
    const nodeId = concept.id || concept.label;
    const parentKey =
      concept.parent && String(concept.parent).trim() ? String(concept.parent).trim() : 'root';
    if (!childrenByParent.has(parentKey)) {
      childrenByParent.set(parentKey, []);
    }
    childrenByParent.get(parentKey)!.push(nodeId);
  });

  childrenByParent.forEach((ids, key) => {
    childrenByParent.set(key, sortChildIds(ids, concepts));
  });

  const rootChildren = childrenByParent.get('root') || [];
  const rootPos = { x: 320, y: 24 };
  const rootGap = Math.max(220, Math.min(460, 220 + rootChildren.length * 28));
  const rootStartX = rootPos.x - ((Math.max(rootChildren.length, 1) - 1) * rootGap) / 2;
  const externalRoot = layoutRoot.mode === 'external-root' ? layoutRoot.rootId : null;

  if (layoutRoot.mode === 'session-card' && rootChildren.length > 0) {
    newNodes.push({
      id: MAP_ROOT_ID,
      type: 'default',
      position: rootPos,
      draggable: true,
      data: {
        plainLabel: 'Session',
        label: (
          <div>
            <div className="font-semibold text-sm">Session</div>
            <div className="text-xs opacity-70">Topics</div>
          </div>
        ) as ReactNode,
      },
      style: {
        background: 'linear-gradient(135deg, #1a1f2b 0%, #12161e 100%)',
        color: '#f0f2f5',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '12px',
        padding: '10px 16px',
        fontSize: '12px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25)',
        cursor: 'grab',
      },
    });
  }

  const calculateSubtreeWidth = (nodeId: string | null): number => {
    const key = nodeId || 'root';
    if (widthCache.has(key)) {
      return widthCache.get(key)!;
    }
    const children = childrenByParent.get(key) || [];
    let width: number;
    if (children.length === 0) {
      const concept = concepts.find((c) => (c.id || c.label) === nodeId);
      width = concept ? estimateNodeWidth(concept) + 80 : 120;
    } else {
      let totalWidth = 0;
      children.forEach((childId) => {
        totalWidth += calculateSubtreeWidth(childId) + 40;
      });
      width = Math.max(totalWidth, 150);
    }
    widthCache.set(key, width);
    return width;
  };

  const rootAnchor =
    layoutRoot.mode === 'session-card' && rootChildren.length > 0
      ? { x: rootPos.x + 40, y: rootPos.y + 50 }
      : null;

  const positionNodes = (
    parentId: string | null,
    level: number,
    parentPos: { x: number; y: number } | null,
    leftBound: number
  ): number => {
    const key = parentId || 'root';
    const children = childrenByParent.get(key) || [];
    if (children.length === 0) return leftBound;

    let currentX = leftBound;
    const verticalGap = 130 + level * 35;
    const siblingGap = 40 + level * 20;

    children.forEach((childId, childIndex) => {
      const concept = concepts.find((c) => (c.id || c.label) === childId);
      if (!concept) return;
      const cleanedText = cleanMindMapNode({
        title: concept.label,
        description: concept.explanation,
      });

      const subtreeWidth = calculateSubtreeWidth(childId);
      let position = { x: 0, y: 0 };

      if (level === 0) {
        position = {
          x: rootStartX + childIndex * rootGap,
          y: rootChildren.length > 0 && layoutRoot.mode === 'session-card' ? 128 : 36,
        };
        currentX = position.x + subtreeWidth / 2;
      } else if (parentPos) {
        const subtreeCenter = currentX + subtreeWidth / 2;
        position = {
          x: subtreeCenter,
          y: parentPos.y + verticalGap,
        };
        currentX += subtreeWidth + siblingGap;
      }

      const labelEl = (
        <div className={edgeVariant === 'record' ? 'text-center' : undefined}>
          <div className="font-semibold">{cleanedText.title}</div>
          {cleanedText.description && (
            <div className={`text-xs mt-1 opacity-75 ${edgeVariant === 'record' ? 'line-clamp-2' : ''}`}>
              {cleanedText.description}
            </div>
          )}
        </div>
      );

      const recordExtras =
        edgeVariant === 'record'
          ? {
              borderRadius: concept.type === 'main' ? '16px' : '12px',
              padding: concept.type === 'main' ? '14px 20px' : '10px 14px',
              fontSize: concept.type === 'main' ? '14px' : '12px',
              fontWeight: concept.type === 'main' ? '600' : '500',
              maxWidth: concept.type === 'detail' ? '120px' : '160px',
              boxShadow:
                concept.type === 'main'
                  ? '0 0 30px rgba(20, 184, 166, 0.3)'
                  : '0 4px 20px rgba(0, 0, 0, 0.3)',
            }
          : {};

      newNodes.push({
        id: childId,
        type: 'default',
        position,
        draggable: true,
        data: {
          plainLabel: cleanedText.title,
          label: labelEl as ReactNode,
        },
        style: {
          ...getNodeStyle(concept.type),
          ...recordExtras,
          cursor: 'grab',
        },
      });

      const underRoot = key === 'root';
      if (underRoot && layoutRoot.mode === 'session-card' && rootAnchor) {
        const libStyle = { stroke: '#14b8a6', strokeWidth: 2 };
        newEdges.push({
          id: `edge-${MAP_ROOT_ID}-${childId}`,
          source: MAP_ROOT_ID,
          target: childId,
          type: 'smoothstep',
          animated: true,
          style: libStyle,
        });
      } else if (underRoot && externalRoot) {
        const rs = recordEdgeStyle(concept.type);
        newEdges.push({
          id: `edge-${externalRoot}-${childId}`,
          source: externalRoot,
          target: childId,
          type: 'smoothstep',
          animated: rs.animated,
          style: { stroke: rs.stroke, strokeWidth: rs.strokeWidth },
        });
      } else if (concept.parent && parentPos) {
        const parentSource = String(concept.parent).trim();
        if (edgeVariant === 'record') {
          const rs = recordEdgeStyle(concept.type);
          newEdges.push({
            id: `edge-${parentSource}-${childId}`,
            source: parentSource,
            target: childId,
            type: 'smoothstep',
            animated: rs.animated,
            style: { stroke: rs.stroke, strokeWidth: rs.strokeWidth },
          });
        } else {
          newEdges.push({
            id: `edge-${parentSource}-${childId}`,
            source: parentSource,
            target: childId,
            type: 'smoothstep',
            animated: true,
            style: { stroke: '#14b8a6', strokeWidth: 2 },
          });
        }
      }

      const nextLeftBound = level === 0 ? position.x - subtreeWidth / 2 : currentX - subtreeWidth;
      positionNodes(childId, level + 1, position, nextLeftBound);
    });

    return currentX;
  };

  positionNodes(null, 0, null, 0);

  if (layoutRoot.mode === 'external-root') {
    const { lectureAnchor } = layoutRoot;
    const rootIds = childrenByParent.get('root') || [];
    if (rootIds.length > 0) {
      const rootPositions = rootIds
        .map((id) => newNodes.find((n) => n.id === id)?.position)
        .filter((p): p is { x: number; y: number } => !!p);
      if (rootPositions.length > 0) {
        const meanX = rootPositions.reduce((s, p) => s + p.x, 0) / rootPositions.length;
        const minRootY = Math.min(...rootPositions.map((p) => p.y));
        const lectureCenterX = lectureAnchor.x + 50;
        const topicRowY = lectureAnchor.y + lectureAnchor.height + lectureAnchor.gapAfter;
        const tx = lectureCenterX - meanX;
        const ty = topicRowY - minRootY;
        const shifted = translateNodes(newNodes, tx, ty);
        newNodes.length = 0;
        newNodes.push(...shifted);
      }
    }
  }

  return { nodes: newNodes, edges: newEdges };
}
