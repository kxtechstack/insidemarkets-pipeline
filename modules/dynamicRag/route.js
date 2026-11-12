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
 *   chatConfig.js   settings
 *   chatError.js    a clear error message for the user
 *
 * Reply on success : { ok: true, request_id, conversation_id, status, answer, debug }
 *     status = accept         -> answer is null for now (later steps will fill it)
 *     status = reject         -> answer is a polite message
 *     status = clarification  -> answer is one question back to the user
 * Reply on problem : { ok: false, error: { code, message } }
 *
 * FOR TESTING ONLY (to be switched off before real clients use the chat):
 *   - "debug" in the reply shows what every step produced.
 *   - body.stopAfterStep = 1, 2 or 3 stops the chat after that step, so the
 *     test file can check each step alone (Steps 1 and 2 without the AI).
 */

const { ChatError } = require('./chatError');
const { receiveQuestion } = require('./receiveQuestion');   // Step 1
const { preprocessQuery } = require('./preprocessQuery');   // Step 2
const { validateQuery } = require('./validateQuery');       // Step 3
const { understandQuery } = require('./understandQuery');   // Step 5

function registerDynamicRagRoute(app) {
  app.post('/dynamic-rag/chat', async (req, res) => {
    const startedAt = Date.now();
    const stopAfterStep = Number(req.body && req.body.stopAfterStep) || null;

    try {
      // ── Step 1: receive the question ───────────────────────────────
      const request = await receiveQuestion(req.body);
      console.log(
        `[DynamicRAG] receiveQuestion ok | request=${request.request_id} ` +
        `conversation=${request.conversation_id}${request.is_new_conversation ? ' (new)' : ''} ` +
        `| ${Date.now() - startedAt}ms`
      );

      const reply = (status, answer, debug) => res.json({
        ok: true,
        request_id: request.request_id,
        conversation_id: request.conversation_id,
        status,
        answer,
        debug,
      });

      if (stopAfterStep === 1) {
        return reply('stopped_for_test', null, { receiveQuestion: request });
      }

      // ── Step 2: clean the question (no AI) ─────────────────────────
      const cleaned = await preprocessQuery(request);
      console.log(
        `[DynamicRAG] preprocessQuery ok | changes=${cleaned.corrections_applied.length} ` +
        `dates=${cleaned.time_expressions.length} ` +
        `wordList=${cleaned.word_list_loaded ? 'loaded' : 'NOT loaded'} ` +
        `| ${Date.now() - startedAt}ms`
      );

      if (stopAfterStep === 2) {
        return reply('stopped_for_test', null, { receiveQuestion: request, preprocessQuery: cleaned });
      }

      // ── Step 3: accept / reject / ask back (AI) ────────────────────
      const validation = await validateQuery(cleaned);
      console.log(
        `[DynamicRAG] validateQuery ok | status=${validation.status} label=${validation.ai_label} ` +
        `aiCalls=${validation.attempts} | ${Date.now() - startedAt}ms`
      );

      const debug = { receiveQuestion: request, preprocessQuery: cleaned, validateQuery: validation };

      // Reject or clarification: the chat stops here and replies.
      // (Saving this reply in the chat history comes with Step 10.)
      if (validation.status !== 'accept') {
        return reply(validation.status, validation.message, debug);
      }

      if (stopAfterStep === 3) {
        return reply('accept', null, debug);
      }

      // ── Step 5: understand the question (AI + code checks) ─────────
      const understood = await understandQuery(request, cleaned);
      debug.understandQuery = understood;
      console.log(
        `[DynamicRAG] understandQuery ok | status=${understood.status} goal=${understood.primary_goal} ` +
        `companies=${understood.companies.length} places=${understood.places.length} ` +
        `removed=${understood.removed_by_check.length} aiCalls=${understood.attempts} ` +
        `| ${Date.now() - startedAt}ms`
      );

      if (understood.status === 'clarification') {
        return reply('clarification', understood.message, debug);
      }

      // ── Step 6 onwards will be added here ──────────────────────────

      return reply('accept', null, debug);

    } catch (err) {
      if (err instanceof ChatError) {
        console.log(`[DynamicRAG] stopped: ${err.code} — ${err.message}`);
        return res.status(err.httpStatus).json({
          ok: false,
          error: { code: err.code, message: err.message },
        });
      }

      // Anything else is our bug or a database problem: log the real reason,
      // show the user a plain message.
      console.error('[DynamicRAG] error:', err.message);
      return res.status(500).json({
        ok: false,
        error: { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' },
      });
    }
  });
}

module.exports = { registerDynamicRagRoute };
