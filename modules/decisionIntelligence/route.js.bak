/**
 * modules/decisionIntelligence/route.js
 *
 * The real endpoint wiring the whole Decision Intelligence chat together.
 * Exports a function that attaches POST /decision-intelligence/chat onto
 * an existing Express app -- call registerDecisionIntelligenceRoute(app)
 * from server.js, same pattern as the other route groups there.
 *
 * Request body:
 *   {
 *     question: string,       required
 *     clientId: string,       required
 *     industry: string,       required
 *     type?: 'list' | 'inference' | 'decision'   OPTIONAL
 *   }
 *
 * `type` is optional by design (see architecture note below) --
 * when the frontend ALREADY knows the type (a click from the Question
 * Library's 3 tabs), it sends `type` and classifyQuestion() is skipped
 * entirely -- no LLM call, no misclassification risk, since the type is
 * correct by construction. When `type` is omitted (a click on one of the
 * front-page suggested decision cards, or a free-typed question), the
 * classifier runs first to figure out which of the 3 pipelines to use.
 *
 * Response shape (varies by type -- frontend branches on `type` in the response):
 *   List:      { type: 'list', items: [...] }                         (buildListAnswer's shape)
 *   Inference: { type: 'inference', answer: string, sources: [...] }
 *   Decision:  { type: 'decision', answer: string, chart: base64|null, chartMeta: {...}|null }
 */

const { extractIntent, retrieveForIntent, getAllCompanies } = require('./secRetrieval');
const { generateAnswer } = require('./generateAnswer');
// CHANGED: chartPipeline.js is now required LAZILY (only inside
// handleDecision, only when a chart is actually about to be rendered),
// not at module load time. chartjs-node-canvas depends on a native
// `canvas` binary that fails to load on Windows (ERR_DLOPEN_FAILED,
// confirmed) -- requiring it unconditionally at the top of this file
// meant the ENTIRE server (including List/Inference, which never touch
// charts) couldn't even start on a Windows dev machine. Wrapped in
// try/catch below so a chart-rendering failure degrades to a text-only
// decision answer instead of crashing the whole request.
const { retrieveClientData, detectTargetModules } = require('./retrieveClientData');
const { buildListAnswer } = require('./buildListAnswer');
const { generateInferenceAnswer } = require('./generateInferenceAnswer');
const { classifyQuestion } = require('./classifyQuestion');

const {
  createConversation, appendMessage,
  listConversations, loadConversation, deleteConversation,
  getSuggestedQuestions,                       // ← new
} = require('./chatHistory');


/**
 * Handles a 'list' question: client data only, no LLM.
 */
async function handleList(question, clientId, industry) {
  // Scope retrieval to the module(s) the question is about -- a "policy
  // changes" question shouldn't also return Forward Outlook or Market
  // Dynamics signals that happen to match on generic words. Falls back
  // to searching all modules if no keywords match.
  const modules = detectTargetModules(question);
  const searchResults = await retrieveClientData(question, clientId, industry, 10, modules);
  const items = await buildListAnswer(searchResults);
  return { type: 'list', items };
}

/**
 * Handles an 'inference' question: client data + LLM synthesis.
 */
async function handleInference(question, clientId, industry) {
  const searchResults = await retrieveClientData(question, clientId, industry);
  const { answer, sources } = await generateInferenceAnswer(question, searchResults);
  return { type: 'inference', answer, sources };
}

/**
 * Handles a 'decision' question: SEC filings + client data (numeric ->
 * verified facts + chart, qualitative/framework -> LLM grounded in both
 * sources). Open-ended questions with no company named skip SEC
 * retrieval entirely and answer from client data only -- see file header
 * for why (avoids an unscoped, potentially-wrong-company SEC search).
 */
async function handleDecision(question, clientId, industry) {
  const intent = await extractIntent(question, getAllCompanies);

  // NEW: open-ended DI question, no company named -- skip SEC retrieval
  // entirely rather than letting retrieveChunks() run an UNFILTERED
  // search across all 496 companies' filings (ticker=null), which could
  // surface an unrelated company's text and present it as general
  // guidance. Client data is still real and relevant even without an
  // SEC anchor for THIS category of question (unlike the SWOT case
  // tested earlier, where the model correctly refused without a company
  // anchor -- a generic strategy question isn't company-scoped the same
  // way a SWOT explicitly is, so client-only grounding is appropriate
  // here). NOTE: this is a stopgap -- the rich open-ended report
  // template (Outlook/Impact table/chart/Driving Factors/etc.) is still
  // PENDING; this produces a plainer qualitative-prompt answer instead
  // until that template is built.
  if (!intent.tickers.length) {
    const answer = await generateAnswer(question, intent, [], [], clientId, industry);
    return { type: 'decision', answer, chart: null, chartMeta: null, note: 'open_ended_client_only' };
  }

  const { chunks, facts } = await retrieveForIntent(question, intent);
  const answer = await generateAnswer(question, intent, chunks, facts, clientId, industry);

  let chart = null;
  let chartMeta = null;
  try {
    // Lazy require -- see the top-of-file comment for why. If this
    // module can't load (e.g. the Windows/canvas native-binary issue),
    // the catch below just logs it and the answer still returns as
    // text-only, instead of taking down the whole request.
    const { decideChartFormat, renderChart } = require('./chartPipeline');
    const display = decideChartFormat(intent, facts);
    if (display.format === 'chart') {
      chart = await renderChart(display.chartData);
      chartMeta = { chartType: display.chartType };
    }
  } catch (err) {
    console.log(`[handleDecision] Chart rendering unavailable, returning text-only answer: ${err.message}`);
  }

  return { type: 'decision', answer, chart, chartMeta };
}

function registerDecisionIntelligenceRoute(app) {

  // ------------------------------------------------------------------
  // POST /decision-intelligence/chat
  // Saves the user question AND the assistant answer to Supabase,
  // returns the answer plus the conversationId.
  // ------------------------------------------------------------------
  app.post('/decision-intelligence/chat', async (req, res) => {
    try {
      const {
        question, clientId, industry,
        type: providedType,
        conversationId: incomingConversationId,
        userId,
      } = req.body;

      if (!question || !clientId || !industry || !userId) {
        return res.status(400).json({
          error: 'question, clientId, industry, and userId are required',
        });
      }

      // 1. Resolve or create the conversation
      let conversationId = incomingConversationId;
      if (!conversationId) {
        conversationId = await createConversation({
          clientId, userId, firstQuestion: question,
        });
      }

      // 2. Save the user's question
      await appendMessage({
        conversationId,
        role: 'user',
        content: question,
      });

      // 3. Classify (same as before)
      let type = providedType;
      let classifierReasoning = null;
      if (!type) {
        const classification = await classifyQuestion(question);
        type = classification.type;
        classifierReasoning = classification.reasoning;
      } else if (!['list', 'inference', 'decision'].includes(type)) {
        return res.status(400).json({
          error: `Invalid type "${type}" -- must be list, inference, or decision`,
        });
      }

      // 4. Dispatch (same as before)
      let result;
      if (type === 'list') {
        result = await handleList(question, clientId, industry);
      } else if (type === 'inference') {
        result = await handleInference(question, clientId, industry);
      } else {
        result = await handleDecision(question, clientId, industry);
      }

      if (classifierReasoning) result.classifierReasoning = classifierReasoning;

      // 5. Save the assistant's answer
      const contentForSearch =
        result.type === 'list'
          ? `List: ${result.items?.length ?? 0} items`
          : result.answer || '';

      await appendMessage({
        conversationId,
        role: 'assistant',
        content: contentForSearch,
        type: result.type,
        payload: result,
      });

      // 6. Return answer + conversationId
      return res.json({ ...result, conversationId });

    } catch (err) {
      console.error('[DecisionIntelligence] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------------
  // GET /decision-intelligence/conversations?userId=...
  // List this user's chats (for the Previous Chats modal).
  // ------------------------------------------------------------------
  app.get('/decision-intelligence/conversations', async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      const conversations = await listConversations({ userId });
      return res.json({ conversations });
    } catch (err) {
      console.error('[DI listConversations] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------------
  // GET /decision-intelligence/conversations/:id?userId=...
  // Load one conversation + its messages.
  // ------------------------------------------------------------------
  app.get('/decision-intelligence/conversations/:id', async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      const data = await loadConversation({
        conversationId: req.params.id,
        userId,
      });
      return res.json(data);
    } catch (err) {
      console.error('[DI loadConversation] Error:', err.message);
      return res.status(404).json({ error: err.message });
    }
  });

    // ------------------------------------------------------------------
  // GET /decision-intelligence/suggested-questions
  //   ?clientId=...&surface=home|library&category=decision|inference|list
  //   &industry=...&companyName=...
  // ------------------------------------------------------------------
  app.get('/decision-intelligence/suggested-questions', async (req, res) => {
    try {
      const { clientId, surface, category, industry, companyName } = req.query;
      if (!clientId || !surface) {
        return res.status(400).json({ error: 'clientId and surface are required' });
      }
      const questions = await getSuggestedQuestions({
        clientId, surface, category, industry, companyName,
      });
      return res.json({ questions });
    } catch (err) {
      console.error('[DI suggested-questions] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------------
  // DELETE /decision-intelligence/conversations/:id?userId=...
  // ------------------------------------------------------------------
  app.delete('/decision-intelligence/conversations/:id', async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      await deleteConversation({
        conversationId: req.params.id,
        userId,
      });
      return res.json({ success: true });
    } catch (err) {
      console.error('[DI deleteConversation] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerDecisionIntelligenceRoute };