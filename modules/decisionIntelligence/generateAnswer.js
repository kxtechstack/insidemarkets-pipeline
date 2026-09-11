/**
 * modules/decisionIntelligence/generateAnswer.js
 *
 * Generates the Decision Intelligence answer for three cases:
 *   1. Numeric (dataType === 'quantitative' && facts.length) -- no LLM,
 *      still uses buildNumericAnswer(). Return shape wraps the text in a
 *      minimal report so the frontend can render everything consistently.
 *   2. Framework (swot / pestle / risk_analysis / five_forces) -- uses the
 *      existing framework prompts, but now also parses a CITED_SOURCES
 *      line so the frontend can render clickable sources beneath the text.
 *   3. Qualitative (open-ended DI) -- uses the new JSON schema prompt
 *      (decision_intelligence_qualitative_v2) and returns a structured
 *      report object plus a resolved sources array.
 *
 * All three return { report, sources }.
 */

const { callLLM } = require('../llmClient');
const { buildNumericAnswer } = require('./buildNumericAnswer');
const { sanitizeQuestionForLLM } = require('./secRetrieval');
const { retrieveClientData } = require('./retrieveClientData');
const { resolveSecUrls } = require('./secUrlResolver');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MAX_CONTEXT_CHARS = 12000;
const MAX_SEC_CONTEXT_CHARS = Math.floor(MAX_CONTEXT_CHARS * 0.6);
const MAX_CLIENT_CONTEXT_CHARS = MAX_CONTEXT_CHARS - MAX_SEC_CONTEXT_CHARS;
const ITEM_MAX_CHARS = 400;

const FRAMEWORK_CATEGORIES = new Set(['swot', 'pestle', 'risk_analysis', 'five_forces']);

const FRAMEWORK_PROMPT_IDS = {
  five_forces: 'decision_intelligence_five_forces_v1',
  pestle: 'decision_intelligence_pestle_v1',
  risk_analysis: 'decision_intelligence_risk_analysis_v1',
  swot: 'decision_intelligence_swot_v1',
};

const QUALITATIVE_PROMPT_ID = 'decision_intelligence_qualitative_v2';

async function loadPrompt(promptId) {
  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', promptId)
    .eq('is_active', true)
    .single();
  if (error || !data) {
    throw new Error(`Could not load prompt '${promptId}': ${error?.message}`);
  }
  return data.prompt_template;
}

/**
 * Builds the numbered context. Each item is tagged as SEC or Client so
 * the LLM can distinguish them, and so we can map citations back to the
 * right source. Returns { text, sourceManifest } where sourceManifest
 * is an array of { index, kind, payload } in the same order.
 */
function buildNumberedContext(chunks, facts, clientResults) {
  const items = [];
  let runningLen = 0;
  let secLen = 0;

  // Verified financial facts first (SEC side)
  if (facts && facts.length) {
    const factLines = facts.map(f => `- ${f.ticker} ${f.metric_name}: ${f.metric_value} ${f.unit} (FY${f.fiscal_year})`);
    const factBlock = 'VERIFIED FINANCIAL FACTS (structured, trust these over text):\n' + factLines.join('\n');
    items.push({ kind: 'facts', text: factBlock });
    runningLen += factBlock.length;
  }

  // SEC chunks
  for (const c of chunks) {
    const block = `[SEC] ${c.ticker} FY${c.fiscal_year} -- ${c.item_code}\n${(c.chunk_text || '').slice(0, ITEM_MAX_CHARS)}`;
    if (secLen + block.length > MAX_SEC_CONTEXT_CHARS) break;
    items.push({ kind: 'sec', text: block, payload: c });
    secLen += block.length;
    runningLen += block.length;
  }

  // Client signals
  let clientLen = 0;
  for (const r of clientResults || []) {
    const p = r.payload || {};
    let text = p.chunk_text || p.summary || '';
    if (text.length > ITEM_MAX_CHARS) {
      text = text.slice(0, ITEM_MAX_CHARS).trim() + '...';
    }
    const block = `[CLIENT] ${p.title || 'Untitled'}\n${text}`;
    if (clientLen + block.length > MAX_CLIENT_CONTEXT_CHARS) break;
    items.push({ kind: 'client', text: block, payload: p, qdrantPointId: r.id != null ? String(r.id) : null });
    clientLen += block.length;
    runningLen += block.length;
  }

  // Number the visible items (skip the facts block, it's not citeable)
  const visible = items.filter(i => i.kind !== 'facts');
  const sourceManifest = [];
  const numbered = [];
  visible.forEach((item, idx) => {
    const n = idx + 1;
    numbered.push(`[${n}] ${item.text}`);
    sourceManifest.push({ index: n, ...item });
  });

  const factsPart = items.find(i => i.kind === 'facts');
  const out = [];
  if (factsPart) out.push(factsPart.text);
  out.push(numbered.join('\n\n'));

  return { text: out.join('\n\n---\n\n'), sourceManifest };
}

/**
 * Extracts CITED_SOURCES line from the LLM output.
 * Returns { citedIndices: Set<number>, cleanBody: string }.
 */
function extractCitedSources(raw) {
  if (!raw) return { citedIndices: new Set(), cleanBody: '' };
  const match = raw.match(/^\s*CITED_SOURCES\s*:\s*(none|[\d,\s]+)\s*\n+/i);
  if (!match) return { citedIndices: new Set(), cleanBody: raw.trim() };
  const tail = raw.slice(match[0].length);
  const cited = match[1].toLowerCase() === 'none'
    ? new Set()
    : new Set(match[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)));
  return { citedIndices: cited, cleanBody: tail.trim() };
}

/**
 * Parses the JSON body of a report, stripping stray markdown fences.
 * Throws if it can't parse -- caller decides on retry/fallback.
 */
function parseJsonReport(raw) {
  let s = raw.trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  return JSON.parse(s);
}

/**
 * Resolves cited source indices into a flat sources array with URLs.
 * SEC sources get their URL via secUrlResolver. Client sources already
 * carry URL in their Qdrant payload.
 */
async function resolveSources(citedIndices, sourceManifest) {
  const cited = sourceManifest.filter(s => citedIndices.has(s.index));
  if (!cited.length) return [];

  // Batch SEC lookups
  const secPointIds = cited
    .filter(s => s.kind === 'sec')
    .map(s => String(s.payload?.qdrant_point_id || s.payload?.id || ''))
    .filter(Boolean);
  const secUrlMap = secPointIds.length ? await resolveSecUrls(secPointIds) : new Map();

  return cited.map(s => {
    if (s.kind === 'sec') {
      const pointId = String(s.payload?.qdrant_point_id || s.payload?.id || '');
      const meta = secUrlMap.get(pointId) || {};
      return {
        index: s.index,
        type: 'sec',
        title: `${s.payload.ticker} ${s.payload.fiscal_year} 10-K -- ${s.payload.item_code}`,
        url: meta.url || null,
        ticker: s.payload.ticker,
        fiscal_year: s.payload.fiscal_year,
        item_code: s.payload.item_code,
      };
    }
    // Client signal
    const p = s.payload || {};
    return {
      index: s.index,
      type: 'client',
      title: p.title || 'Untitled',
      url: p.url || null,
      module: p.module_id || null,
      qdrant_point_id: s.qdrantPointId || null,
    };
  });
}

/**
 * Framework questions: keep the existing text prompt, but ask the LLM
 * to prefix its answer with CITED_SOURCES so we can resolve sources.
 * Returns { report: { title, bodyText }, sources }.
 */
async function generateFrameworkReport(question, intent, chunks, facts, clientResults) {
  const promptId = FRAMEWORK_PROMPT_IDS[intent.questionCategory];
  const systemPrompt = await loadPrompt(promptId);

  const { text: context, sourceManifest } = buildNumberedContext(chunks, facts, clientResults);
  const questionForLlm = sanitizeQuestionForLLM(question, intent.unresolvedMentions || []);
  const citationInstruction =
    '\n\nBEFORE YOUR MAIN ANSWER, on the very first line, output exactly:\n' +
    'CITED_SOURCES: <comma-separated context indices you relied on, e.g. 1,4,7>\n' +
    'If you relied on no sources, output: CITED_SOURCES: none\n' +
    'Then a blank line, then your normal answer. Do not mention CITED_SOURCES in the visible answer.\n';

  const userPrompt = `Context:\n${context}\n\nQuestion: ${questionForLlm}${citationInstruction}`;

  let raw = '';
  try {
    raw = await callLLM(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { temperature: 0.1, max_tokens: 1600, timeout: 180000 }
    );
  } catch (err) {
    return { report: { title: 'Report unavailable', bodyText: `LLM call failed: ${err.message}` }, sources: [] };
  }

  const { citedIndices, cleanBody } = extractCitedSources(raw);
  const sources = await resolveSources(citedIndices, sourceManifest);

  return {
    report: {
      title: `${intent.questionCategory.toUpperCase()} -- ${question}`,
      bodyText: cleanBody,
    },
    sources,
  };
}

/**
 * Open-ended qualitative DI: JSON schema prompt.
 * Returns { report: {...json...}, sources }.
 */
async function generateQualitativeReport(question, intent, chunks, facts, clientResults) {
  const systemPrompt = await loadPrompt(QUALITATIVE_PROMPT_ID);

  const { text: context, sourceManifest } = buildNumberedContext(chunks, facts, clientResults);
  const questionForLlm = sanitizeQuestionForLLM(question, intent.unresolvedMentions || []);
  const userPrompt = `Context:\n${context}\n\nQuestion: ${questionForLlm}`;

  let raw = '';
  try {
    raw = await callLLM(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { temperature: 0.1, max_tokens: 2500, timeout: 180000 }
    );
  } catch (err) {
    return { report: { title: 'Report unavailable', bodyText: `LLM call failed: ${err.message}` }, sources: [] };
  }

  const { citedIndices, cleanBody } = extractCitedSources(raw);

  let report;
  try {
    report = parseJsonReport(cleanBody);
  } catch (err) {
    // Retry once
    try {
      const retryRaw = await callLLM(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt + '\n\nIMPORTANT: Your previous response was not valid JSON. Respond again with CITED_SOURCES line then pure JSON only.' },
        ],
        { temperature: 0, max_tokens: 2500, timeout: 180000 }
      );
      const retry = extractCitedSources(retryRaw);
      report = parseJsonReport(retry.cleanBody);
    } catch (err2) {
      // Fall back to text-only, keep the retrieved sources visible
      const sources = await resolveSources(citedIndices, sourceManifest);
      return {
        report: { title: question, bodyText: cleanBody || 'Could not generate a structured report.' },
        sources,
      };
    }
  }

  const sources = await resolveSources(citedIndices, sourceManifest);
  return { report, sources };
}

/**
 * Main entry point. Returns { report, sources }.
 */
async function generateAnswer(question, intent, chunks, facts, clientId = null, industry = null) {
  // --- 1. Numeric path: no LLM ---
  if (intent.dataType === 'quantitative' && facts && facts.length) {
    const text = buildNumericAnswer(facts);
    return {
      report: {
        title: question,
        bodyText: text,
      },
      sources: [],
    };
  }

  // --- Retrieve client data once (used by both framework and qualitative) ---
  let clientResults = [];
  if (clientId && industry) {
    try {
      clientResults = await retrieveClientData(question, clientId, industry);
    } catch (err) {
      console.log(`[generateAnswer] Client data retrieval failed: ${err.message}`);
    }
  }

  // --- 2. Framework path ---
  if (FRAMEWORK_CATEGORIES.has(intent.questionCategory)) {
    return generateFrameworkReport(question, intent, chunks, facts, clientResults);
  }

  // --- 3. Qualitative / open-ended path ---
  return generateQualitativeReport(question, intent, chunks, facts, clientResults);
}

module.exports = { generateAnswer };