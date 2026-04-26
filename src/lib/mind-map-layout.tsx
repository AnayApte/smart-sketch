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

/** Layout uses `position.x` as horizontal center and `position.y` as top (see tree `positionNodes` / radial). */
function estimateLayoutBox(
  concept: ConceptPayload | undefined,
  nodeId: string,
  edgeVariant: MindMapEdgeVariant
): { w: number; h: number } {
  if (nodeId === MAP_ROOT_ID) {
    return { w: 132, h: 76 };
  }
  if (!concept) {
    return { w: 128, h: 56 };
  }
  const w0 = estimateNodeWidth(concept);
  const hasDesc = !!(concept.explanation && String(concept.explanation).trim());
  /** Narrow detail cards wrap titles; reserve extra vertical space for collision layout. */
  const detailTitleWrap = (label: string): number => {
    if (label.length <= 14) return 0;
    return Math.min(44, Math.ceil(label.length / 14) * 15);
  };
  if (edgeVariant === 'record') {
    const cap = concept.type === 'detail' ? 120 : 160;
    const w =
      concept.type === 'detail'
        ? Math.min(w0 + 56, cap + 44)
        : Math.min(w0 + 52, cap + 48);
    const baseH =
      concept.type === 'main'
        ? 64
        : concept.type === 'concept'
          ? 60
          : 72 + detailTitleWrap(concept.label);
    const descH = hasDesc ? (concept.type === 'detail' ? 52 : 42) : concept.type === 'detail' ? 12 : 0;
    return { w, h: baseH + descH };
  }
  const w = concept.type === 'detail' ? w0 + 52 : w0 + 44;
  const baseH =
    concept.type === 'main'
      ? 64
      : concept.type === 'concept'
        ? 58
        : 62 + detailTitleWrap(concept.label);
  const descH = hasDesc ? (concept.type === 'detail' ? 50 : 44) : concept.type === 'detail' ? 10 : 0;
  return { w, h: baseH + descH };
}

function layoutBox(node: Node, concept: ConceptPayload | undefined, edgeVariant: MindMapEdgeVariant) {
  const { w, h } = estimateLayoutBox(concept, node.id, edgeVariant);
  const left = node.position.x - w / 2;
  const top = node.position.y;
  return { left, top, w, h, cx: node.position.x, cy: top + h / 2 };
}

function boxesOverlap(
  a: { left: number; top: number; w: number; h: number },
  b: { left: number; top: number; w: number; h: number },
  margin: number
): boolean {
  const m = margin / 2;
  return (
    a.left - m < b.left + b.w + m &&
    a.left + a.w + m > b.left - m &&
    a.top - m < b.top + b.h + m &&
    a.top + a.h + m > b.top - m
  );
}

function overlapDepth(
  a: { left: number; top: number; w: number; h: number },
  b: { left: number; top: number; w: number; h: number },
  margin: number
): { ox: number; oy: number } | null {
  const m = margin / 2;
  const aL = a.left - m;
  const aR = a.left + a.w + m;
  const aT = a.top - m;
  const aB = a.top + a.h + m;
  const bL = b.left - m;
  const bR = b.left + b.w + m;
  const bT = b.top - m;
  const bB = b.top + b.h + m;
  const ox = Math.min(aR, bR) - Math.max(aL, bL);
  const oy = Math.min(aB, bB) - Math.max(aT, bT);
  if (ox <= 0 || oy <= 0) return null;
  return { ox, oy };
}

function subtreeSize(rootId: string, childMap: Map<string, string[]>): number {
  let n = 0;
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    n += 1;
    for (const c of childMap.get(id) || []) stack.push(c);
  }
  return n;
}

function collectSubtreeIds(rootId: string, childMap: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of childMap.get(id) || []) stack.push(c);
  }
  return out;
}

function conceptDepth(conceptById: Map<string, ConceptPayload>, nodeId: string): number {
  let d = 0;
  let cur: string | undefined = nodeId;
  while (cur) {
    const c = conceptById.get(cur);
    if (!c?.parent || !String(c.parent).trim()) break;
    d += 1;
    cur = String(c.parent).trim();
  }
  return d;
}

/**
 * Nudge overlapping mind-map nodes apart while moving whole subtrees so parent–child edges stay coherent.
 */
function resolveMindMapCollisions(
  nodes: Node[],
  concepts: ConceptPayload[],
  edgeVariant: MindMapEdgeVariant,
  childrenByParent: Map<string, string[]>
): void {
  if (nodes.length < 2) return;

  const conceptById = new Map<string, ConceptPayload>();
  concepts.forEach((c) => {
    const id = c.id || c.label;
    if (id) conceptById.set(String(id), c);
  });

  const childMap = new Map<string, string[]>();
  childrenByParent.forEach((ids, parentKey) => {
    childMap.set(parentKey, ids);
  });

  const indexById = new Map<string, number>();
  nodes.forEach((n, i) => indexById.set(n.id, i));

  const margin = 32;
  const maxIters = 96;

  for (let iter = 0; iter < maxIters; iter += 1) {
    let anyMove = false;

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const na = nodes[i];
        const nb = nodes[j];
        const ca = conceptById.get(na.id);
        const cb = conceptById.get(nb.id);
        const boxA = layoutBox(na, ca, edgeVariant);
        const boxB = layoutBox(nb, cb, edgeVariant);

        if (!boxesOverlap(boxA, boxB, margin)) continue;

        const depth = conceptDepth(conceptById, na.id);
        const depthB = conceptDepth(conceptById, nb.id);
        const sizeA = subtreeSize(na.id, childMap);
        const sizeB = subtreeSize(nb.id, childMap);

        let moverId: string;
        let stillId: string;
        if (depth !== depthB) {
          moverId = depth > depthB ? na.id : nb.id;
          stillId = depth > depthB ? nb.id : na.id;
        } else if (sizeA !== sizeB) {
          moverId = sizeA > sizeB ? nb.id : na.id;
          stillId = sizeA > sizeB ? na.id : nb.id;
        } else {
          moverId = nb.id;
          stillId = na.id;
        }

        const stillNode = nodes[indexById.get(stillId)!];
        const moveNode = nodes[indexById.get(moverId)!];
        const stillConcept = conceptById.get(stillId);
        const moveConcept = conceptById.get(moverId);
        const stillBox = layoutBox(stillNode, stillConcept, edgeVariant);
        const moveBox = layoutBox(moveNode, moveConcept, edgeVariant);

        const od = overlapDepth(stillBox, moveBox, margin);
        if (!od) continue;

        let dx = 0;
        let dy = 0;
        const extra = 18;
        const narrowCol =
          Math.abs(stillBox.cx - moveBox.cx) < Math.max(56, Math.min(stillBox.w, moveBox.w) * 0.48);
        const grayGray =
          stillConcept?.type === 'detail' && moveConcept?.type === 'detail';
        /** Prefer vertical separation for same-column stacks (gray–gray, gray under orange). */
        let verticalBias = 0;
        if (narrowCol) verticalBias += 40;
        else if (grayGray) verticalBias += 16;
        const useHorizontal = od.ox + verticalBias < od.oy;
        if (useHorizontal) {
          const dir = moveBox.cx >= stillBox.cx ? 1 : -1;
          dx = dir * (od.ox + extra);
        } else {
          const dir = moveBox.cy >= stillBox.cy ? 1 : -1;
          dy = dir * (od.oy + extra);
        }

        const toShift = collectSubtreeIds(moverId, childMap);
        toShift.forEach((id) => {
          const idx = indexById.get(id);
          if (idx === undefined) return;
          const n = nodes[idx];
          n.position = { x: n.position.x + dx, y: n.position.y + dy };
        });
        anyMove = true;
      }
    }

    if (!anyMove) break;
  }
}

function pushMindMapConceptNode(
  newNodes: Node[],
  childId: string,
  concept: ConceptPayload,
  position: { x: number; y: number },
  edgeVariant: MindMapEdgeVariant
): void {
  const cleanedText = cleanMindMapNode({
    title: concept.label,
    description: concept.explanation,
  });
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
}

function pushMindMapEdge(
  newEdges: Edge[],
  source: string,
  target: string,
  concept: ConceptPayload,
  edgeVariant: MindMapEdgeVariant,
  fromExternalRoot: boolean
): void {
  if (fromExternalRoot) {
    const rs = recordEdgeStyle(concept.type);
    newEdges.push({
      id: `edge-${source}-${target}`,
      source,
      target,
      type: 'smoothstep',
      animated: rs.animated,
      style: { stroke: rs.stroke, strokeWidth: rs.strokeWidth },
    });
    return;
  }
  if (edgeVariant === 'record') {
    const rs = recordEdgeStyle(concept.type);
    newEdges.push({
      id: `edge-${source}-${target}`,
      source,
      target,
      type: 'smoothstep',
      animated: rs.animated,
      style: { stroke: rs.stroke, strokeWidth: rs.strokeWidth },
    });
  } else {
    newEdges.push({
      id: `edge-${source}-${target}`,
      source,
      target,
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#14b8a6', strokeWidth: 2 },
    });
  }
}

/**
 * Record / external-root: topics on a ring around the lecture center, children on outward rings
 * in angular wedges (360° distribution at each depth).
 */
function layoutRadialMindMapExternal(
  newNodes: Node[],
  newEdges: Edge[],
  concepts: ConceptPayload[],
  childrenByParent: Map<string, string[]>,
  externalRootId: string,
  lectureAnchor: { x: number; y: number; height: number; gapAfter: number },
  edgeVariant: MindMapEdgeVariant
): void {
  const rootChildren = childrenByParent.get('root') || [];
  if (rootChildren.length === 0) return;

  const centerCx = lectureAnchor.x + 50;
  const centerCy = lectureAnchor.y + lectureAnchor.height / 2;
  const nRoot = rootChildren.length;
  const twoPi = Math.PI * 2;
  /** First slot toward bottom (screen +y), then full circle. */
  const rootAngle0 = Math.PI / 2;
  /** Keep first ring outside the lecture node with extra margin; scale up when many roots share 360°. */
  const ring0 = Math.min(
    780,
    Math.max(
      168 + lectureAnchor.gapAfter,
      128 +
        lectureAnchor.gapAfter +
        nRoot * 32 +
        Math.max(0, nRoot - 3) * 26 +
        Math.max(0, nRoot - 8) * 22 +
        Math.max(0, nRoot - 14) * 18
    )
  );

  const orangeRoots = rootChildren.filter((id) => {
    const c = concepts.find((x) => (x.id || x.label) === id);
    return c?.type === 'concept';
  }).length;
  /** Wider chord between orange roots on 360° (fixed angular gap → need larger r). */
  const ring0Final = Math.min(780, ring0 + Math.min(100, orangeRoots * 22 + (orangeRoots >= 2 ? 28 : 0)));

  /** Radial distance between tree levels. */
  const radialStep = (depth: number) => 228 + depth * 48;

  const visit = (nodeId: string, theta: number, r: number, depth: number): void => {
    const concept = concepts.find((c) => (c.id || c.label) === nodeId);
    if (!concept) return;

    const { h } = estimateLayoutBox(concept, nodeId, edgeVariant);
    const cx = centerCx + r * Math.cos(theta);
    const cyGeom = centerCy + r * Math.sin(theta);
    const position = { x: cx, y: cyGeom - h / 2 };

    pushMindMapConceptNode(newNodes, nodeId, concept, position, edgeVariant);

    const parentStr = concept.parent && String(concept.parent).trim();
    if (!parentStr) {
      pushMindMapEdge(newEdges, externalRootId, nodeId, concept, edgeVariant, true);
    } else {
      pushMindMapEdge(newEdges, parentStr, nodeId, concept, edgeVariant, false);
    }

    const children = childrenByParent.get(nodeId) || [];
    const k = children.length;
    if (k === 0) return;

    let childR = r + radialStep(depth) + Math.min(64, k * 9);

    const orangeSiblings = children.filter((cid) => {
      const ch = concepts.find((c) => (c.id || c.label) === cid);
      return ch?.type === 'concept';
    }).length;

    /** Angular fan for siblings; widen when several orange (`concept`) nodes share a parent. */
    let wedge = Math.min(Math.PI - 0.12, 0.72 + k * 0.34);
    if (orangeSiblings >= 2) {
      wedge = Math.min(Math.PI - 0.08, wedge + 0.48 + orangeSiblings * 0.14);
    } else if (orangeSiblings === 1 && k >= 3) {
      wedge = Math.min(Math.PI - 0.1, wedge + 0.22);
    }
    /** Minimum angle between adjacent siblings so same-level cards (esp. orange) do not bunch. */
    const minWedgeForK = k >= 2 ? (k - 1) * 0.14 : 0;
    wedge = Math.min(Math.PI - 0.06, Math.max(wedge, minWedgeForK));

    let step = k <= 1 ? 0 : wedge / (k - 1);

    const maxChildW = Math.max(
      0,
      ...children.map((cid) => {
        const ch = concepts.find((c) => (c.id || c.label) === cid);
        return ch ? estimateLayoutBox(ch, cid, edgeVariant).w : 0;
      })
    );

    /**
     * Adjacent siblings share one ring: chord ≈ 2·r·sin(step/2) must clear card width.
     * If the wedge would exceed π, push the ring outward until geometry fits.
     */
    if (k >= 2 && maxChildW > 0) {
      const chordTarget = maxChildW * 1.24;
      const maxWedge = Math.PI - 0.05;
      let rUse = childR;
      let solved = false;
      for (let guard = 0; guard < 28; guard += 1) {
        const sinHalf = Math.min(0.999, chordTarget / (2 * rUse));
        const stepMin = 2 * Math.asin(sinHalf);
        const stepAdj = Math.max(step, stepMin);
        const wedgeNeed = (k - 1) * stepAdj;
        if (wedgeNeed <= maxWedge) {
          step = stepAdj;
          wedge = wedgeNeed;
          childR = rUse;
          solved = true;
          break;
        }
        rUse += 52;
      }
      if (!solved) {
        step = maxWedge / Math.max(k - 1, 1);
        wedge = maxWedge;
        childR = rUse;
      }
    }

    children.forEach((childId, j) => {
      const offset = k <= 1 ? 0 : (j - (k - 1) / 2) * step;
      const rStagger = k <= 1 ? 0 : (j - (k - 1) / 2) * 18;
      visit(childId, theta + offset, childR + rStagger, depth + 1);
    });
  };

  rootChildren.forEach((rootId, i) => {
    const theta = rootAngle0 + (twoPi * i) / nRoot;
    visit(rootId, theta, ring0Final, 0);
  });
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
  const rootGap = Math.max(280, Math.min(560, 280 + rootChildren.length * 34));
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

  if (layoutRoot.mode === 'external-root') {
    layoutRadialMindMapExternal(
      newNodes,
      newEdges,
      concepts,
      childrenByParent,
      externalRoot!,
      layoutRoot.lectureAnchor,
      edgeVariant
    );
  } else {
    const widthCache = new Map<string, number>();

    const calculateSubtreeWidth = (nodeId: string | null): number => {
      const key = nodeId || 'root';
      if (widthCache.has(key)) {
        return widthCache.get(key)!;
      }
      const children = childrenByParent.get(key) || [];
      let width: number;
      if (children.length === 0) {
        const concept = concepts.find((c) => (c.id || c.label) === nodeId);
        width = concept ? estimateNodeWidth(concept) + 112 : 144;
      } else {
        let totalWidth = 0;
        children.forEach((childId) => {
          totalWidth += calculateSubtreeWidth(childId) + 62;
        });
        width = Math.max(totalWidth, 188);
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
      const verticalGap = 188 + level * 50;
      const siblingGap = 62 + level * 28;

      children.forEach((childId, childIndex) => {
        const concept = concepts.find((c) => (c.id || c.label) === childId);
        if (!concept) return;

        const subtreeWidth = calculateSubtreeWidth(childId);
        let position = { x: 0, y: 0 };

        if (level === 0) {
          position = {
            x: rootStartX + childIndex * rootGap,
            y: rootChildren.length > 0 && layoutRoot.mode === 'session-card' ? 136 : 44,
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

        pushMindMapConceptNode(newNodes, childId, concept, position, edgeVariant);

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
        } else if (concept.parent && parentPos) {
          const parentSource = String(concept.parent).trim();
          pushMindMapEdge(newEdges, parentSource, childId, concept, edgeVariant, false);
        }

        const nextLeftBound = level === 0 ? position.x - subtreeWidth / 2 : currentX - subtreeWidth;
        positionNodes(childId, level + 1, position, nextLeftBound);
      });

      return currentX;
    };

    positionNodes(null, 0, null, 0);
  }

  resolveMindMapCollisions(newNodes, concepts, edgeVariant, childrenByParent);

  return { nodes: newNodes, edges: newEdges };
}
