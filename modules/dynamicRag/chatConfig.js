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

  // ── Test tools ─────────────────────────────────────────────────────────
  // The chat playground page (/dynamic-rag/playground) shows what every
  // step did with a question. Only for testing on our own laptop: it opens
  // only when the .env file has DR_PLAYGROUND=on. Keep it OFF on the live
  // server.
  PLAYGROUND_ON: process.env.DR_PLAYGROUND === 'on',
};
