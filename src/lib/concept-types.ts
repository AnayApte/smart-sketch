/**
 * Canonical shape for AI-extracted concepts (agent + /api/process-transcript).
 */
export type ConceptType = 'main' | 'concept' | 'detail';

export interface ConceptPayload {
  id?: string;
  label: string;
  type: ConceptType;
  explanation?: string;
  /** Parent concept id from the same extraction batch, or null for roots */
  parent?: string | null;
}
