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
 * Non-US geography: if a question names a non-US region and is SEC-shaped,
 * this returns null silently. V2 answers it from client data / custom
 * sources instead. No hard refusal is issued by this handler.
 */

const { detectNonUSGeography } = require('../sec/resolveCompanySet');
const { resolveCompanySet } = require('../sec/resolveCompanySet');
const {
  resolveCompanySetFacts,
  selectCompaniesForSubsector,
  findAllowlistTickers,
} = require('../sec/subsectorResolver');
const { extractIntent, retrieveForIntent, getAllCompanies } = require('../sec/secRetrieval');
const { buildNumericAnswer } = require('../sec/buildNumericAnswer');
const { decideChartFormat, renderChart } = require('../sec/chartPipeline');
const { resolveSecUrls } = require('../sec/secUrlResolver');

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

// ─────────────────────────────────────────────────────────────────────────
// Shape detection
// ─────────────────────────────────────────────────────────────────────────

/**
 * Returns one of:
 *   'company_set'   → run company-set numeric path
 *   'numeric'       → run named-ticker numeric path
 *   'framework'     → pull SEC chunks, inject into V2 decisionHandler
 *   null            → not SEC-shaped; V2 handles normally
 */
function detectSecShape(question, routerResult, intent) {
  const q = String(question || '').toLowerCase();

  // Company-set query (from router's classification)
  if (routerResult && routerResult.is_company_set_query === true) {
    return 'company_set';
  }

  // A named ticker must be present for the other two paths
  const hasTickers = Array.isArray(intent.tickers) && intent.tickers.length > 0;
  if (!hasTickers) return null;

  // Framework + ticker
  if (FRAMEWORK_CATEGORIES.has(intent.questionCategory)) return 'framework';

  // Numeric + ticker
  const looksNumeric = NUMERIC_KEYWORDS.some((k) => q.includes(k));
  if (looksNumeric) return 'numeric';

  // Ticker named but nothing else specific — treat as framework-style
  // so we still surface SEC narrative chunks.
  if (intent.questionCategory === 'qualitative') return 'framework';

  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Chart helper — same shape chartPipeline.js expects
// ─────────────────────────────────────────────────────────────────────────
async function tryBuildChart(intent, facts) {
  if (!Array.isArray(facts) || facts.length < 2) return { chart: null, chartMeta: null };
  try {
    const display = decideChartFormat(intent, facts);
    if (display.format === 'chart') {
      const chart = await renderChart(display.chartData);
      return { chart, chartMeta: { chartType: display.chartType } };
    }
    // decideChartFormat returned 'text' but we have multiple values —
    // force a sensible default so the user always gets a visual.
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

  // Unresolved sector term → not our problem, fall through to V2
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

  // Enrich facts with human-readable company names
  const enrichedFacts = await enrichFactsWithNames(facts);

  // Build the text answer (no LLM)
  const bodyText = buildNumericAnswer(enrichedFacts);

  // Sources come straight from resolveCompanySetFacts (already SEC URLs)
  const sources = (factsResult.sources || []).map((s) => ({
    type: 'sec',
    title: s.title,
    url: s.url,
    ticker: s.ticker,
    fiscal_year: s.fiscal_year,
    item_code: s.item_code,
  }));

  // Chart
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

  // Build sources from fact + filings
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

  // Convert SEC chunks into the V2 hit shape so buildDecisionAnswer's
  // buildContext() consumes them the same way it consumes client hits.
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

  // Look up company + CIK
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

  // Look up filings by filing_id
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
  // Everything is wrapped in try/catch. Any failure returns null so V2
  // runs unmodified.
  try {
    if (!question || typeof question !== 'string' || !question.trim()) return null;

    // Extract intent (tickers, years, framework detection) via the old
    // deterministic code path. No LLM beyond what extractIntent itself
    // does — which is nothing (pure lookup + fuzzy match).
    let intent;
    try {
      intent = await extractIntent(question, getAllCompanies);
    } catch (err) {
      console.log(`[secHandler] extractIntent failed: ${err.message}`);
      return null;
    }

    // Detect SEC shape
    const shape = detectSecShape(question, routerResult, intent);
    if (!shape) {
      console.log(`[secHandler] not SEC-shaped — falling through`);
      return null;
    }

    console.log(`[secHandler] shape=${shape} tickers=[${(intent.tickers || []).join(',')}]`);

    // Non-US geography guard.
    // If the question names a non-US region AND is SEC-shaped, drop SEC
    // silently. V2 will answer from client data / custom sources.
    const nonUs = detectNonUSGeography(question);
    if (nonUs) {
      console.log(`[secHandler] non-US geography "${nonUs}" — dropping SEC, V2 will handle`);
      return null;
    }

    // Dispatch
    if (shape === 'company_set') {
      return await runCompanySetPath(question, intent);
    }
    if (shape === 'numeric') {
      return await runNumericPath(question, intent);
    }
    if (shape === 'framework') {
      return await runFrameworkPath(question, intent);
    }

    return null;

  } catch (err) {
    console.log(`[secHandler] unhandled error, falling through to V2: ${err.message}`);
    return null;
  }
}

module.exports = {
  buildSecAnswer,
  detectSecShape,
  runCompanySetPath,
  runNumericPath,
  runFrameworkPath,
};