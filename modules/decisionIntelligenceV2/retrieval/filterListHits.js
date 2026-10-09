/**
 * modules/decisionIntelligenceV2/retrieval/filterListHits.js
 *
 * Deterministic filter for list, inference, and decision questions.
 * No LLM. No drift.
 *
 * For each hit, keeps it if at least one cleaned concept appears in
 * title or chunk_text (case-insensitive, plural-tolerant, word-boundary).
 *
 * Multi-word concepts: if the exact phrase doesn't match, also try each
 * significant word in the phrase (skip fillers like "of", "and", "the").
 * Example: "vapour duty" → also matches "duty stamps".
 *
 * Cleaning rules:
 *   - split multi-word concepts into individual words
 *   - drop common filler words ("industry", "update", "trends", etc.)
 *   - drop words under 3 chars
 *   - dedupe
 *
 * TWO FILTERS EXPORTED:
 *   - filterListHits             — OR-logic (list answers)
 *   - filterListHitsConjunctive  — AND-logic on market+topic (inference/decision)
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

const PHRASE_STOPWORDS = new Set(['of', 'and', 'the', 'in', 'on', 'at', 'to', 'for', 'a', 'an']);

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

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsPhrase(text, phrase) {
  if (!text || !phrase) return false;
  const t = String(text).toLowerCase();

  // 1. Try exact phrase (with plural variants for single words)
  for (const v of phraseVariants(phrase)) {
    if (!v) continue;
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(v)}(?:[^a-z0-9]|$)`, 'i');
    if (re.test(t)) return true;
  }

  // 2. Multi-word fallback — try each significant word individually
  const words = String(phrase).toLowerCase().trim().split(/\s+/);
  if (words.length > 1) {
    for (const w of words) {
      if (w.length < 3) continue;
      if (PHRASE_STOPWORDS.has(w)) continue;
      const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(w)}(?:[^a-z0-9]|$)`, 'i');
      if (re.test(t)) return true;
    }
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
 *
 * Uses OR-logic deliberately: list answers are browsing surfaces, and a
 * looser filter gives the user more to scan. Strict AND-logic lives in
 * filterListHitsConjunctive below, used by inference/decision.
 */
function filterListHits(hits, concepts) {
  if (!Array.isArray(hits) || hits.length === 0) return [];
  const clean = normalizeConcepts(concepts);
  if (clean.length === 0) return hits;

  return hits.filter((h) => {
    const haystack = `${h.title || ''} ${h.chunk_text || ''}`.toLowerCase();
    return clean.some((c) => containsPhrase(haystack, c));
  });
}

/**
 * Conjunctive filter for inference / decision.
 *
 * A hit passes only if it contains:
 *   - at least one MARKET concept (typically entity_mentions — geography,
 *     company, or regulator names), AND
 *   - at least one TOPIC concept (typically concept_keywords — the actual
 *     subject: "retail", "funding", "regulation").
 *
 * Rationale: a question like "retail in Saudi Arabia" should NOT be
 * answered by "ice cream in Saudi Arabia" (topic miss) or by "US retail
 * acquisition" (market miss). It needs BOTH dimensions represented.
 *
 * Self-correcting behaviour:
 *   The router occasionally leaks topic words into entity_mentions, which
 *   would make the market bucket overlap with the topic bucket. To stay
 *   robust to that, any word that appears in BOTH cleaned buckets is
 *   removed from the topic bucket before matching. This means the rule
 *   always distinguishes market-anchor from topic regardless of how the
 *   router populates its fields.
 *
 * Fallback behaviour:
 *   - If both buckets are empty after cleaning, all hits pass.
 *   - If only one bucket has entries, require ≥1 from that bucket
 *     (equivalent to the old OR-logic).
 */
function filterListHitsConjunctive(hits, marketConcepts, topicConcepts) {
  if (!Array.isArray(hits) || hits.length === 0) return [];

  const cleanMarket = normalizeConcepts(marketConcepts);
  const marketSet   = new Set(cleanMarket);

  // Self-correction: strip market words out of the topic bucket so that
  // a geography-only hit cannot pass both checks on the same word.
  const cleanTopic = normalizeConcepts(topicConcepts).filter((w) => !marketSet.has(w));

  // Both buckets empty → no filter possible, pass everything
  if (cleanMarket.length === 0 && cleanTopic.length === 0) return hits;

  // Only market bucket populated → require ≥1 market word
  if (cleanTopic.length === 0) {
    return hits.filter((h) => {
      const haystack = `${h.title || ''} ${h.chunk_text || ''}`.toLowerCase();
      return cleanMarket.some((c) => containsPhrase(haystack, c));
    });
  }

  // Only topic bucket populated → require ≥1 topic word
  if (cleanMarket.length === 0) {
    return hits.filter((h) => {
      const haystack = `${h.title || ''} ${h.chunk_text || ''}`.toLowerCase();
      return cleanTopic.some((c) => containsPhrase(haystack, c));
    });
  }

  // Both populated → require ≥1 from EACH bucket
  return hits.filter((h) => {
    const haystack = `${h.title || ''} ${h.chunk_text || ''}`.toLowerCase();
    const marketHit = cleanMarket.some((c) => containsPhrase(haystack, c));
    if (!marketHit) return false;
    return cleanTopic.some((c) => containsPhrase(haystack, c));
  });
}

module.exports = {
  filterListHits,
  filterListHitsConjunctive,
  containsPhrase,
  phraseVariants,
  normalizeConcepts,
};