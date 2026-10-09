/**
 * modules/decisionIntelligenceV2/handlers/confidenceGate.js
 *
 * Pre-writer confidence check. Runs AFTER retrieval, BEFORE the schema
 * designer + writer. If the retrieved hits don't look like they're
 * actually about the question, short-circuit to "no data".
 *
 * Deterministic. No LLM. Uses only:
 *   - the router's concept_keywords and entity_mentions
 *   - the retrieval hits themselves (title + score)
 *
 * Client gate — PASSES when EITHER:
 *   A. Top hit's score >= STRONG_SCORE (0.55), OR
 *   B. At least MIN_TITLE_MATCHES (3) hits have a concept or entity in
 *      their title (concept signal overrides low numeric score)
 *
 * Custom gate — PASSES when score >= CUSTOM_SCORE (0.55).
 *
 * The handler runs if EITHER gate passes.
 *
 * Multi-word concepts: same fallback rule as filterListHits — if the
 * exact phrase doesn't match, try each significant word individually.
 */

const STRONG_SCORE      = Number(process.env.DI_CONFIDENCE_STRONG_SCORE) || 0.55;
const CUSTOM_SCORE      = Number(process.env.DI_CUSTOM_CONFIDENCE_FLOOR) || 0.55;
const MIN_TITLE_MATCHES = Number(process.env.DI_CONFIDENCE_MIN_TITLE_MATCHES) || 3;

const PHRASE_STOPWORDS = new Set(['of', 'and', 'the', 'in', 'on', 'at', 'to', 'for', 'a', 'an']);

function phraseVariants(phrase) {
  const p = String(phrase).toLowerCase().trim();
  if (!p) return [];
  if (p.includes(' ')) return [p];

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

function countTitleMatches(hits, routerResult) {
  const concepts = (routerResult?.concept_keywords || []).filter(Boolean);
  const entities = (routerResult?.entity_mentions || []).filter(Boolean);
  const allTerms = [...concepts, ...entities];

  if (allTerms.length === 0) return { count: 0, matched: [] };

  const matched = [];
  for (const h of hits) {
    const title = String(h.title || '');
    const hitTerm = allTerms.find((t) => containsPhrase(title, t));
    if (hitTerm) matched.push({ title, term: hitTerm });
  }

  return { count: matched.length, matched };
}

function passesClientConfidence(hits, routerResult) {
  if (!Array.isArray(hits) || hits.length === 0) {
    return { pass: false, reason: 'no client hits' };
  }

  const topHit = hits[0];
  const topScore = topHit?.score || 0;

  if (topScore >= STRONG_SCORE) {
    return {
      pass: true,
      reason: `top score ${topScore.toFixed(3)} >= strong floor ${STRONG_SCORE}`,
      topScore,
    };
  }

  const titleMatches = countTitleMatches(hits, routerResult);
  if (titleMatches.count >= MIN_TITLE_MATCHES) {
    return {
      pass: true,
      reason:
        `${titleMatches.count} hits have a concept/entity in their title ` +
        `(>= ${MIN_TITLE_MATCHES}) — top score ${topScore.toFixed(3)}`,
      topScore,
      titleMatches,
    };
  }

  return {
    pass: false,
    reason:
      `top score ${topScore.toFixed(3)} < ${STRONG_SCORE} AND only ` +
      `${titleMatches.count} hit(s) have a concept in their title ` +
      `(< ${MIN_TITLE_MATCHES})`,
    topScore,
    titleMatches,
  };
}

function passesCustomConfidence(customHits) {
  if (!Array.isArray(customHits) || customHits.length === 0) {
    return { pass: false, reason: 'no custom hits' };
  }

  const topHit = customHits[0];
  const topScore = topHit?.score || 0;

  if (topScore < CUSTOM_SCORE) {
    return {
      pass: false,
      reason: `custom top score ${topScore.toFixed(3)} < floor ${CUSTOM_SCORE}`,
      topScore,
    };
  }

  return {
    pass: true,
    reason: `custom hit above floor (score ${topScore.toFixed(3)})`,
    topScore,
  };
}

function evaluateConfidence({ clientHits, customHits, routerResult }) {
  const clientResult = passesClientConfidence(clientHits, routerResult);
  const customResult = passesCustomConfidence(customHits);

  const pass = clientResult.pass || customResult.pass;

  return {
    pass,
    client: clientResult,
    custom: customResult,
    reason: pass
      ? (clientResult.pass ? `[client] ${clientResult.reason}` : `[custom] ${customResult.reason}`)
      : `[client] ${clientResult.reason}; [custom] ${customResult.reason}`,
  };
}

module.exports = {
  evaluateConfidence,
  passesClientConfidence,
  passesCustomConfidence,
  countTitleMatches,
  containsPhrase,
  STRONG_SCORE,
  CUSTOM_SCORE,
  MIN_TITLE_MATCHES,
};