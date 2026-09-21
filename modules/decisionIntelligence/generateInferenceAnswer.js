/**
 * modules/decisionIntelligence/generateInferenceAnswer.js
 *
 * Inference questions: client data only, no SEC. Returns { report, sources }.
 * Uses decision_intelligence_inference_v2 (JSON schema + CITED_SOURCES).
 *
 * Context builder caps each item's text so the LLM sees many distinct
 * sources within the request budget, and numbers them so the LLM can
 * cite by index (e.g. "1,4,7"). The backend then maps cited indices
 * back to real signal metadata for the frontend.
 */

const { callLLM } = require('../llmClient');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const INFERENCE_PROMPT_ID = 'decision_intelligence_inference_v2';

const MAX_CONTEXT_CHARS = 12000;
const ITEM_MAX_CHARS = 400;

const MODULE_NAMES = {
  '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960': 'Policy & Risk',
  '55c5ee19-bfca-468b-81b3-b89ca4f303c8': 'Market Dynamics',
  '2eb989fd-0ea0-4320-b73a-f7eb8b970473': 'Forward Outlook',
};

async function loadInferencePrompt() {
  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', INFERENCE_PROMPT_ID)
    .eq('is_active', true)
    .single();
  if (error || !data) {
    throw new Error(`Could not load Inference prompt '${INFERENCE_PROMPT_ID}': ${error?.message}`);
  }
  return data.prompt_template;
}

/**
 * Builds the numbered context for the LLM, plus a source manifest that
 * maps each index back to the original Qdrant payload.
 */
function buildNumberedContext(searchResults) {
  const items = [];
  let len = 0;

  for (const r of searchResults) {
    const p = r.payload || {};
    let text = p.chunk_text || p.summary || '';
    if (text.length > ITEM_MAX_CHARS) {
      text = text.slice(0, ITEM_MAX_CHARS).trim() + '...';
    }
    const part = `${p.title || 'Untitled'}\n${text}`;
    if (len + part.length > MAX_CONTEXT_CHARS) break;
    items.push({
      payload: p,
      qdrantPointId: r.id != null ? String(r.id) : null,
      text,
    });
    len += part.length;
  }

  const sourceManifest = [];
  const numbered = [];
  items.forEach((item, idx) => {
    const n = idx + 1;
    numbered.push(`[${n}] ${item.text}`);
    sourceManifest.push({ index: n, kind: 'client', ...item });
  });

  return { text: numbered.join('\n\n'), sourceManifest };
}

/**
 * Extract CITED_SOURCES line from the top of the LLM output.
 */
function extractCitedSources(raw) {
  if (!raw) return { citedIndices: new Set(), cleanBody: '' };
  const match = raw.match(/^\s*CITED_SOURCES\s*:\s*(none|[\d,\s]+)\s*\n+/i);
  if (!match) return { citedIndices: new Set(), cleanBody: raw.trim() };

  const tail = raw.slice(match[0].length);
  const cited = match[1].toLowerCase() === 'none'
    ? new Set()
    : new Set(
        match[1]
          .split(',')
          .map(s => parseInt(s.trim(), 10))
          .filter(n => !isNaN(n))
      );
  return { citedIndices: cited, cleanBody: tail.trim() };
}

/**
 * Parse JSON body, stripping any stray markdown code fences.
 */
function parseJsonReport(raw) {
  let s = (raw || '').trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  return JSON.parse(s);
}

/**
 * Map cited indices back to source objects.
 */
function resolveSources(citedIndices, sourceManifest) {
  return sourceManifest
    .filter(s => citedIndices.has(s.index))
    .map(s => {
      const p = s.payload || {};
      return {
        index: s.index,
        type: 'client',
        title: p.title || 'Untitled',
        url: p.url || null,
        module: MODULE_NAMES[p.module_id] || 'Unknown',
        article_id: p.article_id || null,
        qdrant_point_id: s.qdrantPointId || null,
      };
    });
}

async function generateInferenceAnswer(question, searchResults) {
  if (!searchResults.length) {
    return {
      report: null,
      sources: [],
      _empty: true,
      _reason: 'no signals matched the question',
    };
  }

  const { text: context, sourceManifest } = buildNumberedContext(searchResults);

  let systemPrompt;
  try {
    systemPrompt = await loadInferencePrompt();
  } catch (err) {
    return {
      report: { title: question, bodyText: `Could not load inference prompt: ${err.message}` },
      sources: [],
    };
  }

  const userPrompt = `Context:\n${context}\n\nQuestion: ${question}`;

  let raw = '';
  try {
    raw = await callLLM(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.1, max_tokens: 1800, timeout: 180000 }
    );
  } catch (err) {
    return {
      report: { title: question, bodyText: `LLM call failed: ${err.message}` },
      sources: [],
    };
  }

  const { citedIndices, cleanBody } = extractCitedSources(raw);

  let report;
  try {
    report = parseJsonReport(cleanBody);
  } catch (err) {
    // Retry once, then fall back to plain text
    try {
      const retryRaw = await callLLM(
        [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content:
              userPrompt +
              '\n\nIMPORTANT: Your previous response was not valid JSON. Respond again with the CITED_SOURCES line first, then the pure JSON object only. No markdown fences.',
          },
        ],
        { temperature: 0, max_tokens: 1800, timeout: 180000 }
      );
      const retry = extractCitedSources(retryRaw);
      report = parseJsonReport(retry.cleanBody);
    } catch (err2) {
      const sources = resolveSources(citedIndices, sourceManifest);
      return {
        report: {
          title: question,
          bodyText: cleanBody || 'Could not generate a structured report.',
        },
        sources,
      };
    }
  }

  // If the LLM flagged no_data BUT retrieval actually returned a
  // meaningful number of articles, ignore the LLM's refusal -- it's
  // being overly cautious. Build a report from the top retrieved
  // articles and cite them directly.
  let overrideSources = null;
  if (report && report.no_data === true) {
    const hasRealContext = searchResults && searchResults.length >= 5;
    if (!hasRealContext) {
      return {
        report: null,
        sources: [],
        _empty: true,
        _reason: report.reason || 'no relevant data',
      };
    }
    console.log(`[generateInferenceAnswer] LLM refused but retrieval returned ${searchResults.length} results; overriding with retrieved sources`);

    // Take the top 8 retrieved articles and cite them all
    const top = searchResults.slice(0, 8);
    const topIndices = top.map((_, i) => i + 1);
    overrideSources = top.map((r, i) => ({
      index: i + 1,
      type: 'client',
      title: r.payload?.title || 'Untitled',
      url: r.payload?.url || null,
      module: MODULE_NAMES[r.payload?.module_id] || 'Unknown',
      article_id: r.payload?.article_id || null,
      qdrant_point_id: r.id != null ? String(r.id) : null,
    }));

    report = {
      title: question,
      outlook: [
        `We surfaced ${searchResults.length} articles matching this question. Below is a summary of the top ${top.length} most relevant sources.`,
        `Top article: "${top[0]?.payload?.title || 'Untitled'}".`,
      ],
      key_movement_analysis: {
        columns: ['Source', 'Module'],
        rows: top.slice(0, 5).map(r => ({
          cells: [
            (r.payload?.title || 'Untitled').slice(0, 80),
            MODULE_NAMES[r.payload?.module_id] || 'Unknown',
          ],
        })),
      },
      driving_factors: top.slice(0, 4).map(r =>
        `${r.payload?.title || 'Untitled'} (relevance: ${(r.score * 100).toFixed(0)}%)`
      ),
      what_to_watch: [
        'Review the full list of sources below for the complete context.'
      ],
      bottom_line: `${searchResults.length} relevant articles found. Please review the sources for details.`,
    };
  }

  const sources = overrideSources
    ? overrideSources
    : resolveSources(citedIndices, sourceManifest);
  return { report, sources };
}

module.exports = { generateInferenceAnswer };