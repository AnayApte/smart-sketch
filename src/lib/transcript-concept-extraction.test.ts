import { describe, expect, it } from 'vitest';
import {
  fallbackConceptsFromTranscript,
  mergeSegmentConcepts,
  parseConceptsJson,
  repairConceptHierarchy,
  splitTranscriptIntoSegments,
  validateConceptHierarchy,
} from './transcript-concept-extraction';
import { transcriptFixtures } from './__fixtures__/transcript-fixtures';

describe('splitTranscriptIntoSegments', () => {
  it('splits longer transcript into overlapping segments', () => {
    const source = `${transcriptFixtures.long} ${transcriptFixtures.medium} ${transcriptFixtures.noisy}`;
    const segments = splitTranscriptIntoSegments(source, { targetWords: 28, overlapRatio: 0.2 });
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[0].index).toBe(0);
    expect(segments[1].index).toBe(1);
    expect(segments[0].text.length).toBeGreaterThan(0);
  });
});

describe('repairConceptHierarchy + validation', () => {
  it('repairs missing ids, invalid parents, and keeps hierarchy valid', () => {
    const raw = [
      { label: 'Distributed systems intro', type: 'main' as const, parent: null },
      { label: 'CAP theorem', type: 'concept' as const, parent: 'bad-id' },
      { label: 'Partition tolerance', type: 'detail' as const, parent: null },
    ];
    const repaired = repairConceptHierarchy(raw, 1);
    const validation = validateConceptHierarchy(repaired);
    expect(validation.valid).toBe(true);
    expect(repaired.every((c) => c.id?.startsWith('s2_'))).toBe(true);
    expect(repaired.find((c) => c.type !== 'main' && !c.parent)).toBeUndefined();
  });
});

describe('mergeSegmentConcepts', () => {
  it('deduplicates similar labels and remaps parents', () => {
    const merged = mergeSegmentConcepts([
      { id: 's1_c1', label: 'Recursion basics', type: 'main', parent: null, segmentIndex: 0 },
      { id: 's1_c2', label: 'Base case', type: 'concept', parent: 's1_c1', segmentIndex: 0 },
      { id: 's2_c1', label: 'Recursion basic', type: 'concept', parent: 's1_c1', segmentIndex: 1 },
      { id: 's2_c2', label: 'Stack memory', type: 'detail', parent: 's2_c1', segmentIndex: 1 },
    ]);
    const recursionNodes = merged.filter((c) => c.label.toLowerCase().includes('recursion'));
    expect(recursionNodes.length).toBe(1);
    expect(merged.some((c) => c.id === 's2_c2' && c.parent)).toBe(true);
  });
});

describe('fallbackConceptsFromTranscript', () => {
  it('returns a minimal multi-node hierarchy', () => {
    const fallback = fallbackConceptsFromTranscript(transcriptFixtures.short);
    const validation = validateConceptHierarchy(fallback);
    expect(fallback.length).toBe(3);
    expect(validation.valid).toBe(true);
  });
});

describe('parseConceptsJson sanitization', () => {
  it('forces short idea label and short description', () => {
    const payload = JSON.stringify({
      concepts: [
        {
          id: 'c1',
          label: 'This is a very long node title that should be trimmed aggressively',
          type: 'main',
          explanation:
            'this explanation is way too long and should become a short sentence that keeps only the core idea for display',
          parent: null,
        },
      ],
    });
    const parsed = parseConceptsJson(payload);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label.split(/\s+/).length).toBeLessThanOrEqual(6);
    expect((parsed[0].explanation || '').split(/\s+/).length).toBeLessThanOrEqual(28);
  });

  it('keeps title separate from explanation and allows slight overflow', () => {
    const payload = JSON.stringify({
      concepts: [
        {
          id: 'c2',
          label: 'Neural network optimization and tuning in modern production systems',
          type: 'concept',
          explanation:
            'Neural network optimization covers scheduler strategy, adaptive learning rates, and regularization choices for stable production performance',
          parent: 'c1',
        },
      ],
    });
    const parsed = parseConceptsJson(payload);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label.split(/\s+/).length).toBeLessThanOrEqual(6);
    expect((parsed[0].explanation || '').toLowerCase().startsWith(parsed[0].label.toLowerCase())).toBe(false);
    expect((parsed[0].explanation || '').split(/\s+/).length).toBeLessThanOrEqual(28);
  });

  it('accepts title/description format and removes duplicated prefix', () => {
    const payload = JSON.stringify({
      concepts: [
        {
          id: 'c3',
          title: 'Photosynthesis converts light energy into chemical',
          description:
            'Photosynthesis converts light energy into chemical energy stored in carbohydrates.',
          type: 'main',
          parent: null,
        },
      ],
    });
    const parsed = parseConceptsJson(payload);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label.split(/\s+/).length).toBeLessThanOrEqual(5);
    expect(parsed[0].label.toLowerCase()).toContain('photosynthesis');
    expect((parsed[0].explanation || '').toLowerCase().startsWith(parsed[0].label.toLowerCase())).toBe(false);
  });
});

