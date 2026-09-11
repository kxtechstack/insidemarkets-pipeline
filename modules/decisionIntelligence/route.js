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
 *     userId: string,         required (for chat history ownership)
 *   }
 *
 * Response shape (varies by type -- frontend branches on `type` in the response):
 *   List:      { type: 'list', items: [...] }
 *   Inference: { type: 'inference', report: {...}, sources: [...] }
 *   Decision:  { type: 'decision', report: {...}, sources: [...], chart: base64|null, chartMeta: {...}|null }
 */

const { extractIntent, retrieveForIntent, getAllCompanies } = require('./secRetrieval');
const { generateAnswer } = require('./generateAnswer');
const { retrieveClientData, detectTargetModules } = require('./retrieveClientData');
const { buildListAnswer } = require('./buildListAnswer');
const { generateInferenceAnswer } = require('./generateInferenceAnswer');
const { classifyQuestion } = require('./classifyQuestion');

const {
  createConversation, appendMessage,
  listConversations, loadConversation, deleteConversation,
  getSuggestedQuestions,
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
 * Returns { type: 'inference', report: {...}, sources: [...] }
 */
async function handleInference(question, clientId, industry) {
  const searchResults = await retrieveClientData(question, clientId, industry);
  const { report, sources } = await generateInferenceAnswer(question, searchResults);
  return { type: 'inference', report, sources };
}

/**
 * Handles a 'decision' question: SEC filings + client data.
 * Numeric questions -> verified facts + chart.
 * Framework questions (SWOT/PESTLE/etc.) -> text-based report + sources.
 * Open-ended qualitative questions -> structured JSON report + sources.
 *
 * Returns { type: 'decision', report, sources, chart, chartMeta }
 */
async function handleDecision(question, clientId, industry) {
  const intent = await extractIntent(question, getAllCompanies);

  // SEC retrieval only when a company is named in the question.
  const { chunks, facts } = intent.tickers.length
    ? await retrieveForIntent(question, intent)
    : { chunks: [], facts: [] };

  const { report, sources, chart: autoChart, chartMeta: autoChartMeta } = await generateAnswer(
    question, intent, chunks, facts, clientId, industry
  );

  // Chart priority:
  //   1. Numeric path: chart from verified facts (highest priority)
  //   2. Qualitative path: chart auto-derived from the report's table (if any)
  //   3. No chart: just text
  let chart = autoChart || null;
  let chartMeta = autoChartMeta || null;

  if (!chart && intent.dataType === 'quantitative' && facts.length && intent.isChartable) {
    try {
      const { decideChartFormat, renderChart } = require('./chartPipeline');
      const display = decideChartFormat(intent, facts);
      if (display.format === 'chart') {
        chart = await renderChart(display.chartData);
        chartMeta = { chartType: display.chartType };
      }
    } catch (err) {
      console.log(`[handleDecision] Chart rendering unavailable: ${err.message}`);
    }
  }

  return { type: 'decision', report, sources, chart, chartMeta };
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

      // 4. Dispatch
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
          : (result.report?.title || result.report?.bodyText || '');

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