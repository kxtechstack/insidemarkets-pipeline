/**
 * modules/decisionIntelligenceV2/route.js
 *
 * V2 HTTP route. Mirrors /decision-intelligence/chat but uses the V2
 * router + handlers. Both V1 and V2 routes coexist — V1 is untouched.
 *
 * Reuses the existing chatHistory for conversation persistence so users
 * keep one unified history when they switch between V1 and V2.
 */

const {
  createConversation,
  appendMessage,
  listConversations,
  loadConversation,
  deleteConversation,
  getSuggestedQuestions,
} = require('../decisionIntelligence/chatHistory');

const { route } = require('./routing/router');
const { retrieveClientSignals } = require('./retrieval/clientSignalsRetrieval');
const { retrieveCustomSourceHits } = require('./retrieval/customSourceRetrieval');
const { buildListItems } = require('./handlers/listHandler');
const { buildInferenceAnswer } = require('./handlers/inferenceHandler');
const { buildDecisionAnswer } = require('./handlers/decisionHandler');
const {
  buildGreetingResponse,
  buildOffTopicResponse,
  buildClarificationResponse,
  buildListResponse,
  buildInferenceResponse,
  buildDecisionResponse,
} = require('./responseBuilder');

// ─────────────────────────────────────────────────────────────────────────
// Pipeline runner — orchestration of router → retrieval → handler
// ─────────────────────────────────────────────────────────────────────────
async function runV2Pipeline({ question, clientId, industry, forcedType }) {
  // 1. Route (unless the frontend forced a type)
  let routerResult;
  if (forcedType) {
    const valid = ['list', 'inference', 'decision'];
    if (!valid.includes(forcedType)) {
      throw new Error(`Invalid forced type "${forcedType}"`);
    }
    routerResult = {
      intent: 'market_intelligence',
      type: forcedType,
      time_constraint: { present: false, value: null, unit: null, phrase: null },
      entity_mentions: [],
      concept_keywords: [],
      is_company_set_query: false,
      primary_intent: question,
      _fallback: false,
    };
  } else {
    routerResult = await route(question, industry);
  }

  // 2. Non market-intelligence short-circuits
  if (routerResult.intent === 'greeting') {
    return {
      routerResult,
      payload: await buildGreetingResponse({ routerResult, clientId, industry }),
    };
  }
  if (routerResult.intent === 'off_topic') {
    return {
      routerResult,
      payload: await buildOffTopicResponse({ routerResult, clientId, industry }),
    };
  }
  if (routerResult.intent === 'clarification') {
    return {
      routerResult,
      payload: await buildClarificationResponse({ routerResult, clientId, industry }),
    };
  }

  // 3. Market intelligence — retrieve once (client + custom)
  const [clientRetr, customHits] = await Promise.all([
    retrieveClientSignals(question, clientId, industry, {
      precomputedUnderstanding: routerResult,
    }),
    retrieveCustomSourceHits(question, clientId),
  ]);

  // 4. Dispatch to handler
  let handlerResult;
  if (routerResult.type === 'list') {
    handlerResult = await buildListItems(clientRetr.hits);
    const payload = await buildListResponse({ handlerResult, clientId, industry });
    return { routerResult, handlerResult, payload };
  }

  if (routerResult.type === 'inference') {
    handlerResult = await buildInferenceAnswer(question, clientRetr.hits, customHits);
    const payload = await buildInferenceResponse({ handlerResult, clientId });
    return { routerResult, handlerResult, payload };
  }

  // decision
  handlerResult = await buildDecisionAnswer(question, clientRetr.hits, customHits);
  const payload = await buildDecisionResponse({ handlerResult, clientId });
  return { routerResult, handlerResult, payload };
}

// ─────────────────────────────────────────────────────────────────────────
// Route registration
// ─────────────────────────────────────────────────────────────────────────
function registerDecisionIntelligenceV2Route(app) {
  app.post('/decision-intelligence-v2/chat', async (req, res) => {
    try {
      const {
        question,
        clientId,
        industry,
        userId,
        conversationId: incomingConversationId,
        type: providedType,
      } = req.body;

      if (!question || !clientId || !industry || !userId) {
        return res.status(400).json({
          error: 'question, clientId, industry, and userId are required',
        });
      }

      // Create or resume conversation
      let conversationId = incomingConversationId;
      if (!conversationId) {
        conversationId = await createConversation({
          clientId,
          userId,
          firstQuestion: question,
        });
      }

      await appendMessage({ conversationId, role: 'user', content: question });

      // Run the pipeline
      let result;
      try {
        result = await runV2Pipeline({
          question,
          clientId,
          industry,
          forcedType: providedType || null,
        });
      } catch (err) {
        console.error('[V2 pipeline] error:', err.message);
        return res.status(500).json({ error: err.message });
      }

      const { payload, routerResult } = result;

      // Persist assistant message
      const assistantContent =
        payload.type === 'list'
          ? `List: ${payload.items?.length ?? 0} items`
          : (payload.report?.title || '').slice(0, 200);

      try {
        await appendMessage({
          conversationId,
          role: 'assistant',
          content: assistantContent,
          type: payload.type,
          payload,
        });
      } catch (err) {
        console.log(`[V2 route] failed to persist assistant message: ${err.message}`);
      }

      // Response
      return res.json({
        ...payload,
        conversationId,
        classifierReasoning: routerResult.primary_intent || null,
      });

    } catch (err) {
      console.error('[DecisionIntelligenceV2] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Conversation endpoints — reuse same tables as V1 ──────────────────
  app.get('/decision-intelligence-v2/conversations', async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      const conversations = await listConversations({ userId });
      return res.json({ conversations });
    } catch (err) {
      console.error('[DI V2 listConversations] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/decision-intelligence-v2/conversations/:id', async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      const data = await loadConversation({
        conversationId: req.params.id,
        userId,
      });
      return res.json(data);
    } catch (err) {
      console.error('[DI V2 loadConversation] Error:', err.message);
      return res.status(404).json({ error: err.message });
    }
  });

  app.delete('/decision-intelligence-v2/conversations/:id', async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      await deleteConversation({
        conversationId: req.params.id,
        userId,
      });
      return res.json({ success: true });
    } catch (err) {
      console.error('[DI V2 deleteConversation] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/decision-intelligence-v2/suggested-questions', async (req, res) => {
    try {
      const { clientId, surface, category, industry, companyName } = req.query;
      if (!clientId || !surface) {
        return res.status(400).json({ error: 'clientId and surface are required' });
      }
      const questions = await getSuggestedQuestions({
        clientId,
        surface,
        category,
        industry,
        companyName,
      });
      return res.json({ questions });
    } catch (err) {
      console.error('[DI V2 suggested-questions] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerDecisionIntelligenceV2Route, runV2Pipeline };