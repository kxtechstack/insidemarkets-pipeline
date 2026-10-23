/**
 * modules/decisionIntelligenceV2/route.js
 *
 * V2 HTTP route. All three question types (list / inference / decision)
 * use the same deterministic concept-matching filter. No LLM filter.
 *
 * LIST pipeline:
 *   router → client-signal retrieval → deterministic filter → list handler
 *   (client signals only — no custom sources)
 *
 * INFERENCE / DECISION pipeline:
 *   router → client + custom retrieval → deterministic filter → handler
 *   (custom sources always kept)
 *
 * Reuses the existing chatHistory for conversation persistence.
 *
 * ALSO registers /decision-intelligence-v2/chat-with-memory — the
 * chatContext-wrapped variant that runs the resolver before the pipeline
 * and the state updater after. The existing /chat route is untouched.
 */

const {
  createConversation,
  appendMessage,
  listConversations,
  loadConversation,
  deleteConversation,
  getSuggestedQuestions,
} = require('../decisionIntelligence/chatHistory');

const { route } = require('./routing/router');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { selectRelevantHitsForList } = require('./handlers/topicalCoverage');
const { retrieveClientSignals } = require('./retrieval/clientSignalsRetrieval');
const { retrieveCustomSourceHits } = require('./retrieval/customSourceRetrieval');
const { filterListHits, normalizeConcepts, containsPhrase } = require('./retrieval/filterListHits');
const stringSimilarity = require('string-similarity');
const { buildListItems } = require('./handlers/listHandler');
const { buildInferenceAnswer } = require('./handlers/inferenceHandler');
const { buildDecisionAnswer } = require('./handlers/decisionHandler');
const { buildSecAnswer } = require('./handlers/secHandler');
const {
  buildGreetingResponse,
  buildOffTopicResponse,
  buildClarificationResponse,
  buildListResponse,
  buildInferenceResponse,
  buildDecisionResponse,
} = require('./responseBuilder');

// chatContext layer (new)
const { resolveContext } = require('./chatContext/contextResolver');
const { updateState } = require('./chatContext/stateUpdater');
const { loadState } = require('./chatContext/mem0Adapter');
const { reformatPreviousAnswer } = require('./chatContext/reformatter');

// ─────────────────────────────────────────────────────────────────────────
// Normalizes squished brand names (e.g. "Kbeauty", "KBeauty", "Loreal")
// into their proper spaced/hyphenated form.
// ─────────────────────────────────────────────────────────────────────────
function normalizeSquishedBrands(text) {
  if (!text) return text;
  let q = String(text);
  
  // 1. Handle camelCase: "KBeauty" -> "K Beauty"
  q = q.replace(/([a-z])([A-Z])/g, '$1 $2');

  // 2. Known proper nouns in our domain
  const knownBrands = [
    { pattern: /\bkbeaut(y|ies|i)\b/gi, replace: 'K-Beauty' },
    { pattern: /\bkbeauty\b/gi, replace: 'K-Beauty' },
    { pattern: /\bloreal\b/gi, replace: "L'Oréal" },
    { pattern: /\bcoca ?cola\b/gi, replace: 'Coca-Cola' },
    { pattern: /\bestee ?lauder\b/gi, replace: 'Estée Lauder' },
    { pattern: /\bulta ?beauty\b/gi, replace: 'Ulta Beauty' },
  ];
  
  for (const fix of knownBrands) {
    q = q.replace(fix.pattern, fix.replace);
  }

  return q;
}

// ─────────────────────────────────────────────────────────────────────────
// Deterministic filter for inference / decision.
//
// Same concept normalization as list. Keeps any hit where at least one
// clean concept appears in title OR body. If no concepts survive cleaning,
// keeps all hits (nothing to filter on).
// ─────────────────────────────────────────────────────────────────────────
function filterForInferenceOrDecision(clientHits, concepts) {
  const clean = normalizeConcepts(concepts);
  if (clean.length === 0) return clientHits;

  return clientHits.filter((h) => {
    const haystack = `${h.title || ''} ${h.chunk_text || ''}`.toLowerCase();
    
    // 1. Exact phrase match
    if (clean.some((c) => containsPhrase(haystack, c))) return true;
    
    // 2. Squished string match (ignores spaces/hyphens)
    const haystackJoined = haystack.replace(/[\s\-_]+/g, '');
    for (const c of clean) {
      const conceptJoined = c.replace(/[\s\-_]+/g, '');
      if (haystackJoined.includes(conceptJoined)) {
        return true; 
      }
    }
    
    return false;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// List candidate cleanup.
//
// Before the LLM is asked "which of these candidates are relevant?", we
// clean the list. This prevents three classes of pollution that were causing
// list questions to sometimes return no_data even when real signals existed:
//
//   1. Same article appearing multiple times (multiple chunks of one article
//      all retrieved as separate hits). Kept: the first (highest-scoring).
//   2. Syndicated copies of the same story across different URLs, already
//      marked is_duplicate = true by the pipeline. Removed.
//   3. Orphaned chunks — articles present in Qdrant but with no matching
//      signal row in Supabase. Removed.
//
// After cleanup, every remaining candidate is guaranteed to survive
// buildListItems() and appear in the final list. So if the LLM picks any
// of them, we always show something. No more "picked only junk" -> no_data.
//
// Runs ONLY on the list path. Inference / decision / framework paths are
// unchanged.
// ─────────────────────────────────────────────────────────────────────────

const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function textMentions(text, entity) {
  const e = stripAccents(entity).toLowerCase().trim();
  if (!e) return false;
  return containsPhrase(stripAccents(text).toLowerCase(), e);
}

// Real company/place names from the router. Removes the industry word (e.g. "Cosmetics").
function cleanListEntities(routerResult, industry) {
  const industryWords = [industry, routerResult && routerResult.sector_term]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase().trim());

  const out = [];
  for (const raw of (routerResult && routerResult.entity_mentions) || []) {
    const e = String(raw || '').trim();
    if (e.length < 2) continue;
    const el = e.toLowerCase();
    const isIndustryWord = industryWords.some(
      (w) =>
        w === el ||
        (el.length >= 4 && w.startsWith(el)) ||
        (w.length >= 4 && el.startsWith(w))
    );
    if (isIndustryWord) continue;
    out.push(e);
  }
  return out;
}

async function prepareListCandidates(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return [];

  const byArticleId = new Map();
  for (const h of hits) {
    if (!h || !h.article_id) continue;
    if (byArticleId.has(h.article_id)) continue;
    byArticleId.set(h.article_id, h);
  }
  if (byArticleId.size === 0) return [];

  const ids = [...byArticleId.keys()];
  let policyRows, mdRows, foRows;
  try {
    [policyRows, mdRows, foRows] = await Promise.all([
      supabase.from('policy_signals').select('article_id, is_duplicate, category').in('article_id', ids),
      supabase.from('market_dynamics_signals').select('article_id, is_duplicate, category').in('article_id', ids),
      supabase.from('trend_signals').select('article_id, is_duplicate, sector').in('article_id', ids),
    ]);
  } catch (err) {
    console.log(`[prepareListCandidates] Supabase lookup failed, keeping all ${ids.length} candidates: ${err.message}`);
    return [...byArticleId.values()];
  }

  // supabase-js does not throw on errors, it returns {error}. Check it.
  if ([policyRows, mdRows, foRows].some((r) => !r || r.error)) {
    console.log(`[prepareListCandidates] Supabase returned an error, keeping all ${ids.length} candidates`);
    return [...byArticleId.values()];
  }

  const valid = new Set();
  const categoryByArticle = new Map();
  const add = (rows, field) => {
    for (const r of rows || []) {
      if (r.is_duplicate !== false) continue;
      valid.add(r.article_id);
      if (r[field] && !categoryByArticle.has(r.article_id)) categoryByArticle.set(r.article_id, r[field]);
    }
  };
  add(policyRows.data, 'category');
  add(mdRows.data, 'category');
  add(foRows.data, 'sector');

  const cleaned = [...byArticleId.values()]
    .filter((h) => valid.has(h.article_id))
    .map((h) => ({ ...h, category: categoryByArticle.get(h.article_id) || null }));

  console.log(`[prepareListCandidates] ${hits.length} raw → ${byArticleId.size} unique → ${cleaned.length} verified`);
  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────
// Pipeline runner
// ─────────────────────────────────────────────────────────────────────────
async function runV2Pipeline({ question, clientId, industry, forcedType }) {
  // ── 0. Normalize squished brand names ──────────────────────────────
  question = normalizeSquishedBrands(question);
  // ────────────────────────────────────────────────────────────────────

  // ── 1. Route ────────────────────────────────────────────────────────
  let routerResult;
  if (forcedType) {
    const valid = ['list', 'inference', 'decision'];
    if (!valid.includes(forcedType)) {
      throw new Error(`Invalid forced type "${forcedType}"`);
    }
    routerResult = {
      intent: 'market_intelligence',
      type: forcedType,
      time_constraint: { present: false, value: null, unit: null, phrase: null },
      entity_mentions: [],
      concept_keywords: [],
      sector_term: null,
      is_company_set_query: false,
      primary_intent: question,
      _fallback: false,
    };
  } else {
    routerResult = await route(question, industry);
  }

    // ── 1.2 FORCE LIST IF USER SAID "LIST" ──────────────────────────────
  // If the question starts with "list", it is a list. No exceptions.
  // This prevents the SEC handler from hijacking "list" questions.
  const isListRequest = /^\s*list\b/i.test(question);
  if (isListRequest && routerResult.intent === 'market_intelligence') {
    if (routerResult.type !== 'list') {
      console.log(`[V2 route] FORCED type=list because question starts with "list" (was ${routerResult.type})`);
    }
    routerResult.type = 'list';
  }
  // ────────────────────────────────────────────────────────────────────

  // ── 1.5 SEC pre-check ───────────────────────────────────────────────
  // Only runs for market_intelligence questions. Wrapped so any failure
  // in the SEC layer silently falls through to normal V2.
  //   - mode:'numeric'   → returns a full payload (numeric answer + chart)
  //   - mode:'framework' → returns injectChunks to merge into decision context
  //   - null             → not SEC-shaped, or SEC failed; V2 runs unmodified
  let secResult = null;
  if (routerResult.intent === 'market_intelligence') {
    try {
      secResult = await buildSecAnswer({
        question,
        routerResult,
        clientId,
        industry,
      });
    } catch (err) {
      console.log(`[V2 route] SEC handler threw, falling through: ${err.message}`);
      secResult = null;
    }
  }

  // SEC numeric answer is authoritative — return it directly.
  // EXCEPTION: For comparison questions where we only found one entity's data,
  // route through the decision handler so it can add the missing-data warning.
  if (secResult && secResult.mode === 'numeric' && secResult.payload) {
    const qLowerSec = String(question || '').toLowerCase();
    const isComparisonForNumeric = /\b(vs\.?|versus|against|compare)\b/i.test(qLowerSec);
    
    let isPartialComparison = false;
    if (isComparisonForNumeric) {
      const entities = (routerResult && routerResult.entity_mentions) || [];
      const tickersInSources = new Set(
        (secResult.payload.sources || [])
          .map(s => s.ticker)
          .filter(Boolean)
      );
      // If we detected 2+ entities but only returned 1 ticker's worth of data, it's partial
      isPartialComparison = entities.length > 1 && tickersInSources.size < entities.length;
    }

    if (isPartialComparison) {
      console.log(`[V2 route] Partial numeric comparison — routing through decision handler for merge+warning`);
      // Force decision type so the merge logic runs
      routerResult.type = 'decision';

      // Get the actual company name from the source title
      const sourceTitle = secResult.payload.sources?.[0]?.title || '';
      const ticker = secResult.payload.sources?.[0]?.ticker || 'SEC';
      // Extract company name from source title like "Estée Lauder Companies (The) (EL) — FY2025 Revenue"
      const companyNameMatch = sourceTitle.match(/^(.+?)\s*\([A-Z.]+\)/);
      const companyName = companyNameMatch ? companyNameMatch[1].trim() : ticker;

      // Wrap the numeric answer as a synthetic "framework" chunk so it's merged
      const syntheticChunk = {
        id: '__sec_numeric__',
        score: 1.0,
        module_id: '__sec__',
        module_name: 'SEC Filing',
        title: `${companyName} (${ticker}) — Verified Financial Facts`,
        chunk_text: `Company: ${companyName}\nTicker: ${ticker}\n\n${secResult.payload.report?.bodyText || ''}`,
        article_id: null,
        published_date: null,
        submodule_id: null,
        _matched: true,
        _sec: true,
        _sec_payload: {
          ticker: ticker,
          fiscal_year: null,
          item_code: 'financial_facts',
        },
      };
      // Don't return yet — fall through and let decision handler merge
      // We'll pass this chunk into secInjectChunks
      secResult = {
        mode: 'framework',
        injectChunks: [syntheticChunk],
      };
    } else {
      console.log(`[V2 route] SEC numeric answer returned directly`);
      return {
        routerResult,
        handlerResult: secResult.handlerResult || secResult.payload,
        payload: secResult.payload,
      };
    }
  }

  // SEC region fallback (non-US + SEC-numeric) — return directly.
  // Either a list of region+topic-matching signals, or a no_data payload.
  if (secResult && secResult.mode === 'region_fallback' && secResult.payload) {
    console.log(`[V2 route] SEC region fallback returned directly (type=${secResult.payload.type})`);
    return {
      routerResult,
      handlerResult: secResult.payload,
      payload: secResult.payload,
    };
  }

  // SEC framework chunks (if any) will be merged into the decision context
  // further down. Held in `secResult.injectChunks`.
  const secInjectChunks = (secResult && secResult.mode === 'framework' && Array.isArray(secResult.injectChunks))
    ? secResult.injectChunks
    : [];

    // ── NEW: COMPARISON MERGE ──────────────────────────────────────────
  // If the user asks "A vs B", we must force the decision handler, even if
  // SEC only found data for A or dropped data. The decision handler will merge 
  // whatever SEC found with client signals (which may have data for B).
  const isComparisonQuestion = /\b(vs\.?|versus|against|compare)\b/i.test(question);

  if (isComparisonQuestion && !isListRequest) {
    console.log(`[V2 route] Comparison detected — forcing type=decision to merge SEC + Client signals.`);
    routerResult.type = 'decision';
  } else if (secInjectChunks.length > 0 && !isListRequest) {
    console.log(`[V2 route] SEC framework chunks present — forcing type=decision (was ${routerResult.type})`);
    routerResult.type = 'decision';
  } else if (secInjectChunks.length > 0 && isListRequest) {
    console.log(`[V2 route] SEC chunks present but user said "list" — ignoring SEC hijack.`);
  }
  // ───────────────────────────────────────────────────────────────────

  // ── 2. Non market-intelligence short-circuits ───────────────────────
  if (routerResult.intent === 'greeting') {
    return { routerResult, payload: await buildGreetingResponse({ routerResult, clientId, industry }) };
  }
  if (routerResult.intent === 'off_topic') {
    return { routerResult, payload: await buildOffTopicResponse({ routerResult, clientId, industry }) };
  }
  if (routerResult.intent === 'clarification') {
    return { routerResult, payload: await buildClarificationResponse({ routerResult, clientId, industry }) };
  }

    // ── 3. LIST — deterministic, client signals only ────────────────────
  //
  // Pipeline:
  //   1. Retrieve client signals.
  //   2. Concept filter (deterministic, cheap).
  //   3. Candidate cleanup (dedupe + Supabase verification).
  //   4. Per-item LLM selection (only when 2+ candidates survive cleanup).
  //   5. If zero items → no_data.
  //
  // Custom sources and SEC are NEVER used for list questions.
      if (routerResult.type === 'list') {
    // ── 1. FORCE CONCEPTS (Fixes the empty concepts=[] bug) ───────────
    // Concepts only: if a typo made the router return two spellings of one word
    // (filing / filling / fillings), keep just the shorter one.
    const dedupedConcepts = [];
    for (const c of (routerResult.concept_keywords || [])) {
      const lc = String(c).toLowerCase().trim();
      const idx = dedupedConcepts.findIndex((k) => {
        const kl = String(k).toLowerCase().trim();
        return kl === lc || stringSimilarity.compareTwoStrings(kl, lc) > 0.8;
      });
      if (idx === -1) dedupedConcepts.push(c);
      else if (String(c).length < String(dedupedConcepts[idx]).length) dedupedConcepts[idx] = c;
    }

    let conceptsForFilter = [
      ...dedupedConcepts,
      ...(routerResult.entity_mentions || []),
    ];
    
        // Time words are not topics. The time window is handled separately (time=90days).
    const LIST_TIME_WORDS = new Set([
      'quarter', 'quarters', 'quarterly', 'month', 'months', 'monthly',
      'week', 'weeks', 'weekly', 'day', 'days', 'daily',
      'year', 'years', 'yearly', 'annual', 'annually',
      'recent', 'recently', 'latest', 'current', 'today',
    ]);
    conceptsForFilter = conceptsForFilter.filter(
      (c) => !LIST_TIME_WORDS.has(String(c).toLowerCase().trim())
    );

    if (conceptsForFilter.length === 0) {
      const stopWords = new Set(['list', 'recent', 'the', 'in', 'for', 'of', 'and', 'or', 'to', 'a', 'an', 'sector', 'industry']);
      conceptsForFilter = question.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
    }

    const clientRetr = await retrieveClientSignals(question, clientId, industry, {
      precomputedUnderstanding: { ...routerResult, concept_keywords: conceptsForFilter },
    });

    const listEntities = cleanListEntities(routerResult, industry);

    let filtered = filterListHits(clientRetr.hits, conceptsForFilter);

    // Keyword filter removed everything and no company/place is named?
    // Don't give up. Keep the search matches and let the AI judge them.
    if (filtered.length === 0 && listEntities.length === 0 && clientRetr.hits.length > 0) {
      console.log(`[V2 route] list keyword filter removed all ${clientRetr.hits.length} hits — keeping them for AI selection`);
      filtered = clientRetr.hits;
    }

    // ── 2. STRICT CATEGORY PRE-CHECK (But flexible on categories) ──
    const qLower = question.toLowerCase();
    let allowedCategories = null;

    if (/\b(funding|investment|raise|series\s+[a-z]|vc|capital)\b/i.test(qLower)) {
      allowedCategories = ['funding', 'investment', 'industry structure'];
    } else if (/\b(acquisition|merger|m&a|takeover)\b/i.test(qLower)) {
      allowedCategories = ['acquisition', 'merger', 'industry structure'];
    } else if (/\b(new entrants|new players|startups|new brands|emerging brands)\b/i.test(qLower)) {
      allowedCategories = ['industry structure', 'product', 'innovation'];
    } else if (/\b(regulation|policy|law|compliance|regulatory)\b/i.test(qLower)) {
      allowedCategories = ['regulatory', 'compliance', 'policy', 'legal'];
    } else if (/\b(leadership|executive|ceo|hiring|talent)\b/i.test(qLower)) {
      allowedCategories = ['talent movement', 'industry structure']; // Added industry structure
    } else if (/\b(technology|ai|innovation|tech)\b/i.test(qLower)) {
      allowedCategories = ['technology', 'product', 'innovation'];
    } else if (/\b(expansion|expands|new market)\b/i.test(qLower)) {
      allowedCategories = ['industry structure', 'expansion', 'product'];
    } else if (/\b(partnership|joint venture|collaboration)\b/i.test(qLower)) {
      allowedCategories = ['industry structure', 'partnership', 'product', 'licensing'];
    } else if (/\b(launch|product launch|new product)\b/i.test(qLower)) {
      allowedCategories = ['product', 'innovation'];
    }

    let catFiltered = filtered;
    let categoryMatched = false;

    if (allowedCategories) {
      catFiltered = filtered.filter(h => {
        const cat = (h.category || h.insight_category || '').toLowerCase();
        return allowedCategories.some(allowed => cat.includes(allowed));
      });

      if (catFiltered.length > 0) {
        categoryMatched = true;
        filtered = catFiltered;
        console.log(`[V2 route] list category filter: kept ${filtered.length}/${clientRetr.hits.length} (allowed=[${allowedCategories.join(', ')}])`);
      } else {
        // If 0 matches, DO NOT throw away the signals. Keep all 15 and let the LLM decide.
        console.log(`[V2 route] list category filter: 0 matches, falling back to all ${filtered.length} signals`);
      }
    }
    // ────────────────────────────────────────────────────────────────

    if (filtered.length === 0) {
      const payload = await buildListResponse({ handlerResult: { items: [] }, clientId, industry, question });
      return { routerResult, handlerResult: { items: [] }, payload };
    }

    const candidates = await prepareListCandidates(filtered);

    if (candidates.length === 0) {
      const payload = await buildListResponse({ handlerResult: { items: [] }, clientId, industry, question });
      return { routerResult, handlerResult: { items: [] }, payload };
    }

        let selected = [];
    let missingEntityName = null;

    if (listEntities.length > 0) {
      // Question names a real company/place → keep only items that mention it.
      const mentionsAny = (text) => listEntities.some((e) => textMentions(text, e));
      const inTitle = candidates.filter((h) => mentionsAny(h.title || ''));
      const inText  = candidates.filter((h) => mentionsAny(`${h.title || ''} ${h.chunk_text || ''}`));

      if (inTitle.length > 0) {
        console.log(`[V2 route] list entity in TITLE: ${inTitle.length}/${candidates.length} [${listEntities.join(', ')}]`);
        selected = inTitle;
      } else if (inText.length > 0) {
        console.log(`[V2 route] list entity in TEXT: ${inText.length}/${candidates.length} [${listEntities.join(', ')}]`);
        selected = inText;
      } else {
        console.log(`[V2 route] list: nothing mentions [${listEntities.join(', ')}] — showing top general results`);
        missingEntityName = listEntities[0];
        selected = candidates.slice(0, 5);
      }
    } else if (candidates.length === 1) {
      selected = candidates;
    } else {
      try {
        selected = await selectRelevantHitsForList(question, candidates);
      } catch (err) {
        selected = candidates;
      }

      if (!selected || selected.length === 0) {
        // AI said nothing fits. Only keep items whose TITLE has a topic word.
        const topicWords = normalizeConcepts(conceptsForFilter);
        selected = candidates
          .filter((h) => topicWords.some((c) => containsPhrase(h.title || '', c)))
          .slice(0, 5);
        console.log(`[V2 route] list: AI kept 0 — title-word rescue kept ${selected.length}`);
      }

      // Same order every time
      const order = new Map(candidates.map((h, i) => [h, i]));
      selected = [...selected].sort((a, b) => order.get(a) - order.get(b));
    }

    if (!selected || selected.length === 0) {
      const payload = await buildListResponse({
        handlerResult: { items: [], _empty: true, _reason: 'no signals genuinely answer this question' },
        clientId, industry, question,
      });
      return { routerResult, handlerResult: { items: [] }, payload };
    }

    const handlerResult = await buildListItems(selected);

    // Same title shown twice? Keep only the first one.
    const seenTitles = new Set();
    handlerResult.items = (handlerResult.items || []).filter((it) => {
      const key = String(it.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key) return true;
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });

    const payload = await buildListResponse({ handlerResult, clientId, industry, missingEntityName });
    return { routerResult, handlerResult, payload };
  }

  // ── 4. INFERENCE / DECISION — full retrieval + deterministic filter ─
  const [clientRetr, customHits] = await Promise.all([
    retrieveClientSignals(question, clientId, industry, {
      precomputedUnderstanding: routerResult,
    }),
    retrieveCustomSourceHits(question, clientId),
  ]);

  const conceptsForFilter = [
    ...(routerResult.concept_keywords || []),
    ...(routerResult.entity_mentions || []),
  ];

  // Framework questions (SWOT / PESTLE / Five Forces / Risk) are STRUCTURAL —
  // they apply a template to whatever data exists; they don't ask "does
  // this hit mention the framework name". The concept filter is guaranteed
  // to drop all client hits on those questions because no client signal
  // literally says "swot" / "pestle" / etc. So we skip the filter for
  // framework questions and let the writer decide relevance.
  const isFrameworkQuestion = /\b(swot|pestle|pestel|five\s*forces|5\s*forces|porter|risk\s*analysis|risk\s*categor)/i.test(question);

  const keptClient = isFrameworkQuestion
    ? clientRetr.hits
    : filterForInferenceOrDecision(clientRetr.hits, conceptsForFilter);

  const keptCustom = customHits; // custom sources always kept

  // Merge SEC chunks (if the SEC handler produced any) into the client
  // hits. SEC chunks bypass the deterministic concept filter because they
  // were retrieved by SEC-specific logic (ticker + framework item codes).
  const keptClientWithSec = secInjectChunks.length
    ? [...secInjectChunks, ...keptClient]
    : keptClient;

  // For inference, SEC chunks don't count toward material — inference
  // never consumes them. For decision, they do.
  const materialCount = routerResult.type === 'decision'
    ? keptClientWithSec.length + keptCustom.length
    : keptClient.length + keptCustom.length;
  const hasMaterial = materialCount > 0;

  console.log(
    `[V2 route] ${routerResult.type} filter: kept client=${keptClient.length}/${clientRetr.hits.length} ` +
    `sec=${secInjectChunks.length} custom=${keptCustom.length} (concepts=[${conceptsForFilter.join(', ')}])`
  );

  if (!hasMaterial) {
    if (routerResult.type === 'inference') {
      const payload = await buildInferenceResponse({
        handlerResult: { _empty: true, _reason: 'no relevant content matched this question' },
        clientId,
        question,
      });
      return { routerResult, payload };
    }
    const payload = await buildDecisionResponse({
      handlerResult: { _empty: true, _reason: 'no relevant content matched this question' },
      clientId,
      question,
    });
    return { routerResult, payload };
  }

  if (routerResult.type === 'inference') {
    // SEC chunks only attach to decision — inference stays client+custom only.
    const handlerResult = await buildInferenceAnswer(question, keptClient, keptCustom, routerResult);
    const payload = await buildInferenceResponse({ handlerResult, clientId, question });
    return { routerResult, handlerResult, payload };
  }

  // decision — SEC chunks merged in (empty array if SEC didn't fire)
  const handlerResult = await buildDecisionAnswer(question, keptClientWithSec, keptCustom, routerResult);
  const payload = await buildDecisionResponse({ handlerResult, clientId, question });
  return { routerResult, handlerResult, payload };
}

// ─────────────────────────────────────────────────────────────────────────
// Route registration
// ─────────────────────────────────────────────────────────────────────────
function registerDecisionIntelligenceV2Route(app) {
  app.post('/decision-intelligence-v2/chat', async (req, res) => {
    try {
      let {
        question,
        clientId,
        industry,
        userId,
        conversationId: incomingConversationId,
        type: providedType,
      } = req.body;

      if (!question || !clientId || !industry || !userId) {
        return res.status(400).json({
          error: 'question, clientId, industry, and userId are required',
        });
      }

      let conversationId = incomingConversationId;
      if (!conversationId) {
        conversationId = await createConversation({
          clientId,
          userId,
          firstQuestion: question,
        });
      }

      question = normalizeSquishedBrands(question);
      await appendMessage({ conversationId, role: 'user', content: question });

      let result;
      try {
        result = await runV2Pipeline({
          question,
          clientId,
          industry,
          forcedType: providedType || null,
        });
      } catch (err) {
        console.error('[V2 pipeline] error:', err.message);
        return res.status(500).json({ error: err.message });
      }

      const { payload, routerResult } = result;

      let assistantContent;
      if (payload.greeting && payload.message) {
        assistantContent = String(payload.message).slice(0, 200);
      } else if (payload.no_data && payload.message) {
        assistantContent = String(payload.message).slice(0, 200);
      } else if (payload.type === 'list') {
        assistantContent = `List: ${payload.items?.length ?? 0} items`;
      } else {
        assistantContent = (payload.report?.title || '').slice(0, 200);
      }

      try {
        await appendMessage({
          conversationId,
          role: 'assistant',
          content: assistantContent,
          type: payload.type,
          payload,
        });
      } catch (err) {
        console.log(`[V2 route] failed to persist assistant message: ${err.message}`);
      }

      return res.json({
        ...payload,
        conversationId,
        classifierReasoning: routerResult.primary_intent || null,
      });

    } catch (err) {
      console.error('[DecisionIntelligenceV2] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // NEW — chatContext-wrapped chat.
  //
  // Same as /chat, but:
  //   1. Loads conversation state
  //   2. Runs context resolver (LLM) to produce a standalone query
  //   3. For greeting/off_topic/clarification → pass raw message, skip updater
  //      Otherwise                              → pass standalone query
  //   4. Runs state updater after the answer (non-small-talk only)
  //
  // Response shape is identical to /chat, plus `resolver` and `state`
  // for debugging. Existing /chat is untouched.
  // ───────────────────────────────────────────────────────────────────────
  app.post('/decision-intelligence-v2/chat-with-memory', async (req, res) => {
    try {
      let {
        question,
        clientId,
        industry,
        userId,
        conversationId: incomingConversationId,
        type: providedType,
      } = req.body;

      if (!question || !clientId || !industry || !userId) {
        return res.status(400).json({
          error: 'question, clientId, industry, and userId are required',
        });
      }

      let conversationId = incomingConversationId;
      if (!conversationId) {
        conversationId = await createConversation({
          clientId,
          userId,
          firstQuestion: question,
        });
      }

      // ── 1. Load conversation state (before resolver needs it) ─────────
      let currentState = {};
      try {
        currentState = await loadState(conversationId);
      } catch (err) {
        console.log(`[chat-with-memory] loadState failed: ${err.message}`);
      }

      // ── 2. Normalize + Persist user message BEFORE resolver ──────────
      question = normalizeSquishedBrands(question);
      await appendMessage({ conversationId, role: 'user', content: question });

      // ── 3. Run context resolver ───────────────────────────────────────
      let resolverResult;
      try {
        resolverResult = await resolveContext({
          conversationId,
          userMessage: question,
          currentState,
        });
      } catch (err) {
        console.log(`[chat-with-memory] resolver threw, using raw question: ${err.message}`);
        resolverResult = {
          kind: 'new_question',
          standalone_query: question,
          references: [],
          context_used: [],
          new_constraints: [],
          _fallback: true,
        };
      }

      // ── 4. Decide what query to send to the pipeline ──────────────────
      const skipStateUpdate =
        resolverResult.kind === 'greeting' ||
        resolverResult.kind === 'off_topic' ||
        resolverResult.kind === 'clarification';

      const queryForPipeline = skipStateUpdate
        ? question
        : resolverResult.standalone_query;

      // ── 4.5. REFORMAT — bypass pipeline entirely ──────────────────────
      if (resolverResult.kind === 'reformat') {
        console.log(`[chat-with-memory] kind=reformat — bypassing pipeline`);

        let reformatResult;
        try {
          reformatResult = await reformatPreviousAnswer({
            conversationId,
            instruction: resolverResult.standalone_query,
          });
        } catch (err) {
          console.log(`[chat-with-memory] reformatter threw: ${err.message}`);
          reformatResult = { payload: null, previousFound: false };
        }

        if (!reformatResult.payload) {
          const fallbackPayload = {
            type: 'list',
            items: [],
            no_data: true,
            message: reformatResult.previousFound
              ? "I couldn't reformat the previous answer. Try rephrasing or asking the question again."
              : "There's no previous answer in this conversation to reformat.",
            suggestions: [],
          };
          return res.json({
            ...fallbackPayload,
            conversationId,
            classifierReasoning: 'reformat (fallback)',
            resolver: resolverResult,
            state: currentState,
          });
        }

        const payload = reformatResult.payload;
        const assistantContent = (payload.report?.title || '').slice(0, 200);

        try {
          await appendMessage({
            conversationId,
            role: 'assistant',
            content: assistantContent,
            type: payload.type,
            payload,
          });
        } catch (err) {
          console.log(`[chat-with-memory] failed to persist reformat: ${err.message}`);
        }

        return res.json({
          ...payload,
          conversationId,
          classifierReasoning: 'reformat',
          resolver: resolverResult,
          state: currentState,
        });
      }

      console.log(
        `[chat-with-memory] kind=${resolverResult.kind} ` +
        `skipUpdater=${skipStateUpdate} ` +
        `query="${queryForPipeline.slice(0, 120)}"`
      );

      // ── 4.5. REFORMAT — bypass pipeline entirely ──────────────────────
      if (resolverResult.kind === 'reformat') {
        console.log(`[chat-with-memory] kind=reformat — bypassing pipeline`);

        let reformatResult;
        try {
          reformatResult = await reformatPreviousAnswer({
            conversationId,
            instruction: resolverResult.standalone_query,
          });
        } catch (err) {
          console.log(`[chat-with-memory] reformatter threw: ${err.message}`);
          reformatResult = { payload: null, previousFound: false };
        }

        if (!reformatResult.payload) {
          const fallbackPayload = {
            type: 'list',
            items: [],
            no_data: true,
            message: reformatResult.previousFound
              ? "I couldn't reformat the previous answer. Try rephrasing or asking the question again."
              : "There's no previous answer in this conversation to reformat.",
            suggestions: [],
          };
          return res.json({
            ...fallbackPayload,
            conversationId,
            classifierReasoning: 'reformat (fallback)',
            resolver: {
              kind: 'reformat',
              standalone_query: resolverResult.standalone_query,
              references: resolverResult.references || [],
              context_used: resolverResult.context_used || [],
              new_constraints: resolverResult.new_constraints || [],
            },
            state: currentState,
          });
        }

        const payload = reformatResult.payload;
        const assistantContent = (payload.report?.title || '').slice(0, 200);

        try {
          await appendMessage({
            conversationId,
            role: 'assistant',
            content: assistantContent,
            type: payload.type,
            payload,
          });
        } catch (err) {
          console.log(`[chat-with-memory] failed to persist reformat: ${err.message}`);
        }

        return res.json({
          ...payload,
          conversationId,
          classifierReasoning: 'reformat',
          resolver: {
            kind: 'reformat',
            standalone_query: resolverResult.standalone_query,
            references: resolverResult.references || [],
            context_used: resolverResult.context_used || [],
            new_constraints: resolverResult.new_constraints || [],
          },
          state: currentState,
        });
      }

      // ── 5. Run existing V2 pipeline ───────────────────────────────────
      let result;
      try {
        result = await runV2Pipeline({
          question: queryForPipeline,
          clientId,
          industry,
          forcedType: providedType || null,
        });
      } catch (err) {
        console.error('[chat-with-memory] pipeline error:', err.message);
        return res.status(500).json({ error: err.message });
      }

      const { payload, routerResult } = result;

      let assistantContent;
      if (payload.greeting && payload.message) {
        assistantContent = String(payload.message).slice(0, 200);
      } else if (payload.no_data && payload.message) {
        assistantContent = String(payload.message).slice(0, 200);
      } else if (payload.type === 'list') {
        assistantContent = `List: ${payload.items?.length ?? 0} items`;
      } else {
        assistantContent = (payload.report?.title || '').slice(0, 200);
      }

      try {
        await appendMessage({
          conversationId,
          role: 'assistant',
          content: assistantContent,
          type: payload.type,
          payload,
        });
      } catch (err) {
        console.log(`[chat-with-memory] failed to persist assistant message: ${err.message}`);
      }

      // ── 6. State updater (skip for small-talk kinds) ──────────────────
      let finalState = currentState;
      if (!skipStateUpdate) {
        try {
          const updaterResult = await updateState({
            conversationId,
            userMessage: queryForPipeline,
            answer: assistantContent,
            currentState,
          });
          finalState = updaterResult.updatedState;
        } catch (err) {
          console.log(`[chat-with-memory] state updater failed: ${err.message}`);
        }
      }

      return res.json({
        ...payload,
        conversationId,
        classifierReasoning: routerResult.primary_intent || null,
        resolver: {
          kind: resolverResult.kind,
          standalone_query: resolverResult.standalone_query,
          references: resolverResult.references,
          context_used: resolverResult.context_used,
          new_constraints: resolverResult.new_constraints,
        },
        state: finalState,
      });

    } catch (err) {
      console.error('[DecisionIntelligenceV2 chat-with-memory] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerDecisionIntelligenceV2Route, runV2Pipeline };