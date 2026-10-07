/**
 * modules/decisionIntelligenceV2/retrieval/filterListHits.js
 *
 * Deterministic list filter. No LLM.
 *
 * Split multi-word concepts into individual words, drop common filler
 * words, then keep any hit where AT LEAST ONE cleaned concept appears in
 * title or chunk_text (case-insensitive, word-boundary).
 *
 * If no concepts survive cleaning, keep all hits.
 */

const FILLER_CONCEPTS = new Set([
  'industry', 'sector', 'business', 'company', 'companies',
  'update', 'updates', 'news', 'information', 'data',
  'requirement', 'requirements', 'change', 'changes',
  'trend', 'trends', 'growth', 'development', 'developments',
  'activity', 'activities', 'market', 'markets',
  'report', 'reports', 'article', 'articles',
  'analysis', 'overview', 'summary',
]);

function phraseVariants(phrase) {
  const p = String(phrase).toLowerCase().trim();
  if (!p) return [];
  const words = p.split(/\s+/);
  if (words.length > 1) return [p];

  const variants = new Set([p]);
  variants.add(p + 's');
  if (p.endsWith('y') && p.length > 2) variants.add(p.slice(0, -1) + 'ies');
  if (
    p.endsWith('s') || p.endsWith('x') || p.endsWith('z') ||
    p.endsWith('ch') || p.endsWith('sh')
  ) {
    variants.add(p + 'es');
  }
  return [...variants];
}

function containsPhrase(text, phrase) {
  if (!text || !phrase) return false;
  const t = String(text).toLowerCase();
  for (const v of phraseVariants(phrase)) {
    if (!v) continue;
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
    if (re.test(t)) return true;
  }
  return false;
}

function normalizeConcepts(concepts) {
  const out = new Set();
  for (const raw of concepts || []) {
    const lower = String(raw).toLowerCase().trim();
    if (!lower) continue;
    const words = lower.split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (w.length < 3) continue;
      if (FILLER_CONCEPTS.has(w)) continue;
      out.add(w);
    }
  }
  return [...out];
}

function filterListHits(hits, concepts) {
  if (!Array.isArray(hits) || hits.length === 0) return [];

  const clean = normalizeConcepts(concepts);
  if (clean.length === 0) return hits;

  return hits.filter((h) => {
    const haystack = `${h.title || ''} ${h.chunk_text || ''}`.toLowerCase();
    return clean.some((c) => containsPhrase(haystack, c));
  });
}

module.exports = { filterListHits, containsPhrase, phraseVariants, normalizeConcepts };