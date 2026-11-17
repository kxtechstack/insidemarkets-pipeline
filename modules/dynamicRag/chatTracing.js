/**
 * modules/dynamicRag/chatTracing.js
 *
 * Sends a step-by-step record of every DI chat question to Phoenix
 * (a small website that runs on your laptop at http://localhost:6006).
 * In Phoenix you can open one question and see:
 *   - every step (receiveQuestion, preprocessQuery, validateQuery ...)
 *   - what went INTO each step and what came OUT
 *   - every AI call inside a step: the exact prompt, the AI reply,
 *     tokens used and how long it took
 * So when an answer is wrong, you can see which step went wrong.
 *
 * ON / OFF:
 *   ON  only when the .env file has PHOENIX_COLLECTOR_ENDPOINT:
 *         laptop:       PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006
 *         TEST server:  PHOENIX_COLLECTOR_ENDPOINT=http://phoenix:6006
 *                       PHOENIX_API_KEY=<system key made in Phoenix>
 *       (the server's Phoenix has a login, so records are sent with that
 *        key; the Phoenix package reads PHOENIX_API_KEY by itself)
 *   OFF when that line is missing. The LIVE server never gets it.
 *   When OFF, every function below just runs the step as normal and does
 *   nothing else, and the Phoenix package is not even loaded.
 *
 * Safety: if anything in here fails, the chat carries on as normal.
 * Phoenix being closed on your laptop does not break the chat either.
 *
 * Used by:
 *   route.js        traceChat()  -> one record per question
 *                   traceStep()  -> one row per step inside it
 *                   traceChatResult() -> the final status + answer
 *   ../llmClient.js traceLLM()   -> one row per AI call
 *                   (only inside a DI chat question; the news pipeline's
 *                    AI calls are never recorded)
 */

const PHOENIX_URL = process.env.PHOENIX_COLLECTOR_ENDPOINT || '';
const PROJECT_NAME = process.env.PHOENIX_PROJECT || 'di-chat';
const MAX_TEXT = 100000; // very long step outputs are cut to this many characters

let phoenix = null; // stays null when tracing is OFF

if (PHOENIX_URL) {
  try {
    phoenix = require('@arizeai/phoenix-otel');
    // batch: false = send each record straight away (easier while testing)
    phoenix.register({ projectName: PROJECT_NAME, url: PHOENIX_URL, batch: false });
    console.log(`[chatTracing] Phoenix tracing ON -> ${PHOENIX_URL} (project "${PROJECT_NAME}")`);
  } catch (err) {
    phoenix = null;
    console.log(`[chatTracing] Phoenix tracing could not start, chat runs without it: ${err.message}`);
  }
}

// Turns any value into text Phoenix can show. Never throws.
function toText(value) {
  if (value === undefined || value === null) return '';
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch (err) {
    text = String(value);
  }
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n... (cut, ${text.length} characters in total)` : text;
}

function mimeOf(value) {
  return typeof value === 'string' ? 'text/plain' : 'application/json';
}

// Sets one value on a record. Never throws.
function safeSet(span, key, value) {
  try {
    if (value !== undefined && value !== null && value !== '') span.setAttribute(key, value);
  } catch (err) { /* ignore: tracing must never break the chat */ }
}

// Runs fn inside a new record called `name`. Used by traceChat and traceStep.
function runInSpan(name, setUp, fn, setDone) {
  const S = phoenix.SemanticConventions;
  const tracer = phoenix.trace.getTracer('di-chat');

  return tracer.startActiveSpan(name, async (span) => {
    try { setUp(span, S); } catch (err) { /* ignore */ }
    try {
      const result = await fn();
      try { setDone(span, S, result); } catch (err) { /* ignore */ }
      span.setStatus({ code: phoenix.SpanStatusCode.OK });
      return result;
    } catch (err) {
      try {
        span.recordException(err);
        span.setStatus({ code: phoenix.SpanStatusCode.ERROR, message: err.message });
        if (err.code) safeSet(span, 'error.code', String(err.code));
      } catch (e) { /* ignore */ }
      throw err; // the chat handles the error exactly as before
    } finally {
      span.end();
    }
  });
}

/**
 * One record for the whole question. Every step and AI call goes inside it.
 * body = the request body { question, clientId, userId, conversationId }
 */
function traceChat(body, fn) {
  if (!phoenix) return fn();
  const b = body || {};
  return runInSpan(
    'DI chat',
    (span, S) => {
      safeSet(span, S.OPENINFERENCE_SPAN_KIND, 'CHAIN');
      safeSet(span, S.INPUT_VALUE, toText(b.question));
      safeSet(span, S.INPUT_MIME_TYPE, 'text/plain');
      if (b.userId) safeSet(span, S.USER_ID, String(b.userId));
      if (b.conversationId) safeSet(span, S.SESSION_ID, String(b.conversationId));
      if (b.clientId) safeSet(span, 'client_id', String(b.clientId));
    },
    fn,
    () => {}
  );
}

/**
 * One record for one step. input = what the step gets; the step's return
 * value is saved as its output.
 */
function traceStep(name, input, fn) {
  if (!phoenix) return fn();
  return runInSpan(
    name,
    (span, S) => {
      safeSet(span, S.OPENINFERENCE_SPAN_KIND, 'CHAIN');
      safeSet(span, S.INPUT_VALUE, toText(input));
      safeSet(span, S.INPUT_MIME_TYPE, mimeOf(input));
    },
    fn,
    (span, S, result) => {
      safeSet(span, S.OUTPUT_VALUE, toText(result));
      safeSet(span, S.OUTPUT_MIME_TYPE, mimeOf(result));
    }
  );
}

/**
 * Saves the final reply (status + answer) on the question's record.
 * Call it from route.js just before the reply is sent.
 */
function traceChatResult(status, answer, conversationId) {
  if (!phoenix) return;
  try {
    const S = phoenix.SemanticConventions;
    const span = phoenix.trace.getActiveSpan();
    if (!span) return;
    const out = { status, answer };
    safeSet(span, S.OUTPUT_VALUE, toText(out));
    safeSet(span, S.OUTPUT_MIME_TYPE, 'application/json');
    safeSet(span, 'chat.status', String(status));
    if (conversationId) safeSet(span, S.SESSION_ID, String(conversationId));
  } catch (err) { /* ignore */ }
}

/**
 * One record for one AI call. Used by ../llmClient.js around the HTTP call.
 * Only records when we are inside a DI chat question (so the news
 * pipeline's AI calls are never sent to Phoenix).
 *   requestBody = { model, messages, temperature, max_tokens, ... }
 *   fn          = the real call; must return the axios response
 */
function traceLLM(requestBody, fn) {
  if (!phoenix) return fn();
  let insideChat = false;
  try { insideChat = Boolean(phoenix.trace.getActiveSpan()); } catch (err) { insideChat = false; }
  if (!insideChat) return fn();

  const rb = requestBody || {};
  return runInSpan(
    'AI call',
    (span, S) => {
      safeSet(span, S.OPENINFERENCE_SPAN_KIND, 'LLM');
      safeSet(span, S.LLM_MODEL_NAME, rb.model);
      safeSet(span, S.LLM_PROVIDER, 'novita');
      const { messages, ...settings } = rb;
      safeSet(span, S.LLM_INVOCATION_PARAMETERS, toText(settings));
      (messages || []).forEach((m, i) => {
        safeSet(span, `${S.LLM_INPUT_MESSAGES}.${i}.${S.MESSAGE_ROLE}`, m.role);
        safeSet(span, `${S.LLM_INPUT_MESSAGES}.${i}.${S.MESSAGE_CONTENT}`, toText(m.content));
      });
      safeSet(span, S.INPUT_VALUE, toText(messages));
      safeSet(span, S.INPUT_MIME_TYPE, 'application/json');
    },
    fn,
    (span, S, response) => {
      const data = (response && response.data) || {};
      const choice = (data.choices && data.choices[0]) || {};
      const content = (choice.message && choice.message.content) || '';
      safeSet(span, `${S.LLM_OUTPUT_MESSAGES}.0.${S.MESSAGE_ROLE}`, 'assistant');
      safeSet(span, `${S.LLM_OUTPUT_MESSAGES}.0.${S.MESSAGE_CONTENT}`, toText(content));
      safeSet(span, S.OUTPUT_VALUE, toText(content));
      safeSet(span, S.OUTPUT_MIME_TYPE, 'text/plain');
      if (choice.finish_reason) safeSet(span, 'llm.finish_reason', String(choice.finish_reason));
      const usage = data.usage || {};
      if (typeof usage.prompt_tokens === 'number') safeSet(span, S.LLM_TOKEN_COUNT_PROMPT, usage.prompt_tokens);
      if (typeof usage.completion_tokens === 'number') safeSet(span, S.LLM_TOKEN_COUNT_COMPLETION, usage.completion_tokens);
      if (typeof usage.total_tokens === 'number') safeSet(span, S.LLM_TOKEN_COUNT_TOTAL, usage.total_tokens);
    }
  );
}

module.exports = {
  TRACING_ON: () => Boolean(phoenix),
  traceChat,
  traceStep,
  traceChatResult,
  traceLLM,
};
