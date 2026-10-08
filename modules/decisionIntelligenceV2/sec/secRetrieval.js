/**
 * modules/decisionIntelligenceV2/sec/secRetrieval.js
 */

const { createClient } = require('@supabase/supabase-js');
const stringSimilarity = require('string-similarity');
const { pipeline } = require('@xenova/transformers');
const { QdrantClient } = require('@qdrant/js-client-rest');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});
const COLLECTION = process.env.SEC10K_QDRANT_COLLECTION || 'sec10k_chunks';

const stripDiacritics = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

async function getAllCompanies() {
  const { data, error } = await supabase.from('companies').select('ticker, company_name');
  if (error) throw error;
  return data;
}

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
  'ESTEE LAUDER': 'EL', 'ESTÉE LAUDER': 'EL',
  "L'OREAL": 'LRLCY', 'LORÉAL': 'LRLCY',
};

const STOPWORD_TICKERS = new Set(['ARE', 'ALL', 'ON', 'AT', 'IT', 'A', 'FOR', 'SO', 'OR', 'IS', 'BE', 'TECH', 'DOV', 'CAN', 'NOW', 'NEW', 'ONE', 'TWO', 'KEY', 'DAY', 'END', 'OIL', 'GAS', 'BIG', 'MAX', 'TOP', 'LOW', 'HIGH', 'SAFE', 'FAST', 'FREE', 'REAL', 'OPEN', 'PLAY', 'RISE', 'SAVE', 'STAY', 'WELL', 'EXE', 'SEE', 'ME', 'MY', 'BY', 'DO', 'UP', 'OF', 'PAY', 'LIFE', 'LOVE', 'WORK', 'TIME', 'MOVE', 'NICE', 'FIRST', 'BEST', 'ONLY', 'SURE', 'ABLE', 'HOME', 'HELP', 'BACK', 'HOLD', 'MEET', 'TAKE', 'MAKE', 'GIVE', 'HAVE', 'KNOW', 'FIND', 'LOOK', 'WANT', 'NEED', 'TELL', 'SAY', 'GO', 'TO']);

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
  'LAST', 'PAST', 'PREVIOUS', 'YEARS', 'YEAR', 'SHOULD', 'OVER', 'EXPANSION', 'EXPAND', 'PRIORITIZE', 'PRIORITIS', 'DIRECT', 'RETAIL', 'SPECIALTY', 'ECOMMERCE', 'PARTNERSHIP', 'PARTNERSHIPS',
]);

let _companyLookup = null;

async function loadCompanyLookup(getAllCompaniesFn) {
  if (_companyLookup) return _companyLookup;
  const companies = await getAllCompaniesFn();
  const lookup = new Map();
  for (const c of companies) {
    lookup.set(c.ticker.toUpperCase(), c.ticker);
    const firstWord = c.company_name.split(' ')[0].toUpperCase();
    if (!GENERIC_FIRST_WORDS.has(firstWord)) lookup.set(firstWord, c.ticker);
    lookup.set(c.company_name.toUpperCase(), c.ticker);
    lookup.set(stripDiacritics(c.company_name).toUpperCase(), c.ticker);
  }
  const validTickers = new Set(lookup.values());
  for (const [alias, ticker] of Object.entries(TICKER_ALIASES)) {
    if (validTickers.has(ticker)) lookup.set(alias, ticker);
  }
  _companyLookup = lookup;
  return lookup;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTickers(question, lookup) {
  const found = [];
  const normalizedQuestion = stripDiacritics(question);

  const names = [...lookup.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (STOPWORD_TICKERS.has(name)) continue;
    const ticker = lookup.get(name);
    const normalizedName = stripDiacritics(name);

    const isFullName = normalizedName.includes(' ');
    const isTicker = normalizedName === ticker;
    const capitalizedPattern = new RegExp(`\\b${escapeRegex(normalizedName)}\\b`);
    if (!isFullName && !isTicker && !capitalizedPattern.test(normalizedQuestion)) continue;

    const pattern = new RegExp(`\\b${escapeRegex(normalizedName)}\\b`, 'i');
    if (pattern.test(normalizedQuestion) && !found.includes(ticker)) found.push(ticker);
  }
  if (found.length) return found;

  const candidateWords = (normalizedQuestion.match(/[A-Za-z][A-Za-z&.]*/g) || [])
    .filter((w) => w.length >= 4 && !QUESTION_STOPWORDS.has(w.toUpperCase()));

  const allNames = [...lookup.keys()]
    .map(stripDiacritics)
    .filter((n) => {
      if (STOPWORD_TICKERS.has(n)) return false;
      const t = lookup.get(n);
      if (t && STOPWORD_TICKERS.has(t)) return false;
      return true;
    });

  const strippedToTicker = new Map();
  for (const [rawName, ticker] of lookup.entries()) {
    strippedToTicker.set(stripDiacritics(rawName), ticker);
  }

  for (const word of candidateWords) {
    const sameLengthNames = allNames.filter(
      (n) => Math.abs(n.length - word.length) <= 3
    );
    if (!sameLengthNames.length) continue;
    const { bestMatch } = stringSimilarity.findBestMatch(
      word.toUpperCase(),
      sameLengthNames.map((n) => n.toUpperCase())
    );

    const upper = word.toUpperCase();
    const minRating = upper.length <= 6 ? 0.7 : 0.6;

    if (bestMatch.rating >= minRating) {
      const matchedName = sameLengthNames[bestMatch.target - 1];
      const ticker =
        strippedToTicker.get(matchedName) ||
        strippedToTicker.get(sameLengthNames.find((n) => n.toUpperCase() === bestMatch.target));
      if (ticker && !found.includes(ticker)) found.push(ticker);
    }
  }
  return found;
}

function extractUnresolvedMentions(question, resolvedTickers, lookup) {
  const normalizedQuestion = stripDiacritics(question);

  const alreadyMatchedNames = [...lookup.entries()]
    .filter(([, ticker]) => resolvedTickers.includes(ticker))
    .map(([name]) => stripDiacritics(name));

  const allNamesForFuzzy = [...lookup.keys()]
    .map(stripDiacritics)
    .filter((n) => !STOPWORD_TICKERS.has(n));

  const words = normalizedQuestion.match(/[A-Za-z][A-Za-z&.']*/g) || [];
  const unresolved = [];
  const seen = new Set();

  const strippedToTicker = new Map();
  for (const [rawName, ticker] of lookup.entries()) {
    strippedToTicker.set(stripDiacritics(rawName), ticker);
  }

  for (const w of words) {
    const core = w.toLowerCase().endsWith("'s") ? w.slice(0, -2) : w;
    const coreClean = core.replace(/^[.']+|[.']+$/g, '');
    if (coreClean.length < 4) continue;
    const upper = coreClean.toUpperCase();
    if (QUESTION_STOPWORDS.has(upper) || STOPWORD_TICKERS.has(upper)) continue;
    if (lookup.has(upper)) continue;
    if (!/^[A-Z]/.test(coreClean)) continue;

    const isSubstringOfMatched = alreadyMatchedNames.some((name) => {
      const pattern = new RegExp(`\\b${escapeRegex(upper)}\\b`);
      return pattern.test(name);
    });
    if (isSubstringOfMatched) continue;

    const sameLengthNames = allNamesForFuzzy.filter(
      (n) => Math.abs(n.length - upper.length) <= 3
    );
    if (sameLengthNames.length) {
      const { bestMatch } = stringSimilarity.findBestMatch(
        upper,
        sameLengthNames.map((n) => n.toUpperCase())
      );
      const matchedName = sameLengthNames[bestMatch.target - 1];
      const matchedTicker = matchedName ? strippedToTicker.get(matchedName) : null;
      if (bestMatch.rating >= 0.6 && matchedTicker && resolvedTickers.includes(matchedTicker)) {
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
    const pattern = new RegExp(`${escapeRegex(name)}(?:'s)?`, 'gi');
    sanitized = sanitized.replace(pattern, '');
  }
  sanitized = sanitized.replace(/\s*,\s*,/g, ',');
  sanitized = sanitized.replace(/\s{2,}/g, ' ').trim().replace(/^,|,$/g, '').trim();
  return sanitized;
}

// ─────────────────────────────────────────────────────────────────────────
// NEW: build intent from the router's already-extracted structured output.
// This is the primary path. The router LLM does the heavy lifting —
// entity resolution, metric canonicalization, time parsing, framework
// detection — and this function just adapts its output to the shape
// the rest of the SEC pipeline expects.
// ─────────────────────────────────────────────────────────────────────────
async function extractIntentFromRouter(question, routerResult, getAllCompaniesFn) {
  const lookup = await loadCompanyLookup(getAllCompaniesFn);

  // 1. Tickers — resolve router's entity_mentions against the companies table
  const tickers = [];
  for (const entity of routerResult.entity_mentions || []) {
    const upper = String(entity).toUpperCase().trim();
    const ticker = lookup.get(upper);
    if (ticker && !tickers.includes(ticker)) {
      tickers.push(ticker);
      continue;
    }
    // If the exact match failed, try the diacritic-stripped form
    const stripped = stripDiacritics(upper);
    const altTicker = lookup.get(stripped);
    if (altTicker && !tickers.includes(altTicker)) {
      tickers.push(altTicker);
    }
  }
  const ticker = tickers[0] || null;

  // 2. Metric — from router directly
  const metric = routerResult.metric || null;

  // 3. Time — convert router's time_constraint to requestedYearCount when
  //    the unit is years, else fall back to what the phrase suggests.
  let requestedYearCount = null;
  let allYears = [];
  const tc = routerResult.time_constraint;

  if (tc && tc.present) {
    if (tc.unit === 'years') {
      requestedYearCount = Math.max(1, Math.min(Number(tc.value) || 1, 10));
    } else if (tc.phrase) {
      // Look for explicit years in the phrase like "2024 and 2023"
      const explicitYears = [...new Set((String(tc.phrase).match(/\b(20\d{2})\b/g) || []).map(Number))].sort();
      if (explicitYears.length) {
        allYears = explicitYears;
      } else if (/\b(year|yr|yer|yrs|yers)\b/i.test(String(tc.phrase))) {
        requestedYearCount = Math.max(1, Math.min(Number(tc.value) || 1, 10));
      }
    }
  }

  // Also scan the raw question for explicit years, in case router missed them
  if (allYears.length === 0) {
    const explicitYears = [...new Set((String(question).match(/\b(20\d{2})\b/g) || []).map(Number))].sort();
    if (explicitYears.length) allYears = explicitYears;
  }

  // 4. Framework — from router directly
  const framework = routerResult.framework || null;
  const FRAMEWORK_CATEGORIES = new Set(['swot', 'pestle', 'five_forces', 'risk_analysis']);
  const isFrameworkQuestion = framework && FRAMEWORK_CATEGORIES.has(framework);

  // 5. Question category — infer from what we extracted
  let questionCategory;
  if (isFrameworkQuestion) questionCategory = framework;
  else if (metric) {
    if (tickers.length > 1 && (allYears.length > 1 || (requestedYearCount || 1) > 1)) questionCategory = 'comparison_trend';
    else if (tickers.length > 1) questionCategory = 'comparison';
    else if (allYears.length > 1 || (requestedYearCount || 1) > 1) questionCategory = 'trend';
    else questionCategory = 'single_value';
  } else questionCategory = 'qualitative';

  const isNumericQuestion = Boolean(metric) && !isFrameworkQuestion;
  const dataType = isNumericQuestion ? 'quantitative' : 'qualitative';

  // 6. Unresolved mentions (used for V2 fallback path, not needed here)
  const unresolvedMentions = [];

  return {
    tickers,
    ticker,
    fiscalYear: allYears[0] || null,
    allYears,
    requestedYearCount,
    noDataNote: null,
    itemCode: null,
    isNumericQuestion,
    metric,
    dataType,
    questionCategory,
    isChartable: dataType === 'quantitative' && questionCategory !== 'single_value',
    isSwot: framework === 'swot',
    isPestle: framework === 'pestle',
    isFiveForces: framework === 'five_forces',
    isRiskAnalysis: framework === 'risk_analysis',
    isCompositionQuestion: false,
    metricsFound: metric ? [metric] : [],
    isRelationshipQuestion: false,
    isDistributionQuestion: false,
    isCumulativeQuestion: false,
    insufficientForDistribution: false,
    unresolvedMentions,
    _source: 'router',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// LEGACY: build intent by parsing the raw question with keyword lists and
// fuzzy matching. Kept as a fallback only — the router path is preferred.
// ─────────────────────────────────────────────────────────────────────────
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

function detectMetric(question) {
  const q = String(question || '').toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length >= 5);

  for (const [name, kws] of METRIC_KEYWORDS) {
    for (const kw of kws) {
      if (q.includes(kw)) return name;
    }
    for (const kw of kws) {
      if (kw.includes(' ')) continue;
      for (const w of words) {
        const sim = stringSimilarity.compareTwoStrings(w, kw);
        if (sim >= 0.65) return name;
      }
    }
  }
  return null;
}

function detectAllMetrics(question) {
  const q = String(question || '').toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length >= 5);
  const found = new Set();

  for (const [name, kws] of METRIC_KEYWORDS) {
    let matched = false;
    for (const kw of kws) {
      if (q.includes(kw)) { matched = true; break; }
    }
    if (!matched) {
      for (const kw of kws) {
        if (kw.includes(' ')) continue;
        for (const w of words) {
          const sim = stringSimilarity.compareTwoStrings(w, kw);
          if (sim >= 0.65) { matched = true; break; }
        }
        if (matched) break;
      }
    }
    if (matched) found.add(name);
  }

  return [...found];
}

const WORD_TO_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, couple: 2, few: 3,
};

async function getLatestFiscalYear(ticker, metricName = null) {
  let query = supabase
    .from('financial_facts')
    .select('fiscal_year')
    .eq('ticker', ticker)
    .order('fiscal_year', { ascending: false })
    .limit(1);
  if (metricName) query = query.eq('metric_name', metricName);
  const { data } = await query;
  return data?.[0]?.fiscal_year || null;
}

async function getLatestFiscalYears(ticker, metricName, n) {
  let query = supabase
    .from('financial_facts')
    .select('fiscal_year')
    .eq('ticker', ticker)
    .order('fiscal_year', { ascending: false })
    .limit(Math.max(1, n));
  if (metricName) query = query.eq('metric_name', metricName);
  const { data } = await query;
  return [...new Set((data || []).map(r => r.fiscal_year))];
}

async function extractIntent(question, getAllCompaniesFn) {
  const lookup = await loadCompanyLookup(getAllCompaniesFn);
  const tickers = extractTickers(question, lookup);
  const ticker = tickers[0] || null;
  const unresolvedMentions = extractUnresolvedMentions(question, tickers, lookup);
  const qLower = question.toLowerCase();

  let allYears = [...new Set((question.match(/\b(20\d{2})\b/g) || []).map(Number))].sort();

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

  let requestedYearCount = null;

  const lastNMatch = question.match(
    /\b(?:last|past|previous)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\b\s*(\w*)/i
  );
  if (lastNMatch && allYears.length === 0) {
    const afterNumber = (lastNMatch[2] || '').toLowerCase();
    const isNonYearUnit = /^(day|week|month|quarter|hour|minute)/.test(afterNumber);
    if (!isNonYearUnit) {
      const raw = lastNMatch[1].toLowerCase();
      let n = /^\d+$/.test(raw) ? parseInt(raw, 10) : (WORD_TO_NUM[raw] || 2);
      n = Math.max(1, Math.min(n, 10));
      requestedYearCount = n;
    }
  }

  if (
    allYears.length === 0 &&
    requestedYearCount === null &&
    /\b(?:last|this|current|past|latest|recent|most recent)\s+year\b/i.test(question)
  ) {
    requestedYearCount = 1;
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

  const metric = detectMetric(question);
  const metricsFound = detectAllMetrics(question);

  const isRelationshipQuestion = qLower.includes('relationship') || qLower.includes('correlat')
    || /\b(vs|versus|against)\b/.test(qLower);
  const isDistributionQuestion = ['distribution', 'spread', 'outlier', 'variance',
    'how varied', 'range of'].some(k => qLower.includes(k));
  const isCumulativeQuestion = ['cumulative', 'stacked', 'running total'].some(k => qLower.includes(k));

  isNumericQuestion = isNumericQuestion || isRelationshipQuestion || isDistributionQuestion;
  if (metric) isNumericQuestion = true;
  if (requestedYearCount !== null) isNumericQuestion = true;

  const COMPOSITION_KEYWORDS = ['share', 'breakdown', 'composition', 'percentage',
    'proportion', 'split of', 'distribution', 'makeup', 'mix of'];
  const isCompositionQuestion = COMPOSITION_KEYWORDS.some(k => qLower.includes(k));

  const isDescriptiveQuestion = ['categoriz', 'categoris', 'product segment',
    'business segment', 'revenue breakdown', 'business model', 'business line',
    'how does', 'what are the main', 'what are the core', 'core business',
    'main products', 'product lines'].some(k => qLower.includes(k));

  const qualitativeSections = new Set(['Item 1A', 'Item 3', 'Item 1']);
  const dataType = (
    isFrameworkQuestion ||
    isDescriptiveQuestion ||
    (qualitativeSections.has(itemCode) && !isNumericQuestion)
  ) ? 'qualitative' : 'quantitative';

  const resolvedFiscalYear = allYears.length ? allYears[0] : fiscalYear;

  const nEntities = tickers.length;
  const nYears = allYears.length || (requestedYearCount || 1);
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
    tickers, ticker, fiscalYear: resolvedFiscalYear, allYears,
    requestedYearCount, noDataNote: null,
    itemCode, isNumericQuestion, metric,
    dataType, questionCategory, isChartable, isSwot, isPestle, isFiveForces,
    isRiskAnalysis, isCompositionQuestion, metricsFound, isRelationshipQuestion,
    isDistributionQuestion, isCumulativeQuestion, insufficientForDistribution,
    unresolvedMentions,
    _source: 'keywords',
  };
}

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
  const years = intent.allYears.length ? intent.allYears : [null];

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

async function retrieveChunksStratified(question, intent, topK = 12, opts = {}) {
  const { latestOnly = false } = opts;
  const queryVector = await embedText(question);
  const tickers = intent.tickers.length ? intent.tickers : [null];
  const perSectionK = Math.max(2, Math.floor(topK / FRAMEWORK_ITEM_CODES.length));

  const allHits = [];
  const seenIds = new Set();

  for (const ticker of tickers) {
    let years;
    if (latestOnly) {
      const latest = ticker ? await getLatestFiscalYear(ticker) : null;
      years = latest ? [latest] : [];
    } else if (intent.allYears.length) {
      years = intent.allYears;
    } else {
      const latest = ticker ? await getLatestFiscalYear(ticker) : null;
      years = latest ? [latest] : [];
    }
    if (years.length === 0) continue;

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

async function retrieveForIntent(question, intent, opts = {}) {
  const isFramework = FRAMEWORK_CATEGORIES.has(intent.questionCategory);
  const chunks = isFramework
    ? await retrieveChunksStratified(question, intent, 12, opts)
    : await retrieveChunks(question, intent, 6);

  let facts = [];
  if (intent.isNumericQuestion) {
    const metricForLookup = intent.metric || 'Revenue';

    for (const ticker of intent.tickers) {
      let yearsForTicker = [];

      if (intent.allYears && intent.allYears.length) {
        yearsForTicker = intent.allYears;
      } else if (intent.requestedYearCount) {
        yearsForTicker = await getLatestFiscalYears(ticker, metricForLookup, intent.requestedYearCount);
      } else {
        const latest = await getLatestFiscalYear(ticker, metricForLookup);
        if (latest) yearsForTicker = [latest];
      }

      for (const year of yearsForTicker) {
        facts.push(...await getFinancialFacts(ticker, year));
      }
    }

    if (intent.metricsFound && intent.metricsFound.length >= 2) {
      facts = facts.filter(f => intent.metricsFound.includes(f.metric_name));
    } else if (intent.metric) {
      facts = facts.filter(f => f.metric_name === intent.metric);
    }

    if (
      intent.requestedYearCount &&
      intent.tickers.length === 1 &&
      facts.length > 0
    ) {
      const distinctYears = [...new Set(facts.map(f => f.fiscal_year))];
      if (distinctYears.length < intent.requestedYearCount) {
        const latestAvailable = Math.max(...distinctYears);
        intent.noDataNote =
          `Requested ${intent.requestedYearCount} year(s) but only ${distinctYears.length} ` +
          `are available (through FY${latestAvailable}).`;
      }
    }
  }

  return { chunks, facts };
}

module.exports = {
  getAllCompanies,
  extractIntent, extractIntentFromRouter,
  loadCompanyLookup, extractTickers,
  extractUnresolvedMentions, sanitizeQuestionForLLM,
  detectMetric, detectAllMetrics,
  getLatestFiscalYear, getLatestFiscalYears,
  embedText, retrieveChunks, retrieveChunksStratified, retrieveForIntent,
  getFinancialFacts, getChunkTextByPointIds,
  stripDiacritics,
};