/**
 * modules/dynamicRag/validateQuery.js
 *
 * STEP 3 of the manager's doc — "Query validation".
 * This is the first step that uses the AI.
 *
 * Job: decide if the chat should work on this question at all.
 *
 *   accept         a business / market question, clear enough  -> go on
 *   reject         not our job (poem, code, recipe, "hi")      -> polite reply, stop
 *   clarification  maybe our job, but too vague to work on     -> ask ONE question, stop
 *
 * How it works:
 *   0. A message with no letters or numbers at all ("...", "?!") is asked
 *      back straight away, without the AI.
 *   1. Load the instruction (prompt) from the prompts table.
 *   2. Ask the AI to label the question. The AI only SUGGESTS a label.
 *   3. Check the AI's reply here in code. If it is broken, ask once more.
 *      If it is still broken, tell the user to try again. Never guess.
 *   4. Code (not the AI) turns the label into the final result and picks
 *      the message the user sees.
 *
 * What Step 3 does NOT do: check if we have data for the question,
 * search anything, or answer the question.
 */

const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../llmClient');
const { ChatError } = require('./chatError');
const {
  VALIDATE_PROMPT_ID,
  PROMPT_REFRESH_MS,
  REJECT_MESSAGE,
  GREETING_MESSAGE,
  CLARIFICATION_FALLBACK_MESSAGE,
} = require('./chatConfig');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// The four labels the AI may use. "greeting" is our own extra label: for
// the user it is a reject, but with a friendlier message than "not our job".
const AI_LABELS = ['accept', 'clarification', 'greeting', 'reject'];

// How many times we ask the AI before giving up.
const MAX_ATTEMPTS = 2;

// A clarification question written by the AI is only used if it looks sane.
const MIN_QUESTION_CHARS = 10;
const MAX_QUESTION_CHARS = 300;

// ── 1. The instruction, from the prompts table ───────────────────────────
let promptCache = { text: null, loadedAt: 0 };

async function loadPrompt() {
  if (promptCache.text && Date.now() - promptCache.loadedAt < PROMPT_REFRESH_MS) {
    return promptCache.text;
  }

  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', VALIDATE_PROMPT_ID)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw new Error(`could not load prompt ${VALIDATE_PROMPT_ID}: ${error.message}`);
  if (!data || !data.prompt_template) {
    throw new Error(`prompt ${VALIDATE_PROMPT_ID} is missing or switched off in the prompts table`);
  }

  promptCache = { text: data.prompt_template, loadedAt: Date.now() };
  return promptCache.text;
}

// ── 2. Read the AI's reply (no AI, no database — easy to test) ───────────
/**
 * The AI was told to reply with only this JSON:
 *   { "status": "...", "reason": "...", "clarification_question": "..." }
 *
 * Small models sometimes wrap it in ``` marks or add a sentence around it,
 * so we take the text from the first "{" to the last "}".
 *
 * @returns { label, reason, question }  or  null if the reply cannot be used
 */
function readAiReply(replyText) {
  const text = String(replyText || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const label = String(parsed.status || '').trim().toLowerCase();
  if (!AI_LABELS.includes(label)) return null;

  return {
    label,
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
    question: typeof parsed.clarification_question === 'string' ? parsed.clarification_question.trim() : '',
  };
}

// ── 3. Turn the label into the final result ──────────────────────────────
/**
 * @returns {
 *   status   : 'accept' | 'reject' | 'clarification'
 *   reason   : the AI's short reason (for our logs, not shown to the user)
 *   message  : what the user sees (null when status is 'accept')
 *   ai_label : the raw label the AI gave
 * }
 */
function decide(ai) {
  if (ai.label === 'accept') {
    return { status: 'accept', reason: ai.reason, message: null, ai_label: ai.label };
  }

  if (ai.label === 'greeting') {
    return { status: 'reject', reason: ai.reason, message: GREETING_MESSAGE, ai_label: ai.label };
  }

  if (ai.label === 'reject') {
    return { status: 'reject', reason: ai.reason, message: REJECT_MESSAGE, ai_label: ai.label };
  }

  // clarification: use the AI's question only if it looks like a real,
  // short question. Otherwise use our own fixed one.
  const q = ai.question;
  const usable = q.length >= MIN_QUESTION_CHARS && q.length <= MAX_QUESTION_CHARS && q.includes('?');
  return {
    status: 'clarification',
    reason: ai.reason,
    message: usable ? q : CLARIFICATION_FALLBACK_MESSAGE,
    ai_label: ai.label,
  };
}

// ── Step 3 main ──────────────────────────────────────────────────────────
/**
 * @param {object} cleaned  what Step 2 returned (needs cleaned.preprocessed_query)
 * @returns the result from decide(), plus attempts (how many AI calls it took)
 * @throws ChatError 503 if the AI could not give a usable reply
 */
async function validateQuery(cleaned) {
  // A message with no letters and no numbers at all ("...", "?!", "👍") has
  // nothing to label. No need to ask the AI: ask the user what they need.
  if (!/[\p{L}\p{N}]/u.test(cleaned.preprocessed_query)) {
    return {
      status: 'clarification',
      reason: 'The message has no words in it.',
      message: CLARIFICATION_FALLBACK_MESSAGE,
      ai_label: 'clarification',
      attempts: 0,
    };
  }

  const prompt = await loadPrompt();

  const messages = [
    { role: 'system', content: prompt },
    // The question is sent as separate text, fenced with """ marks, so the
    // AI treats it as something to label and not as an instruction.
    { role: 'user', content: `Question to label:\n"""\n${cleaned.preprocessed_query}\n"""` },
  ];

  let lastProblem = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let reply;
    try {
      // temperature 0 = the same question gets the same label every time.
      reply = await callLLM(messages, { temperature: 0, max_tokens: 200, timeout: 30000, maxRetries: 2 });
    } catch (err) {
      lastProblem = `AI call failed: ${err.message}`;
      console.log(`[DynamicRAG] validateQuery attempt ${attempt}: ${lastProblem}`);
      continue;
    }

    const ai = readAiReply(reply);
    if (ai) return { ...decide(ai), attempts: attempt };

    lastProblem = `AI reply could not be used: ${String(reply).slice(0, 200)}`;
    console.log(`[DynamicRAG] validateQuery attempt ${attempt}: ${lastProblem}`);
  }

  // We do NOT guess "accept" here. A wrong guess would send a poem request
  // through the whole chat, or block a real question with no reason.
  console.error(`[DynamicRAG] validateQuery gave up after ${MAX_ATTEMPTS} attempts. ${lastProblem}`);
  throw new ChatError(503, 'AI_UNAVAILABLE', 'I could not process your question right now. Please try again in a moment.');
}

module.exports = { validateQuery, readAiReply, decide };
