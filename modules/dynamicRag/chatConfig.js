/**
 * modules/dynamicRag/chatConfig.js
 *
 * Settings for the Decision Intelligence chat, all in one place.
 */

module.exports = {
  // ── Step 1 (receiveQuestion.js) ────────────────────────────────────────
  // Longest question we accept (characters). Stops huge pastes that would
  // slow the AI down or cost too much.
  MAX_QUESTION_CHARS: Number(process.env.DR_MAX_QUESTION_CHARS) || 2000,

  // Chat title shown in the chat list = start of the first question.
  TITLE_MAX_CHARS: 80,

  // ── Step 2 (preprocessQuery.js) ────────────────────────────────────────
  // How long the word list (dr_terms table) is kept in memory before it is
  // read again. 1 minute = a new row starts working within a minute,
  // without asking the database on every single question.
  WORD_LIST_REFRESH_MS: Number(process.env.DR_WORD_LIST_REFRESH_MS) || 60 * 1000,

  // ── Step 3 (validateQuery.js) ──────────────────────────────────────────
  // Which row of the prompts table holds the Step 3 instruction for the AI.
  VALIDATE_PROMPT_ID: 'dynamic_rag_validate_query_v1',

  // How long a prompt is kept in memory before it is read again.
  // 1 minute = an edited prompt starts working within a minute.
  PROMPT_REFRESH_MS: Number(process.env.DR_PROMPT_REFRESH_MS) || 60 * 1000,

  // What the user sees when the question is not our job (poem, code...).
  REJECT_MESSAGE:
    'That is outside what I can help with. I can answer business and market questions, ' +
    'for example industry trends, competitor comparisons, company financials, ' +
    'policy changes and new opportunities.',

  // What the user sees after "hi", "thanks" or "what can you do?".
  GREETING_MESSAGE:
    'Happy to help. I can answer business and market questions, for example industry trends, ' +
    'competitor comparisons, company financials, policy changes and new opportunities. ' +
    'What would you like to know?',

  // Used when the question is too vague and the AI did not write a good
  // question to ask back.
  CLARIFICATION_FALLBACK_MESSAGE:
    'Could you tell me a little more about what you need? For example: a market or industry, ' +
    'a company, competitors, trends or opportunities.',

  // ── Step 5 (understandQuery.js) ────────────────────────────────────────
  // Which row of the prompts table holds the Step 5 instruction for the AI.
  UNDERSTAND_PROMPT_ID: 'dynamic_rag_understand_query_v1',

  // "Today" for working out dates like "last 3 months". The date is taken
  // in this time zone.
  CHAT_TIMEZONE: process.env.DR_TIMEZONE || 'Asia/Kolkata',

  // What the user sees when the question names nothing to work on
  // (for example just "analysis" or "revenue").
  NO_TOPIC_MESSAGE:
    'What should I look at? Tell me a company, market, product or topic, for example ' +
    '"competitor launches this month" or "skincare trends in the UAE".',

  // What the user sees when the question has a date we could not read
  // (for example "03/04/2025", which is March 4 or April 3 by country).
  // {words} is replaced by the date words that were not understood.
  TIME_UNCLEAR_MESSAGE:
    'I could not read the date in your question ({words}). Please write it like ' +
    '"March 2025", "Q1 2025", "1 March 2025", "March to June 2025" or "last 6 months".',

  // ── Step 6 (planTasks.js) ──────────────────────────────────────────────
  // Which row of the prompts table holds the Step 6 instruction for the AI.
  PLAN_PROMPT_ID: 'dynamic_rag_plan_tasks_v1',

  // ── Step 7 (buildWorkflow.js) ──────────────────────────────────────────
  // Which row of the prompts table holds the Step 7 instruction for the AI.
  WORKFLOW_PROMPT_ID: 'dynamic_rag_build_workflow_v1',

  // ── Step 8 (validateWorkflow.js) ───────────────────────────────────────
  // What the user sees when the list of jobs breaks a rule (nothing runs).
  PLAN_FAILED_MESSAGE:
    'I could not put together a safe way to answer this question. Please try asking it in a simpler way, ' +
    'for example one company, market or topic at a time.',
  // true = Step 8 also refuses jobs whose real code (Step 9) is not ready.
  // Off until Step 9 is built; then switch it on.
  REQUIRE_READY_JOBS: false,

  // ── Test tools ─────────────────────────────────────────────────────────
  // The chat playground page (/dynamic-rag/playground) shows what every
  // step did with a question. Only for testing on our own laptop: it opens
  // only when the .env file has DR_PLAYGROUND=on. Keep it OFF on the live
  // server.
  PLAYGROUND_ON: process.env.DR_PLAYGROUND === 'on',
  // On the TEST server the playground also needs a secret key in the link:
  //   http://<server>/dynamic-rag/playground?key=<DR_PLAYGROUND_KEY>
  // Without the right key the page says it is off. On the laptop leave
  // DR_PLAYGROUND_KEY out and the page opens without a key, as before.
  PLAYGROUND_KEY: process.env.DR_PLAYGROUND_KEY || '',
};
