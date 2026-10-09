/**
 * modules/decisionIntelligenceV2/handlers/confidenceGate.js
 *
 * Pre-writer confidence check. Runs AFTER retrieval, BEFORE the schema
 * designer + writer. If the retrieved hits don't look like they're
 * actually about the question, short-circuit to "no data".
 *
 * Deterministic. No LLM. Uses only:
 *   - the router's concept_keywords, entity_mentions, sector_term
 *   - the retrieval hits themselves (title + chunk_text + score)
 *
 * Client gate — PASSES when BOTH:
 *   1. At least one of:
 *        A. Top hit's score >= STRONG_SCORE (0.55), OR
 *        B. At least MIN_TITLE_MATCHES (3) hits have a concept or entity
 *           in their title (concept signal overrides low numeric score)
 *   2. AND at least MIN_ON_TOPIC_HITS (2) hits contain the router's
 *      sector_term (title OR chunk_text). If the router didn't produce
 *      a sector_term, we fall back to requiring concept_keywords or
 *      entity_mentions to appear in title OR chunk_text.
 *
 * The topicality requirement is the second gate. Score alone is not
 * evidence of relevance — the Saudi retail trace showed ice-cream-shop
 * hits scoring 0.69 on a "retail industry" question. Requiring the
 * sector word to appear in at least N hits filters those out.
 *
 * Custom gate — PASSES when score >= CUSTOM_SCORE (0.55). Unchanged.
 *
 * The handler runs if EITHER gate passes.
 *
 * Multi-word concepts: same fallback rule as filterListHits — if the
 * exact phrase doesn't match, try each significant word individually.
 */

const STRONG_SCORE       = Number(process.env.DI_CONFIDENCE_STRONG_SCORE) || 0.55;
const CUSTOM_SCORE       = Number(process.env.DI_CUSTOM_CONFIDENCE_FLOOR) || 0.55;
const MIN_TITLE_MATCHES  = Number(process.env.DI_CONFIDENCE_MIN_TITLE_MATCHES) || 3;
const MIN_ON_TOPIC_HITS  = Number(process.env.DI_CONFIDENCE_MIN_ON_TOPIC_HITS) || 2;

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

/**
 * Counts how many hits contain the router's topical anchor in title OR
 * chunk_text. Anchor preference order:
 *   1. routerResult.sector_term (single best signal — the industry word)
 *   2. any routerResult.concept_keywords
 *   3. any routerResult.entity_mentions
 * Returns { count, anchor, mode } where mode is
 * 'sector' | 'concepts' | 'entities' | 'none'.
 */
function countOnTopicHits(hits, routerResult) {
  if (!Array.isArray(hits) || hits.length === 0) {
    return { count: 0, anchor: null, mode: 'none' };
  }

  const sectorTerm = routerResult && typeof routerResult.sector_term === 'string'
    ? routerResult.sector_term.trim()
    : '';

  if (sectorTerm) {
    let count = 0;
    for (const h of hits) {
      const haystack = `${h.title || ''} ${h.chunk_text || ''}`;
      if (containsPhrase(haystack, sectorTerm)) count++;
    }
    return { count, anchor: sectorTerm, mode: 'sector' };
  }

  const concepts = (routerResult?.concept_keywords || []).filter(Boolean);
  if (concepts.length > 0) {
    let count = 0;
    for (const h of hits) {
      const haystack = `${h.title || ''} ${h.chunk_text || ''}`;
      if (concepts.some((c) => containsPhrase(haystack, c))) count++;
    }
    return { count, anchor: concepts[0], mode: 'concepts' };
  }

  const entities = (routerResult?.entity_mentions || []).filter(Boolean);
  if (entities.length > 0) {
    let count = 0;
    for (const h of hits) {
      const haystack = `${h.title || ''} ${h.chunk_text || ''}`;
      if (entities.some((e) => containsPhrase(haystack, e))) count++;
    }
    return { count, anchor: entities[0], mode: 'entities' };
  }

  // No anchor at all — cannot enforce topicality, pass by default.
  return { count: hits.length, anchor: null, mode: 'none' };
}

function passesClientConfidence(hits, routerResult) {
  if (!Array.isArray(hits) || hits.length === 0) {
    return { pass: false, reason: 'no client hits' };
  }

  const topHit = hits[0];
  const topScore = topHit?.score || 0;

  // ── Topicality check ────────────────────────────────────────────────
  // Score alone is not evidence of relevance. Require at least
  // MIN_ON_TOPIC_HITS hits to contain the router's sector_term (or, if
  // none, the concept_keywords / entity_mentions) in title OR chunk_text.
  const onTopic = countOnTopicHits(hits, routerResult);

  if (topScore >= STRONG_SCORE) {
    if (onTopic.mode !== 'none' && onTopic.count < MIN_ON_TOPIC_HITS) {
      return {
        pass: false,
        reason:
          `top score ${topScore.toFixed(3)} >= strong floor ${STRONG_SCORE} ` +
          `BUT only ${onTopic.count} hit(s) are on-topic ` +
          `(< ${MIN_ON_TOPIC_HITS}; anchor="${onTopic.anchor}")`,
        topScore,
        onTopic,
      };
    }
    return {
      pass: true,
      reason:
        `top score ${topScore.toFixed(3)} >= strong floor ${STRONG_SCORE}` +
        (onTopic.mode !== 'none'
          ? ` AND ${onTopic.count} on-topic hit(s) (anchor="${onTopic.anchor}")`
          : ''),
      topScore,
      onTopic,
    };
  }

  const titleMatches = countTitleMatches(hits, routerResult);
  if (titleMatches.count >= MIN_TITLE_MATCHES) {
    if (onTopic.mode !== 'none' && onTopic.count < MIN_ON_TOPIC_HITS) {
      return {
        pass: false,
        reason:
          `${titleMatches.count} hits have a concept/entity in their title ` +
          `(>= ${MIN_TITLE_MATCHES}) BUT only ${onTopic.count} hit(s) are ` +
          `on-topic (< ${MIN_ON_TOPIC_HITS}; anchor="${onTopic.anchor}")`,
        topScore,
        titleMatches,
        onTopic,
      };
    }
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
  countOnTopicHits,
  containsPhrase,
  STRONG_SCORE,
  CUSTOM_SCORE,
  MIN_TITLE_MATCHES,
  MIN_ON_TOPIC_HITS,
};