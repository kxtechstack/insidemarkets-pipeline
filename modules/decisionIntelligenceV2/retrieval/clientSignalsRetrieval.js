/**
 * modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval.js
 *
 * STAGE 1g — hybrid retrieval with matched-first ordering and un-matched
 * tail up to minResults.
 *
 * Changes from Stage 1f:
 *   1. Un-matched hits are NO LONGER dropped entirely. Matched hits are
 *      returned first (sorted by score), then the top un-matched hits are
 *      appended until the total reaches `minResults` (default 10). This
 *      fixes "too thin" results without re-introducing the noise problem:
 *      matched hits always rank above un-matched ones.
 *   2. Return shape now includes matchedCount / unmatchedCount so the
 *      caller can render them differently if desired.
 *
 * No hardcoded industry mappings. No keyword lists. No allowlists.
 */

const { pipeline } = require('@xenova/transformers');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { understandQuestion } = require('./questionUnderstanding');

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const POLICY_COLLECTION =
  process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';

const POLICY_MODULE_ID = '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960';
const MD_MODULE_ID     = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const FO_MODULE_ID     = '2eb989fd-0ea0-4320-b73a-f7eb8b970473';

const MODULE_NAMES = {
  [POLICY_MODULE_ID]: 'Policy & Risk',
  [MD_MODULE_ID]:     'Market Dynamics',
  [FO_MODULE_ID]:     'Forward Outlook',
};

const ALL_MODULE_IDS = [POLICY_MODULE_ID, MD_MODULE_ID, FO_MODULE_ID];

const DEFAULT_PER_MODULE_LIMIT = 15;
const DEFAULT_SCORE_FLOOR      = 0.20;
const DEFAULT_FINAL_FLOOR      = 0.20;
const DEFAULT_TOP_K            = 15;
const DEFAULT_MIN_HITS_TO_STOP = 3;
const DEFAULT_MIN_RESULTS      = 10;

const BOOST = {
  CONCEPT_IN_TITLE:   0.10,
  ENTITY_IN_TITLE:    0.30,
  CONCEPT_CAP:        0.20,
  ENTITY_CAP:         0.60,
  COMBINED_CAP:       0.70,
};

const NO_MATCH_PENALTY = 0.70;

const UNIT_DAYS = {
  days: 1, weeks: 7, months: 30, quarters: 90, years: 365,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedderPromise;
};

const embedText = async (text) => {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

// ─────────────────────────────────────────────────────────────────────────
// Time-window helpers
// ─────────────────────────────────────────────────────────────────────────
function buildWindowAttempts(timeConstraint) {
  if (!timeConstraint || !timeConstraint.present) {
    return { requested: null, attempts: [null] };
  }

  const multiplier = UNIT_DAYS[timeConstraint.unit];
  if (!multiplier) return { requested: null, attempts: [null] };

  const requestedDays = Math.max(
    1,
    Math.round(Number(timeConstraint.value) * multiplier)
  );

  const ladder = [requestedDays, 30, 90, 365, null];
  const seen = new Set();
  const attempts = [];
  for (const d of ladder) {
    if (d === null) {
      if (!seen.has('null')) { seen.add('null'); attempts.push(null); }
    } else if (!seen.has(d)) {
      seen.add(d);
      attempts.push(d);
    }
  }

  return { requested: requestedDays, attempts };
}

// ─────────────────────────────────────────────────────────────────────────
// Phrase matching — plural-tolerant
// ─────────────────────────────────────────────────────────────────────────
function phraseVariants(phrase) {
  const p = String(phrase).toLowerCase().trim();
  if (!p) return [];

  const words = p.split(/\s+/);
  if (words.length > 1) return [p];

  const variants = new Set([p]);
  variants.add(p + 's');
  if (p.endsWith('y') && p.length > 2) {
    variants.add(p.slice(0, -1) + 'ies');
  }
  if (p.endsWith('s') || p.endsWith('x') || p.endsWith('z') ||
      p.endsWith('ch') || p.endsWith('sh')) {
    variants.add(p + 'es');
  }
  return [...variants];
}

function containsPhrase(text, phrase) {
  if (!text || !phrase) return false;
  const t = String(text).toLowerCase();
  const variants = phraseVariants(phrase);
  for (const v of variants) {
    if (!v) continue;
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
    if (re.test(t)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Boost computation
// ─────────────────────────────────────────────────────────────────────────
function computeBoost(hit, understanding) {
  const title = hit.title || '';

  const matchedConcepts = [];
  const matchedEntities = [];

  for (const kw of understanding.concept_keywords || []) {
    if (containsPhrase(title, kw)) matchedConcepts.push(kw);
  }
  for (const ent of understanding.entity_mentions || []) {
    if (containsPhrase(title, ent)) matchedEntities.push(ent);
  }

  const rawConceptBoost = matchedConcepts.length * BOOST.CONCEPT_IN_TITLE;
  const rawEntityBoost  = matchedEntities.length * BOOST.ENTITY_IN_TITLE;

  const conceptBoost = Math.min(rawConceptBoost, BOOST.CONCEPT_CAP);
  const entityBoost  = Math.min(rawEntityBoost,  BOOST.ENTITY_CAP);
  const combinedBoost = Math.min(conceptBoost + entityBoost, BOOST.COMBINED_CAP);

  const totalMatches = matchedConcepts.length + matchedEntities.length;
  const penalty = totalMatches === 0 ? NO_MATCH_PENALTY : 1.0;
  const multiplier = (1 + combinedBoost) * penalty;

  return {
    multiplier,
    rawBoost: rawConceptBoost + rawEntityBoost,
    cappedBoost: combinedBoost,
    penalty,
    matched: {
      conceptsInTitle: matchedConcepts,
      entitiesInTitle: matchedEntities,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Qdrant search with retry
// ─────────────────────────────────────────────────────────────────────────
async function searchModuleWithRetry(moduleId, params, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await qdrant.search(POLICY_COLLECTION, params);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        console.log(
          `[retrieveClientSignals] module ${moduleId} attempt ${attempt} failed (${err.message}), retrying in 500ms`
        );
        await sleep(500);
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────
// Main retrieval
// ─────────────────────────────────────────────────────────────────────────
async function retrieveClientSignals(question, clientId, industry, opts = {}) {
  const perModuleLimit = opts.perModuleLimit ?? DEFAULT_PER_MODULE_LIMIT;
  const vectorFloor    = opts.vectorFloor    ?? DEFAULT_SCORE_FLOOR;
  const finalFloor     = opts.finalFloor     ?? DEFAULT_FINAL_FLOOR;
  const topK           = opts.topK           ?? DEFAULT_TOP_K;
  const minHitsToStop  = opts.minHitsToStop  ?? DEFAULT_MIN_HITS_TO_STOP;
  const minResults     = opts.minResults     ?? DEFAULT_MIN_RESULTS;
  const modules        = opts.modules        ?? ALL_MODULE_IDS;

  if (!question || !clientId || !industry) {
    throw new Error('retrieveClientSignals: question, clientId, industry required');
  }

  let understanding;
  if (opts.precomputedUnderstanding) {
    understanding = { ...opts.precomputedUnderstanding };
    // Router output uses `type`; retrieval internals expect `question_type`.
    // Alias so downstream code (and logging) works consistently.
    if (understanding.question_type === undefined && understanding.type !== undefined) {
      understanding.question_type = understanding.type;
    }
  } else {
    understanding = await understandQuestion(question, industry);
  }

  console.log(
    `[retrieval] understanding: type=${understanding.question_type} ` +
    `concepts=[${(understanding.concept_keywords || []).join(', ')}] ` +
    `entities=[${(understanding.entity_mentions || []).join(', ')}] ` +
    `time=${understanding.time_constraint?.present ? `${understanding.time_constraint.value}${understanding.time_constraint.unit}` : 'none'}`
  );

  const vector = await embedText(question);

  const perModuleResults = await Promise.all(
    modules.map(async (moduleId) => {
      try {
        const hits = await searchModuleWithRetry(moduleId, {
          vector,
          limit: perModuleLimit,
          filter: {
            must: [
              { key: 'client_id', match: { value: clientId } },
              { key: 'industry',  match: { value: industry } },
              { key: 'module_id', match: { value: moduleId } },
            ],
          },
          with_payload: true,
        });
        return { moduleId, hits };
      } catch (err) {
        console.log(
          `[retrieveClientSignals] search failed for module ${moduleId} after retry: ${err.message}`
        );
        return { moduleId, hits: [] };
      }
    })
  );

  const merged = [];
  for (const { moduleId, hits } of perModuleResults) {
    for (const h of hits) {
      if (!h || typeof h.score !== 'number') continue;
      if (h.score < vectorFloor) continue;

      const p = h.payload || {};
      const baseHit = {
        id: h.id,
        score: h.score,
        module_id: p.module_id || moduleId,
        module_name: MODULE_NAMES[p.module_id || moduleId] || 'Unknown',
        title: p.title || 'Untitled',
        chunk_text: p.chunk_text || '',
        article_id: p.article_id || null,
        published_date: p.published_date || null,
        submodule_id: p.submodule_id || null,
      };

      const boost = computeBoost(baseHit, understanding);
      baseHit._vector_score  = baseHit.score;
      baseHit._boost_mult    = boost.multiplier;
      baseHit._boost_penalty = boost.penalty;
      baseHit._boost_matched = boost.matched;
      baseHit._matched       = (boost.matched.conceptsInTitle.length > 0)
                             || (boost.matched.entitiesInTitle.length > 0);
      baseHit.score          = Math.min(baseHit.score * boost.multiplier, 1.0);

      merged.push(baseHit);
    }
  }

  merged.sort((a, b) => b.score - a.score);

  const { requested, attempts } = buildWindowAttempts(understanding.time_constraint);
  let applied = null;
  let widened = false;
  let timeFiltered = [];

  if (requested === null) {
    timeFiltered = merged.filter((m) => m.score >= finalFloor);
    applied = null;
    widened = false;
  } else {
    for (const days of attempts) {
      let slice;
      if (days === null) {
        slice = merged.filter((m) => m.score >= finalFloor);
      } else {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        slice = merged.filter((m) => {
          if (m.score < finalFloor) return false;
          if (!m.published_date) return false;
          const ts = new Date(m.published_date).getTime();
          return Number.isFinite(ts) && ts >= cutoff;
        });
      }

      if (slice.length >= minHitsToStop || days === null) {
        timeFiltered = slice;
        applied = days;
        widened = days !== requested;
        break;
      }
    }
  }

  // Split into matched / un-matched. Both are already sorted desc by score
  // because timeFiltered preserves the earlier sort.
  const matchedHits   = timeFiltered.filter((h) => h._matched);
  const unmatchedHits = timeFiltered.filter((h) => !h._matched);

  // Order: matched first, then top un-matched appended until we hit minResults
  let finalList = [...matchedHits];
  if (finalList.length < minResults) {
    const needed = minResults - finalList.length;
    finalList = [...finalList, ...unmatchedHits.slice(0, needed)];
  }

  console.log(
    `[retrieval] matched=${matchedHits.length} un-matched=${unmatchedHits.length} ` +
    `final=${finalList.length} (minResults=${minResults})`
  );

  const hits = finalList.slice(0, topK);

  // Recompute counts on the FINAL capped list — ensures they sum to hits.length
  const finalMatchedCount = hits.filter((h) => h._matched).length;
  const finalUnmatchedCount = hits.length - finalMatchedCount;

  return {
    hits,
    understanding,
    timeWindow: {
      requested,
      applied,
      widened,
      phrase: understanding.time_constraint?.phrase || null,
    },
    matchedCount: finalMatchedCount,
    unmatchedCount: finalUnmatchedCount,
  };
}

module.exports = {
  retrieveClientSignals,
  embedText,
  ALL_MODULE_IDS,
  MODULE_NAMES,
  computeBoost,
  buildWindowAttempts,
  containsPhrase,
  phraseVariants,
  BOOST,
  NO_MATCH_PENALTY,
};