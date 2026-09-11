/**
 * modules/decisionIntelligence/generateAnswer.js
 *
 * Node port of query_rag.py's prompt constants + select_system_prompt() +
 * the qualitative branch of answer_question(). This is the ONLY place an
 * LLM gets called in the whole Decision Intelligence pipeline -- numeric
 * questions never reach here (buildNumericAnswer.js handles those
 * directly from verified facts, no model involved).
 *
 * Uses the project's existing modules/llmClient.js (same one ragChat.js
 * already uses for Groq calls).
 *
 * CHANGED: generateAnswer() now accepts optional clientId + industry.
 * When both are provided, retrieveClientData.js is used to pull the
 * client's own relevant signals (Policy & Risk / Market Dynamics /
 * Forward Outlook) and merges them into the LLM context alongside the
 * SEC facts/chunks -- this is what makes Decision Intelligence actually
 * combine SEC filings AND the client's own data, per Govind's scope.
 * When clientId/industry are omitted, behavior is UNCHANGED (SEC-only),
 * so existing SEC-only tests/callers keep working exactly as before.
 * The numeric path (buildNumericAnswer) is deliberately NOT touched --
 * numeric answers stay pure verified financial_facts, no LLM, so there's
 * no narrative for client context to enrich.
 */

const { callLLM } = require('../llmClient');
const { buildNumericAnswer } = require('./buildNumericAnswer');
const { sanitizeQuestionForLLM } = require('./secRetrieval');
const { retrieveClientData } = require('./retrieveClientData');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MAX_CONTEXT_CHARS = 12000;
// CHANGED: SEC context and client context now split the character budget,
// so one source can't crowd the other out entirely. Roughly 60/40 --
// SEC filing text tends to be denser/more load-bearing for the
// SWOT/PESTLE/etc. prompts, client signals are usually shorter summaries.
const MAX_SEC_CONTEXT_CHARS = Math.floor(MAX_CONTEXT_CHARS * 0.6);
const MAX_CLIENT_CONTEXT_CHARS = MAX_CONTEXT_CHARS - MAX_SEC_CONTEXT_CHARS;

// ---------------------------------------------------------------------------
// Prompts are stored in the `prompts` table -- same convention as
// ragChat.js's getRagPromptTemplate(). One row per analysis type.
// ---------------------------------------------------------------------------
const DECISION_PROMPT_IDS = {
  five_forces: 'decision_intelligence_five_forces_v1',
  pestle: 'decision_intelligence_pestle_v1',
  risk_analysis: 'decision_intelligence_risk_analysis_v1',
  swot: 'decision_intelligence_swot_v1',
  qualitative: 'decision_intelligence_qualitative_v1',
};

async function getDecisionPromptTemplate(category) {
  const promptId = DECISION_PROMPT_IDS[category] || DECISION_PROMPT_IDS.qualitative;

  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', promptId)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    throw new Error(`Could not load Decision Intelligence prompt '${promptId}': ${error?.message}`);
  }

  return data.prompt_template;
}

async function selectSystemPrompt(intent) {
  return getDecisionPromptTemplate(intent.questionCategory);
}

// ---------------------------------------------------------------------------
// Builds the LLM context block: verified SEC facts first (if any), then
// SEC chunk text (capped at MAX_SEC_CONTEXT_CHARS), then -- CHANGED -- a
// separate "CLIENT-SPECIFIC CONTEXT" section built from the client's own
// retrieved signals (capped at MAX_CLIENT_CONTEXT_CHARS), clearly labeled
// so the LLM (and a human reading the prompt for debugging) can tell SEC
// filing text apart from the client's own collected data.
// ---------------------------------------------------------------------------
function buildContext(chunks, facts, clientResults = []) {
  const parts = [];

  if (facts && facts.length) {
    const factLines = facts.map(f => `- ${f.ticker} ${f.metric_name}: ${f.metric_value} ${f.unit} (FY${f.fiscal_year})`);
    parts.push('VERIFIED FINANCIAL FACTS (from structured data, trust these over text):\n' + factLines.join('\n'));
  }

  let secLen = parts.reduce((sum, p) => sum + p.length, 0);
  const secParts = [];
  for (const c of chunks) {
    const chunkPart = `[SEC Source: ${c.ticker} FY${c.fiscal_year} - ${c.item_code}]\n${c.chunk_text}`;
    if (secLen + chunkPart.length > MAX_SEC_CONTEXT_CHARS) break;
    secParts.push(chunkPart);
    secLen += chunkPart.length;
  }
  parts.push(...secParts);

  // CHANGED: new section, only appears when the caller actually retrieved
  // client data (clientResults is empty for SEC-only callers, so this is
  // a no-op and output is byte-for-byte identical to the old behavior).
  if (clientResults && clientResults.length) {
    // FIX: previously used the FULL chunk_text with no per-item cap, so
    // the highest-scored 2-3 results (each potentially a few hundred
    // words) could consume the entire MAX_CLIENT_CONTEXT_CHARS budget by
    // themselves, silently excluding everything after them -- even a
    // result far more directly relevant (e.g. an article naming the
    // company by name) that just happened to rank a few spots lower.
    // Capping each item's included text guarantees many more distinct
    // sources fit within the same total budget, so relevance ranking
    // (already done in retrieveClientData) actually gets to matter across
    // more than the top 2-3 results.
    const CLIENT_ITEM_MAX_CHARS = 400;
    const clientParts = [];
    let clientLen = 0;
    for (const r of clientResults) {
      const p = r.payload || {};
      const label = p.module_id || 'Client Data';
      let text = p.chunk_text || p.summary || '';
      if (text.length > CLIENT_ITEM_MAX_CHARS) {
        text = text.slice(0, CLIENT_ITEM_MAX_CHARS).trim() + '...';
      }
      const clientPart = `[Client Source: ${p.title || 'Untitled'} (${label})]\n${text}`;
      if (clientLen + clientPart.length > MAX_CLIENT_CONTEXT_CHARS) break;
      clientParts.push(clientPart);
      clientLen += clientPart.length;
    }
    if (clientParts.length) {
      parts.push(
        'CLIENT-SPECIFIC CONTEXT (the client\'s own collected data -- treat as equally trustworthy to the SEC filing text above, but scoped specifically to this client):\n\n' +
        clientParts.join('\n\n')
      );
    }
    // DEBUG (temporary -- remove once the client-data merge is confirmed
    // working reliably): prints hard evidence of what actually made it
    // into the context, so we can tell a code-level inclusion problem
    // apart from the LLM simply choosing not to mention something that
    // WAS included.
    console.log(`[buildContext DEBUG] client results in: ${clientResults.length}, included after truncation: ${clientParts.length}, client section chars: ${clientLen}`);
    console.log(`[buildContext DEBUG] titles included: ${clientParts.map(p => p.match(/\[Client Source: ([^(]+)/)?.[1]?.trim()).join(' | ')}`);
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Top-level: given a question + its already-classified intent + retrieved
 * SEC chunks/facts, produces the final answer text.
 *   - numeric questions with facts -> buildNumericAnswer(), no LLM call,
 *     client data NOT merged (see file header)
 *   - everything else (qualitative/framework) -> LLM call with the
 *     matching fixed-header prompt, client data merged in IF clientId +
 *     industry are provided
 *
 * @param {string} question
 * @param {object} intent - from extractIntent.js
 * @param {Array} chunks - SEC chunks from retrieveChunks.js
 * @param {Array} facts - financial_facts rows from retrieveChunks.js
 * @param {string} [clientId] - CHANGED: optional. When provided (with industry), pulls client data into context.
 * @param {string} [industry] - CHANGED: optional, required alongside clientId.
 * @returns {Promise<string>} the answer text
 */
async function generateAnswer(question, intent, chunks, facts, clientId = null, industry = null) {
  let answerText;

  if (intent.dataType === 'quantitative' && facts.length) {
    answerText = buildNumericAnswer(facts);
  } else {
    const systemPrompt = await selectSystemPrompt(intent);

    // CHANGED: only fetch client data when both clientId and industry were
    // passed in. Failures here are non-fatal -- a client-data lookup
    // problem should never break the SEC-grounded answer, so this is
    // wrapped in its own try/catch and simply falls back to no client
    // context (logged, not thrown) rather than failing the whole question.
    let clientResults = [];
    if (clientId && industry) {
      try {
        clientResults = await retrieveClientData(question, clientId, industry);
      } catch (err) {
        console.log(`[generateAnswer] Client data retrieval failed, continuing with SEC-only context: ${err.message}`);
      }
    }

    const context = buildContext(chunks, facts, clientResults);

    const questionForLlm = sanitizeQuestionForLLM(question, intent.unresolvedMentions || []);
    const allowedCompaniesNote = intent.tickers.length
      ? `\n\n(Only answer for these companies, using ONLY the context above: ${intent.tickers.join(', ')}. Do not mention, describe, or guess facts about any other company.)`
      : '';
    const userPrompt = `Context:\n${context}\n\nQuestion: ${questionForLlm}${allowedCompaniesNote}`;

    try {
      answerText = await callLLM(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.1, max_tokens: 1200, timeout: 180000 }
      );
    } catch (err) {
      answerText = `Sorry, I couldn't generate an answer right now (LLM request failed: ${err.message}). Please try again in a moment.`;
    }
  }

  if (intent.unresolvedMentions && intent.unresolvedMentions.length) {
    const names = intent.unresolvedMentions.join("', '");
    answerText += `\n\nNote: '${names}' could not be matched to any company in our database, so it was excluded from the answer above.`;
  }

  if (intent.insufficientForDistribution) {
    answerText += `\n\nNote: A distribution chart needs at least 5 companies to be meaningful -- only ${intent.tickers.length} were named here, so a regular chart is shown instead.`;
  }

  return answerText;
}

module.exports = {
  generateAnswer, selectSystemPrompt, buildContext, getDecisionPromptTemplate,
};