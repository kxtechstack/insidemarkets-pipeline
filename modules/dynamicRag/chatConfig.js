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

  // ── Step 9 (runWorkflow.js) ────────────────────────────────────────────
  // The module ids of the four client-data modules (the same ids the news
  // pipeline saves on every signal and every Qdrant point).
  MODULE_IDS: {
    policy: '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960',      // Policy & Risk
    market: '55c5ee19-bfca-468b-81b3-b89ca4f303c8',      // Market Dynamics
    outlook: '2eb989fd-0ea0-4320-b73a-f7eb8b970473',     // Forward Outlook
    competitor: '5e953748-931d-4212-99e9-08c9a050cfef',  // Competitive Radar
  },
  // The Qdrant collection that holds the text of all four modules.
  SEARCH_COLLECTION: process.env.POLICY_QDRANT_COLLECTION || 'policy_articles',
  // A text piece less similar than this to the search words is not used
  // (0 = unrelated, 1 = the same text). Tuned on real questions.
  MIN_SEARCH_SCORE: Number(process.env.DR_MIN_SEARCH_SCORE) || 0.2,
  // Places and companies are checked on each signal after the search, so
  // a search with them reads this many times more pieces first (40 x 5).
  SEARCH_WIDEN: Number(process.env.DR_SEARCH_WIDEN) || 5,
  // A search reads page after page until it has 20 signals that pass every
  // filter, the rest is too far from the question, or it has read this
  // many text pieces (search by meaning) / signal rows per module (exact read).
  SEARCH_MAX_PIECES: Number(process.env.DR_SEARCH_MAX_PIECES) || 600,
  EXACT_READ_MAX_ROWS: Number(process.env.DR_EXACT_READ_MAX_ROWS) || 1000,
  // A search naming a place or a company first reads which signals are
  // tagged with it (newest first, at most this many per module), and
  // searches by meaning among those.
  TAGGED_MAX_SIGNALS: Number(process.env.DR_TAGGED_MAX_SIGNALS) || 2000,
  // Step 9 part 2 — the AI jobs. Their prompts (public.prompts, DI – 5 … 12):
  JOB_PROMPT_IDS: {
    extract_facts: 'dynamic_rag_job_extract_facts_v1',
    summarise: 'dynamic_rag_job_summarise_v1',
    compare: 'dynamic_rag_job_compare_v1',
    cluster: 'dynamic_rag_job_group_v1',
    identify_patterns: 'dynamic_rag_job_patterns_v1',
    identify_gaps: 'dynamic_rag_job_gaps_v1',
    discover_opportunities: 'dynamic_rag_job_opportunities_v1',
    analyse_risks: 'dynamic_rag_job_risks_v1',
  },
  // letters of a signal's text shown to an AI job (cut at a space). 26 Nov
  // (DB check): 300 cut "store count to 338" to "to 3…" and the AI wrote
  // "Nykaa has 3 offline stores"; the whole saved text is given now.
  AI_ITEM_CHARS: 600,
  AI_MAX_FINDINGS_IN: 20,      // earlier findings given to one AI job
  CLUSTER_AI_MIN: 4,           // grouping asks the AI only when this many items are in no existing group
  ANSWER_AI_CALLS: 1,          // AI calls kept for the answer (Step 10)
  // a point with more sources than this: each source must really be about
  // it (its title shares 2+ words with the point), 26 Nov
  POINT_SOURCES_CHECK_FROM: 6,
  AI_CALL_TIMEOUT_MS: 40000,   // one AI call
  // news about a period that is over may be written this many days after it
  // ends; kept only when its text names the period ("Q3 2026")
  REPORTED_LATER_DAYS: 60,
  // the evidence check says "sufficient" from this many supported points
  MIN_SUPPORTED: 3,
  // Step 10 — the answer. Its prompt (public.prompts, DI – 13. Write the Answer):
  ANSWER_PROMPT_ID: 'dynamic_rag_answer_v1',
  // the fixed words of the answer (written by code, not by the AI)
  ANSWER_TEXT: {
    nothing_found: 'I could not find news in your data that answers this question. The searches below found nothing, so I am not giving an answer that the news does not support.',
    // the searches found news, but none of it answers the question
    nothing_answers: 'The news in your data does not answer this question, so I am not giving an answer that the news does not support.',
    list_intro: 'Here are the {n} news items from your data that match the question, with their sources.',
    list_intro_one: 'Here is the 1 news item from your data that matches the question, with its source.',
    // the AI points did not pass the checks, but news naming the company was found
    named_list_intro: 'I could not write a checked summary, so here are the {n} news items from your data that name it, with their sources.',
    named_list_intro_one: 'I could not write a checked summary, so here is the 1 news item from your data that names it, with its source.',
    no_news_for_heading: 'No news found for this.',
    no_news_cell: 'no news found',
    evidence_title: 'How good the evidence is',
    limits_title: 'Not found or not done',
    sources_title: 'Sources',
    conflicts: 'Some sources give different numbers for the same thing (see the facts)',
    compare_by_code: 'The AI could not write the comparison, so the main news of each side is shown side by side instead',
    compare_by_code_point: 'main news found',
    // the comparison row made by code: how many news items each side's search found
    compare_count_point: 'news items found in your data',
    confidence: {
      good: 'Good evidence: several news items support the main points.',
      some: 'Some evidence: the answer rests on a few news items, so read it with care.',
      not_enough: 'Not enough evidence in your data to answer this.',
    },
  },
  // The whole run of one question may take at most this long.
  RUN_TIME_LIMIT_MS: Number(process.env.DR_RUN_TIME_LIMIT_MS) || 90 * 1000,
  // Letters of a signal's summary passed on to the analysis jobs.
  ITEM_TEXT_CHARS: 600,

  // ── Step 8 (validateWorkflow.js) ───────────────────────────────────────
  // What the user sees when the list of jobs breaks a rule (nothing runs).
  PLAN_FAILED_MESSAGE:
    'I could not put together a safe way to answer this question. Please try asking it in a simpler way, ' +
    'for example one company, market or topic at a time.',
  // true = Step 8 also refuses jobs whose real code (Step 9) is not ready.
  // 25 Nov: every job the planner can use is built; the two that are not
  // (filter_data, forecast) are never planned. Kept off on purpose: if one
  // ever came, Step 9 marks it "not built" (recorded) and the rest of the
  // question is still answered, instead of refusing the whole question.
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
  // Previous Chats in the DI tab: at most this many chats in the list, and
  // this many messages when one chat is opened (chatHistory.js)
  HISTORY_MAX_CHATS: 100,
  HISTORY_MAX_MESSAGES: 200,
};
