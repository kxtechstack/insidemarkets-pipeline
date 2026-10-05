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
const { keepVisibleResults } = require('./visibleFilter');
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
    // Regulator / agency names — needed for questions like
    // "Has the Nuclear Regulatory Commission proposed anything recently?"
    "commission", "nrc", "nuclear regulatory", "nuclear regulator",
    "regulator", "regulatory body", "regulatory commission",
    "atomic energy", "nuclear safety", "nuclear safety authority",
    "energy commission", "energy regulator",
    "securities commission", "competition commission",
    "central bank",
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
// ── Named-entity rescue ─────────────────────────────────────────────────
// Semantic search is bad at short entity questions ("What updates on
// Glossier?"). The embedding of a 6-word generic question often scores
// below the DI_SCORE_FLOOR against specific signal chunks that mention
// the entity by name, so the signal is missed even though it's in the DB.
//
// This fallback catches that: extract capitalized words from the question
// and do a direct ILIKE lookup on signal_title / summary / organization
// across all three signal tables. If an entity match is found, we return
// those signals regardless of semantic score.

const ENTITY_STOPWORDS = new Set([
  // Question words
  'what', 'who', 'where', 'when', 'why', 'how', 'which', 'whom', 'whose',
  // Articles / conjunctions
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than',
  'in', 'on', 'at', 'by', 'for', 'with', 'from', 'to', 'of', 'as',
  // Common verbs
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'may', 'might',
  'tell', 'me', 'us', 'show', 'give', 'get', 'find', 'list',
  // Query intent words
  'any', 'all', 'some', 'more', 'most', 'many', 'much', 'few', 'less',
  'new', 'news', 'update', 'updates', 'recent', 'recently', 'latest',
  'last', 'past', 'this', 'that', 'these', 'those', 'week', 'weeks',
  'month', 'months', 'year', 'years', 'day', 'days', 'today', 'yesterday',
  'about', 'regarding', 'concerning',
  // Industry words that would match too broadly
  'industry', 'market', 'sector', 'company', 'companies', 'business',
  // ── Generic business / regulatory terminology ────────────────────────
  // These are capitalized mid-sentence in normal writing but are NOT
  // proper nouns — so they shouldn't trigger entity rescue.
  'excise', 'duty', 'duties', 'tax', 'taxes', 'taxation',
  'product', 'products', 'service', 'services',
  'regulation', 'regulations', 'regulatory', 'compliance', 'law', 'laws',
  'legislation', 'legislative', 'policy', 'policies', 'rule', 'rules',
  'act', 'acts', 'bill', 'bills', 'amendment', 'amendments',
  'procedure', 'procedures', 'process', 'processes', 'step', 'steps',
  'requirement', 'requirements', 'deadline', 'deadlines',
  'cosmetic', 'cosmetics', 'beauty', 'skincare', 'haircare', 'makeup',
  'funding', 'investment', 'investments', 'venture', 'capital',
  'revenue', 'profit', 'income', 'sales', 'earnings',
  'report', 'reports', 'study', 'studies', 'analysis', 'research',
  'government', 'ministry', 'agency', 'authority', 'commission',
  'united', 'states', 'kingdom', 'europe', 'european', 'asia', 'global',
]);

function extractNamedEntities(question) {
  if (!question) return [];
  // Grab capitalized words that aren't at the start of a sentence-only
  // context (allow "Glossier" even mid-sentence), 3+ chars, not stopwords.
  const matches = question.match(/\b[A-Z][a-zA-Z0-9&.'-]{2,}\b/g) || [];
  const out = [];
  const seen = new Set();
  for (const w of matches) {
    const lower = w.toLowerCase();
    if (ENTITY_STOPWORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(w);
  }
  return out;
}

// Region-aware retrieval: when a non-US region is detected in the question
// (via detectNonUSGeography in resolveCompanySet.js), always do an ILIKE
// match on that region's aliases against signal_title / summary. This
// bypasses the semantic-score floor entirely -- short questions like
// "south korea swot analysis" embed to generic vectors that don't clear
// the floor, but the region term itself is an exact match we can rely on.
const REGION_ALIASES = {
  'south korea': ['south korea', 'korea', 'seoul', 'k-beauty', 'korean'],
  'north korea': ['north korea', 'dprk', 'pyongyang'],
  'united kingdom': ['united kingdom', 'uk', 'britain', 'england', 'scotland', 'wales'],
  'uk': ['uk', 'united kingdom', 'britain', 'england'],
  'germany': ['germany', 'german', 'berlin'],
  'france': ['france', 'french', 'paris'],
  'japan': ['japan', 'japanese', 'tokyo'],
  'china': ['china', 'chinese', 'beijing', 'shanghai'],
  'india': ['india', 'indian', 'delhi', 'mumbai'],
  'brazil': ['brazil', 'brazilian', 'sao paulo'],
  'mexico': ['mexico', 'mexican'],
  'indonesia': ['indonesia', 'indonesian', 'jakarta'],
  'vietnam': ['vietnam', 'vietnamese'],
  'european union': ['european union', 'eu', 'europe', 'european'],
  'europe': ['europe', 'european', 'eu'],
  'middle east': ['middle east', 'mena', 'gulf', 'uae', 'saudi'],
  'africa': ['africa', 'african'],
  'latin america': ['latin america', 'latam', 'south america'],
};

async function retrieveSignalsByRegion(clientId, regionTerm) {
  if (!regionTerm) return [];
  const key = String(regionTerm).toLowerCase().trim();
  const aliases = REGION_ALIASES[key] || [key];

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const signalTables = [
    { table: 'policy_signals', moduleId: POLICY_MODULE_ID,
      columns: 'id, article_id, signal_title, summary, source_published_date, created_at, submodule_id, module_id, industry, client_id' },
    { table: 'market_dynamics_signals', moduleId: MARKET_DYNAMICS_MODULE_ID,
      columns: 'id, article_id, signal_title, summary, published_date, created_at, submodule_id, module_id, organization, client_id' },
    { table: 'trend_signals', moduleId: FORWARD_OUTLOOK_MODULE_ID,
      columns: 'id, article_id, signal_title, summary, source_published_date, created_at, submodule_id, module_id, organization, industry, client_id' },
  ];

  const results = [];
  for (const { table, moduleId, columns } of signalTables) {
    const orClauses = [];
    for (const a of aliases) {
      const escaped = a.replace(/[%_]/g, m => `\\${m}`);
      orClauses.push(`signal_title.ilike.%${escaped}%`);
      orClauses.push(`summary.ilike.%${escaped}%`);
    }
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('client_id', clientId)
      .or(orClauses.join(','))
      .limit(15);

    if (error) {
      console.log(`[RegionRescue] ${table} failed: ${error.message}`);
      continue;
    }
    for (const row of data || []) {
      results.push({
        region_match: true,
        module_id: row.module_id || moduleId,
        signal_id: row.id,
        article_id: row.article_id,
        title: row.signal_title,
        summary: row.summary,
        published_date: row.source_published_date || row.published_date || row.created_at,
        submodule_id: row.submodule_id,
        organization: row.organization || null,
      });
    }
  }
  console.log(`[RegionRescue] region="${regionTerm}" aliases=[${aliases.join(',')}] -> ${results.length} signal(s)`);
  return results;
}

async function retrieveSignalsByEntity(clientId, entities) {
  if (!entities || entities.length === 0) return [];

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  // Each table has slightly different columns. We select only what exists
  // in each and normalize the output afterwards.
  const signalTables = [
    {
      table: 'policy_signals',
      moduleId: POLICY_MODULE_ID,
      columns: 'id, article_id, signal_title, summary, source_published_date, created_at, submodule_id, module_id, industry, client_id',
    },
    {
      table: 'market_dynamics_signals',
      moduleId: MARKET_DYNAMICS_MODULE_ID,
      columns: 'id, article_id, signal_title, summary, published_date, created_at, submodule_id, module_id, organization, client_id',
    },
    {
      table: 'trend_signals',
      moduleId: FORWARD_OUTLOOK_MODULE_ID,
      columns: 'id, article_id, signal_title, summary, source_published_date, created_at, submodule_id, module_id, organization, industry, client_id',
    },
  ];

  const results = [];

  for (const { table, moduleId, columns } of signalTables) {
    // Build OR filter: entity matching against signal_title OR summary.
    const orClauses = [];
    for (const e of entities) {
      const escaped = e.replace(/[%_]/g, m => `\\${m}`);
      orClauses.push(`signal_title.ilike.%${escaped}%`);
      orClauses.push(`summary.ilike.%${escaped}%`);
    }

    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('client_id', clientId)
      .or(orClauses.join(','))
      .limit(10);

    if (error) {
      console.log(`[EntityRescue] ${table} query failed: ${error.message}`);
      continue;
    }

    for (const row of data || []) {
      results.push({
        entity_match: true,
        module_id: row.module_id || moduleId,
        signal_id: row.id,
        article_id: row.article_id,
        title: row.signal_title,
        summary: row.summary,
        published_date:
          row.source_published_date || row.published_date || row.created_at,
        submodule_id: row.submodule_id,
        organization: row.organization || null,
      });
    }
  }

  console.log(
    `[EntityRescue] entities=${JSON.stringify(entities)} -> ${results.length} signal(s)`
  );
  return results;
}

/**
 * Searches the client's own data across existing modules, with optional
 * time-window filtering and module scoping.
 */
async function retrieveClientData(question, clientId, industry, limitPerModule = 10, modules = null, scoreFloorOverride = null, disableWidening = false) {
  const timeWindow = detectTimeWindow(question);
  const topicQuery = stripTimeTokens(question);
  const questionVector = await embedText(topicQuery);

  const targetModules = (modules && modules.length) ? modules : LIVE_MODULE_IDS;

  // Window progression: requested window first (if any), then 30d, 90d,
  // 365d, then no filter. The first window that returns any hits above
  // the score floor wins.
  const windowsToTry = timeWindow
    ? (disableWidening ? [timeWindow.days] : [timeWindow.days, 30, 90, 365, null])
    : [null];

  // Keep widening until we have at least this many results, OR we've
  // tried every window. Prevents "past week" from returning 1-2 items
  // when the corpus has plenty of older, still-relevant material.
  const MIN_RESULTS_TO_STOP_WIDENING = 5;

  let bestAttempt = [];
  let bestWindowDays = null;

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

    const SCORE_FLOOR = scoreFloorOverride ?? (Number(process.env.DI_SCORE_FLOOR) || 0.53);
    const filtered = await keepVisibleResults(
      allResults.filter(r => r.score >= SCORE_FLOOR),
      clientId
    );

    // Remember the richest attempt so far
    if (filtered.length > bestAttempt.length) {
      bestAttempt = filtered;
      bestWindowDays = days;
    }

    // Stop as soon as we have enough results
    if (filtered.length >= MIN_RESULTS_TO_STOP_WIDENING) {
      bestAttempt = filtered;
      bestWindowDays = days;
      break;
    }
  }

  if (timeWindow && bestWindowDays !== timeWindow.days) {
    console.log(
      `[retrieveClientData] Window "${timeWindow.label}" (${timeWindow.days}d) returned < ${MIN_RESULTS_TO_STOP_WIDENING} hits; widened to ${bestWindowDays || 'no filter'}`
    );
  }

  let chosen = bestAttempt;

  // ── Named-entity rescue ──────────────────────────────────────────────
  // If semantic search came up empty (or thin) and the question names
  // specific entities, fall back to a direct Postgres lookup. This
  // recovers short entity questions like "What updates on Glossier?"
  // that score poorly against Qdrant chunks.
  if (chosen.length < 3) {
    const entities = extractNamedEntities(topicQuery);
    if (entities.length > 0) {
      const entityMatches = await retrieveSignalsByEntity(clientId, entities);

      // Filter entity matches to target modules only.
      const filteredEntities = entityMatches.filter(m =>
        targetModules.includes(m.module_id)
      );

      // Dedupe against what we already have (by article_id or signal_id).
      const existingIds = new Set(
        chosen.map(r => r.payload?.article_id || r.payload?.signal_id)
      );
      const additions = filteredEntities.filter(m =>
        !existingIds.has(m.article_id) && !existingIds.has(m.signal_id)
      );

      if (additions.length > 0) {
        console.log(
          `[retrieveClientData] Entity rescue added ${additions.length} signal(s) ` +
          `via direct lookup (${entities.join(', ')})`
        );
        // Normalize additions to the same shape as Qdrant hits so the
        // rest of the pipeline (buildListAnswer, generateInferenceAnswer)
        // can consume them uniformly.
        const normalizedAdditions = additions.map((m, idx) => ({
          id: `entity_${m.signal_id || m.article_id || idx}`,
          score: 0.99, // high score so they sort to the top
          payload: {
            article_id: m.article_id || null,
            signal_id: m.signal_id,
            title: m.title,
            summary: m.summary,
            chunk_text: m.summary || m.title,
            module_id: m.module_id,
            submodule_id: m.submodule_id,
            published_date: m.published_date,
            source_published_date: m.published_date,
            entity_match: true,
          },
        }));
        chosen = [...normalizedAdditions, ...chosen];
      } else {
        console.log(
          `[retrieveClientData] Entity rescue found no new signal(s) for ` +
          `${entities.join(', ')}`
        );
      }
    }
  }
    // ── Region rescue ─────────────────────────────────────────────────────
  // When a non-US region is detected and we still don't have enough hits,
  // do an exact ILIKE match on the region name + its aliases. This catches
  // lowercase short queries like "south korea swot analysis" whose
  // embeddings don't clear the semantic score floor.
  if (chosen.length < 5) {
    try {
      const { detectNonUSGeography } = require('./resolveCompanySet');
      const region = detectNonUSGeography(question);
      if (region) {
        const regionMatches = await retrieveSignalsByRegion(clientId, region);
        const existingIds = new Set(
          chosen.map(r => r.payload?.article_id || r.payload?.signal_id)
        );
        const additions = regionMatches.filter(m =>
          !existingIds.has(m.article_id) && !existingIds.has(m.signal_id)
        );
        if (additions.length > 0) {
          console.log(`[retrieveClientData] Region rescue added ${additions.length} signal(s) for "${region}"`);
          const normalized = additions.map((m, idx) => ({
            id: `region_${m.signal_id || m.article_id || idx}`,
            score: 0.98,
            payload: {
              article_id: m.article_id || null,
              signal_id: m.signal_id,
              title: m.title,
              summary: m.summary,
              chunk_text: m.summary || m.title,
              module_id: m.module_id,
              submodule_id: m.submodule_id,
              published_date: m.published_date,
              source_published_date: m.published_date,
              region_match: true,
            },
          }));
          chosen = [...normalized, ...chosen];
        } else {
          console.log(`[retrieveClientData] Region rescue found no new signal(s) for "${region}"`);
        }
      }
    } catch (err) {
      console.log(`[retrieveClientData] Region rescue failed: ${err.message}`);
    }
  }

  const chosenFinal = chosen;

  // NEW: log every retrieved chunk with its score, so we can see exactly
  // what's passing the current 0.20 threshold before deciding whether to
  // change it.
  const effectiveFloor = Number(process.env.DI_SCORE_FLOOR) || 0.53;
  console.log(`[retrieveClientData] Query: "${question}" | window=${bestWindowDays === null ? 'no filter' : bestWindowDays + 'd'} | floor=${effectiveFloor} | ${chosenFinal.length} result(s)`);
  chosenFinal.forEach((r, i) => {
    console.log(`  [${i + 1}] score=${r.score.toFixed(3)} | module=${r.payload.module_id} | title="${r.payload.title}"`);
    console.log(`      chunk_text: ${(r.payload.chunk_text || '(none)').slice(0, 300)}`);
  });

  // Dedupe by article/title and sort by score
  const seen = new Set();
  const deduped = [];
  for (const r of [...chosenFinal].sort((a, b) => b.score - a.score)) {
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