/**
 * modules/decisionIntelligenceV2/handlers/secHandler.js
 */

console.log('[secHandler] MODULE LOADED');

const { detectNonUSGeography, resolveCompanySet } = require('../sec/resolveCompanySet');
const { resolveCompanySetFacts, findAllowlistTickers } = require('../sec/subsectorResolver');
const {
  extractIntent,
  extractIntentFromRouter,
  retrieveForIntent,
  getAllCompanies,
} = require('../sec/secRetrieval');
const { buildNumericAnswer } = require('../sec/buildNumericAnswer');
const { getRegionAliases } = require('../sec/regionAliases');
const { containsPhrase, normalizeConcepts } = require('../retrieval/filterListHits');

const FRAMEWORK_CATEGORIES = new Set(['swot', 'pestle', 'five_forces', 'risk_analysis']);

const NUMERIC_KEYWORDS = [
  'revenue', 'net income', 'profit', 'earnings', 'eps', 'margin',
  'total assets', 'total liabilities', 'cash flow', 'how much',
  'what was the', 'capital expenditure', 'r&d spending',
];

const REGION_MIN_HITS = 3;

const SECTOR_KEYWORDS_FALLBACK = [
  'cosmetic', 'cosmetics', 'beauty',
  'pharma', 'pharmaceutical', 'biotech', 'biotechnology',
  'retail', 'retailer', 'retailers',
  'bank', 'banks', 'banking', 'insurance', 'insurers',
  'oil', 'oil and gas', 'energy', 'oilfield services',
  'tech', 'technology', 'semiconductor', 'semiconductors', 'software', 'cloud',
  'airline', 'airlines',
  'auto', 'autos', 'automaker', 'automakers', 'automobile', 'automobiles', 'automotive',
  'electric vehicle', 'electric vehicles', 'ev',
  'utility', 'utilities', 'telecom', 'telecommunications', 'media', 'streaming',
  'food', 'beverage', 'beverages',
  'aerospace', 'defense', 'healthcare', 'health care',
  'reit', 'reits', 'restaurant', 'restaurants',
  'travel', 'hotel', 'hotels',
  'steel', 'mining', 'chemicals', 'packaging',
  'railway', 'railroads', 'shipping', 'logistics',
  'home improvement', 'ecommerce', 'e-commerce', 'ev_charging',
  'k-beauty',
];

const MAX_SECTOR_COMPANIES = 3;

const COMPANY_NAME_STOP = new Set([
  'inc', 'corp', 'co', 'company', 'group', 'holdings', 'ltd', 'plc',
  'sa', 'ag', 'nv', 'se', 'llc', 'lp',
]);

async function questionNamesCompany(question, tickers) {
  if (!Array.isArray(tickers) || tickers.length === 0) return false;
  const q = String(question || '').toLowerCase();

  for (const t of tickers) {
    const escaped = String(t).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(q)) return true;
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: companies } = await supabase
    .from('companies').select('ticker, company_name').in('ticker', tickers);

  for (const c of companies || []) {
    const name = String(c.company_name || '').toLowerCase();
    const words = name.split(/[^a-z0-9&']+/).filter((w) => w.length >= 4 && !COMPANY_NAME_STOP.has(w));
    for (const w of words) {
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`).test(q)) return true;
    }
  }
  return false;
}

function detectSecShape(question, routerResult, intent) {
  const q = String(question || '').toLowerCase();

  if (routerResult && routerResult.is_company_set_query === true) {
    return 'company_set';
  }

  const hasTickers = Array.isArray(intent.tickers) && intent.tickers.length > 0;
  if (!hasTickers) return null;

  if (FRAMEWORK_CATEGORIES.has(intent.questionCategory)) return 'framework';

  // Numeric if the router gave us any metrics OR a year range.
  const hasMetrics = Array.isArray(intent.metricsFound) && intent.metricsFound.length > 0;
  if (hasMetrics || intent.metric || intent.requestedYearCount) return 'numeric';

  const looksNumeric = NUMERIC_KEYWORDS.some((k) => q.includes(k));
  if (looksNumeric) return 'numeric';

  if (intent.questionCategory === 'qualitative') return 'framework';

  return null;
}

function isSecNumericQuestion(question, routerResult, intent) {
  if (routerResult && routerResult.is_company_set_query === true) return true;

  if (intent && ((intent.metricsFound && intent.metricsFound.length > 0) || intent.metric)) {
    return true;
  }

  const q = String(question || '').toLowerCase();

  const hasRanking =
    /\btop\s+\d+\b/.test(q) || /\brank(ed|ing)?\b/.test(q) ||
    /\bhighest\b|\blargest\b|\bbiggest\b|\bbest\b\s+by\b/.test(q) ||
    /\bcompare\b.*\bby\b/.test(q);

  const hasMetric = NUMERIC_KEYWORDS.some((k) => q.includes(k)) ||
    /\bby\s+(revenue|sales|income|profit|earnings|market\s*cap|assets|liabilities)\b/.test(q);

  if (hasRanking && hasMetric) return true;

  const hasTickers = Array.isArray(intent.tickers) && intent.tickers.length > 0;
  if (hasTickers && hasMetric) return true;

  return false;
}

function findRegionHits(hits, region, concepts) {
  const aliases = getRegionAliases(region);
  if (!aliases.length) return { passing: [], regionMatchCount: 0 };

  const cleanConcepts = normalizeConcepts(concepts);
  const requireTopic = cleanConcepts.length > 0;
  let regionMatchCount = 0;
  const passing = [];

  for (const h of hits || []) {
    const haystack = `${h.title || ''} ${h.chunk_text || ''}`;
    const regionMatch = aliases.some((a) => containsPhrase(haystack, a));
    if (!regionMatch) continue;
    regionMatchCount++;
    if (requireTopic) {
      const topicMatch = cleanConcepts.some((c) => containsPhrase(haystack, c));
      if (!topicMatch) continue;
    }
    passing.push(h);
  }
  return { passing, regionMatchCount };
}

async function buildRegionFallbackPayload(region, passingHits, regionMatchCount, question, clientId) {
  const { getVerifiedSuggestions } = require('../../decisionIntelligence/suggestionEngine');

  if (passingHits.length >= REGION_MIN_HITS) {
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

  let suggestions = [];
  try { suggestions = await getVerifiedSuggestions(clientId, 4); }
  catch (err) { console.log(`[secHandler:region] suggestions failed: ${err.message}`); }
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

  return { type: 'list', items: [], no_data: true, message, suggestions };
}

async function buildRegionFallback(question, region, clientId, industry, routerResult) {
  const { retrieveClientSignals } = require('../retrieval/clientSignalsRetrieval');
  const { retrieveCustomSourceHits } = require('../retrieval/customSourceRetrieval');
  const concepts = [
    ...((routerResult && routerResult.concept_keywords) || []),
    ...((routerResult && routerResult.entity_mentions) || []),
  ];

  let clientHits = [];
  let customHits = [];
  try {
    const [clientRetr, customRetr] = await Promise.all([
      retrieveClientSignals(question, clientId, industry, { precomputedUnderstanding: routerResult }),
      retrieveCustomSourceHits(question, clientId),
    ]);
    clientHits = clientRetr?.hits || [];
    customHits = customRetr || [];
  } catch (err) {
    console.log(`[secHandler:region] retrieval failed: ${err.message}`);
  }

  const normalizedCustom = customHits.map((c, idx) => ({
    id: c.id || `custom_${idx}`, score: c.score || 0,
    module_id: '__custom__', module_name: 'Uploaded Document',
    title: c.payload?.source_name || c.payload?.title || 'Uploaded document',
    chunk_text: c.payload?.chunk_text || '',
    article_id: null, published_date: null, submodule_id: null,
    _matched: true, _custom: true, _custom_payload: c.payload || {},
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
    payload: await buildRegionFallbackPayload(region, passing, regionMatchCount, question, clientId),
  };
}

async function tryBuildChart(intent, facts) {
  if (!Array.isArray(facts) || facts.length < 2) return { chart: null, chartMeta: null };

  let decideChartFormat, renderChart;
  try { ({ decideChartFormat, renderChart } = require('../sec/chartPipeline')); }
  catch (err) {
    console.log(`[secHandler] chartPipeline unavailable (${err.message}) — skipping chart`);
    return { chart: null, chartMeta: null };
  }

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
        type: 'line', xAxis: 'year',
        metricLabel: facts[0]?.metric_name || 'Value',
        series: [{
          name: t, labels: years,
          data: years.map((y) => {
            const f = facts.find((x) => x.ticker === t && x.fiscal_year === y);
            return f && f.metric_value !== null ? Number(f.metric_value) : null;
          }),
        }],
      };
    } else if (tickers.length > 1) {
      chartData = {
        type: 'bar', xAxis: 'company',
        metricLabel: facts[0]?.metric_name || 'Value',
        series: tickers.map((t) => {
          const f = facts.find((x) => x.ticker === t);
          return { name: t, labels: [t], data: [f && f.metric_value !== null ? Number(f.metric_value) : null] };
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
    type: 'sec', title: s.title, url: s.url,
    ticker: s.ticker, fiscal_year: s.fiscal_year, item_code: s.item_code,
  }));

  const chartIntent = {
    ...intent, dataType: 'quantitative', questionCategory: 'comparison',
    metric: filter.metric, tickers: [...new Set(facts.map((f) => f.ticker))],
    isChartable: facts.length >= 2,
  };
  const { chart, chartMeta } = await tryBuildChart(chartIntent, enrichedFacts);

  console.log(
    `[secHandler] company-set numeric answer: ${facts.length} fact(s), ` +
    `${sources.length} source(s), chart=${!!chart}`
  );

  return {
    mode: 'numeric',
    payload: { type: 'decision', report: { title: question, bodyText }, sources, chart, chartMeta },
    handlerResult: { report: { title: question, bodyText }, sources, chart, chartMeta },
  };
}

async function runNumericPath(question, intent) {
  const { facts } = await retrieveForIntent(question, intent);
  if (!facts || !facts.length) {
    console.log(`[secHandler] numeric path: 0 facts for tickers=[${intent.tickers.join(',')}]`);
    return null;
  }

  const enrichedFacts = await enrichFactsWithNames(facts);
  let bodyText = buildNumericAnswer(enrichedFacts);
  if (intent.noDataNote) bodyText = `_${intent.noDataNote}_\n\n${bodyText}`;

  const sources = await buildNumericSources(enrichedFacts);
  const { chart, chartMeta } = await tryBuildChart(intent, enrichedFacts);

  console.log(
    `[secHandler] numeric answer: ${facts.length} fact(s) for [${intent.tickers.join(',')}], ` +
    `${sources.length} source(s), chart=${!!chart}`
  );

  return {
    mode: 'numeric',
    payload: { type: 'decision', report: { title: question, bodyText }, sources, chart, chartMeta },
    handlerResult: { report: { title: question, bodyText }, sources, chart, chartMeta },
  };
}

async function runSectorFrameworkPath(question, sectorTermFromRouter = null) {
  let sectorTerm = sectorTermFromRouter && String(sectorTermFromRouter).trim();

  if (!sectorTerm) {
    const q = String(question || '').toLowerCase();
    const sorted = [...SECTOR_KEYWORDS_FALLBACK].sort((a, b) => b.length - a.length);
    for (const kw of sorted) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
      if (re.test(q)) { sectorTerm = kw; break; }
    }
  }
  if (!sectorTerm) {
    console.log(`[secHandler:sector] no sector term — falling through`);
    return null;
  }

  const tickers = findAllowlistTickers(sectorTerm);
  if (!tickers || tickers.length === 0) {
    console.log(`[secHandler:sector] "${sectorTerm}" not in allowlist — falling through`);
    return null;
  }

  const cappedTickers = tickers.slice(0, MAX_SECTOR_COMPANIES);
  console.log(`[secHandler:sector] "${sectorTerm}" → tickers=[${cappedTickers.join(',')}] (latest year only)`);

  const sectorIntent = {
    tickers: cappedTickers, allYears: [], requestedYearCount: 1, fiscalYear: null,
    questionCategory: 'swot', isNumericQuestion: false,
    itemCode: null, metric: null, metricsFound: [],
  };

  const { chunks } = await retrieveForIntent(question, sectorIntent, { latestOnly: true });
  if (!chunks || !chunks.length) {
    console.log(`[secHandler:sector] 0 chunks retrieved for [${cappedTickers.join(',')}]`);
    return null;
  }

  const injectChunks = chunks.map((c) => ({
    id: c.qdrant_point_id || null, score: 1.0,
    module_id: '__sec__', module_name: 'SEC Filing',
    title: `${c.ticker} ${c.fiscal_year} 10-K — ${c.item_code}`,
    chunk_text: c.chunk_text || '',
    article_id: null, published_date: null, submodule_id: null,
    _matched: true, _vector_score: 1.0, _boost_mult: 1.0, _boost_penalty: 1.0,
    _boost_matched: { conceptsInTitle: [], entitiesInTitle: [] },
    _sec: true,
    _sec_payload: {
      ticker: c.ticker, fiscal_year: c.fiscal_year,
      item_code: c.item_code, qdrant_point_id: c.qdrant_point_id || null,
    },
  }));

  console.log(`[secHandler:sector] injecting ${injectChunks.length} SEC chunk(s) for sector "${sectorTerm}"`);
  return { mode: 'framework', injectChunks };
}

async function runFrameworkPath(question, intent) {
  const { chunks } = await retrieveForIntent(question, intent);
  if (!chunks || !chunks.length) {
    console.log(`[secHandler] framework path: 0 chunks for [${intent.tickers.join(',')}]`);
    return null;
  }

  const injectChunks = chunks.map((c) => ({
    id: c.qdrant_point_id || null, score: 1.0,
    module_id: '__sec__', module_name: 'SEC Filing',
    title: `${c.ticker} ${c.fiscal_year} 10-K — ${c.item_code}`,
    chunk_text: c.chunk_text || '',
    article_id: null, published_date: null, submodule_id: null,
    _matched: true, _vector_score: 1.0, _boost_mult: 1.0, _boost_penalty: 1.0,
    _boost_matched: { conceptsInTitle: [], entitiesInTitle: [] },
    _sec: true,
    _sec_payload: {
      ticker: c.ticker, fiscal_year: c.fiscal_year,
      item_code: c.item_code, qdrant_point_id: c.qdrant_point_id || null,
    },
  }));

  console.log(
    `[secHandler] framework path: injecting ${injectChunks.length} SEC chunk(s) ` +
    `for [${intent.tickers.join(',')}] into V2 decisionHandler`
  );

  return { mode: 'framework', injectChunks };
}

async function enrichFactsWithNames(facts) {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const tickers = [...new Set(facts.map((f) => f.ticker))];
  const nameByTicker = {};
  if (tickers.length) {
    const { data } = await supabase.from('companies').select('ticker, company_name').in('ticker', tickers);
    (data || []).forEach((c) => { nameByTicker[c.ticker] = c.company_name; });
  }
  return facts.map((f) => ({ ...f, company_name: nameByTicker[f.ticker] || f.ticker }));
}

async function buildNumericSources(facts) {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const tickers = [...new Set(facts.map((f) => f.ticker))];

  const { data: companies } = await supabase.from('companies').select('ticker, company_name, cik').in('ticker', tickers);
  const cikByTicker = {};
  const nameByTicker = {};
  (companies || []).forEach((c) => {
    cikByTicker[c.ticker] = c.cik;
    nameByTicker[c.ticker] = c.company_name;
  });

  const filingIds = [...new Set(facts.map((f) => f.filing_id).filter(Boolean))];
  const filingById = {};
  if (filingIds.length) {
    const { data: filings } = await supabase.from('filings').select('*').in('id', filingIds);
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
    const directUrl = filing?.source_url || filing?.url || filing?.filing_url || filing?.sec_url || null;
    const fallbackUrl = cik
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K&dateb=&owner=include&count=10`
      : null;

    sources.push({
      type: 'sec',
      title: `${nameByTicker[f.ticker] || f.ticker} (${f.ticker}) — FY${f.fiscal_year} ${f.metric_name}`,
      url: directUrl || fallbackUrl,
      ticker: f.ticker, fiscal_year: f.fiscal_year, item_code: f.metric_name,
    });
  }
  return sources;
}

async function buildSecAnswer({ question, routerResult, clientId, industry }) {
  try {
    if (!question || typeof question !== 'string' || !question.trim()) return null;

    // Try router-driven intent first.
    let intent;
    try {
      intent = await extractIntentFromRouter(question, routerResult, getAllCompanies);
    } catch (err) {
      console.log(`[secHandler] extractIntentFromRouter failed: ${err.message} — falling back to keyword parser`);
      intent = null;
    }

    // Fall back if router-driven intent is empty.
    if (!intent || (intent.tickers.length === 0 && !intent.metric && !(intent.metricsFound || []).length && !intent.requestedYearCount)) {
      try {
        intent = await extractIntent(question, getAllCompanies);
        if (intent) intent._fallback = true;
      } catch (err) {
        console.log(`[secHandler] extractIntent fallback also failed: ${err.message}`);
        return null;
      }
    }

    if (!intent) return null;

    const routerSector = routerResult && typeof routerResult.sector_term === 'string'
      ? routerResult.sector_term.trim()
      : null;

    const isFrameworkQuestion = FRAMEWORK_CATEGORIES.has(intent.questionCategory);
    const hasTickers = Array.isArray(intent.tickers) && intent.tickers.length > 0;

    // Sector guard — only for company-set questions that name no company.
    if (routerSector && hasTickers && routerResult && routerResult.is_company_set_query === true) {
      const namesCompany = await questionNamesCompany(question, intent.tickers);
      if (!namesCompany) {
        console.log(`[secHandler] company-set sector "${routerSector}" + no named company — clearing [${intent.tickers.join(',')}]`);
        intent.tickers = [];
      } else {
        console.log(`[secHandler] company-set sector "${routerSector}" but company named in question — keeping [${intent.tickers.join(',')}]`);
      }
    }

    // Framework guard — if framework question has sector term but tickers
    // don't correspond to any company named in the question, clear them
    // so the sector allowlist fires instead of a hallucinated company.
    if (isFrameworkQuestion && routerSector && Array.isArray(intent.tickers) && intent.tickers.length > 0) {
      const namesCompany = await questionNamesCompany(question, intent.tickers);
      if (!namesCompany) {
        console.log(`[secHandler] framework sector "${routerSector}" + no named company — clearing hallucinated tickers [${intent.tickers.join(',')}]`);
        intent.tickers = [];
      }
    }

    // Framework + no ticker → sector allowlist
    if (isFrameworkQuestion && !(Array.isArray(intent.tickers) && intent.tickers.length > 0)) {
      const sectorResult = await runSectorFrameworkPath(question, routerSector);
      if (sectorResult) return sectorResult;
      console.log(`[secHandler] framework + no ticker + no sector match — falling through`);
      return null;
    }

    const shape = detectSecShape(question, routerResult, intent);
    if (!shape) {
      console.log(`[secHandler] not SEC-shaped — falling through`);
      return null;
    }

    console.log(`[secHandler] shape=${shape} tickers=[${(intent.tickers || []).join(',')}] metrics=[${(intent.metricsFound || []).join(',')}] years=${intent.requestedYearCount || 'null'}`);

    const nonUs = detectNonUSGeography(question);
    if (nonUs) {
      if (isSecNumericQuestion(question, routerResult, intent)) {
        console.log(`[secHandler] non-US "${nonUs}" + SEC-numeric → region fallback`);
        return await buildRegionFallback(question, nonUs, clientId, industry, routerResult);
      }
      console.log(`[secHandler] non-US "${nonUs}" but not SEC-numeric — falling through to V2`);
      return null;
    }

    const tickersStillPresent = Array.isArray(intent.tickers) && intent.tickers.length > 0;
    if (shape === 'company_set' && tickersStillPresent) {
      console.log(`[secHandler] company_set with named tickers [${intent.tickers.join(',')}] — using numeric path`);
      return await runNumericPath(question, intent);
    }
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
  questionNamesCompany,
  runCompanySetPath,
  runNumericPath,
  runFrameworkPath,
};