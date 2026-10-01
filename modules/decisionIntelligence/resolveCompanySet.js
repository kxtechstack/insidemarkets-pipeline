// modules/decisionIntelligence/resolveCompanySet.js
const { callLLM } = require('../llmClient');

const VALID_SECTORS = new Set([
  'Information Technology', 'Financials', 'Health Care', 'Energy',
  'Industrials', 'Consumer Discretionary', 'Consumer Staples',
  'Utilities', 'Real Estate', 'Materials', 'Communication Services',
]);

const VALID_METRICS = new Set([
  'Revenue', 'NetIncome', 'TotalAssets', 'TotalLiabilities', 'CashFlow', 'CapEx',
]);

// ── Shared mapping block injected into both prompts ────────────────────────
const SECTOR_MAPPING_BLOCK = `COMMON TERM -> SECTOR MAPPINGS (use this to resolve
business / industry words the user types into one of our 11 sectors):

Information Technology:
  tech, technology, software, SaaS, cloud, hardware, semiconductor, chip, AI,
  artificial intelligence, machine learning, cybersecurity, internet, FAANG,
  big tech, IT services, enterprise software, consumer electronics

Financials:
  bank, banking, financial services, insurance, asset management, investment bank,
  brokerage, wealth management, payments, fintech, credit cards, mortgage,
  capital markets, private equity, venture capital, hedge fund

Health Care:
  pharma, pharmaceutical, biotech, biotechnology, drugs, healthcare, health care,
  medical devices, medical equipment, hospital, diagnostics, life sciences,
  genomics, therapeutics, clinical trials, health insurance

Energy:
  oil, gas, petroleum, energy, oilfield services, pipeline, refinery,
  renewables, clean energy, coal, LNG, drilling, exploration

Industrials:
  industrial, manufacturing, aerospace, defense, airline, airlines, aviation,
  railway, railroad, shipping, logistics, machinery, construction equipment,
  electrical equipment, automation, engineering, conglomerate

Consumer Discretionary:
  retail, e-commerce, ecommerce, apparel, fashion, luxury, cosmetics, beauty,
  skincare, restaurants, hotels, travel, leisure, autos, automobiles, automotive,
  homebuilders, home improvement

Consumer Staples:
  food, beverage, drinks, household products, personal care products, tobacco,
  alcohol, groceries, supermarkets, packaged foods, cleaning products,
  consumer staples

Utilities:
  utility, utilities, electric utility, gas utility, water utility, power,
  electricity, regulated utility

Real Estate:
  real estate, REIT, property, commercial real estate, residential real estate,
  office REIT, data center REIT, real estate development

Materials:
  chemicals, chemical, metals, mining, steel, aluminum, gold, copper, materials,
  packaging, paper, forest products, construction materials, specialty chemicals

Communication Services:
  telecom, telecommunications, wireless, media, entertainment, streaming,
  broadcasting, publishing, advertising, social media, internet content,
  cable, satellite, gaming`;

// ── Prompt 1: main classifier ──────────────────────────────────────────────
function buildClassifierPrompt(question) {
  return `Analyze this question and determine if it references a SET of companies by category or sector (as opposed to a specific named company), for the purpose of comparing their PUBLIC FINANCIAL FILINGS (SEC data).

Question: "${question}"

${SECTOR_MAPPING_BLOCK}

IMPORTANT: Only answer true if the question is asking to compare named public
companies' financial metrics (revenue, assets, etc.) across a sector. If the
question is instead asking about "my market", "my industry", "my data", recent
news, signals, trends, or activity the client has collected (even if it uses
words like "corporate" or "companies" in passing), respond isCompanySet: false.

If it does reference a company set for financial comparison, respond with JSON:
{
  "isCompanySet": true,
  "sector": "Information Technology" | "Financials" | "Health Care" | "Energy" | "Industrials" | "Consumer Discretionary" | "Consumer Staples" | "Utilities" | "Real Estate" | "Materials" | "Communication Services" | null,
  "metric": "Revenue" | "NetIncome" | "TotalAssets" | "TotalLiabilities" | "CashFlow" | null,
  "orderBy": "desc" | "asc",
  "limit": 5,
  "unresolved_term": null
}

RESOLUTION RULES:
1. First try to resolve the user's domain word using the COMMON TERM -> SECTOR
   MAPPINGS above. If it maps cleanly, use that sector and set unresolved_term: null.
2. If the user's domain word is NOT in the mapping table AND you cannot confidently
   map it to one of the 11 sectors, set sector: null AND set unresolved_term to
   the exact word the user used (e.g. "cosmetic", "aerospace startups").
3. If the question genuinely asks about companies ACROSS all sectors (e.g. "top 5
   US companies by revenue" with no domain restriction), set sector: null AND
   unresolved_term: null.
4. "tech" or "technology" -> "Information Technology".
5. If the user names a specific company, respond { "isCompanySet": false }.

If the question is about a specific named company (Apple, Microsoft), or does
not reference a sector/company set for financial comparison, respond:
{ "isCompanySet": false }

Respond with ONLY the JSON, no other text.`;
}

// ── Prompt 2: disambiguation (only runs when unresolved_term is present) ──
function buildDisambiguationPrompt(question, unresolvedTerm) {
  return `The user asked: "${question}"

Their wording references "${unresolvedTerm}", which didn't map cleanly to any of
our 11 sectors. Your job: decide which of the 11 sectors below is CLOSEST to
"${unresolvedTerm}", or return null if none is a good fit.

The 11 sectors:
Information Technology, Financials, Health Care, Energy, Industrials,
Consumer Discretionary, Consumer Staples, Utilities, Real Estate, Materials,
Communication Services

Respond with JSON:
{
  "sector": "One of the 11 sectors above" | null,
  "reasoning": "one short sentence"
}

If "${unresolvedTerm}" could plausibly fit multiple sectors, pick the one that
contains the LARGEST number of US-listed companies matching that term. If you
genuinely cannot pick, return sector: null.

Respond with ONLY the JSON, no other text.`;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function stripFences(raw) {
  return (raw || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
}

async function callClassifier(question) {
  const raw = await callLLM(
    [{ role: 'user', content: buildClassifierPrompt(question) }],
    { temperature: 0, max_tokens: 300, timeout: 30000 }
  );
  return JSON.parse(stripFences(raw));
}

async function callDisambiguation(question, unresolvedTerm) {
  const raw = await callLLM(
    [{ role: 'user', content: buildDisambiguationPrompt(question, unresolvedTerm) }],
    { temperature: 0, max_tokens: 200, timeout: 30000 }
  );
  return JSON.parse(stripFences(raw));
}

// ── Main entry point ───────────────────────────────────────────────────────
async function resolveCompanySet(question) {
  // Fast guard: "my market / my industry / my data" questions are never
  // company-set queries.
  const q = (question || '').toLowerCase();
  const ownDataPhrases = [
    'my market', 'my industry', 'my sector', 'my data', 'my client',
    'in my', 'our market', 'our industry', 'our sector',
  ];
  if (ownDataPhrases.some(p => q.includes(p))) {
    console.log(`[resolveCompanySet] own-data phrase detected -- skipping`);
    return null;
  }

  // ── Layer 1: main classifier with mapping table ──
  let parsed;
  try {
    parsed = await callClassifier(question);
  } catch (err) {
    console.log(`[resolveCompanySet] classifier failed: ${err.message}`);
    return null;
  }

  if (!parsed.isCompanySet) return null;

  let sector = VALID_SECTORS.has(parsed.sector) ? parsed.sector : null;
  let unresolvedTerm = typeof parsed.unresolved_term === 'string'
    ? parsed.unresolved_term.trim()
    : null;

  // ── Layer 2: disambiguation -- only if unresolved_term is present ──
  if (sector === null && unresolvedTerm) {
    console.log(`[resolveCompanySet] layer-1 unresolved: "${unresolvedTerm}" -- trying disambiguation`);
    try {
      const disambig = await callDisambiguation(question, unresolvedTerm);
      if (disambig && VALID_SECTORS.has(disambig.sector)) {
        sector = disambig.sector;
        unresolvedTerm = null;
        console.log(`[resolveCompanySet] layer-2 resolved "${unresolvedTerm}" -> ${sector} (${disambig.reasoning || 'no reasoning'})`);
      } else {
        console.log(`[resolveCompanySet] layer-2 could not resolve "${unresolvedTerm}" -- returning null sector with unresolved marker`);
      }
    } catch (err) {
      console.log(`[resolveCompanySet] disambiguation failed: ${err.message}`);
      // leave unresolvedTerm set so caller can refuse
    }
  }

  const metric = VALID_METRICS.has(parsed.metric) ? parsed.metric : 'Revenue';
  const orderBy = parsed.orderBy === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(Math.max(Number(parsed.limit) || 5, 1), 20);

  console.log(
    `[resolveCompanySet] resolved: sector=${sector || 'null'} metric=${metric} ` +
    `orderBy=${orderBy} limit=${limit} unresolved=${unresolvedTerm || 'none'}`
  );

  return { sector, metric, orderBy, limit, unresolvedTerm };
}

module.exports = { resolveCompanySet };