/**
 * modules/decisionIntelligenceV2/handlers/secHandler.js
 *
 * SEC sidecar for V2.
 *
 * This file is OPTIONAL. If anything inside it throws, it returns null
 * and V2 runs exactly as it does today. No V2 behavior is modified by
 * the presence of this file.
 *
 * Decides whether a question is SEC-shaped, and if so:
 *   1. Company-set ("top 5 cosmetic companies by revenue") → numeric path
 *      with allowlist subsector picking + financial_facts + chart. 0 LLM.
 *   2. Named ticker + numeric ("Apple revenue last 3 years") → numeric
 *      path from financial_facts. 0 LLM.
 *   3. Named ticker + framework ("SWOT for Estée Lauder") → pulls SEC
 *      narrative chunks and returns them as `injectChunks` so V2's
 *      decisionHandler merges them into its writer context.
 *
 * Non-US geography:
 *   · If the question names a non-US region and is SEC-numeric-shaped
 *     (ranking / financial metric / company-set), we NEVER fall through.
 *     Instead we look for hits that mention the region AND match the
 *     question's topic. If we find enough, return a list. Otherwise
 *     return no_data.
 *   · If the question names a non-US region but is NOT SEC-numeric (e.g.
 *     a SWOT for a non-US market), we fall through to V2 as before.
 */

const { detectNonUSGeography, resolveCompanySet } = require('../sec/resolveCompanySet');
const {
  resolveCompanySetFacts,
} = require('../sec/subsectorResolver');
const { extractIntent, retrieveForIntent, getAllCompanies } = require('../sec/secRetrieval');
const { buildNumericAnswer } = require('../sec/buildNumericAnswer');
const { decideChartFormat, renderChart } = require('../sec/chartPipeline');
const { getRegionAliases } = require('../sec/regionAliases');
const { containsPhrase, normalizeConcepts } = require('../retrieval/filterListHits');

// ─────────────────────────────────────────────────────────────────────────
// Module IDs
// ─────────────────────────────────────────────────────────────────────────
const POLICY_MODULE_ID = '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960';
const MD_MODULE_ID     = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const FO_MODULE_ID     = '2eb989fd-0ea0-4320-b73a-f7eb8b970473';

const FRAMEWORK_CATEGORIES = new Set(['swot', 'pestle', 'five_forces', 'risk_analysis']);

const NUMERIC_KEYWORDS = [
  'revenue', 'net income', 'profit', 'earnings', 'eps', 'margin',
  'total assets', 'total liabilities', 'cash flow', 'how much',
  'what was the', 'capital expenditure', 'r&d spending',
];

// Threshold for the region fallback: how many topic+region-matching hits
// we need before we surface them as a list. Below this we return no_data.
const REGION_MIN_HITS = 3;

// ─────────────────────────────────────────────────────────────────────────
// Shape detection
// ─────────────────────────────────────────────────────────────────────────
function detectSecShape(question, routerResult, intent) {
  const q = String(question || '').toLowerCase();

  if (routerResult && routerResult.is_company_set_query === true) {
    return 'company_set';
  }

  const hasTickers = Array.isArray(intent.tickers) && intent.tickers.length > 0;
  if (!hasTickers) return null;

  if (FRAMEWORK_CATEGORIES.has(intent.questionCategory)) return 'framework';

  const looksNumeric = NUMERIC_KEYWORDS.some((k) => q.includes(k));
  if (looksNumeric) return 'numeric';

  if (intent.questionCategory === 'qualitative') return 'framework';

  return null;
}

/**
 * Is the question unambiguously asking for SEC-grade numeric data?
 *
 * Broad on purpose — a false positive here just costs one extra filter
 * pass and produces an honest list or no_data response. A false negative
 * means V2 gets to hallucinate a ranked answer from news signals.
 */
function isSecNumericQuestion(question, routerResult, intent) {
  if (routerResult && routerResult.is_company_set_query === true) return true;

  const q = String(question || '').toLowerCase();

  // Ranking phrases
  const hasRanking =
    /\btop\s+\d+\b/.test(q) ||
    /\brank(ed|ing)?\b/.test(q) ||
    /\bhighest\b|\blargest\b|\bbiggest\b|\bbest\b\s+by\b/.test(q) ||
    /\bcompare\b.*\bby\b/.test(q);

  // Financial metric phrases
  const hasMetric = NUMERIC_KEYWORDS.some((k) => q.includes(k)) ||
    /\bby\s+(revenue|sales|income|profit|earnings|market\s*cap|assets|liabilities)\b/.test(q);

  if (hasRanking && hasMetric) return true;

  // Named ticker + numeric keyword is also SEC-numeric
  const hasTickers = Array.isArray(intent.tickers) && intent.tickers.length > 0;
  if (hasTickers && hasMetric) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Region fallback helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Deterministic filter: returns hits whose title or chunk_text mentions
 * the region (or one of its aliases) AND matches at least one of the
 * question's concepts.
 *
 * If concepts is empty, we only require the region match — otherwise a
 * router failure would turn a valid region answer into no_data.
 */
function findRegionHits(hits, region, concepts) {
  const aliases = getRegionAliases(region);
  if (!aliases.length) return { passing: [], regionMatchCount: 0 };

  const cleanConcepts = normalizeConcepts(concepts);
  const requireTopic = cleanConcepts.length > 0;

  let regionMatchCount = 0;
  const passing = [];

  for (const h of hits || []) {
    const haystack = `${h.title || ''} ${h.chunk_text || ''}`;

    // Region check
    const regionMatch = aliases.some((a) => containsPhrase(haystack, a));
    if (!regionMatch) continue;
    regionMatchCount++;

    // Topic check (skip if no concepts available)
    if (requireTopic) {
      const topicMatch = cleanConcepts.some((c) => containsPhrase(haystack, c));
      if (!topicMatch) continue;
    }

    passing.push(h);
  }

  return { passing, regionMatchCount };
}

/**
 * Builds the response payload when a non-US SEC-numeric question is
 * detected. Either surfaces region+topic-matching hits as a list, or
 * returns no_data with an explanatory message.
 */
async function buildRegionFallbackPayload(region, passingHits, regionMatchCount, question) {
  const { getVerifiedSuggestions } = require('../decisionIntelligence/suggestionEngine');

  if (passingHits.length >= REGION_MIN_HITS) {
    // Surface the hits as a list with an explanatory message.
    // Reuse listHandler to produce clean items from the filtered hits.
    const { buildListItems } = require('./listHandler');

    let items = [];
    try {
      const result = await buildListItems(passingHits);
      items = result.items || [];
    } catch (err) {
      console.log(`[secHandler:region] buildListItems failed: ${err.message}`);
    }

    if (items.length >= REGION_MIN_HITS) {
      return {
        type: 'list',
        items,
        message:
          `I can't rank companies by revenue for ${region} — our SEC financial data ` +
          `covers US-listed companies only. Here's what our collected signals show ` +
          `for ${region} instead.`,
      };
    }
  }

  // Not enough signal — return no_data
  let suggestions = [];
  try {
    suggestions = await getVerifiedSuggestions(null, 4);
  } catch (err) {
    console.log(`[secHandler:region] suggestions failed: ${err.message}`);
  }
  if (!suggestions || !suggestions.length) {
    suggestions = [
      'What are the major policy changes affecting my industry?',
      'What recent market activity is happening in my sector?',
    ];
  }

  let message;
  if (regionMatchCount === 0) {
    message =
      `I can't rank companies by revenue for ${region} — our SEC financial data ` +
      `covers US-listed companies only — and I don't have any ${region}-specific ` +
      `signals that answer this. Try dropping the country, or asking about ${region} ` +
      `market activity instead.`;
  } else {
    message =
      `I can't rank companies by revenue for ${region} — our SEC financial data ` +
      `covers US-listed companies only — and the ${region} signals I have don't ` +
      `directly answer this. Try dropping the country, or asking about ${region} ` +
      `market activity instead.`;
  }

  return {
    type: 'list',
    items: [],
    no_data: true,
    message,
    suggestions,
  };
}

/**
 * Top-level region fallback. Retrieves client + custom hits, filters by
 * region + topic, and produces a payload. Wrapped so any failure is
 * caught by the outer try in buildSecAnswer.
 */
async function buildRegionFallback(question, region, clientId, industry, routerResult) {
  const { retrieveClientSignals } = require('../retrieval/clientSignalsRetrieval');
  const { retrieveCustomSourceHits } = require('../retrieval/customSourceRetrieval');

  const concepts = [
    ...((routerResult && routerResult.concept_keywords) || []),
    ...((routerResult && routerResult.entity_mentions) || []),
  ];

  // Fetch both sides in parallel — same retrieval V2 would use.
  let clientHits = [];
  let customHits = [];
  try {
    const [clientRetr, customRetr] = await Promise.all([
      retrieveClientSignals(question, clientId, industry, {
        precomputedUnderstanding: routerResult,
      }),
      retrieveCustomSourceHits(question, clientId),
    ]);
    clientHits = clientRetr?.hits || [];
    customHits = customRetr || [];
  } catch (err) {
    console.log(`[secHandler:region] retrieval failed: ${err.message}`);
  }

  // Normalize custom hits to the same shape used by buildListItems —
  // they carry their fields under .payload.
  const normalizedCustom = customHits.map((c, idx) => ({
    id: c.id || `custom_${idx}`,
    score: c.score || 0,
    module_id: '__custom__',
    module_name: 'Uploaded Document',
    title: c.payload?.source_name || c.payload?.title || 'Uploaded document',
    chunk_text: c.payload?.chunk_text || '',
    article_id: null,
    published_date: null,
    submodule_id: null,
    _matched: true,
    _custom: true,
    _custom_payload: c.payload || {},
  }));

  const combined = [...clientHits, ...normalizedCustom];

  const { passing, regionMatchCount } = findRegionHits(combined, region, concepts);

  console.log(
    `[secHandler:region] region="${region}" concepts=[${concepts.join(', ')}] ` +
    `regionHits=${regionMatchCount} topicHits=${passing.length} ` +
    `passing=${passing.length}/${REGION_MIN_HITS} → ${passing.length >= REGION_MIN_HITS ? 'LIST' : 'NO_DATA'}`
  );

  return {
    mode: 'region_fallback',
    payload: await buildRegionFallbackPayload(region, passing, regionMatchCount, question),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Chart helper
// ─────────────────────────────────────────────────────────────────────────
async function tryBuildChart(intent, facts) {
  if (!Array.isArray(facts) || facts.length < 2) return { chart: null, chartMeta: null };
  try {
    const display = decideChartFormat(intent, facts);
    if (display.format === 'chart') {
      const chart = await renderChart(display.chartData);
      return { chart, chartMeta: { chartType: display.chartType } };
    }
    const tickers = [...new Set(facts.map((f) => f.ticker))];
    const years = [...new Set(facts.map((f) => f.fiscal_year))].sort();

    let chartData = null;
    if (tickers.length === 1 && years.length > 1) {
      const t = tickers[0];
      chartData = {
        type: 'line',
        xAxis: 'year',
        metricLabel: facts[0]?.metric_name || 'Value',
        series: [{
          name: t,
          labels: years,
          data: years.map((y) => {
            const f = facts.find((x) => x.ticker === t && x.fiscal_year === y);
            return f && f.metric_value !== null ? Number(f.metric_value) : null;
          }),
        }],
      };
    } else if (tickers.length > 1) {
      chartData = {
        type: 'bar',
        xAxis: 'company',
        metricLabel: facts[0]?.metric_name || 'Value',
        series: tickers.map((t) => {
          const f = facts.find((x) => x.ticker === t);
          return {
            name: t,
            labels: [t],
            data: [f && f.metric_value !== null ? Number(f.metric_value) : null],
          };
        }),
      };
    }
    if (!chartData) return { chart: null, chartMeta: null };
    const chart = await renderChart(chartData);
    return { chart, chartMeta: { chartType: chartData.type } };
  } catch (err) {
    console.log(`[secHandler] chart failed: ${err.message}`);
    return { chart: null, chartMeta: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Numeric path — company-set
// ─────────────────────────────────────────────────────────────────────────
async function runCompanySetPath(question, intent) {
  const filter = await resolveCompanySet(question);
  if (!filter) return null;

  if (filter.sector === null && filter.unresolvedTerm) {
    console.log(`[secHandler] company-set unresolved: "${filter.unresolvedTerm}" — falling through`);
    return null;
  }

  const factsResult = await resolveCompanySetFacts(filter);
  const facts = factsResult?.facts || [];

  if (!facts.length) {
    console.log(`[secHandler] company-set produced 0 facts — falling through`);
    return null;
  }

  const enrichedFacts = await enrichFactsWithNames(facts);
  const bodyText = buildNumericAnswer(enrichedFacts);

  const sources = (factsResult.sources || []).map((s) => ({
    type: 'sec',
    title: s.title,
    url: s.url,
    ticker: s.ticker,
    fiscal_year: s.fiscal_year,
    item_code: s.item_code,
  }));

  const chartIntent = {
    ...intent,
    dataType: 'quantitative',
    questionCategory: 'comparison',
    metric: filter.metric,
    tickers: [...new Set(facts.map((f) => f.ticker))],
    isChartable: facts.length >= 2,
  };
  const { chart, chartMeta } = await tryBuildChart(chartIntent, enrichedFacts);

  console.log(
    `[secHandler] company-set numeric answer: ${facts.length} fact(s), ` +
    `${sources.length} source(s), chart=${!!chart}`
  );

  return {
    mode: 'numeric',
    payload: {
      type: 'decision',
      report: { title: question, bodyText },
      sources,
      chart,
      chartMeta,
    },
    handlerResult: {
      report: { title: question, bodyText },
      sources,
      chart,
      chartMeta,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Numeric path — named tickers
// ─────────────────────────────────────────────────────────────────────────
async function runNumericPath(question, intent) {
  const { facts } = await retrieveForIntent(question, intent);
  if (!facts || !facts.length) {
    console.log(`[secHandler] numeric path: 0 facts for tickers=[${intent.tickers.join(',')}]`);
    return null;
  }

  const enrichedFacts = await enrichFactsWithNames(facts);
  const bodyText = buildNumericAnswer(enrichedFacts);
  const sources = await buildNumericSources(enrichedFacts);
  const { chart, chartMeta } = await tryBuildChart(intent, enrichedFacts);

  console.log(
    `[secHandler] numeric answer: ${facts.length} fact(s) for [${intent.tickers.join(',')}], ` +
    `${sources.length} source(s), chart=${!!chart}`
  );

  return {
    mode: 'numeric',
    payload: {
      type: 'decision',
      report: { title: question, bodyText },
      sources,
      chart,
      chartMeta,
    },
    handlerResult: {
      report: { title: question, bodyText },
      sources,
      chart,
      chartMeta,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Framework path — pull SEC chunks, hand back for V2 decisionHandler
// ─────────────────────────────────────────────────────────────────────────
async function runFrameworkPath(question, intent) {
  const { chunks } = await retrieveForIntent(question, intent);
  if (!chunks || !chunks.length) {
    console.log(`[secHandler] framework path: 0 chunks for [${intent.tickers.join(',')}]`);
    return null;
  }

  const injectChunks = chunks.map((c) => ({
    id: c.qdrant_point_id || null,
    score: 1.0,
    module_id: '__sec__',
    module_name: 'SEC Filing',
    title: `${c.ticker} ${c.fiscal_year} 10-K — ${c.item_code}`,
    chunk_text: c.chunk_text || '',
    article_id: null,
    published_date: null,
    submodule_id: null,
    _matched: true,
    _vector_score: 1.0,
    _boost_mult: 1.0,
    _boost_penalty: 1.0,
    _boost_matched: { conceptsInTitle: [], entitiesInTitle: [] },
    _sec: true,
    _sec_payload: {
      ticker: c.ticker,
      fiscal_year: c.fiscal_year,
      item_code: c.item_code,
      qdrant_point_id: c.qdrant_point_id || null,
    },
  }));

  console.log(
    `[secHandler] framework path: injecting ${injectChunks.length} SEC chunk(s) ` +
    `for [${intent.tickers.join(',')}] into V2 decisionHandler`
  );

  return {
    mode: 'framework',
    injectChunks,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
async function enrichFactsWithNames(facts) {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const tickers = [...new Set(facts.map((f) => f.ticker))];
  const nameByTicker = {};
  if (tickers.length) {
    const { data } = await supabase
      .from('companies')
      .select('ticker, company_name')
      .in('ticker', tickers);
    (data || []).forEach((c) => { nameByTicker[c.ticker] = c.company_name; });
  }
  return facts.map((f) => ({
    ...f,
    company_name: nameByTicker[f.ticker] || f.ticker,
  }));
}

async function buildNumericSources(facts) {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const tickers = [...new Set(facts.map((f) => f.ticker))];

  const { data: companies } = await supabase
    .from('companies')
    .select('ticker, company_name, cik')
    .in('ticker', tickers);
  const cikByTicker = {};
  const nameByTicker = {};
  (companies || []).forEach((c) => {
    cikByTicker[c.ticker] = c.cik;
    nameByTicker[c.ticker] = c.company_name;
  });

  const filingIds = [...new Set(facts.map((f) => f.filing_id).filter(Boolean))];
  const filingById = {};
  if (filingIds.length) {
    const { data: filings } = await supabase
      .from('filings')
      .select('*')
      .in('id', filingIds);
    (filings || []).forEach((r) => { filingById[r.id] = r; });
  }

  const sources = [];
  const seen = new Set();
  for (const f of facts) {
    const key = `${f.ticker}:${f.fiscal_year}:${f.metric_name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const filing = f.filing_id ? filingById[f.filing_id] : null;
    const cik = cikByTicker[f.ticker];
    const directUrl =
      filing?.source_url || filing?.url || filing?.filing_url || filing?.sec_url || null;
    const fallbackUrl = cik
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K&dateb=&owner=include&count=10`
      : null;

    sources.push({
      type: 'sec',
      title: `${nameByTicker[f.ticker] || f.ticker} (${f.ticker}) — FY${f.fiscal_year} ${f.metric_name}`,
      url: directUrl || fallbackUrl,
      ticker: f.ticker,
      fiscal_year: f.fiscal_year,
      item_code: f.metric_name,
    });
  }
  return sources;
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────
async function buildSecAnswer({ question, routerResult, clientId, industry }) {
  try {
    if (!question || typeof question !== 'string' || !question.trim()) return null;

    let intent;
    try {
      intent = await extractIntent(question, getAllCompanies);
    } catch (err) {
      console.log(`[secHandler] extractIntent failed: ${err.message}`);
      return null;
    }

    const shape = detectSecShape(question, routerResult, intent);
    if (!shape) {
      console.log(`[secHandler] not SEC-shaped — falling through`);
      return null;
    }

    console.log(`[secHandler] shape=${shape} tickers=[${(intent.tickers || []).join(',')}]`);

    // ── Non-US geography handling ──────────────────────────────────────
    const nonUs = detectNonUSGeography(question);

    if (nonUs) {
      // Is this an SEC-numeric question? Ranking, financial metric, etc.
      if (isSecNumericQuestion(question, routerResult, intent)) {
        // SEC-numeric + non-US → never fall through. Look for
        // region+topic-matching hits, or return no_data.
        console.log(`[secHandler] non-US "${nonUs}" + SEC-numeric → region fallback`);
        return await buildRegionFallback(question, nonUs, clientId, industry, routerResult);
      }

      // Non-US but not SEC-numeric (framework, narrative, list).
      // Let V2 handle it — it can answer from client signals.
      console.log(`[secHandler] non-US "${nonUs}" but not SEC-numeric — falling through to V2`);
      return null;
    }

    // ── Dispatch ───────────────────────────────────────────────────────
    if (shape === 'company_set') return await runCompanySetPath(question, intent);
    if (shape === 'numeric')     return await runNumericPath(question, intent);
    if (shape === 'framework')   return await runFrameworkPath(question, intent);

    return null;

  } catch (err) {
    console.log(`[secHandler] unhandled error, falling through to V2: ${err.message}`);
    return null;
  }
}

module.exports = {
  buildSecAnswer,
  detectSecShape,
  isSecNumericQuestion,
  findRegionHits,
  buildRegionFallback,
  buildRegionFallbackPayload,
  runCompanySetPath,
  runNumericPath,
  runFrameworkPath,
};