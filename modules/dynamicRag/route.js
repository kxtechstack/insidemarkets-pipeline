/**
 * modules/dynamicRag/route.js
 *
 * The API door of the Decision Intelligence chat.
 *
 *   POST /dynamic-rag/chat
 *   body: { question, clientId, userId, conversationId? }
 *
 * It only calls the step files in order. Which file is which step of the
 * manager's doc:
 *
 *   Step 1  receiveQuestion.js   take the question, check the user, save it
 *   Step 2  preprocessQuery.js   clean the question text (no AI)
 *   Step 3  validateQuery.js     accept / reject / ask the user back (AI)
 *   Step 4  (skipped for now)    remembering earlier questions in the chat
 *   Step 5  understandQuery.js   goals, companies, places, dates... (AI + code checks)
 *   Step 6+ not built yet
 *
 * Helpers (not steps):
 *   chatConfig.js        settings
 *   chatError.js         a clear error message for the user
 *   chatPlayground.html  test page that shows what every step did
 *
 * Reply on success : { ok: true, request_id, conversation_id, status, answer, debug }
 *     status = accept         -> answer is null for now (later steps will fill it)
 *     status = reject         -> answer is a polite message
 *     status = clarification  -> answer is one question back to the user
 * Reply on problem : { ok: false, error: { code, message }, failed_step, debug }
 *
 * FOR TESTING ONLY (to be switched off before real clients use the chat):
 *   - "debug" in the reply shows what every step produced, and
 *     debug.timings how long each step took (milliseconds).
 *   - body.stopAfterStep = 1, 2 or 3 stops the chat after that step, so the
 *     test file can check each step alone (Steps 1 and 2 without the AI).
 *   - GET /dynamic-rag/playground opens the playground page, only when the
 *     .env file has DR_PLAYGROUND=on.
 */

const path = require('path');
const { ChatError } = require('./chatError');
const { PLAYGROUND_ON } = require('./chatConfig');
const { receiveQuestion } = require('./receiveQuestion');   // Step 1
const { preprocessQuery } = require('./preprocessQuery');   // Step 2
const { validateQuery } = require('./validateQuery');       // Step 3
const { understandQuery } = require('./understandQuery');   // Step 5

function registerDynamicRagRoute(app) {
  // ── Test page: type a question, see every step ─────────────────────────
  app.get('/dynamic-rag/playground', (req, res) => {
    if (!PLAYGROUND_ON) {
      return res.status(404).send('The playground is off. Add DR_PLAYGROUND=on to the .env file and restart the server.');
    }
    return res.sendFile(path.join(__dirname, 'chatPlayground.html'));
  });

  // ── The chat ───────────────────────────────────────────────────────────
  app.post('/dynamic-rag/chat', async (req, res) => {
    const startedAt = Date.now();
    const stopAfterStep = Number(req.body && req.body.stopAfterStep) || null;

    // What every step produced, and how long it took. Filled in as we go,
    // so on an error we can still show the steps that worked.
    const debug = { timings: {} };
    let currentStep = 'receiveQuestion';
    let stepStartedAt = Date.now();
    const stepDone = (name, result) => {
      debug[name] = result;
      debug.timings[name] = Date.now() - stepStartedAt;
      stepStartedAt = Date.now();
    };

    try {
      // ── Step 1: receive the question ───────────────────────────────
      const request = await receiveQuestion(req.body);
      stepDone('receiveQuestion', request);
      console.log(
        `[DynamicRAG] receiveQuestion ok | request=${request.request_id} ` +
        `conversation=${request.conversation_id}${request.is_new_conversation ? ' (new)' : ''} ` +
        `| ${Date.now() - startedAt}ms`
      );

      const reply = (status, answer) => {
        debug.timings.total = Date.now() - startedAt;
        return res.json({
          ok: true,
          request_id: request.request_id,
          conversation_id: request.conversation_id,
          status,
          answer,
          debug,
        });
      };

      if (stopAfterStep === 1) return reply('stopped_for_test', null);

      // ── Step 2: clean the question (no AI) ─────────────────────────
      currentStep = 'preprocessQuery';
      const cleaned = await preprocessQuery(request);
      stepDone('preprocessQuery', cleaned);
      console.log(
        `[DynamicRAG] preprocessQuery ok | changes=${cleaned.corrections_applied.length} ` +
        `dates=${cleaned.time_expressions.length} ` +
        `wordList=${cleaned.word_list_loaded ? 'loaded' : 'NOT loaded'} ` +
        `| ${Date.now() - startedAt}ms`
      );

      if (stopAfterStep === 2) return reply('stopped_for_test', null);

      // ── Step 3: accept / reject / ask back (AI) ────────────────────
      currentStep = 'validateQuery';
      const validation = await validateQuery(cleaned);
      stepDone('validateQuery', validation);
      console.log(
        `[DynamicRAG] validateQuery ok | status=${validation.status} label=${validation.ai_label} ` +
        `aiCalls=${validation.attempts} | ${Date.now() - startedAt}ms`
      );

      // Reject or clarification: the chat stops here and replies.
      // (Saving this reply in the chat history comes with Step 10.)
      if (validation.status !== 'accept') return reply(validation.status, validation.message);

      if (stopAfterStep === 3) return reply('accept', null);

      // ── Step 5: understand the question (AI + code checks) ─────────
      currentStep = 'understandQuery';
      const understood = await understandQuery(request, cleaned);
      stepDone('understandQuery', understood);
      console.log(
        `[DynamicRAG] understandQuery ok | status=${understood.status} goal=${understood.primary_goal} ` +
        `companies=${understood.companies.length} places=${understood.places.length} ` +
        `removed=${understood.removed_by_check.length} aiCalls=${understood.attempts} ` +
        `| ${Date.now() - startedAt}ms`
      );

      if (understood.status === 'clarification') return reply('clarification', understood.message);

      // ── Step 6 onwards will be added here ──────────────────────────

      return reply('accept', null);

    } catch (err) {
      debug.timings.total = Date.now() - startedAt;

      if (err instanceof ChatError) {
        console.log(`[DynamicRAG] stopped at ${currentStep}: ${err.code} — ${err.message}`);
        return res.status(err.httpStatus).json({
          ok: false,
          error: { code: err.code, message: err.message },
          failed_step: currentStep,
          debug,
        });
      }

      // Anything else is our bug or a database problem: log the real reason,
      // show the user a plain message.
      console.error(`[DynamicRAG] error at ${currentStep}:`, err.message);
      return res.status(500).json({
        ok: false,
        error: { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' },
        failed_step: currentStep,
        debug,
      });
    }
  });
}

module.exports = { registerDynamicRagRoute };
