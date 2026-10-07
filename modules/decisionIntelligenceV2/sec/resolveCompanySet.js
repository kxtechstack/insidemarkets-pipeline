/**
 * modules/decisionIntelligenceV2/sec/resolveCompanySet.js
 *
 * COPIED VERBATIM from modules/decisionIntelligence/resolveCompanySet.js
 * Only change: import path of callLLM (../llmClient → ../../llmClient).
 *
 * Owns: geographic scope guard + company-set classifier + sector
 * disambiguation. Used by secHandler.js.
 */

const { callLLM } = require('../../llmClient');

// ── Geographic scope guard ──────────────────────────────────────────────
// Financial data source is SEC filings — US-listed companies only.
// When a question names a non-US geography, SEC answers would be wrong.

const US_TERMS = [
  'us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america',
  'america', 'american', 'americans',
  'wall street', 'silicon valley',
];

const NON_US_COUNTRIES = [
  'afghanistan','albania','algeria','andorra','angola','antigua',
  'argentina','armenia','aruba','australia','austria','azerbaijan',
  'bahamas','bahrain','bangladesh','barbados','belarus','belgium',
  'belize','benin','bermuda','bhutan','bolivia','bosnia',
  'botswana','brazil','brunei','bulgaria','burkina faso','burundi',
  'cambodia','cameroon','canada','cape verde','cayman islands',
  'central african republic','chad','chile','china','colombia',
  'comoros','congo','costa rica',"cote d'ivoire",'croatia','cuba',
  'cyprus','czechia','czech republic',
  'denmark','djibouti','dominica','dominican republic',
  'ecuador','egypt','el salvador','equatorial guinea','eritrea',
  'estonia','eswatini','ethiopia',
  'fiji','finland','france',
  'gabon','gambia','georgia','germany','ghana','greece','grenada',
  'guatemala','guinea','guinea-bissau','guyana',
  'haiti','honduras','hong kong','hungary',
  'iceland','india','indonesia','iran','iraq','ireland','israel','italy',
  'jamaica','japan','jordan',
  'kazakhstan','kenya','kiribati','kosovo','kuwait','kyrgyzstan',
  'laos','latvia','lebanon','lesotho','liberia','libya',
  'liechtenstein','lithuania','luxembourg',
  'macau','madagascar','malawi','malaysia','maldives','mali','malta',
  'marshall islands','mauritania','mauritius','mexico','micronesia',
  'moldova','monaco','mongolia','montenegro','morocco','mozambique',
  'myanmar',
  'namibia','nauru','nepal','netherlands','new zealand','nicaragua',
  'niger','nigeria','north korea','north macedonia','norway',
  'oman',
  'pakistan','palau','palestine','panama','papua new guinea','paraguay',
  'peru','philippines','poland','portugal',
  'qatar',
  'romania','russia','rwanda',
  'saint kitts','saint lucia','saint vincent','samoa','san marino',
  'sao tome','saudi arabia','senegal','serbia','seychelles',
  'sierra leone','singapore','slovakia','slovenia','solomon islands',
  'somalia','south africa','south korea','south sudan','spain',
  'sri lanka','sudan','suriname','sweden','switzerland','syria',
  'taiwan','tajikistan','tanzania','thailand','timor-leste','togo',
  'tonga','trinidad','tunisia','turkey','turkmenistan','tuvalu',
  'uganda','ukraine','united arab emirates','united kingdom',
  'uruguay','uzbekistan',
  'vanuatu','vatican','venezuela','vietnam',
  'yemen',
  'zambia','zimbabwe',
];

const NON_US_ALIASES = [
  'uk','britain','great britain','england','scotland','wales',
  'northern ireland','holland','deutschland','espana','italia',
  'uae','ksa','saudi','emirates','korea','s. korea','n. korea',
  'prc','roc','russian federation','czech','burma','ivory coast',
  'swaziland','vatican city','holy see',
];

const NON_US_REGIONS = [
  'europe','european','eu','emea','asia','asian','apac',
  'southeast asia','south asia','east asia','central asia',
  'middle east','mena','africa','african','sub-saharan africa',
  'latin america','latam','south america','central america',
  'caribbean','nordics','nordic','scandinavia','scandinavian',
  'balkans','balkan','baltic','baltic states',
  'oceania','pacific islands','commonwealth',
  'gcc','brics','asean',
];

const NON_US_CURRENCIES = [
  'euro','euros','eur','pound','pounds','gbp','sterling',
  'yen','jpy','yuan','renminbi','rmb','cny',
  'rupee','rupees','inr','won','krw',
  'real','brl','peso','pesos','mxn','ars',
  'dirham','aed','riyal','sar','ringgit','myr',
  'baht','thb','rupiah','idr','rand','zar',
];

const NON_US_TERMS = [
  ...NON_US_COUNTRIES,
  ...NON_US_ALIASES,
  ...NON_US_REGIONS,
  ...NON_US_CURRENCIES,
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ACRONYM_OVERRIDES = {
  'uk': 'UK', 'us': 'US', 'usa': 'USA', 'uae': 'UAE', 'eu': 'EU',
  'emea': 'EMEA', 'apac': 'APAC', 'mena': 'MENA', 'latam': 'LATAM',
  'gcc': 'GCC', 'brics': 'BRICS', 'asean': 'ASEAN', 'prc': 'PRC',
  'roc': 'ROC', 'ksa': 'KSA',
};

function titleCase(s) {
  return s.split(/\s+/).map(w => {
    const lower = w.toLowerCase();
    if (ACRONYM_OVERRIDES[lower]) return ACRONYM_OVERRIDES[lower];
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

function detectNonUSGeography(question) {
  if (!question) return null;
  const q = String(question).toLowerCase();

  for (const term of US_TERMS) {
    const pattern = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
    if (pattern.test(q)) return null;
  }

  for (const term of NON_US_TERMS) {
    const pattern = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
    if (pattern.test(q)) {
      return titleCase(term);
    }
  }

  return null;
}
// ── end geographic scope guard ─────────────────────────────────────────

const VALID_SECTORS = new Set([
  'Information Technology', 'Financials', 'Health Care', 'Energy',
  'Industrials', 'Consumer Discretionary', 'Consumer Staples',
  'Utilities', 'Real Estate', 'Materials', 'Communication Services',
]);

const VALID_METRICS = new Set([
  'Revenue', 'NetIncome', 'TotalAssets', 'TotalLiabilities', 'CashFlow', 'CapEx',
]);

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
  "unresolved_term": null,
  "subsector_term": null
}

RESOLUTION RULES:
1. First try to resolve the user's domain word using the COMMON TERM -> SECTOR
   MAPPINGS above. If it maps cleanly, use that sector and set unresolved_term: null.
2. If the user's domain word is NOT in the mapping table AND you cannot confidently
   map it to one of the 11 sectors, set sector: null AND set unresolved_term to
   the exact word the user used (e.g. "cosmetic", "aerospace startups").
3. If the question genuinely asks about companies ACROSS all sectors (e.g. "top 5
   US companies by revenue" with no domain restriction), set sector: null,
   unresolved_term: null, subsector_term: null.
4. "tech" or "technology" -> "Information Technology".
5. If the user names a specific company, respond { "isCompanySet": false }.

SUBSECTOR_TERM RULE:
- If the user's question contains a SPECIFIC subsector or product category word
  (e.g. "cosmetic", "pharma", "airline", "semiconductor", "beauty", "software"),
  set subsector_term to that exact word.
- Even if the word maps cleanly to a sector via the mapping table, STILL set
  subsector_term to that word. It will be used downstream to narrow to the
  right companies within the sector.
- If the question is broad ("top consumer companies", "top US companies"),
  set subsector_term: null.
- If subsector_term is set, you may leave sector as null -- the downstream
  picker will handle the sector narrowing from the subsector word.

If the question is about a specific named company (Apple, Microsoft), or does
not reference a sector/company set for financial comparison, respond:
{ "isCompanySet": false }

Respond with ONLY the JSON, no other text.`;
}

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
    { temperature: 0, max_tokens: 350, timeout: 30000 }
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

async function resolveCompanySet(question) {
  const q = (question || '').toLowerCase();
  const ownDataPhrases = [
    'my market', 'my industry', 'my sector', 'my data', 'my client',
    'in my', 'our market', 'our industry', 'our sector',
  ];
  if (ownDataPhrases.some(p => q.includes(p))) {
    console.log(`[resolveCompanySet] own-data phrase detected -- skipping`);
    return null;
  }

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

  if (sector === null && unresolvedTerm) {
    console.log(`[resolveCompanySet] layer-1 unresolved: "${unresolvedTerm}" -- trying disambiguation`);
    try {
      const disambig = await callDisambiguation(question, unresolvedTerm);
      if (disambig && VALID_SECTORS.has(disambig.sector)) {
        const resolvedSector = disambig.sector;
        console.log(`[resolveCompanySet] layer-2 resolved "${unresolvedTerm}" -> ${resolvedSector} (${disambig.reasoning || 'no reasoning'})`);
        sector = resolvedSector;
        unresolvedTerm = null;
      } else {
        console.log(`[resolveCompanySet] layer-2 could not resolve "${unresolvedTerm}" -- returning null sector with unresolved marker`);
      }
    } catch (err) {
      console.log(`[resolveCompanySet] disambiguation failed: ${err.message}`);
    }
  }

  const metric = VALID_METRICS.has(parsed.metric) ? parsed.metric : 'Revenue';
  const orderBy = parsed.orderBy === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(Math.max(Number(parsed.limit) || 5, 1), 20);

  const subsectorTerm =
    typeof parsed.subsector_term === 'string' && parsed.subsector_term.trim()
      ? parsed.subsector_term.trim()
      : null;

  console.log(
    `[resolveCompanySet] resolved: sector=${sector || 'null'} metric=${metric} ` +
    `orderBy=${orderBy} limit=${limit} unresolved=${unresolvedTerm || 'none'} ` +
    `subsector=${subsectorTerm || 'none'}`
  );

  return { sector, metric, orderBy, limit, unresolvedTerm, subsectorTerm };
}

module.exports = { resolveCompanySet, detectNonUSGeography };