/**
 * modules/decisionIntelligence/generateInferenceAnswer.js
 *
 * Generates the answer for Inference-type questions in the Decision
 * Intelligence chat -- these DO need the LLM, unlike List, because the
 * question asks for analysis/synthesis (a trend, a comparison, a change
 * over time) rather than a flat set of already-finished signal records.
 *
 * Prompt lives in the `prompts` table (id: decision_intelligence_inference_v1),
 * same convention as ragChat.js's getRagPromptTemplate -- not hardcoded.
 *
 * FIX (413 Payload Too Large): the context builder previously joined the
 * FULL chunk_text of EVERY retrieved result with no size limit at all --
 * confirmed in testing that 28 real results (each potentially ~1800
 * chars) built a ~50,000-char request body, which Groq's API rejected
 * outright with HTTP 413 before the LLM ever got to run. Added the same
 * two-level budget already proven in generateAnswer.js's buildContext():
 * a per-item cap (so one long chunk can't crowd out everything else) plus
 * a total budget (so the request body always stays a safe size).
 */

const { callLLM } = require('../llmClient');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const INFERENCE_PROMPT_ID = 'decision_intelligence_inference_v1';

// FIX: same budget shape as generateAnswer.js's buildContext(). 12000
// total chars is comfortably within Groq's request-size limits; 400
// chars/item guarantees many distinct sources fit instead of the top 2-3
// consuming the whole budget (the exact failure mode found and fixed
// earlier in the SEC+client-data merge).
const MAX_CONTEXT_CHARS = 12000;
const ITEM_MAX_CHARS = 400;

const MODULE_NAMES = {
  '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960': 'Policy & Risk',
  '55c5ee19-bfca-468b-81b3-b89ca4f303c8': 'Market Dynamics',
  '2eb989fd-0ea0-4320-b73a-f7eb8b970473': 'Forward Outlook',
};

async function getInferencePromptTemplate() {
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
 * FIX: builds the context with a per-item cap + running total budget,
 * instead of joining every result's full chunk_text unbounded. Results
 * are assumed to already be sorted by relevance (retrieveClientData.js
 * sorts by score before returning), so truncating once the budget is
 * hit means the STRONGEST matches are kept, weaker ones drop off first.
 */
function buildInferenceContext(searchResults) {
  const parts = [];
  let len = 0;
  let includedCount = 0;

  for (const r of searchResults) {
    const p = r.payload || {};
    let text = p.chunk_text || p.summary || '';
    if (text.length > ITEM_MAX_CHARS) {
      text = text.slice(0, ITEM_MAX_CHARS).trim() + '...';
    }
    const part = `[${includedCount + 1}] ${p.title || 'Untitled'}\n${text}`;
    if (len + part.length > MAX_CONTEXT_CHARS) break;
    parts.push(part);
    len += part.length;
    includedCount++;
  }

  return { context: parts.join('\n\n'), includedCount };
}

/**
 * @param {string} question
 * @param {Array} searchResults - from retrieveClientData()
 * @returns {Promise<{answer: string, sources: Array<{title, url}>}>}
 */
async function generateInferenceAnswer(question, searchResults) {
  if (!searchResults.length) {
    return { answer: 'No relevant data found for your question.', sources: [] };
  }

  const { context, includedCount } = buildInferenceContext(searchResults);
  console.log(`[generateInferenceAnswer] ${includedCount} of ${searchResults.length} results included in context (${context.length} chars)`);

  const systemPrompt = await getInferencePromptTemplate();
  const userPrompt = `Context:\n${context}\n\nQuestion: ${question}`;

  let answer;
  try {
    answer = await callLLM(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.1, max_tokens: 1200, timeout: 180000 }
    );
  } catch (err) {
    answer = `Sorry, I couldn't generate an answer right now (LLM request failed: ${err.message}). Please try again in a moment.`;
  }

  // NOTE: sources still list ALL retrieved results (not just the ones
  // that fit in context) -- this is deliberate. The frontend's source
  // list is a "here's everything relevant we found" reference, separate
  // from what the LLM was actually shown; trimming it to match the
  // truncated context would hide real, relevant sources from the user
  // for no benefit.
  const sources = [...new Map(searchResults.map(r => [r.payload.url, {
    title: r.payload.title,
    url: r.payload.url,
    module: MODULE_NAMES[r.payload.module_id] || 'Unknown',
  }])).values()];

  return { answer, sources };
}

module.exports = { generateInferenceAnswer, getInferencePromptTemplate };