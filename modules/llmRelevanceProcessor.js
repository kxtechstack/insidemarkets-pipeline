/**
 * llmRelevanceProcessor.js
 * ===========================
 * Pulls articles from the processed Redis queue in small batches,
 * classifies each one as relevant/irrelevant via LM Studio, and for
 * relevant articles also extracts structured signal fields (title,
 * category, impact level, source_type, country, summary, business impact)
 * in the SAME LLM call -- no second call needed.
 *
 * Before storing in Qdrant, article content is:
 *   1. Cleaned (removes URLs, ads, nav menus, junk)
 *   2. Synthesized by LLM into its own words (avoids storing copyrighted text)
 *
 * Chunks + embeds the SYNTHESIZED content and stores in Qdrant.
 * Synthesized title and body stored in Supabase — no raw original text anywhere.
 *
 * Prompt is fetched from Supabase (prompts table),
 * never hardcoded here.
 *
 * CHANGED: Now module-aware. Every batch of articles belongs to a
 * specific module (Policy & Risk, Market Dynamics, etc.) and submodule.
 * The relevance prompt is picked based on moduleId, and every stored
 * row is tagged with module_id + submodule_id so the frontend can
 * filter by tab correctly.
 *
 * CHANGED (client context): For modules that need it (Market Dynamics,
 * Forward Outlook), the client's competitors/sectors/focus areas are
 * fetched from admin.client_icp and injected into the relevance prompt
 * so the LLM can judge relevance against THIS client specifically,
 * not just the industry in general. Policy & Risk is intentionally
 * excluded — a regulation is relevant regardless of who the client's
 * competitors are.
 */

const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@xenova/transformers');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { pullProcessedBatch, getProcessedQueueLength } = require('./processedQueue');
const { refreshLock } = require('./queueManager');
const { matchSignalToTrend } = require('./trendClustering');
const FORWARD_OUTLOOK_MODULE_ID = '2eb989fd-0ea0-4320-b73a-f7eb8b970473';
const MARKET_DYNAMICS_MODULE_ID = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Log each article's processing result to Supabase ────────────────────────
const logArticle = async (jobId, clientId, article, status, errorMessage = null, submoduleId = null) => {
  await supabase.from('article_processing_log').insert({
    job_id: jobId,
    client_id: clientId,
    submodule_id: submoduleId,
    article_url: article.url,
    article_title: article.title,
    status,
    error_message: errorMessage,
    raw_content: status === 'failed' ? JSON.stringify(article) : null,
    processed_at: new Date().toISOString(),
  });
};

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
  timeout: 30000, // NEW — was hitting 10s default timeout on cold connections
});

const { callLLM } = require('./llmClient');

const POLICY_COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';
const VECTOR_SIZE = Number(process.env.EMBEDDING_VECTOR_SIZE) || 384;
const DELAY_BETWEEN_CALLS_MS = Number(process.env.LLM_CALL_DELAY_MS) || 1000;
const LLM_BATCH_SIZE = Number(process.env.LLM_BATCH_SIZE) || 10;
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE) || 300;
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP) || 50;
const TEXT_TRUNCATE_LENGTH = Number(process.env.LLM_TEXT_TRUNCATE_LENGTH) || 5000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// NEW: Retries a Qdrant/network operation up to 3 times with backoff,
// so a single transient timeout doesn't crash the entire batch run.
const retryWithBackoff = async (fn, label, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) {
        console.log(`  [Retry] ${label} failed after ${maxRetries} attempts: ${err.message}`);
        throw err;
      }
      const delay = attempt * 2000;
      console.log(`  [Retry] ${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${err.message}`);
      await sleep(delay);
    }
  }
};

// ── Embedding model ──────────────────────────────────────────────────────────
let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return embedderPromise;
};
const embedText = async (text) => {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

// CHANGED: New — maps module UUID → the prompt id (row in `prompts` table) to use.
// Add a new line here whenever a new module needs its own relevance prompt.
const MODULE_RELEVANCE_PROMPTS = {
  '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960': 'policy_risk_relevance_v1',
  '55c5ee19-bfca-468b-81b3-b89ca4f303c8': 'market_dynamics_relevance_v1',
  '2eb989fd-0ea0-4320-b73a-f7eb8b970473': 'forward_outlook_relevance_v1',
};

// NEW: Which modules should use client-specific context (competitors, sectors)
// for relevance scoring. Policy & Risk deliberately excluded — a regulation
// is relevant regardless of who the client's competitors are.
const MODULES_NEEDING_CLIENT_CONTEXT = new Set([
  '55c5ee19-bfca-468b-81b3-b89ca4f303c8', // Market Dynamics
  '2eb989fd-0ea0-4320-b73a-f7eb8b970473', // Forward Outlook
]);

// CHANGED: getRelevancePromptTemplate now takes moduleId and looks up the
// correct prompt for that module, instead of always using policy_risk_relevance_v1.
const getRelevancePromptTemplate = async (moduleId) => {
  const promptId = MODULE_RELEVANCE_PROMPTS[moduleId];

  if (!promptId) {
    throw new Error(`No relevance prompt mapped for module_id: ${moduleId}. Add it to MODULE_RELEVANCE_PROMPTS.`);
  }

  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', promptId)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    throw new Error(`Could not load relevance prompt '${promptId}' from Supabase: ${error?.message}`);
  }

  return data.prompt_template;
};

const getSynthesisPromptTemplate = async () => {
  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', 'article_synthesis_v1')
    .eq('is_active', true)
    .single();

  if (error || !data) {
    throw new Error(`Could not load synthesis prompt: ${error?.message}`);
  }

  return data.prompt_template;
};

// NEW: Fetches this client's competitor/sector context from admin.client_icp,
// and formats it into a short readable text block for the LLM prompt.
// Returns null if the client has no ICP data — callers must handle that
// gracefully (fall back to industry-only reasoning, never crash).
const getClientContext = async (clientId) => {
  try {
    const { data, error } = await supabase
      .schema('admin')
      .from('client_icp')
      .select('context_json')
      .eq('client_id', clientId)
      .single();

    if (error || !data || !data.context_json) {
      console.log(`[ClientContext] No ICP data found for client ${clientId}, using industry-only reasoning.`);
      return null;
    }

    const ctx = data.context_json;
    const lines = [];

    if (Array.isArray(ctx.competitors) && ctx.competitors.length > 0) {
      lines.push(`Known competitors: ${ctx.competitors.join(', ')}`);
    }
    if (Array.isArray(ctx.core_sectors) && ctx.core_sectors.length > 0) {
      lines.push(`Core sectors: ${ctx.core_sectors.join(', ')}`);
    }
    if (Array.isArray(ctx.focus_products_services) && ctx.focus_products_services.length > 0) {
      lines.push(`Focus products/services: ${ctx.focus_products_services.join(', ')}`);
    }
    if (Array.isArray(ctx.geographic_focus) && ctx.geographic_focus.length > 0) {
      lines.push(`Geographic focus: ${ctx.geographic_focus.join(', ')}`);
    }
    if (Array.isArray(ctx.sectors_to_avoid) && ctx.sectors_to_avoid.length > 0) { // NEW
      lines.push(`Lower priority / not core focus for this client: ${ctx.sectors_to_avoid.join(', ')}`);
    }

    if (lines.length === 0) return null;

    return lines.join('\n');

  } catch (err) {
    console.log(`[ClientContext] Error fetching context for client ${clientId}: ${err.message}. Falling back to industry-only reasoning.`);
    return null;
  }
};
// NEW: Fetches just the sectors_to_avoid array for the deterministic override check
const getSectorsToAvoid = async (clientId) => {
  try {
    const { data } = await supabase
      .schema('admin')
      .from('client_icp')
      .select('context_json')
      .eq('client_id', clientId)
      .single();
    return data?.context_json?.sectors_to_avoid || [];
  } catch (err) {
    return [];
  }
};

// NEW: Fetches just the competitors array for the Critical-requires-competitor check
const getCompetitorsList = async (clientId) => {
  try {
    const { data } = await supabase
      .schema('admin')
      .from('client_icp')
      .select('context_json')
      .eq('client_id', clientId)
      .single();
    return data?.context_json?.competitors || [];
  } catch (err) {
    return [];
  }
};

// NEW: Fetches this client's enabled signals for a module, grouped by submodule
// (dimension). Used to (a) constrain the classification prompt to only the
// client's active taxonomy, and (b) validate whatever the LLM returns.
const getEnabledSignalsForClient = async (clientId, moduleId) => {
  const { data, error } = await supabase
    .schema('admin')
    .from('client_signals')
    .select(`
  is_enabled,
  signals!inner (
    id,
    signal_name,
    signal_definition,
    submodule_id,
    module_id,
    submodules!inner (
      id,
      submodule_name
    )
  )
`)
    .eq('client_id', clientId)
    .eq('is_enabled', true)
    .eq('signals.module_id', moduleId)
.order('submodule_id', { foreignTable: 'signals' })
.order('signal_name', { foreignTable: 'signals' });

  if (error) {
    console.log(`[MonitoringScope] Error fetching enabled signals for client ${clientId}: ${error.message}`);
    return [];
  }

 return (data || []).map(row => ({
    signal_id: row.signals.id,
    signal_name: row.signals.signal_name,
    signal_definition: row.signals.signal_definition,
    submodule_id: row.signals.submodule_id,
    submodule_name: row.signals.submodules.submodule_name,
}));
};

// NEW: Formats the enabled signals list into readable text for the prompt,
// grouped by dimension.
const formatScopeForPrompt = (enabledSignals) => {
  if (!enabledSignals.length) return null;

  const grouped = {};
  let counter = 1;

  for (const signal of enabledSignals) {
    if (!grouped[signal.submodule_name]) {
      grouped[signal.submodule_name] = [];
    }
    grouped[signal.submodule_name].push(signal);
  }

  let output = "";

  for (const [dimension, signals] of Object.entries(grouped)) {
    output += `\n=== ${dimension} ===\n`;

    for (const signal of signals) {
      output += `${counter}. ${signal.signal_name}\n`;
      output += `Definition: ${signal.signal_definition}\n\n`;
      counter++;
    }
  }

  return output.trim();
};

// NEW: Deterministic safety net — checks the LLM's chosen signal against the
// client's actual enabled scope. If it picked something outside scope
// (hallucinated or drifted), mark irrelevant instead of storing it silently
// under an unmonitored signal.
const applyMonitoringScopeValidation = (classification, enabledSignals) => {
  if (enabledSignals.length === 0) {
    console.log(`  [MonitoringScope] Client has 0 enabled signals — marking irrelevant`);
    return { ...classification, is_relevant: false, reason: 'No signals enabled in client monitoring scope' };
  }

  const match = enabledSignals[classification.signal_number - 1];

  if (!classification.signal_number || !match) {
    console.log(`  [MonitoringScope] signal_number ${classification.signal_number} is not a valid enabled signal — marking irrelevant`);
    return { ...classification, is_relevant: false, reason: 'Signal not in client monitoring scope' };
  }

  return { ...classification, signal_id: match.signal_id, submodule_id: match.submodule_id };
};

// NEW: Deterministic safety net — since small LLMs don't reliably follow
// the "cap impact_level at Low" instruction in the prompt, this checks
// the classification result against the client's sectors_to_avoid list
// in code and force-overrides impact_level if there's a match.
const applySectorsToAvoidOverride = (classification, article, sectorsToAvoid) => {
  if (!Array.isArray(sectorsToAvoid) || sectorsToAvoid.length === 0) return classification;

  const searchText = `${article.title || ''} ${classification.signal_title || ''} ${classification.summary || ''}`.toLowerCase();

  const matched = sectorsToAvoid.find(sector => searchText.includes(sector.toLowerCase()));

  if (matched && classification.impact_level !== 'Low') {
    console.log(`  [SectorsToAvoid] Overriding impact_level from ${classification.impact_level} to Low (matched: "${matched}")`);
    return { ...classification, impact_level: 'Low' };
  }

  return classification;
};
// NEW: Deterministic safety net — the model sometimes marks impact_level as
// Critical for articles that merely operate in the client's core sector,
// without actually naming one of the client's specific listed competitors.
// Per the prompt's own rules, Critical should be reserved for named-competitor
// events; anything else should cap at High. This enforces that distinction.
const applyCriticalRequiresCompetitorOverride = (classification, article, competitors) => {
  if (!Array.isArray(competitors) || competitors.length === 0) return classification;
  if (classification.impact_level !== 'Critical') return classification;

  const searchText = `${article.title || ''} ${classification.signal_title || ''} ${classification.summary || ''}`.toLowerCase();

  const matched = competitors.find(comp => searchText.includes(comp.toLowerCase()));

  if (!matched) {
    console.log(`  [CriticalCheck] Downgrading impact_level from Critical to High (no named competitor found in: ${competitors.join(', ')})`);
    return { ...classification, impact_level: 'High' };
  }

  return classification;
};

const VALID_SIGNAL_CATEGORIES = [
  'Market Intelligence', 'Corporate Activity', 'Investment Activity',
  'Consumer & Demand', 'Innovation & Product', 'Regulatory & Compliance',
  'Macro & Economic', 'Leadership',
];

const SIGNAL_CATEGORY_FALLBACK_MAP = {
  funding: 'Investment Activity', venture: 'Investment Activity', investment: 'Investment Activity',
  'private equity': 'Investment Activity', merger: 'Corporate Activity', acquisition: 'Corporate Activity',
  consolidation: 'Corporate Activity', partnership: 'Corporate Activity', restructuring: 'Corporate Activity',
  demand: 'Consumer & Demand', consumer: 'Consumer & Demand', pricing: 'Consumer & Demand', retail: 'Consumer & Demand',
  product: 'Innovation & Product', innovation: 'Innovation & Product', technology: 'Innovation & Product', launch: 'Innovation & Product',
  regulation: 'Regulatory & Compliance', compliance: 'Regulatory & Compliance', policy: 'Regulatory & Compliance', legal: 'Regulatory & Compliance',
  macro: 'Macro & Economic', economic: 'Macro & Economic', inflation: 'Macro & Economic', interest: 'Macro & Economic',
  executive: 'Leadership', ceo: 'Leadership', appointment: 'Leadership', hire: 'Leadership', resign: 'Leadership',
};

const applySignalCategoryValidation = (classification) => {
  const raw = (classification.category || '').trim();
  if (VALID_SIGNAL_CATEGORIES.includes(raw)) return classification;

  const normalized = raw.toLowerCase();
  const mappedKey = Object.keys(SIGNAL_CATEGORY_FALLBACK_MAP).find(k => normalized.includes(k));
  const mapped = mappedKey ? SIGNAL_CATEGORY_FALLBACK_MAP[mappedKey] : null;

  if (mapped) {
    console.log(`  [SignalCategory] Mapping "${classification.category}" -> "${mapped}"`);
    return { ...classification, category: mapped };
  }
  console.log(`  [SignalCategory] Unrecognized category "${classification.category}", defaulting to "Market Intelligence"`);
  return { ...classification, category: 'Market Intelligence' };
};

// NEW: Deterministic safety net — the model sometimes returns a sector
// value outside the 5 allowed values (Technology, Supply Chain, Product,
// Sustainability, Consumer), which violates the DB check constraint and
// silently drops the whole signal insert. This maps anything unexpected
// to the closest valid sector before storage, so a signal is never lost.
const VALID_SECTORS = ['Technology', 'Supply Chain', 'Product', 'Sustainability', 'Consumer'];

const SECTOR_FALLBACK_MAP = {
  finance: 'Product',
  banking: 'Product',
  fintech: 'Product',
  logistics: 'Supply Chain',
  manufacturing: 'Supply Chain',
  environment: 'Sustainability',
  environmental: 'Sustainability',
  retail: 'Consumer',
  ai: 'Technology',
  software: 'Technology',
};

const applySectorValidation = (classification) => {
  if (!classification.sector) return classification;

  if (VALID_SECTORS.includes(classification.sector)) return classification;

  const normalized = classification.sector.toLowerCase().trim();
  const mapped = SECTOR_FALLBACK_MAP[normalized];

  if (mapped) {
    console.log(`  [SectorValidation] Mapping invalid sector "${classification.sector}" -> "${mapped}"`);
    return { ...classification, sector: mapped };
  }

  console.log(`  [SectorValidation] Unrecognized sector "${classification.sector}", defaulting to "Technology"`);
  return { ...classification, sector: 'Technology' };
};

// ── Fill prompt placeholders ─────────────────────────────────────────────────
// CHANGED: now accepts clientContext (optional) — inserted wherever the
// prompt template has a {client_context} placeholder. Prompts that don't
// have this placeholder (like Policy & Risk) are unaffected.
const fillPromptTemplate = (template, industry, title, text, clientContext = null, monitoringScope = null) => {
  const truncatedText = (text || '').slice(0, TEXT_TRUNCATE_LENGTH);
  const contextText = clientContext || 'No specific client context available. Use industry-level reasoning only.';
  const scopeText = monitoringScope || 'No monitoring scope configured.';
  return template
    .replace(/{industry}/g, industry)
    .replace(/{title}/g, title || '')
    .replace(/{text}/g, truncatedText)
    .replace(/{client_context}/g, contextText)
    .replace(/{monitoring_scope}/g, scopeText);
};

// ── Clean raw article text before synthesis ──────────────────────────────────
const cleanArticleText = (text) => {
  if (!text) return '';
  return text
    .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '')
    .replace(/^.{1,30}$/gm, '')
    .replace(/share\s+on\s+(twitter|facebook|linkedin|whatsapp|email)/gi, '')
    .replace(/(tweet|retweet|like|follow|subscribe|sign up|log in|sign in|register)/gi, '')
    .replace(/we use cookies.{0,200}/gi, '')
    .replace(/privacy policy.{0,100}/gi, '')
    .replace(/(read more|click here|learn more|find out more|see more|view more).{0,50}/gi, '')
    .replace(/\[image[^\]]*\]/gi, '')
    .replace(/caption:.{0,100}/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
};

// ── Synthesize article into LLM's own words ──────────────────────────────────
// Returns { title, body } — both in LLM's own words, no raw text anywhere.
const synthesizeContent = async (article, classification) => {
  try {
    const cleanedText = cleanArticleText(article.text || '');
    const promptTemplate = await getSynthesisPromptTemplate();
    const userPrompt = promptTemplate
      .replace(/{title}/g, article.title || '')
      .replace(/{text}/g, cleanedText.slice(0, TEXT_TRUNCATE_LENGTH));

    const synthesized = await callLLM([
      { role: 'system', content: 'You are a senior regulatory intelligence analyst writing original analytical summaries. You never copy text from source articles.' },
      { role: 'user', content: userPrompt },
    ], { temperature: 0.3, max_tokens: 1500, timeout: 180000 });
    const lines = synthesized.split('\n').filter(l => l.trim() !== '');
    const titleLine = lines[0].replace(/^\*{0,2}Title:\s*/i, '').replace(/\*{0,2}\s*$/, '').trim();
    const bodyText = lines.slice(1).join('\n').trim();
    console.log(`  [Synthesize] Title: "${titleLine}" | Body: ${bodyText.length} chars`);
    return { title: titleLine, body: bodyText };

  } catch (err) {
    console.log(`  [Synthesize] Failed, falling back to summary: ${err.message}`);
    return { title: null, body: classification.summary || '' };
  }
};

// ── Call LM Studio for relevance classification + signal extraction ──────────
// CHANGED: now accepts clientContext, passed through to fillPromptTemplate
const classifyArticle = async (promptTemplate, industry, article, clientContext = null, moduleId = null, monitoringScope = null) => {
  const prompt = fillPromptTemplate(promptTemplate, industry, article.title, article.text, clientContext, monitoringScope);

  try {
    const rawContent = await callLLM([
      { role: 'system', content: 'You are a strict, precise classification assistant. You only respond with valid JSON, nothing else.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.1, max_tokens: 2000, timeout: 180000 });
    let cleaned = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // NEW: find the first balanced {...} object by counting braces,
    // instead of guessing with regex. Handles both a missing closing
    // brace (truncation) and an extra stray brace (model over-closing).
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace !== -1) {
      let depth = 0;
      let endIndex = -1;
      for (let i = firstBrace; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        else if (cleaned[i] === '}') {
          depth--;
          if (depth === 0) {
            endIndex = i;
            break;
          }
        }
      }
      if (endIndex !== -1) {
        cleaned = cleaned.slice(firstBrace, endIndex + 1);
      }
    }

    // NEW: sanitize BEFORE any parse attempt — fixes bad unicode escapes
    // (e.g. \u00cs where 's' isn't valid hex) and raw control characters
    // (literal newlines/tabs the model puts inside string values, which
    // JSON doesn't allow unescaped)
    cleaned = cleaned
      .replace(/\\u(?![0-9a-fA-F]{4})/g, '')      // strip malformed \u escapes
      .replace(/[\u0000-\u001F]+/g, ' ')           // replace raw control chars with a space
      .replace(/\]"\s*\}/g, ']}')                  // NEW: strip stray quote between closing ] and final }
      .replace(/"\s*\}\s*\}/g, '"}');              // NEW: strip stray extra } if doubled at the very end

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      // NEW: fix the "\"value\"" pattern -- some LLM responses wrap individual
      // field values in escaped quotes (\") instead of normal quotes ("),
      // even though the rest of the JSON object is fine. This shows up most
      // on longer fields like "summary" and "business_impact".
      try {
        const unescaped = cleaned.replace(/\\"/g, '"');
        parsed = JSON.parse(unescaped);
      } catch (unescapeErr) {
        // Fall back to your existing repair attempt
        try {
          const repaired = cleaned.replace(
            /"(reason|country|summary|signal_title|category|impact_level|source_type)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
            (match, key, value) => `"${key}": "${value}"`
          );
          parsed = JSON.parse(repaired);
        } catch (repairErr) {
          // NEW: last resort — try to repair truncated JSON by closing
          // any unclosed strings/arrays/objects. Handles cases where the
          // model ran out of tokens mid-response before finishing.
          try {
            let repaired2 = cleaned;
            const quoteCount = (repaired2.match(/(?<!\\)"/g) || []).length;
            if (quoteCount % 2 !== 0) repaired2 += '"';
            const openBrackets = (repaired2.match(/\[/g) || []).length;
            const closeBrackets = (repaired2.match(/\]/g) || []).length;
            for (let i = 0; i < openBrackets - closeBrackets; i++) repaired2 += ']';
            const openBraces = (repaired2.match(/\{/g) || []).length;
            const closeBraces = (repaired2.match(/\}/g) || []).length;
            for (let i = 0; i < openBraces - closeBraces; i++) repaired2 += '}';
            parsed = JSON.parse(repaired2);
            console.log(`      [Repaired truncated JSON]`);
          } catch (finalErr) {
            console.log(`      Raw response was: ${rawContent}`);
            throw parseErr;
          }
        }
      }
    }


    if (moduleId === FORWARD_OUTLOOK_MODULE_ID) {
      return {
        is_relevant: Boolean(parsed.is_relevant),
        reason: parsed.reason || 'No reason provided',
        signal_title: parsed.signal_title || article.title,
        signal_type: parsed.signal_type || 'Innovation',
        organization: parsed.organization || 'Unknown',
        sector: parsed.sector || 'Technology',
        horizon_estimate: parsed.horizon_estimate || 'mid_term',
        summary: parsed.summary || '',
      };
    }

    if (moduleId === MARKET_DYNAMICS_MODULE_ID) {
      return {
        is_relevant: Boolean(parsed.is_relevant),
        reason: parsed.reason || 'No reason provided',
        topic_summary: parsed.topic_summary || null,
        signal_number: Number.isInteger(parsed.signal_number) ? parsed.signal_number : 0,
        category: parsed.category || null,
        country: parsed.country || 'Global',
        organization: parsed.organization || 'Unknown',
        signal_title: parsed.signal_title || article.title,
        summary: parsed.summary || '',
      };
    }

    return {
      is_relevant: Boolean(parsed.is_relevant),
      reason: parsed.reason || 'No reason provided',
      signal_title: parsed.signal_title || article.title,
      category: parsed.category || 'Other Regulatory Risk',
      impact_level: parsed.impact_level || 'Low',
      source_type: parsed.source_type || 'News Report',
      country: parsed.country || 'Unknown',
      summary: parsed.summary || '',
      business_impact: Array.isArray(parsed.business_impact) ? parsed.business_impact : [],
    };

  } catch (err) {
    console.log(`  [!] LLM classification failed for "${article.title}": ${err.message}`);

    if (moduleId === FORWARD_OUTLOOK_MODULE_ID) {
      return {
        is_relevant: false,
        technical_failure: true,
        reason: `Classification failed: ${err.message}`,
        signal_title: article.title,
        signal_type: 'Innovation',
        organization: 'Unknown',
        sector: 'Technology',
        horizon_estimate: 'mid_term',
        summary: '',
      };
    }

    if (moduleId === MARKET_DYNAMICS_MODULE_ID) {
      return {
        is_relevant: false,
        technical_failure: true,
        reason: `Classification failed: ${err.message}`,
        signal_number: 0,
        category: null,
        country: 'Global',
        organization: 'Unknown',
        signal_title: article.title,
        summary: '',
      };
    }

    return {
      is_relevant: false,
      technical_failure: true,
      reason: `Classification failed: ${err.message}`,
      signal_title: article.title,
      category: 'Other Regulatory Risk',
      impact_level: 'Low',
      source_type: 'News Report',
      country: 'Unknown',
      summary: '',
      business_impact: [],
    };
  }
};

// ── Chunk text ───────────────────────────────────────────────────────────────
const chunkText = (text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) => {
  if (!text) return [];
  const words = text.split(/\s+/);
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = start + chunkSize;
    chunks.push(words.slice(start, end).join(' '));
    start += chunkSize - overlap;
  }
  return chunks;
};

// ── Ensure Qdrant collection exists ─────────────────────────────────────────
const setupPolicyCollection = async () => {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some(c => c.name === POLICY_COLLECTION);
  if (!exists) {
    await qdrant.createCollection(POLICY_COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
    });
    console.log(`[LLMProcessor] Created Qdrant collection '${POLICY_COLLECTION}'`);
  }

  // Always ensure indexes exist — safe to call even if they already exist
  const indexFields = ['article_id', 'client_id', 'industry', 'module_id'];
  for (const field of indexFields) {
    try {
      await qdrant.createPayloadIndex(POLICY_COLLECTION, {
        field_name: field,
        field_schema: 'keyword',
      });
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.log(`[LLMProcessor] Index note for '${field}': ${err.message}`);
      }
    }
  }
};

// ── Store relevant article ───────────────────────────────────────────────────
// CHANGED: now takes moduleId and submoduleId, tags every insert + Qdrant payload with them
const storeRelevantArticle = async (article, classification, clientId, industry, jobId, moduleId, submoduleId) => {
  console.log('moduleId being inserted:', JSON.stringify(moduleId), 'length:', moduleId ? moduleId.length : 'N/A');

  // Step 1 — Synthesize content into LLM's own words
  // NEVER store raw copyrighted article text anywhere
  const synthesized = await synthesizeContent(article, classification);
  const synthesizedTitle = synthesized.title || classification.signal_title;
  const contentToChunk = synthesized.body || classification.summary || '';
  const chunks = chunkText(contentToChunk);
  const articleId = uuidv4();

  // Step 2 — Chunk synthesized body and store in Qdrant
  const points = [];
  for (let i = 0; i < chunks.length; i++) {
    const vector = await retryWithBackoff(() => embedText(chunks[i]), `embed chunk ${i}`);
    points.push({
      id: uuidv4(),
      vector,
      payload: {
        article_id: articleId,
        client_id: clientId,
        industry,
        title: synthesizedTitle,
        url: article.url,
        chunk_index: i,
        chunk_text: chunks[i],
        published_date: article.publishedDate,
        module_id: moduleId,       // CHANGED: new
        submodule_id: submoduleId, // CHANGED: new
      },
    });
  }

  if (points.length > 0) {
    await retryWithBackoff(() => qdrant.upsert(POLICY_COLLECTION, { points }), 'Qdrant upsert');
  }

  // Step 3 — Store metadata in Supabase (synthesized title, no raw text)
  const { error: metaError } = await supabase.from('policy_articles_metadata').insert({
    article_id: articleId,
    client_id: clientId,
    industry,
    title: synthesizedTitle,
    article_url: article.url,
    published_date: article.publishedDate,
    location: classification.country,
    is_relevant: true,
    relevance_reason: classification.reason,
    module_id: moduleId,       // CHANGED: new
    submodule_id: submoduleId, // CHANGED: new
  });
  if (metaError) console.error('[Storage] metadata insert error:', metaError.message);

  // Step 4 — Store synthesized content in Supabase (no raw original text)
  const { error: fullError } = await supabase.from('policy_articles_full').insert({
    article_id: articleId,
    client_id: clientId,
    industry,
    title: synthesizedTitle,
    url: article.url,
    published_date: article.publishedDate,
    author: article.author,
    full_text: contentToChunk,
    is_relevant: true,
    relevance_reason: classification.reason,
    location: classification.country,
    chunk_count: chunks.length,
    qdrant_collection_name: POLICY_COLLECTION,
    job_id: jobId,
    module_id: moduleId,       // CHANGED: new
    submodule_id: submoduleId, // CHANGED: new
  });
  if (fullError) console.error('[Storage] full insert error:', fullError.message);

  // Step 4.5 — Market Dynamics branches off here entirely: instead of a
  // policy_signals row, it stores the individual article as a
  // market_dynamics_signals row (full audit trail — title, org, date,
  // source), then creates/enriches the market_insights card, then links
  // the two together.
  if (moduleId === MARKET_DYNAMICS_MODULE_ID) {
    try {
      const { enrichOrCreateInsight } = require('./marketInsights');

      const { data: signalRow, error: sigError } = await supabase
        .from('market_dynamics_signals')
        .insert({
          article_id: articleId,
          client_id: clientId,
          module_id: moduleId,
          submodule_id: classification.submodule_id,
          signal_id: classification.signal_id,
          signal_title: synthesizedTitle,
          summary: classification.summary || contentToChunk.slice(0, 300),
          organization: classification.organization || 'Unknown',
          category: classification.category,
          country: classification.country,
          source_url: article.url,
          published_date: article.publishedDate,
        })
        .select()
        .single();
      if (sigError) console.error('[Storage] market_dynamics_signals insert error:', sigError.message);

      const result = await enrichOrCreateInsight(
        clientId,
        moduleId,
        classification.submodule_id,
        classification.signal_id,
        articleId,
        contentToChunk,
        industry
      );

      if (signalRow && result.insightId) {
        await supabase.from('market_dynamics_signals').update({ insight_id: result.insightId }).eq('id', signalRow.id);
      }
    } catch (mdErr) {
      console.error(`  [MarketDynamics] Failed to enrich/create insight for "${article.title}": ${mdErr.message} — skipping, continuing to next article`);
    }
    return chunks.length;
  }

  // Step 5 — Store structured signal for frontend
  const signalInsert = {
    article_id: articleId,
    client_id: clientId,
    industry,
    source_article_url: article.url,
    source_published_date: article.publishedDate,
    signal_title: classification.signal_title,
    summary: classification.summary,
    job_id: jobId,
    module_id: moduleId,
    submodule_id: submoduleId,
  };

  if (moduleId === FORWARD_OUTLOOK_MODULE_ID) {
    signalInsert.signal_type = classification.signal_type;
    signalInsert.organization = classification.organization;
    signalInsert.sector = classification.sector;
    signalInsert.horizon_estimate = classification.horizon_estimate;
  } else {
    signalInsert.category = classification.category;
    signalInsert.impact_level = classification.impact_level;
    signalInsert.source_type = classification.source_type;
    signalInsert.country = classification.country;
    signalInsert.business_impact = classification.business_impact;
  }

  const targetSignalsTable = moduleId === FORWARD_OUTLOOK_MODULE_ID ? 'trend_signals' : 'policy_signals';

  const { data: newSignal, error: signalError } = await supabase
    .from(targetSignalsTable)
    .insert(signalInsert)
    .select()
    .single();
  if (signalError) console.error('[Storage] signal insert error:', signalError.message);

  // Step 6 — Forward Outlook trend matching (only runs for that module)
  if (moduleId === FORWARD_OUTLOOK_MODULE_ID && newSignal) {
    try {
      const fingerprintText = `${synthesizedTitle}. ${contentToChunk.slice(0, 400)}`;
      const fingerprintEmbedding = await embedText(fingerprintText);
      await matchSignalToTrend(newSignal.id, fingerprintEmbedding, moduleId, clientId, industry, article.publishedDate);
    } catch (trendErr) {
      console.error('[TrendMatch] Failed to match signal to trend:', trendErr.message);
    }
  }

  return chunks.length;
};

// ── Main processing function ─────────────────────────────────────────────────
// CHANGED: added moduleId parameter — used to pick the right relevance prompt
// and gets passed down into storeRelevantArticle for tagging.
// CHANGED (client context): fetches client context once per batch, only for
// modules in MODULES_NEEDING_CLIENT_CONTEXT, and passes it into classifyArticle.
const processArticlesForRelevance = async (articles, clientId, industry, jobId, moduleId, submoduleId) => {
  if (!articles || articles.length === 0) return { relevant: 0, irrelevant: 0 };

  await setupPolicyCollection();
  const promptTemplate = await getRelevancePromptTemplate(moduleId); // CHANGED: now passes moduleId

  // NEW: fetch client context once per batch (not per article) — only for
  // modules that actually use it. Stays null for Policy & Risk.
  let clientContext = null;
  let sectorsToAvoid = [];
  let competitors = [];
  let enabledSignals = [];
  if (MODULES_NEEDING_CLIENT_CONTEXT.has(moduleId)) {
    clientContext = await getClientContext(clientId);
    if (clientContext) {
      console.log(`[ClientContext] Loaded context for client ${clientId}:\n${clientContext}`);
    }
    sectorsToAvoid = await getSectorsToAvoid(clientId);
    competitors = await getCompetitorsList(clientId);
  }
  if (moduleId === MARKET_DYNAMICS_MODULE_ID) {
    enabledSignals = await getEnabledSignalsForClient(clientId, moduleId);
    console.log(`[MonitoringScope] Client ${clientId} has ${enabledSignals.length} enabled signal(s) for Market Dynamics`);
  }

  let relevantCount = 0;
  let irrelevantCount = 0;

  for (const article of articles) {
    console.log(`[LLMProcessor] Classifying: "${article.title}"`);

    let classification = await classifyArticle(
      promptTemplate, industry, article, clientContext, moduleId,
      moduleId === MARKET_DYNAMICS_MODULE_ID ? formatScopeForPrompt(enabledSignals) : null
    );
    classification = applySectorsToAvoidOverride(classification, article, sectorsToAvoid);
    classification = applyCriticalRequiresCompetitorOverride(classification, article, competitors);
    classification = applySectorValidation(classification);

    if (moduleId === MARKET_DYNAMICS_MODULE_ID) {
      classification = applyMonitoringScopeValidation(classification, enabledSignals);
      classification = applySignalCategoryValidation(classification);
    }

    if (classification.technical_failure) {
      await logArticle(jobId, clientId, article, 'failed', classification.reason, submoduleId);
      irrelevantCount++;
      console.log(`  [!] FAILED | ${classification.reason}`);
    } else if (classification.is_relevant) {
      const chunkCount = await storeRelevantArticle(
        article,
        classification,
        clientId,
        industry,
        jobId,
        moduleId,
        submoduleId
      );
      await logArticle(jobId, clientId, article, 'completed', null, submoduleId);
      relevantCount++;

      if (moduleId === FORWARD_OUTLOOK_MODULE_ID) {
        console.log(
          `  [✓] RELEVANT (${chunkCount} chunks) | ${classification.sector} | ${classification.horizon_estimate} | ${classification.reason}`
        );
      } else {
        console.log(
          `  [✓] RELEVANT (${chunkCount} chunks) | ${classification.category} | ${classification.impact_level} | ${classification.reason}`
        );
      }
    } else {
      await logArticle(jobId, clientId, article, 'skipped', classification.reason, submoduleId);
      irrelevantCount++;
      console.log(`  [✗] IRRELEVANT | ${classification.reason}`);
    }

    await refreshLock(clientId, submoduleId);
    await sleep(DELAY_BETWEEN_CALLS_MS);
  }

  console.log(`[LLMProcessor] Done. Relevant: ${relevantCount}, Irrelevant: ${irrelevantCount}`);
  return { relevant: relevantCount, irrelevant: irrelevantCount };
};

// ── Batch processing from Redis queue ───────────────────────────────────────
// CHANGED: added moduleId parameter, threaded through to processArticlesForRelevance
async function processQueueInBatches(queueKey, clientId, industry, jobId, moduleId, submoduleId, batchSize = LLM_BATCH_SIZE) {
  let totalRelevant = 0;
  let totalIrrelevant = 0;
  let remaining = await getProcessedQueueLength(queueKey);

  console.log(`[LLMProcessor] Starting batch processing of ${queueKey} (${remaining} articles, batches of ${batchSize})`);

  let batchNumber = 1;
  while (remaining > 0) {
    console.log(`\n[LLMProcessor] --- Batch ${batchNumber} (${remaining} remaining) ---`);

    const batch = await pullProcessedBatch(queueKey, batchSize);
    let result;
    try {
      result = await processArticlesForRelevance(batch, clientId, industry, jobId, moduleId, submoduleId);
    } catch (batchErr) {
      console.error(`[LLMProcessor] Batch ${batchNumber} failed, skipping to next batch: ${batchErr.message}`);
      remaining = await getProcessedQueueLength(queueKey);
      batchNumber++;
      continue;
    }

    totalRelevant += result.relevant;
    totalIrrelevant += result.irrelevant;

    remaining = await getProcessedQueueLength(queueKey);
    batchNumber++;
  }

  console.log(`\n[LLMProcessor] ALL BATCHES DONE. Total relevant: ${totalRelevant}, Total irrelevant: ${totalIrrelevant}`);
  return { relevant: totalRelevant, irrelevant: totalIrrelevant };
}

module.exports = {
  processArticlesForRelevance,
  processQueueInBatches,
  setupPolicyCollection, // CHANGED: exported so ragChat.js can also ensure indexes exist
  classifyArticle,       // TEMP: exported for manual testing
  getClientContext,      // TEMP: exported for manual testing
  getRelevancePromptTemplate, // TEMP: exported for manual testing
  fillPromptTemplate,        // TEMP: exported for Gemini comparison script
  getSectorsToAvoid,         // TEMP: exported for Gemini comparison script
  getCompetitorsList,        // TEMP: exported for Gemini comparison script
  applySectorsToAvoidOverride,             // TEMP: exported for Gemini comparison script
  applyCriticalRequiresCompetitorOverride, // TEMP: exported for Gemini comparison script
  applySignalCategoryValidation, // TEMP: exported for testing
  FORWARD_OUTLOOK_MODULE_ID,
  MARKET_DYNAMICS_MODULE_ID,
};