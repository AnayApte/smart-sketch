import type { ConceptPayload, ConceptType } from './concept-types';
import { deduplicateConcepts } from './concept-dedup';
import { cleanMindMapNode } from './mind-map-node-clean';

export interface TranscriptSegment {
  index: number;
  text: string;
}

export interface SegmentedConcept extends ConceptPayload {
  segmentIndex: number;
}

export function normalizeType(t: unknown): ConceptType {
  return t === 'main' || t === 'concept' || t === 'detail' ? t : 'concept';
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function toWords(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function trimToWords(text: string, maxWords: number): string {
  const words = toWords(text);
  return words.slice(0, maxWords).join(' ');
}

function sanitizeLabel(raw: unknown): string {
  return cleanMindMapNode({ title: String(raw ?? ''), description: '' }).title || 'Concept';
}

function sanitizeExplanation(raw: unknown, label: string): string | undefined {
  const input = String(raw ?? '').trim();
  if (!input) return undefined;
  const words = toWords(input);
  const softCapped = words.length <= 28 ? input : words.slice(0, 28).join(' ');
  return cleanMindMapNode({ title: label, description: softCapped }).description;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function splitTranscriptIntoSegments(
  transcript: string,
  opts?: { targetWords?: number; overlapRatio?: number; maxSegments?: number }
): TranscriptSegment[] {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const targetWords = clamp(opts?.targetWords ?? 150, 80, 260);
  const overlapRatio = clamp(opts?.overlapRatio ?? 0.18, 0, 0.45);
  const maxSegments = clamp(opts?.maxSegments ?? 20, 1, 50);
  const overlap = Math.floor(targetWords * overlapRatio);
  const step = Math.max(40, targetWords - overlap);
  const segments: TranscriptSegment[] = [];

  for (let start = 0, idx = 0; start < words.length && idx < maxSegments; start += step, idx += 1) {
    const end = Math.min(words.length, start + targetWords);
    const text = words.slice(start, end).join(' ').trim();
    if (!text) continue;
    segments.push({ index: idx, text });
    if (end >= words.length) break;
  }

  return segments;
}

export function hierarchySystemInstruction(): string {
  return `You extract concepts from lecture transcript segments.
Return exactly one JSON object and nothing else:
{"concepts":[{"id":"s1_c1","title":"Short concept label, 1-5 words","description":"One clear explanatory sentence that does not repeat the title word-for-word","type":"main|concept|detail","parent":null or "s1_c1"}]}
Hard rules:
- One concept = one idea.
- title must be 1-5 words, concise and domain-specific.
- title must be a standalone concept label, never a sentence fragment copied from description.
- type must be exactly one of: main, concept, detail.
- main must have parent null.
- concept/detail must have parent set to an existing id from the same response.
- No self-parenting and no cycles.
- Prefer 4-10 concepts for this segment.
- description should be one clear explanatory sentence.
- description must not start with or duplicate the title text.
- target 10-18 words; if slightly over but concise, keep up to ~28 words.`;
}

export function hierarchyUserPrompt(segmentText: string, segmentIndex: number, totalSegments: number): string {
  return `Segment ${segmentIndex + 1}/${totalSegments}
Extract a hierarchy for this lecture segment.
Return JSON only.

Transcript segment:
${segmentText}`;
}

function normalizeParent(parentRaw: unknown): string | null {
  if (parentRaw === null || parentRaw === undefined) return null;
  if (typeof parentRaw !== 'string') return null;
  const p = parentRaw.trim();
  return p.length > 0 ? p : null;
}

export function parseConceptsJson(content: string | null): ConceptPayload[] {
  if (!content?.trim()) return [];
  let text = content.trim();
  if (text.startsWith('```')) {
    const parts = text.split('```');
    text = (parts[1] ?? parts[0]).trim();
    if (text.toLowerCase().startsWith('json')) {
      text = text.slice(4).trim();
    }
  }

  try {
    const parsed = JSON.parse(text) as { concepts?: unknown };
    if (!Array.isArray(parsed.concepts)) return [];
    return parsed.concepts
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => {
        const incomingTitle =
          typeof c.title === 'string' && c.title.trim().length > 0 ? c.title : c.label;
        const incomingDescription =
          typeof c.description === 'string' && c.description.trim().length > 0
            ? c.description
            : c.explanation;
        const cleaned = cleanMindMapNode({
          title: typeof incomingTitle === 'string' ? incomingTitle : String(incomingTitle ?? ''),
          description:
            typeof incomingDescription === 'string' ? incomingDescription : String(incomingDescription ?? ''),
        });
        const label = sanitizeLabel(cleaned.title);
        const explanation = sanitizeExplanation(cleaned.description, label);
        return {
          id: typeof c.id === 'string' ? c.id.trim() : undefined,
          label,
          type: normalizeType(c.type),
          explanation,
          parent: normalizeParent(c.parent),
        };
      })
      .filter((c) => c.label.length > 0);
  } catch {
    return [];
  }
}

function hasCycle(concepts: ConceptPayload[]): boolean {
  const byId = new Map<string, ConceptPayload>();
  concepts.forEach((c) => {
    if (c.id) byId.set(c.id, c);
  });

  const state = new Map<string, number>(); // 0 unvisited, 1 visiting, 2 done
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    const node = byId.get(id);
    const p = node?.parent ?? null;
    if (p && byId.has(p) && visit(p)) return true;
    state.set(id, 2);
    return false;
  };

  for (const id of Array.from(byId.keys())) {
    if (visit(id)) return true;
  }
  return false;
}

export function validateConceptHierarchy(concepts: ConceptPayload[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();

  concepts.forEach((c, idx) => {
    if (!c.id || c.id.trim().length === 0) errors.push(`Missing id at index ${idx}`);
    if (c.label.trim().length === 0) errors.push(`Missing label at index ${idx}`);
    if (!['main', 'concept', 'detail'].includes(c.type)) errors.push(`Invalid type at index ${idx}`);
    if (c.id) {
      if (ids.has(c.id)) errors.push(`Duplicate id ${c.id}`);
      ids.add(c.id);
    }
  });

  concepts.forEach((c) => {
    const parent = c.parent ?? null;
    if (c.type === 'main' && parent !== null) errors.push(`Main ${c.id} cannot have parent`);
    if (c.type !== 'main' && parent === null) errors.push(`Non-main ${c.id} missing parent`);
    if (parent && !ids.has(parent)) errors.push(`Parent ${parent} missing for ${c.id}`);
    if (parent && c.id && parent === c.id) errors.push(`Self-parent on ${c.id}`);
  });

  if (!errors.length && hasCycle(concepts)) {
    errors.push('Hierarchy has cycle');
  }

  return { valid: errors.length === 0, errors };
}

function similarityByTokens(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  ta.forEach((tok) => {
    if (tb.has(tok)) common += 1;
  });
  return common / Math.max(ta.size, tb.size);
}

function chooseFallbackParent(
  child: ConceptPayload,
  prior: ConceptPayload[],
  idSet: Set<string>
): string | null {
  let bestId: string | null = null;
  let bestScore = -1;
  const candidates = prior.filter((p) => p.id && idSet.has(p.id) && p.id !== child.id);

  for (let i = candidates.length - 1, distance = 0; i >= 0; i -= 1, distance += 1) {
    const cand = candidates[i];
    if (!cand.id) continue;
    const tokenScore = similarityByTokens(child.label, cand.label);
    const recencyScore = 1 / (distance + 1);
    const typeBonus = cand.type === 'main' ? 0.1 : cand.type === 'concept' ? 0.07 : 0;
    const score = tokenScore * 0.65 + recencyScore * 0.35 + typeBonus;
    if (score > bestScore) {
      bestScore = score;
      bestId = cand.id;
    }
  }

  return bestScore >= 0.24 ? bestId : null;
}

export function repairConceptHierarchy(rawConcepts: ConceptPayload[], segmentIndex: number): ConceptPayload[] {
  const prefix = `s${segmentIndex + 1}_`;
  const used = new Set<string>();
  const ordered: ConceptPayload[] = rawConcepts.map((c, idx) => {
    let id = (c.id && String(c.id).trim()) || `${prefix}c${idx + 1}`;
    if (!id.startsWith(prefix)) id = `${prefix}${id}`;
    let suffix = 1;
    while (used.has(id)) {
      id = `${prefix}c${idx + 1}_${suffix}`;
      suffix += 1;
    }
    used.add(id);

    return {
      id,
      label: sanitizeLabel(c.label),
      type: normalizeType(c.type),
      explanation: sanitizeExplanation(c.explanation, sanitizeLabel(c.label)),
      parent: c.parent ? String(c.parent).trim() : null,
    };
  });

  const idSet = new Set(ordered.map((c) => c.id!).filter(Boolean));
  const repaired = ordered.map((c, idx) => {
    let parent = c.parent ?? null;
    if (parent && !parent.startsWith(prefix) && idSet.has(`${prefix}${parent}`)) {
      parent = `${prefix}${parent}`;
    }
    if (parent && !idSet.has(parent)) parent = null;
    if (parent === c.id) parent = null;

    if (c.type === 'main') {
      return { ...c, parent: null };
    }

    if (!parent) {
      const fallbackParent = chooseFallbackParent(c, ordered.slice(0, idx), idSet);
      if (!fallbackParent) {
        return { ...c, type: 'main' as ConceptType, parent: null };
      }
      parent = fallbackParent;
    }

    return { ...c, parent };
  });

  if (hasCycle(repaired)) {
    return repaired.map((c) => ({
      ...c,
      type: normalizeType(c.type),
      parent: c.type === 'main' ? null : c.parent === c.id ? null : c.parent,
    }));
  }

  return repaired;
}

function typeRank(type: ConceptType): number {
  if (type === 'main') return 0;
  if (type === 'concept') return 1;
  return 2;
}

export function mergeSegmentConcepts(all: SegmentedConcept[]): ConceptPayload[] {
  if (all.length === 0) return [];
  const sorted = [...all].sort((a, b) => {
    if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
    const typeDiff = typeRank(a.type) - typeRank(b.type);
    if (typeDiff !== 0) return typeDiff;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });

  const mapping = deduplicateConcepts(
    sorted
      .filter((c): c is SegmentedConcept & { id: string } => !!c.id)
      .map((c) => ({ id: c.id!, label: c.label })),
    0.84
  );

  const canonical = new Map<string, SegmentedConcept>();
  sorted.forEach((c) => {
    if (!c.id) return;
    const target = mapping.get(c.id) || c.id;
    const existing = canonical.get(target);
    if (!existing) {
      canonical.set(target, { ...c, id: target });
      return;
    }
    if (typeRank(c.type) < typeRank(existing.type)) {
      canonical.set(target, { ...existing, type: c.type });
    }
  });

  const merged = Array.from(canonical.values()).map((c) => {
    const remappedParent = c.parent ? mapping.get(c.parent) || c.parent : null;
    return {
      id: c.id,
      label: c.label,
      type: c.type,
      explanation: c.explanation,
      parent: remappedParent === c.id ? null : remappedParent,
      segmentIndex: c.segmentIndex,
    };
  });

  const idSet = new Set(merged.map((m) => m.id).filter((id): id is string => Boolean(id)));
  const finalConcepts = merged.map((c, idx) => {
    if (c.type === 'main') return { ...c, parent: null };
    if (c.parent && idSet.has(c.parent)) return c;
    const fallback = chooseFallbackParent(c, merged.slice(0, idx), idSet);
    if (!fallback) {
      return { ...c, type: 'main' as ConceptType, parent: null };
    }
    return { ...c, parent: fallback };
  });

  return finalConcepts
    .sort((a, b) => {
      if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
      const typeDiff = typeRank(a.type) - typeRank(b.type);
      if (typeDiff !== 0) return typeDiff;
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    })
    .map(({ segmentIndex: _segmentIndex, ...concept }) => concept);
}

export function fallbackConceptsFromTranscript(transcript: string): ConceptPayload[] {
  const clean = transcript.trim();
  if (!clean) return [];
  const sentences = clean
    .split(/[.!?]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const first = (sentences[0] || clean).split(/\s+/).slice(0, 6).join(' ');
  const second = (sentences[1] || sentences[0] || clean).split(/\s+/).slice(0, 6).join(' ');
  const third = (sentences[2] || sentences[1] || sentences[0] || clean).split(/\s+/).slice(0, 6).join(' ');

  return [
    { id: 'f1', label: first || 'Lecture overview', type: 'main', explanation: sentences[0]?.slice(0, 120), parent: null },
    { id: 'f2', label: second || 'Key concept', type: 'concept', explanation: sentences[1]?.slice(0, 120), parent: 'f1' },
    { id: 'f3', label: third || 'Supporting detail', type: 'detail', explanation: sentences[2]?.slice(0, 120), parent: 'f2' },
  ];
}

