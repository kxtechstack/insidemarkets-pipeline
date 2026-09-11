/**
 * modules/decisionIntelligence/retrieveClientData.js
 *
 * Retrieval for List/Inference questions in the Decision Intelligence
 * chat -- searches the CLIENT'S OWN collected data (never SEC filings),
 * across all existing modules at once.
 *
 * Also parses time windows from the question ("last week", "yesterday",
 * "recent") and applies them as a date filter on Qdrant's payload
 * `published_date` field. If the strict window returns nothing, widens
 * to 30d, then 90d, then 365d, then no filter -- so a client with no
 * signals in the requested window still gets something back.
 */

const { pipeline } = require('@xenova/transformers');
const { QdrantClient } = require('@qdrant/js-client-rest');

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});
const POLICY_COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';

const POLICY_MODULE_ID = '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960';
const MARKET_DYNAMICS_MODULE_ID = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const FORWARD_OUTLOOK_MODULE_ID = '2eb989fd-0ea0-4320-b73a-f7eb8b970473';

const LIVE_MODULE_IDS = [
  POLICY_MODULE_ID,
  MARKET_DYNAMICS_MODULE_ID,
  FORWARD_OUTLOOK_MODULE_ID,
];

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

/**
 * Parse a time window from a question. Returns { days, label } or null.
 */
function detectTimeWindow(question) {
  const q = (question || "").toLowerCase();

  // Numeric windows first
  const daysMatch = q.match(/\b(?:last|past|previous)\s+(\d+)\s+days?\b/);
  if (daysMatch) {
    const d = Math.max(1, Math.min(parseInt(daysMatch[1], 10), 365));
    return { days: d, label: `last ${d} days` };
  }
  const weeksMatch = q.match(/\b(?:last|past|previous)\s+(\d+)\s+weeks?\b/);
  if (weeksMatch) {
    const w = Math.max(1, Math.min(parseInt(weeksMatch[1], 10), 52));
    return { days: w * 7, label: `last ${w} weeks` };
  }
  const monthsMatch = q.match(/\b(?:last|past|previous)\s+(\d+)\s+months?\b/);
  if (monthsMatch) {
    const m = Math.max(1, Math.min(parseInt(monthsMatch[1], 10), 12));
    return { days: m * 30, label: `last ${m} months` };
  }

  // Named windows
  if (/\btoday\b/.test(q))                                 return { days: 1,  label: "today" };
  if (/\byesterday\b/.test(q))                             return { days: 2,  label: "yesterday" };
  if (/\b(?:this|last|past|previous)\s+week\b/.test(q))    return { days: 7,  label: "last week" };
  if (/\b(?:this|last|past|previous)\s+month\b/.test(q))   return { days: 30, label: "last month" };
  if (/\b(?:this|last|past|previous)\s+quarter\b/.test(q)) return { days: 90, label: "last quarter" };
  if (/\brecent(ly)?\b/.test(q))                           return { days: 7,  label: "recent" };
  if (/\blatest\b/.test(q))                                return { days: 14, label: "latest" };
  if (/\bnew(est)?\b/.test(q))                             return { days: 14, label: "new" };

  return null;
}

/**
 * Strip time-related tokens from the question so the semantic embedding
 * isn't polluted by words like "yesterday" / "recent" that have no
 * topical meaning. Falls back to the original question if stripping
 * leaves nothing useful.
 */
function stripTimeTokens(question) {
  const stripped = (question || "")
    .replace(/\b(today|yesterday|recent(ly)?|latest|new(est)?|last|past|previous|this)\b/gi, " ")
    .replace(/\b\d+\s+(days?|weeks?|months?|quarters?|years?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return stripped.length >= 4 ? stripped : question;
}

/**
 * Detect which module(s) a question is about, based on keyword signals.
 */
function detectTargetModules(question) {
  const q = (question || "").toLowerCase();
  const matched = new Set();

  const policyKeywords = [
    "policy", "policies", "regulation", "regulations", "regulatory",
    "compliance", "law", "laws", "legislation", "legislative",
    "act ", "acts ", "ban", "banned", "restrict", "restriction", "restrictions",
    "tariff", "tariffs", "circular", "guideline", "guidelines",
    "licensing", "license", "licence",
    "fda", "saso", "bpjph", "npra", "sfda", "mohap", "ec 1223",
    "import", "export", "customs",
    "halal certification", "safety opinion", "draft regulation",
    "reclassif", "notified", "notification",
  ];
  if (policyKeywords.some(k => q.includes(k))) matched.add(POLICY_MODULE_ID);

  const foKeywords = [
    "outlook", "trend", "trends", "horizon", "future",
    "emerging", "forecast", "prediction", "predict",
    "innovation", "innovative", "technology", "technologies",
    "biotech", "next-gen", "next generation",
    "mid-term", "long-term", "near-term", "mid term", "long term", "near term",
    "patent", "patents",
    "launch pipeline", "upcoming",
  ];
  if (foKeywords.some(k => q.includes(k))) matched.add(FORWARD_OUTLOOK_MODULE_ID);

  const mdKeywords = [
    "market", "markets", "funding", "investment", "investments",
    "raise", "raised", "acquisition", "acquire", "acquired",
    "m&a", "merger", "mergers", "consolidation",
    "competitor", "competitors", "competitive",
    "industry structure", "macro", "economic",
    "capital", "valuation", "divest", "divestiture",
    "stake", "venture", "ipo",
    "revenue", "sales", "margin", "margins",
  ];
  if (mdKeywords.some(k => q.includes(k))) matched.add(MARKET_DYNAMICS_MODULE_ID);

  if (matched.size === 0) return [...LIVE_MODULE_IDS];
  return [...matched];
}

/**
 * Searches the client's own data across existing modules, with optional
 * time-window filtering and module scoping.
 */
async function retrieveClientData(question, clientId, industry, limitPerModule = 10, modules = null) {
  const timeWindow = detectTimeWindow(question);
  const topicQuery = stripTimeTokens(question);
  const questionVector = await embedText(topicQuery);

  const targetModules = (modules && modules.length) ? modules : LIVE_MODULE_IDS;

  // Window progression: requested window first (if any), then 30d, 90d,
  // 365d, then no filter. The first window that returns any hits above
  // the score floor wins.
  const windowsToTry = timeWindow
    ? [timeWindow.days, 30, 90, 365, null]
    : [null];

  let chosen = [];

  for (const days of windowsToTry) {
    const allResults = [];

    for (const moduleId of targetModules) {
      const must = [
        { key: 'client_id', match: { value: clientId } },
        { key: 'industry', match: { value: industry } },
        { key: 'module_id', match: { value: moduleId } },
      ];

      if (days) {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        must.push({
          key: 'published_date',
          range: { gte: cutoff },
        });
      }

      const results = await qdrant.search(POLICY_COLLECTION, {
        vector: questionVector,
        limit: limitPerModule,
        filter: { must },
        with_payload: true,
      });
      allResults.push(...results);
    }

    const filtered = allResults.filter(r => r.score >= 0.20);

    if (filtered.length > 0) {
      chosen = filtered;
      if (timeWindow && days !== timeWindow.days) {
        console.log(
          `[retrieveClientData] No hits in "${timeWindow.label}" (${timeWindow.days}d), widened to ${days}d`
        );
      }
      break;
    }
  }

  // Dedupe by article/title and sort by score
  const seen = new Set();
  const deduped = [];
  for (const r of chosen.sort((a, b) => b.score - a.score)) {
    const key = r.payload.url || r.payload.title;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  return deduped;
}

module.exports = {
  retrieveClientData,
  embedText,
  LIVE_MODULE_IDS,
  detectTargetModules,
  detectTimeWindow,   // exported for testing
  stripTimeTokens,    // exported for testing
};