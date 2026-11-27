/**
 * modules/dynamicRag/route.js
 *
 * The API door of the Decision Intelligence chat.
 *
 *   POST /dynamic-rag/chat
 *   header: Authorization: Bearer <Supabase login token>   (the dashboard's DI tab)
 *   body: { question, conversationId? }
 *   Who is asking (client + user) comes from the login token, never from
 *   the body (chatAccess.js). Only test tools (playground, test file) may
 *   send clientId / userId in the body - see chatAccess.js.
 *   The chat list, one chat, delete and suggested questions: chatHistory.js.
 *
 * It only calls the step files in order. Which file is which step of the
 * manager's doc:
 *
 *   Step 1  receiveQuestion.js   take the question, check the user, save it
 *   Step 2  preprocessQuery.js   clean the question text (no AI)
 *   Step 3  validateQuery.js     accept / reject / ask the user back (AI)
 *   Step 4  (skipped for now)    remembering earlier questions in the chat
 *   Step 5  understandQuery.js   goals, companies, places, dates... (AI + code checks)
 *   Step 6  planTasks.js         work plan: what info each goal needs + what analysis (AI + code checks)
 *   Step 7  buildWorkflow.js     the numbered list of jobs (searches + analysis), in order (AI + code)
 *   Step 8  validateWorkflow.js  checks that list before anything runs; approved list + run order (code only)
 *   Step 9  runWorkflow.js       runs the jobs: the searches, then the AI jobs (code + AI)
 *   Step 10 generateAnswer.js    the answer the user reads, with sources (code + one AI call), saved in dr_messages
 *
 * Helpers (not steps):
 *   capabilityRegistry.js the job list the planner may use (Steps 6-9)
 *   chatConfig.js        settings
 *   chatError.js         a clear error message for the user
 *   chatPlayground.html  test page that shows what every step did
 *   chatTracing.js       sends a step-by-step record of each question to
 *                        Phoenix (only when .env has PHOENIX_COLLECTOR_ENDPOINT)
 *
 * Reply on success : { ok: true, request_id, conversation_id, status, answer, answer_details, debug }
 *     status = accept         -> answer is the whole answer (markdown); answer_details its parts,
 *                                sources, evidence and limits (null when a test stops early)
 *     status = reject         -> answer is a polite message
 *     status = clarification  -> answer is one question back to the user
 * Reply on problem : { ok: false, error: { code, message }, failed_step, debug }
 *
 * FOR TEST TOOLS ONLY (a real user with a login token never gets these):
 *   - "debug" in the reply shows what every step produced, and
 *     debug.timings how long each step took (milliseconds).
 *   - body.stopAfterStep = 1, 2, 3, 5, 6 or 7 stops the chat after that step, so the
 *     test file can check each step alone (Steps 1 and 2 without the AI).
 *   - GET /dynamic-rag/playground opens the playground page, only when the
 *     .env file has DR_PLAYGROUND=on (and, on the test server, with
 *     ?key=<DR_PLAYGROUND_KEY> in the link).
 */

const path = require('path');
const { ChatError } = require('./chatError');
const { PLAYGROUND_ON, PLAYGROUND_KEY, PLAN_FAILED_MESSAGE } = require('./chatConfig');
const { receiveQuestion } = require('./receiveQuestion');   // Step 1
const { preprocessQuery } = require('./preprocessQuery');   // Step 2
const { validateQuery } = require('./validateQuery');       // Step 3
const { understandQuery } = require('./understandQuery');   // Step 5
const { planTasks } = require('./planTasks');               // Step 6
const { buildWorkflow } = require('./buildWorkflow');       // Step 7
const { validateWorkflow } = require('./validateWorkflow'); // Step 8
const { runWorkflow } = require('./runWorkflow');           // Step 9 (the searches and the AI jobs)
const { generateAnswer, saveAnswer } = require('./generateAnswer'); // Step 10 (the answer)
const { traceChat, traceStep, traceChatResult } = require('./chatTracing'); // Phoenix records (off unless PHOENIX_COLLECTOR_ENDPOINT is set)
const { whoIsAsking } = require('./chatAccess');                // who is asking: the login token (test tools: playground key)
const { registerChatHistoryRoutes } = require('./chatHistory'); // chat list, one chat, delete, suggested questions

function registerDynamicRagRoute(app) {
  // ── Test page: type a question, see every step ─────────────────────────
  app.get('/dynamic-rag/playground', (req, res) => {
    // off, or (on the test server) the secret key in the link is missing/wrong:
    // the same answer, so nobody can tell the page exists
    if (!PLAYGROUND_ON || (PLAYGROUND_KEY && req.query.key !== PLAYGROUND_KEY)) {
      return res.status(404).send('The playground is off. Add DR_PLAYGROUND=on to the .env file and restart the server.');
    }
    return res.sendFile(path.join(__dirname, 'chatPlayground.html'));
  });

  // ── The chat ───────────────────────────────────────────────────────────
  // traceChat makes one Phoenix record per question (does nothing when off).
  app.post('/dynamic-rag/chat', (req, res) => traceChat(req.body, () => handleChat(req, res)));

  // ── Previous Chats + suggested questions for the DI tab ───────────────
  registerChatHistoryRoutes(app);
}

async function handleChat(req, res) {
  const startedAt = Date.now();
  // set once we know who is asking: only a test tool may stop early or see "debug"
  let stopAfterStep = null;
  let isTest = false;

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
    // ── Who is asking: the login token (never the client / user the screen sends) ──
    currentStep = 'login';
    const who = await whoIsAsking(req);
    isTest = who.test;
    if (isTest) stopAfterStep = Number(req.body && req.body.stopAfterStep) || null;
    const body = { ...(req.body || {}), clientId: who.clientId, userId: who.userId };
    currentStep = 'receiveQuestion';
    stepStartedAt = Date.now();

    // ── Step 1: receive the question ───────────────────────────────
    const request = await traceStep('Step 1 – receiveQuestion', body, () => receiveQuestion(body));
    stepDone('receiveQuestion', request);
    console.log(
      `[DynamicRAG] receiveQuestion ok | request=${request.request_id} ` +
      `conversation=${request.conversation_id}${request.is_new_conversation ? ' (new)' : ''} ` +
      `| ${Date.now() - startedAt}ms`
    );

    const reply = async (status, answer, details = null) => {
      debug.timings.total = Date.now() - startedAt;
      traceChatResult(status, answer, request.conversation_id);
      // a reject, a question back or a refused plan is saved as the chat's
      // reply too (the answer of Step 10 saves itself)
      if (!details && answer && typeof answer === 'string' && status !== 'stopped_for_test') {
        await saveAnswer(request, status, answer, null);
      }
      return res.json({
        ok: true,
        request_id: request.request_id,
        conversation_id: request.conversation_id,
        status,
        answer,
        // Step 10: the parts, sources, evidence and limits of the answer (for the screen)
        answer_details: details ? {
          status: details.status, summary: details.summary, sections: details.sections, confidence: details.confidence,
          limits: details.limits, sources: details.sources,
          // 27 Nov: the news found but not used in the answer (the screen: one closed line)
          other_sources: details.other_sources || [],
          // the answer without the Sources block, source numbers as #source-N links (26 Nov)
          body: details.body || null,
        } : null,
        ...(isTest ? { debug } : {}),
      });
    };

    if (stopAfterStep === 1) return reply('stopped_for_test', null);

    // ── Step 2: clean the question (no AI) ─────────────────────────
    currentStep = 'preprocessQuery';
    const cleaned = await traceStep('Step 2 – preprocessQuery', request, () => preprocessQuery(request));
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
    const validation = await traceStep('Step 3 – validateQuery', cleaned, () => validateQuery(cleaned, { clientId: request.client_id }));
    stepDone('validateQuery', validation);
    console.log(
      `[DynamicRAG] validateQuery ok | status=${validation.status} label=${validation.ai_label} ` +
      `aiCalls=${validation.attempts} | ${Date.now() - startedAt}ms`
    );

    // Reject or clarification: the chat stops here and replies.
    // (This reply is saved in the chat history by reply().)
    if (validation.status !== 'accept') return reply(validation.status, validation.message);

    if (stopAfterStep === 3) return reply('accept', null);

    // ── Step 5: understand the question (AI + code checks) ─────────
    currentStep = 'understandQuery';
    const understood = await traceStep('Step 5 – understandQuery', { request, cleaned }, () => understandQuery(request, cleaned));
    stepDone('understandQuery', understood);
    console.log(
      `[DynamicRAG] understandQuery ok | status=${understood.status} goal=${understood.primary_goal} ` +
      `companies=${understood.companies.length} places=${understood.places.length} ` +
      `removed=${understood.removed_by_check.length} aiCalls=${understood.attempts} ` +
      `| ${Date.now() - startedAt}ms`
    );

    if (understood.status === 'clarification') return reply('clarification', understood.message);

    if (stopAfterStep === 5) return reply('accept', null);

    // ── Step 6: work plan (AI + code checks) ───────────────────────
    currentStep = 'planTasks';
    const plan = await traceStep('Step 6 – planTasks', { cleaned, understood }, () => planTasks(cleaned, understood));
    stepDone('planTasks', plan);
    console.log(
      `[DynamicRAG] planTasks ok | goals=${plan.objectives.join(',')} requirements=${plan.requirements.length} ` +
      `analysis=${plan.analysis_required.join(',')} addedByCode=${plan.requirements.filter((r) => r.added_by_code).length} ` +
      `removed=${plan.removed_by_check.length} aiCalls=${plan.attempts} | ${Date.now() - startedAt}ms`
    );

    if (stopAfterStep === 6) return reply('accept', null);

    // ── Step 7: the list of jobs, in order (AI + code) ─────────────
    currentStep = 'buildWorkflow';
    const aiCallsSoFar = (validation.attempts || 0) + (understood.attempts || 0) + (plan.attempts || 0);
    const workflow = await traceStep('Step 7 – buildWorkflow', { cleaned, understood, plan },
      () => buildWorkflow(cleaned, understood, plan, { aiCallsSoFar }));
    stepDone('buildWorkflow', workflow);
    console.log(
      `[DynamicRAG] buildWorkflow ok | jobs=${workflow.counts.tasks} searches=${workflow.counts.searches} ` +
      `aiJobs=${workflow.counts.ai_jobs}/${workflow.ai_budget} leftOut=${workflow.goals_left_out.length} ` +
      `builtByCode=${workflow.built_by_code} aiCalls=${workflow.attempts} | ${Date.now() - startedAt}ms`
    );

    if (stopAfterStep === 7) return reply('accept', null);

    // ── Step 8: check the list of jobs before anything runs (code) ──
    currentStep = 'validateWorkflow';
    const checkedPlan = await traceStep('Step 8 – validateWorkflow', { workflow, understood, plan },
      async () => validateWorkflow(workflow, understood, plan));
    stepDone('validateWorkflow', checkedPlan);
    console.log(
      `[DynamicRAG] validateWorkflow ${checkedPlan.status} | problems=${checkedPlan.problems.length} ` +
      `batches=${checkedPlan.batches.length} notReady=${checkedPlan.not_ready.length} | ${Date.now() - startedAt}ms`
    );
    if (checkedPlan.status !== 'approved') {
      console.log(`[DynamicRAG] plan refused: ${checkedPlan.problems.join(' | ')}`);
      return reply('plan_failed', PLAN_FAILED_MESSAGE);
    }

    if (stopAfterStep === 8) return reply('accept', null);

    // ── Step 9: run the jobs (the searches, then the AI jobs) ──────
    // The client is the logged-in client from Step 1, never from the plan.
    currentStep = 'runWorkflow';
    const run = await traceStep('Step 9 – runWorkflow', { checkedPlan, workflow },
      () => runWorkflow(checkedPlan, workflow, understood, request));
    stepDone('runWorkflow', run);
    console.log(
      `[DynamicRAG] runWorkflow ${run.status} | done=${run.counts.done} failed=${run.counts.failed} ` +
      `blocked=${run.counts.blocked} skipped=${run.counts.skipped} notBuilt=${run.counts.not_built} signals=${run.counts.signals} ` +
      `aiCalls=${run.ai.used}/${run.ai.budget} ` +
      `| ${Date.now() - startedAt}ms`
    );

    if (stopAfterStep === 9) return reply('accept', null);

    // ── Step 10: the answer the user reads (code + one AI call) ────
    currentStep = 'generateAnswer';
    const answer = await traceStep('Step 10 – generateAnswer', { run },
      () => generateAnswer(run, workflow, understood, request));
    stepDone('generateAnswer', answer);
    console.log(
      `[DynamicRAG] generateAnswer ${answer.status} | evidence=${answer.confidence.level} by=${answer.summary_by} ` +
      `sources=${answer.sources.length} aiCalls=${answer.ai_calls} check=${answer.check.passed} saved=${answer.saved} ` +
      `| ${Date.now() - startedAt}ms`
    );

    return reply('accept', answer.answer_text, answer);

  } catch (err) {
    debug.timings.total = Date.now() - startedAt;

    if (err instanceof ChatError) {
      console.log(`[DynamicRAG] stopped at ${currentStep}: ${err.code} — ${err.message}`);
      traceChatResult(`stopped: ${err.code}`, err.message);
      return res.status(err.httpStatus).json({
        ok: false,
        error: { code: err.code, message: err.message },
        failed_step: currentStep,
        ...(isTest ? { debug } : {}),
      });
    }

    // Anything else is our bug or a database problem: log the real reason,
    // show the user a plain message.
    console.error(`[DynamicRAG] error at ${currentStep}:`, err.message);
    traceChatResult('error', err.message);
    return res.status(500).json({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' },
      failed_step: currentStep,
      ...(isTest ? { debug } : {}),
    });
  }
}

module.exports = { registerDynamicRagRoute };
