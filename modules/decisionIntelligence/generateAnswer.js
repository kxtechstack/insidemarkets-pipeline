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

const MODULE_NAMES = {
  '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960': 'Policy & Risk',
  '55c5ee19-bfca-468b-81b3-b89ca4f303c8': 'Market Dynamics',
  '2eb989fd-0ea0-4320-b73a-f7eb8b970473': 'Forward Outlook',
};
/**
 * Given a report's key_movement_analysis table, try to find a column that
 * has numeric values we can chart. Returns { type, title, dataKey, data }
 * if a chartable column is found, or null otherwise.
 *
 * Heuristic rules:
 *   - Skip column 0 (usually a label like "Channel" or "Market Segment")
 *   - A column is chartable if >=2 of its cells parse as numbers
 *   - Numbers can be: "$5B+", "+10%", "76%", "$13.3B", "-15%", "3.5", etc.
 *   - Order of preference: $ amounts and % values first (they're more
 *     meaningful visually than things like "3-6 months").
 */
function extractChartFromReport(report) {
  const table = report?.key_movement_analysis;
  if (!table?.columns || !table?.rows || table.rows.length < 2) return null;

  const parseNumber = (raw) => {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    // Handle "3-6 months" -> take the smaller number
    const rangeMatch = s.match(/^(\d+(?:\.\d+)?)\s*[-–to]+\s*(\d+(?:\.\d+)?)/i);
    if (rangeMatch) {
      const a = parseFloat(rangeMatch[1]);
      const b = parseFloat(rangeMatch[2]);
      if (!isNaN(a) && !isNaN(b)) return Math.min(a, b);
    }
    const m = s.match(/-?\$?\s*([\d,]+(?:\.\d+)?)\s*([BMKbmk%])?/);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(n)) return null;
    const suffix = (m[2] || '').toUpperCase();
    if (suffix === 'B') n *= 1e9;
    else if (suffix === 'M') n *= 1e6;
    else if (suffix === 'K') n *= 1e3;
    return { value: n, suffix };
  };

  // Try each column after the first, prefer $-columns and %-columns
  let best = null;
  for (let colIdx = 1; colIdx < table.columns.length; colIdx++) {
    const cells = table.rows.map((r) => r.cells[colIdx]);
    const parsed = cells.map(parseNumber);

    const nonNull = parsed.filter((p) => p !== null);
    if (nonNull.length < 2) continue;

    // Require >= 50% of cells to be numeric
    if (nonNull.length / cells.length < 0.5) continue;

    // Require at least 2 distinct values, otherwise the chart is a flat line
    const distinct = new Set(nonNull.map((p) => p.value));
    if (distinct.size < 2) continue;

    // Prefer $ or % columns (suffix present)
    const hasSuffix = nonNull.some((p) => p.suffix === 'B' || p.suffix === 'M' || p.suffix === 'K' || p.suffix === '%');
    const score = hasSuffix ? 2 : 1;

    if (!best || score > best.score) {
      best = {
        score,
        columnIdx: colIdx,
        columnLabel: table.columns[colIdx],
        xLabel: table.columns[0],
        data: table.rows
          .map((r, i) => ({
            name: String(r.cells[0]).slice(0, 32),
            value: parsed[i]?.value ?? null,
          }))
          .filter((d) => d.value !== null),
      };
    }
  }

  if (!best || best.data.length < 2) return null;

  // Chart type: line if the first column looks like years, bar otherwise
  const firstColValues = table.rows.map((r) => String(r.cells[0]));
  const looksLikeYears = firstColValues.every((v) => /^(?:FY)?20\d{2}$/i.test(v.trim()));
  const chartType = looksLikeYears ? 'line' : 'bar';

  return {
    type: chartType,
    title: `${best.columnLabel} by ${best.xLabel}`,
    dataKey: 'value',
    unit: '',
    data: best.data,
  };
}

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
      module: MODULE_NAMES[p.module_id] || p.module_id || null,
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

  // NEW: try to derive a chart from the report's table if possible.
  // Priority: chart from table when numbers are present, otherwise no chart.
  let chart = null;
  let chartMeta = null;
  try {
    const chartSpec = extractChartFromReport(report);
    if (chartSpec) {
      const { renderChart } = require('./chartPipeline');
      const buffer = await renderChart({
        type: chartSpec.type,
        xAxis: 'category',
        metricLabel: chartSpec.title,
        series: [{
          name: chartSpec.title,
          labels: chartSpec.data.map((d) => d.name),
          data: chartSpec.data.map((d) => d.value),
        }],
      });
      chart = buffer;
      chartMeta = { chartType: chartSpec.type };
    }
  } catch (err) {
    console.log(`[generateAnswer] Auto-chart from table failed: ${err.message}`);
  }

  return { report, sources, chart, chartMeta };
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