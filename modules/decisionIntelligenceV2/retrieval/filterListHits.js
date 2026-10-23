/**
 * modules/decisionIntelligenceV2/retrieval/filterListHits.js
 *
 * Deterministic filter for list, inference, and decision questions.
 * No LLM. No drift.
 *
 * For each hit, keeps it if at least one cleaned concept appears in
 * title or chunk_text (case-insensitive, plural-tolerant, word-boundary).
 *
 * Cleaning rules:
 *   - split multi-word concepts into individual words
 *   - drop common filler words ("industry", "update", "trends", etc.)
 *   - drop words under 3 chars
 *   - dedupe
 */

const stringSimilarity = require('string-similarity');

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

/**
 * List filter — keeps any hit where at least one cleaned concept appears
 * in title or chunk_text. If no concepts survive cleaning, keeps all hits.
 */
function filterListHits(hits, concepts) {
  if (!Array.isArray(hits) || hits.length === 0) return [];
  const clean = normalizeConcepts(concepts);
  if (clean.length === 0) return hits;

  return hits.filter((h) => {
    const haystack = `${h.title || ''} ${h.chunk_text || ''}`.toLowerCase();
    
    // 1. Exact match
    if (clean.some((c) => containsPhrase(haystack, c))) return true;
    
    // 2. Squished string match (ignores spaces/hyphens)
    const haystackJoined = haystack.replace(/[\s\-_]+/g, '');
    for (const c of clean) {
      const conceptJoined = c.replace(/[\s\-_]+/g, '');
      // Only for hyphenated words ("k-beauty" vs "kbeauty") or long words.
      // Short words like "round" must not match inside "around" / "background".
      const canSquish = /[-_]/.test(c) || conceptJoined.length >= 7;
      if (canSquish && haystackJoined.includes(conceptJoined)) {
        return true;
      }
    }
    
    return false;
  });
}

module.exports = {
  filterListHits,
  containsPhrase,
  phraseVariants,
  normalizeConcepts,
};