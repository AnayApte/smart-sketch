export interface RawMindMapNodeText {
  title?: string | null;
  description?: string | null;
}

export interface CleanMindMapNodeText {
  title: string;
  description?: string;
}

function cleanWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripOuterPunctuation(text: string): string {
  return text.replace(/^["'`([{]+/, '').replace(/["'`)\]}]+$/, '').trim();
}

function words(text: string): string[] {
  return cleanWhitespace(text).split(/\s+/).filter(Boolean);
}

function toSentenceCase(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeForCompare(text: string): string {
  return cleanWhitespace(text).toLowerCase().replace(/[^\w\s]/g, '');
}

function makeConceptTitle(rawTitle: string, rawDescription: string): string {
  const source = rawTitle || rawDescription;
  if (!source) return 'Concept';

  const clean = stripOuterPunctuation(cleanWhitespace(source));
  const firstClause = clean.split(/[:;.!?]\s+/)[0]?.trim() || clean;
  const parts = words(firstClause);

  // If title reads like a sentence fragment, condense aggressively.
  const isSentenceLike = /\b(is|are|was|were|can|could|will|would|should|has|have|had)\b/i.test(firstClause);
  const maxWords = isSentenceLike ? 4 : 5;
  const compact = parts.slice(0, maxWords).join(' ').trim();
  return compact || 'Concept';
}

function removeRepeatedPrefix(title: string, description: string): string {
  let out = description;
  const normTitle = normalizeForCompare(title);
  const normDesc = normalizeForCompare(description);

  if (!normTitle || !normDesc) return out;

  if (normDesc.startsWith(normTitle)) {
    out = out.slice(title.length).replace(/^[:\-\s,.;]+/, '').trim();
    return out;
  }

  // Remove repeated leading phrase overlap of 3+ words.
  const titleWords = words(title).map((w) => normalizeForCompare(w));
  const descWords = words(description);
  const descNormWords = descWords.map((w) => normalizeForCompare(w));
  let overlap = 0;
  const limit = Math.min(titleWords.length, descNormWords.length);
  while (overlap < limit && titleWords[overlap] === descNormWords[overlap]) {
    overlap += 1;
  }
  if (overlap >= 3) {
    out = descWords.slice(overlap).join(' ').replace(/^[:\-\s,.;]+/, '').trim();
  }

  return out;
}

export function cleanMindMapNode(input: RawMindMapNodeText): CleanMindMapNodeText {
  const rawTitle = stripOuterPunctuation(cleanWhitespace(input.title || ''));
  const rawDescription = stripOuterPunctuation(cleanWhitespace(input.description || ''));

  const title = makeConceptTitle(rawTitle, rawDescription);
  let description = rawDescription || undefined;

  if (description) {
    description = removeRepeatedPrefix(title, description);
    if (normalizeForCompare(description) === normalizeForCompare(title)) {
      description = undefined;
    }
  }

  return {
    title,
    description: description ? toSentenceCase(description) : undefined,
  };
}

