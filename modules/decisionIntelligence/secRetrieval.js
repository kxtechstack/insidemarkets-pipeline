/**
 * modules/decisionIntelligence/secRetrieval.js
 *
 * MERGED FILE -- combines (in order):
 *   1. companies.js
 *   2. extractIntent.js
 *   3. retrieveChunks.js
 *
 * CHANGED (this pass): ported over 3 fuzzy-matching fixes that were
 * previously only applied to an earlier standalone extractIntent.js and
 * never made it into this merged file -- confirmed via file-explorer
 * review that THIS file is now the one actually imported by
 * generateAnswer.js and route.js, so these fixes need to live here:
 *
 *   1. Length-sanity guard tightened from a SCALING `Math.max(word.length, 4)`
 *      to a FIXED `<= 3` -- the old version let a long word like "companies"
 *      (9 chars) match against a much longer legal name like "TJX COMPANIES
 *      INC" (18 chars), because the allowed gap scaled up with word length.
 *      Real typos barely change a word's length, so a small fixed delta is
 *      both safer and still typo-tolerant. This is what caused "distribution
 *      of net income across tech companies" to wrongly resolve to ticker TJX.
 *   2. Similarity threshold lowered from 0.82 to 0.6 -- 0.82 was copied from
 *      Python's difflib.SequenceMatcher scoring, which isn't equivalent to
 *      string-similarity's Dice-coefficient scoring (same number, different
 *      meaning). Real typos like "Mircosoft" scored only 0.625 under this
 *      library, so they were failing to match at all under the old threshold.
 *      Safe to lower now that fix #1 (not the threshold) is what blocks
 *      false substring matches.
 *   3. extractUnresolvedMentions() now runs the SAME fuzzy check as
 *      extractTickers() before flagging a word as unresolved -- previously
 *      a word that extractTickers() correctly fuzzy-matched (e.g. "Goggle"
 *      -> GOOGL) could STILL get flagged here as an unknown/unresolved
 *      company, because this function only checked for an EXACT lookup
 *      match. That contradiction would wrongly strip a correctly-matched
 *      company's name out of the question before it reached the LLM.
 *
 * All three were tested together against a real 496-company Supabase
 * table and confirmed working (see chat history) before being ported here.
 */

const { createClient } = require('@supabase/supabase-js');
const stringSimilarity = require('string-similarity'); // npm install string-similarity
const { pipeline } = require('@xenova/transformers');
const { QdrantClient } = require('@qdrant/js-client-rest');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});
const COLLECTION = process.env.SEC10K_QDRANT_COLLECTION || 'sec10k_chunks';

// =============================================================================
// SECTION 1: companies.js
// =============================================================================

async function getAllCompanies() {
  const { data, error } = await supabase.from('companies').select('ticker, company_name');
  if (error) throw error;
  return data;
}

// =============================================================================
// SECTION 2: extractIntent.js
// =============================================================================

const TICKER_ALIASES = {
  GOOGLE: 'GOOGL', ALPHABET: 'GOOGL', FACEBOOK: 'META', AMAZON: 'AMZN',
  APPLE: 'AAPL', MICROSOFT: 'MSFT', TESLA: 'TSLA', BERKSHIRE: 'BRK.B',
  CITI: 'C', CITIBANK: 'C', GOLDMAN: 'GS', 'MORGAN STANLEY': 'MS',
  JPMORGAN: 'JPM', 'JP MORGAN': 'JPM', 'BANK OF AMERICA': 'BAC',
  'COCA COLA': 'KO', 'COCA-COLA': 'KO', '3M': 'MMM',
  'AMERICAN EXPRESS': 'AXP', PROCTER: 'PG', 'PROCTER & GAMBLE': 'PG',
  'ELI LILLY': 'LLY', LILLY: 'LLY', VERIZON: 'VZ', 'AT&T': 'T', ATT: 'T',
  'GENERAL ELECTRIC': 'GE', CATERPILLAR: 'CAT',
  MASTERCARD: 'MA', VISA: 'V', SALESFORCE: 'CRM', ORACLE: 'ORCL',
  NETFLIX: 'NFLX', MCDONALDS: 'MCD', "MCDONALD'S": 'MCD', COSTCO: 'COST',
  WALMART: 'WMT', DISNEY: 'DIS', BOEING: 'BA', CHEVRON: 'CVX',
  EXXON: 'XOM', EXXONMOBIL: 'XOM', QUALCOMM: 'QCOM', BROADCOM: 'AVGO',
  INTEL: 'INTC', NVIDIA: 'NVDA', 'HOME DEPOT': 'HD',
};

const STOPWORD_TICKERS = new Set(['ARE', 'ALL', 'ON', 'AT', 'IT', 'A', 'FOR', 'SO', 'OR', 'IS', 'BE', 'TECH', 'DOV', 'CAN', 'NOW', 'NEW', 'ONE', 'TWO', 'KEY', 'DAY', 'END', 'OIL', 'GAS', 'BIG', 'MAX', 'TOP', 'LOW', 'HIGH', 'SAFE', 'FAST', 'FREE', 'REAL', 'OPEN', 'PLAY', 'RISE', 'SAVE', 'STAY', 'WELL']);

const GENERIC_FIRST_WORDS = new Set([
  'CAPITAL', 'AMERICAN', 'GENERAL', 'NATIONAL', 'GLOBAL', 'GROUP',
  'HOLDINGS', 'FIRST', 'UNITED', 'INTERNATIONAL', 'PUBLIC', 'ROYAL',
  'CENTRAL', 'STANDARD', 'NORTH', 'SOUTH', 'EAST', 'WEST',
  'NEW', 'OLD', 'MODERN', 'ADVANCED', 'PREMIER', 'PRIME', 'MAIN',
]);

const QUESTION_STOPWORDS = new Set([
  'WHAT', 'WHICH', 'WHO', 'WHEN', 'WHERE', 'WHY', 'HOW', 'WAS', 'WERE',
  'THE', 'AND', 'FOR', 'WITH', 'FROM', 'THIS', 'THAT', 'THESE', 'THOSE',
  'COMPARE', 'SHOW', 'GIVE', 'TELL', 'LIST', 'PLEASE',
  'NET', 'INCOME', 'REVENUE', 'PROFIT', 'EARNINGS', 'MARGIN', 'SALES',
  'TOTAL', 'ASSETS', 'LIABILITIES', 'CASH', 'FLOW', 'CAPITAL',
  'RISK', 'FACTORS', 'MAIN', 'KEY', 'SWOT', 'ANALYSIS', 'ABOUT',
  'DID', 'DOES', 'EACH', 'THEIR', 'ITS', 'BUSINESS', 'SEGMENT',
  'PRODUCT', 'CORE', 'OPERATE', 'COMPANY', 'COMPANIES', 'CATEGORIZE', 'DISTRIBUTION',
  'PESTLE', 'PESTEL', 'PEST', 'PORTER', 'PORTERS', 'FORCES', 'FORCE', 'FIVE',
  'LAST', 'PAST', 'PREVIOUS', 'YEARS', 'YEAR',   'SHOULD', 'OVER', 'EXPANSION', 'EXPAND', 'PRIORITIZE', 'PRIORITIS', 'DIRECT', 'RETAIL', 'SPECIALTY', 'ECOMMERCE', 'PARTNERSHIP', 'PARTNERSHIPS',
]);

let _companyLookup = null; // cached Map<UPPER_NAME_OR_TICKER, ticker>

async function loadCompanyLookup(getAllCompaniesFn) {
  if (_companyLookup) return _companyLookup;
  const companies = await getAllCompaniesFn();
  const lookup = new Map();
  for (const c of companies) {
    lookup.set(c.ticker.toUpperCase(), c.ticker);
    const firstWord = c.company_name.split(' ')[0].toUpperCase();
    if (!GENERIC_FIRST_WORDS.has(firstWord)) lookup.set(firstWord, c.ticker);
    lookup.set(c.company_name.toUpperCase(), c.ticker);
  }
  const validTickers = new Set(lookup.values());
  for (const [alias, ticker] of Object.entries(TICKER_ALIASES)) {
    if (validTickers.has(ticker)) lookup.set(alias, ticker);
  }
  _companyLookup = lookup;
  return lookup;
}

function extractTickers(question, lookup) {
  const found = [];
  const names = [...lookup.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (STOPWORD_TICKERS.has(name)) continue;
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const ticker = lookup.get(name);
    if (pattern.test(question) && !found.includes(ticker)) found.push(ticker);
  }
  if (found.length) return found;

  const candidateWords = (question.match(/[A-Za-z][A-Za-z&.]*/g) || []).filter(w => w.length >= 4 && !QUESTION_STOPWORDS.has(w.toUpperCase()));
  // FIX: filter BOTH the name AND the ticker it maps to against the
  // stopword list. Previously only the name itself was filtered, so
  // "DOVER" (which maps to ticker DOV, a stopword) still made it into
  // the candidate pool and matched "over" via fuzzy.
  const allNames = [...lookup.keys()].filter(n => {
    if (STOPWORD_TICKERS.has(n)) return false;
    const t = lookup.get(n);
    if (t && STOPWORD_TICKERS.has(t)) return false;
    return true;
  });
  for (const word of candidateWords) {
    const sameLengthNames = allNames.filter(n => Math.abs(n.length - word.length) <= 3);
    if (!sameLengthNames.length) continue;
    const { bestMatch } = stringSimilarity.findBestMatch(word.toUpperCase(), sameLengthNames);
    // FIX: stricter threshold for short words. 4-6 char words require 0.85
    // similarity (blocks common English words like "over", "expand" from
    // fuzzy-matching to short company names/tickers); 7+ char words keep
    // 0.6 for typo tolerance ("Mircosoft" -> "Microsoft").
    const minRating = word.length <= 6 ? 0.85 : 0.6;
    if (bestMatch.rating >= minRating) {
      const ticker = lookup.get(bestMatch.target);
      if (!found.includes(ticker)) found.push(ticker);
    }
  }
  return found;
}

function extractUnresolvedMentions(question, resolvedTickers, lookup) {
  const alreadyMatchedNames = [...lookup.entries()]
    .filter(([, ticker]) => resolvedTickers.includes(ticker))
    .map(([name]) => name);
  // FIX #3 (Goggle/Mircosoft false-unresolved bug): needed for the fuzzy
  // re-check below -- see file header.
  const allNamesForFuzzy = [...lookup.keys()].filter(n => !STOPWORD_TICKERS.has(n));

  const words = question.match(/[A-Za-z][A-Za-z&.']*/g) || [];
  const unresolved = [];
  const seen = new Set();

  for (const w of words) {
    const core = w.toLowerCase().endsWith("'s") ? w.slice(0, -2) : w;
    const coreClean = core.replace(/^[.']+|[.']+$/g, '');
    if (coreClean.length < 4) continue;
    const upper = coreClean.toUpperCase();
    if (QUESTION_STOPWORDS.has(upper) || STOPWORD_TICKERS.has(upper)) continue;
    if (lookup.has(upper)) continue;
    if (!/^[A-Z]/.test(coreClean)) continue;

    const isSubstringOfMatched = alreadyMatchedNames.some(name => {
      const pattern = new RegExp(`\\b${upper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      return pattern.test(name);
    });
    if (isSubstringOfMatched) continue;

    // FIX #3: re-run the SAME fuzzy check extractTickers() uses -- if this
    // word is what fuzzy-matched to an ALREADY-RESOLVED ticker, it's not
    // unresolved, extractTickers() already accounted for it. Without this,
    // the two functions could disagree about the same word.
    const sameLengthNames = allNamesForFuzzy.filter(n => Math.abs(n.length - upper.length) <= 3);
    if (sameLengthNames.length) {
      const { bestMatch } = stringSimilarity.findBestMatch(upper, sameLengthNames);
      if (bestMatch.rating >= 0.6 && resolvedTickers.includes(lookup.get(bestMatch.target))) {
        continue;
      }
    }

    if (seen.has(upper)) continue;
    seen.add(upper);
    unresolved.push(coreClean.replace(/'$/, ''));
  }

  return unresolved;
}

function sanitizeQuestionForLLM(question, unresolvedMentions) {
  let sanitized = question;
  for (const name of unresolvedMentions) {
    const pattern = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:'s)?`, 'gi');
    sanitized = sanitized.replace(pattern, '');
  }
  sanitized = sanitized.replace(/\s*,\s*,/g, ',');
  sanitized = sanitized.replace(/\s{2,}/g, ' ').trim().replace(/^,|,$/g, '').trim();
  return sanitized;
}

const PESTLE_KEYWORDS = ['pestle', 'pestel', 'pest analysis'];
const FIVE_FORCES_KEYWORDS = [
  'five forces', '5 forces', "porter's five forces", 'porters five forces',
  'porter five forces', 'five force model', '5 force model', "porter's 5 forces",
];
const RISK_ANALYSIS_KEYWORDS = [
  'risk analysis', 'risk categor', 'categorize the risk', 'categorise the risk',
  'types of risk', 'risk breakdown', 'breakdown of risk', 'risk matrix',
];

const METRIC_KEYWORDS = [
  ['NetIncome', ['net income', 'profit', 'earnings', 'bottom line']],
  ['Revenue', ['revenue', 'sales', 'top line']],
  ['TotalAssets', ['total assets']],
  ['TotalLiabilities', ['total liabilities']],
  ['CashFlow', ['cash flow']],
  ['CapEx', ['capital expenditure', 'capex', 'r&d spending']],
];

const LATEST_FISCAL_YEAR = 2025; // matches DB coverage 2021-2025

const WORD_TO_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, couple: 2, few: 3,
};

async function extractIntent(question, getAllCompaniesFn) {
  const lookup = await loadCompanyLookup(getAllCompaniesFn);
  const tickers = extractTickers(question, lookup);
  const ticker = tickers[0] || null;
  const unresolvedMentions = extractUnresolvedMentions(question, tickers, lookup);
  const qLower = question.toLowerCase();

  let allYears = [...new Set((question.match(/\b(20\d{2})\b/g) || []).map(Number))].sort();

  const lastNMatch = question.match(
    /\b(?:last|past|previous)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\s*years?\b/i
  );
  if (lastNMatch && allYears.length === 0) {
    const raw = lastNMatch[1].toLowerCase();
    let n = /^\d+$/.test(raw) ? parseInt(raw, 10) : (WORD_TO_NUM[raw] || 2);
    n = Math.max(1, Math.min(n, 10));
    allYears = Array.from({ length: n }, (_, i) => LATEST_FISCAL_YEAR - n + 1 + i);
  }

  const rangeMatch = question.match(/\b(20\d{2})\s*(?:to|-|through|thru|until)\s*(20\d{2})\b/i);
  const betweenMatch = question.match(/\bbetween\s+(20\d{2})\s+and\s+(20\d{2})\b/i);
  const m = rangeMatch || betweenMatch;
  if (m) {
    const y1 = parseInt(m[1], 10), y2 = parseInt(m[2], 10);
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    const range = [];
    for (let y = lo; y <= hi; y++) range.push(y);
    allYears = [...new Set([...allYears, ...range])].sort();
  }

  const fiscalYear = allYears.length ? allYears[0] : null;

  const isSwot = qLower.includes('swot');
  const isPestle = PESTLE_KEYWORDS.some(k => qLower.includes(k));
  const isFiveForces = FIVE_FORCES_KEYWORDS.some(k => qLower.includes(k));
  const isRiskAnalysis = RISK_ANALYSIS_KEYWORDS.some(k => qLower.includes(k));
  const isFrameworkQuestion = isSwot || isPestle || isFiveForces || isRiskAnalysis;

  let itemCode = null;
  if (isFrameworkQuestion) {
    itemCode = null;
  } else if (['revenue', 'net income', 'profit', 'earnings', 'margin', 'expense',
    'spending', 'capital expenditure', 'md&a', 'discussion and analysis',
    'outlook', 'cash flow'].some(k => qLower.includes(k))) {
    itemCode = 'Item 7';
  } else if (['financial statement', 'balance sheet', 'footnote', 'auditor',
    'total assets', 'total liabilities', 'stockholders equity',
    'shareholders equity'].some(k => qLower.includes(k))) {
    itemCode = 'Item 8';
  } else if (['lawsuit', 'litigation', 'legal proceeding'].some(k => qLower.includes(k))) {
    itemCode = 'Item 3';
  } else if (/\brisks?\b/.test(qLower)) {
    itemCode = 'Item 1A';
  } else if (['business segment', 'product segment', 'what does', 'main product',
    'core business', 'operate in'].some(k => qLower.includes(k))) {
    itemCode = 'Item 1';
  }

  let isNumericQuestion = ['revenue', 'net income', 'profit', 'earnings', 'eps',
    'margin', 'total assets', 'total liabilities', 'cash flow', 'how much',
    'what was the', 'capital expenditure', 'r&d spending'].some(k => qLower.includes(k));

  let metric = null;
  for (const [name, kws] of METRIC_KEYWORDS) {
    if (kws.some(k => qLower.includes(k))) { metric = name; break; }
  }
  const metricsFound = METRIC_KEYWORDS.filter(([, kws]) => kws.some(k => qLower.includes(k))).map(([n]) => n);

  const isRelationshipQuestion = qLower.includes('relationship') || qLower.includes('correlat')
    || /\b(vs|versus|against)\b/.test(qLower);
  const isDistributionQuestion = ['distribution', 'spread', 'outlier', 'variance',
    'how varied', 'range of'].some(k => qLower.includes(k));
  const isCumulativeQuestion = ['cumulative', 'stacked', 'running total'].some(k => qLower.includes(k));

  isNumericQuestion = isNumericQuestion || isRelationshipQuestion || isDistributionQuestion;

  const COMPOSITION_KEYWORDS = ['share', 'breakdown', 'composition', 'percentage',
    'proportion', 'split of', 'distribution', 'makeup', 'mix of'];
  const isCompositionQuestion = COMPOSITION_KEYWORDS.some(k => qLower.includes(k));

  const qualitativeSections = new Set(['Item 1A', 'Item 3', 'Item 1']);
  const dataType = (isFrameworkQuestion || (qualitativeSections.has(itemCode) && !isNumericQuestion))
    ? 'qualitative' : 'quantitative';

  if (dataType === 'qualitative' && allYears.length === 0) {
    allYears = [LATEST_FISCAL_YEAR];
  }
  const resolvedFiscalYear = allYears.length ? allYears[0] : fiscalYear;

  const nEntities = tickers.length;
  const nYears = allYears.length;
  let insufficientForDistribution = false;

  let questionCategory;
  if (isFiveForces) questionCategory = 'five_forces';
  else if (isPestle) questionCategory = 'pestle';
  else if (isRiskAnalysis) questionCategory = 'risk_analysis';
  else if (isSwot) questionCategory = 'swot';
  else if (dataType === 'qualitative') questionCategory = 'qualitative';
  else if (isRelationshipQuestion && metricsFound.length >= 2) questionCategory = 'relationship';
  else if (isDistributionQuestion && nEntities >= 5) questionCategory = 'distribution';
  else {
    if (isDistributionQuestion && nEntities < 5) insufficientForDistribution = true;
    if (nEntities === 1 && nYears <= 1) questionCategory = 'single_value';
    else if (nEntities === 1 && nYears > 1) questionCategory = 'trend';
    else if (nEntities > 1 && nYears <= 1) questionCategory = 'comparison';
    else if (nEntities > 1 && nYears > 1) questionCategory = 'comparison_trend';
    else questionCategory = 'single_value';
  }

  const isChartable = dataType === 'quantitative' && questionCategory !== 'single_value';

  return {
    tickers, ticker, fiscalYear: resolvedFiscalYear, allYears, itemCode, isNumericQuestion, metric,
    dataType, questionCategory, isChartable, isSwot, isPestle, isFiveForces,
    isRiskAnalysis, isCompositionQuestion, metricsFound, isRelationshipQuestion,
    isDistributionQuestion, isCumulativeQuestion, insufficientForDistribution,
    unresolvedMentions,
  };
}

// =============================================================================
// SECTION 3: retrieveChunks.js
// =============================================================================

let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return embedderPromise;
};

async function embedText(text) {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

function buildQdrantFilter(ticker, fiscalYear, itemCode) {
  const must = [];
  if (ticker) must.push({ key: 'ticker', match: { value: ticker } });
  if (fiscalYear) must.push({ key: 'fiscal_year', match: { value: fiscalYear } });
  if (itemCode) must.push({ key: 'item_code', match: { value: itemCode } });
  return must.length ? { must } : undefined;
}

async function searchOne(queryVector, ticker, fiscalYear, itemCode, topK) {
  let filter = buildQdrantFilter(ticker, fiscalYear, itemCode);
  let hits = await qdrant.search(COLLECTION, { vector: queryVector, filter, limit: topK });

  if (!hits.length && itemCode && itemCode !== 'Item 7' && itemCode !== 'Item 8') {
    filter = buildQdrantFilter(ticker, fiscalYear, null);
    hits = await qdrant.search(COLLECTION, { vector: queryVector, filter, limit: topK });
  }

  if (!hits.length && fiscalYear) {
    filter = buildQdrantFilter(ticker, null, null);
    hits = await qdrant.search(COLLECTION, { vector: queryVector, filter, limit: topK });
  }

  return hits;
}

async function getChunkTextByPointIds(pointIds) {
  if (!pointIds.length) return [];
  const { data, error } = await supabase
    .from('chunks_meta')
    .select('qdrant_point_id, ticker, fiscal_year, item_code, chunk_text')
    .in('qdrant_point_id', pointIds);
  if (error) throw error;

  const byId = new Map(data.map(row => [row.qdrant_point_id, row]));
  return pointIds.map(id => byId.get(id)).filter(Boolean);
}

async function getFinancialFacts(ticker, fiscalYear) {
  let query = supabase.from('financial_facts').select('*').eq('ticker', ticker);
  if (fiscalYear) query = query.eq('fiscal_year', fiscalYear);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function retrieveChunks(question, intent, topK = 6) {
  const queryVector = await embedText(question);
  const tickers = intent.tickers.length ? intent.tickers : [null];
  const years = intent.allYears.length ? intent.allYears : [intent.fiscalYear];

  const perTickerK = tickers.length <= 1 ? topK : Math.max(3, Math.floor(topK / tickers.length) + 1);
  const perYearK = years.length <= 1 ? perTickerK : Math.max(2, Math.floor(perTickerK / years.length) + 1);

  const allHits = [];
  for (const ticker of tickers) {
    for (const year of years) {
      const hits = await searchOne(queryVector, ticker, year, intent.itemCode, perYearK);
      allHits.push(...hits);
    }
  }

  const pointIds = allHits.map(h => String(h.id));
  return getChunkTextByPointIds(pointIds);
}

const FRAMEWORK_ITEM_CODES = ['Item 1', 'Item 1A', 'Item 7'];

async function retrieveChunksStratified(question, intent, topK = 12) {
  const queryVector = await embedText(question);
  const tickers = intent.tickers.length ? intent.tickers : [null];
  const years = intent.allYears.length ? intent.allYears : [intent.fiscalYear];
  const perSectionK = Math.max(2, Math.floor(topK / FRAMEWORK_ITEM_CODES.length));

  const allHits = [];
  const seenIds = new Set();
  for (const ticker of tickers) {
    for (const year of years) {
      for (const itemCode of FRAMEWORK_ITEM_CODES) {
        const hits = await searchOne(queryVector, ticker, year, itemCode, perSectionK);
        for (const h of hits) {
          const id = String(h.id);
          if (!seenIds.has(id)) { seenIds.add(id); allHits.push(h); }
        }
      }
    }
  }

  const pointIds = allHits.map(h => String(h.id));
  return getChunkTextByPointIds(pointIds);
}

const FRAMEWORK_CATEGORIES = new Set(['swot', 'pestle', 'risk_analysis', 'five_forces']);

async function retrieveForIntent(question, intent) {
  const isFramework = FRAMEWORK_CATEGORIES.has(intent.questionCategory);
  const chunks = isFramework
    ? await retrieveChunksStratified(question, intent, 12)
    : await retrieveChunks(question, intent, 6);

  let facts = [];
  if (intent.isNumericQuestion) {
    const yearsToFetch = intent.allYears.length ? intent.allYears : [intent.fiscalYear];
    for (const ticker of intent.tickers) {
      for (const year of yearsToFetch) {
        facts.push(...await getFinancialFacts(ticker, year));
      }
    }
    if (intent.questionCategory === 'relationship' && intent.metricsFound.length >= 2) {
      facts = facts.filter(f => intent.metricsFound.includes(f.metric_name));
    } else if (intent.metric) {
      facts = facts.filter(f => f.metric_name === intent.metric);
    }
  }

  return { chunks, facts };
}

// =============================================================================
// EXPORTS -- everything all three original files exported, combined
// =============================================================================

module.exports = {
  // companies.js
  getAllCompanies,
  // extractIntent.js
  extractIntent, loadCompanyLookup, extractTickers,
  extractUnresolvedMentions, sanitizeQuestionForLLM,
  // retrieveChunks.js
  embedText, retrieveChunks, retrieveChunksStratified, retrieveForIntent,
  getFinancialFacts, getChunkTextByPointIds,
};