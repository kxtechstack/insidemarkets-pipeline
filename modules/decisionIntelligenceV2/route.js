/**
 * modules/decisionIntelligenceV2/route.js
 *
 * V2 HTTP route. All three question types (list / inference / decision)
 * use the same deterministic concept-matching filter. No LLM filter.
 *
 * LIST pipeline:
 *   router → client-signal retrieval → deterministic filter → list handler
 *   (client signals only — no custom sources)
 *
 * INFERENCE / DECISION pipeline:
 *   router → client + custom retrieval → deterministic filter → handler
 *   (custom sources always kept)
 *
 * Reuses the existing chatHistory for conversation persistence.
 *
 * ALSO registers /decision-intelligence-v2/chat-with-memory — the
 * chatContext-wrapped variant that runs the resolver before the pipeline
 * and the state updater after. The existing /chat route is untouched.
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
const { filterListHits, normalizeConcepts, containsPhrase } = require('./retrieval/filterListHits');
const { buildListItems } = require('./handlers/listHandler');
const { buildInferenceAnswer } = require('./handlers/inferenceHandler');
const { buildDecisionAnswer } = require('./handlers/decisionHandler');
const { buildSecAnswer } = require('./handlers/secHandler');
const { evaluateConfidence } = require('./handlers/confidenceGate');
const {
  buildGreetingResponse,
  buildOffTopicResponse,
  buildClarificationResponse,
  buildListResponse,
  buildInferenceResponse,
  buildDecisionResponse,
} = require('./responseBuilder');

// chatContext layer
const { resolveContext } = require('./chatContext/contextResolver');
const { updateState } = require('./chatContext/stateUpdater');
const { loadState } = require('./chatContext/stateStore');

// ─────────────────────────────────────────────────────────────────────────
// Deterministic filter for inference / decision.
// ─────────────────────────────────────────────────────────────────────────
function filterForInferenceOrDecision(clientHits, concepts) {
  const clean = normalizeConcepts(concepts);
  if (clean.length === 0) return clientHits;

  return clientHits.filter((h) => {
    const haystack = `${h.title || ''} ${h.chunk_text || ''}`;
    return clean.some((c) => containsPhrase(haystack, c));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Pipeline runner
// ─────────────────────────────────────────────────────────────────────────
async function runV2Pipeline({ question, clientId, industry, forcedType }) {
  // ── 1. Route ────────────────────────────────────────────────────────
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
      sector_term: null,
      is_company_set_query: false,
      primary_intent: question,
      _fallback: false,
    };
  } else {
    routerResult = await route(question, industry);
  }

  // ── 1.5 SEC pre-check ───────────────────────────────────────────────
  let secResult = null;
  if (routerResult.intent === 'market_intelligence') {
    try {
      secResult = await buildSecAnswer({
        question,
        routerResult,
        clientId,
        industry,
      });
    } catch (err) {
      console.log(`[V2 route] SEC handler threw, falling through: ${err.message}`);
      secResult = null;
    }
  }

  if (secResult && secResult.mode === 'numeric' && secResult.payload) {
    console.log(`[V2 route] SEC numeric answer returned directly`);
    return {
      routerResult,
      handlerResult: secResult.handlerResult || secResult.payload,
      payload: secResult.payload,
    };
  }

  if (secResult && secResult.mode === 'region_fallback' && secResult.payload) {
    console.log(`[V2 route] SEC region fallback returned directly (type=${secResult.payload.type})`);
    return {
      routerResult,
      handlerResult: secResult.payload,
      payload: secResult.payload,
    };
  }

  const secInjectChunks = (secResult && secResult.mode === 'framework' && Array.isArray(secResult.injectChunks))
    ? secResult.injectChunks
    : [];

  // ── 2. Non market-intelligence short-circuits ───────────────────────
  if (routerResult.intent === 'greeting') {
    return { routerResult, payload: await buildGreetingResponse({ routerResult, clientId, industry }) };
  }
  if (routerResult.intent === 'off_topic') {
    return { routerResult, payload: await buildOffTopicResponse({ routerResult, clientId, industry }) };
  }
  if (routerResult.intent === 'clarification') {
    return { routerResult, payload: await buildClarificationResponse({ routerResult, clientId, industry }) };
  }

  // ── 3. LIST — deterministic, client signals only ────────────────────
  if (routerResult.type === 'list') {
    const clientRetr = await retrieveClientSignals(question, clientId, industry, {
      precomputedUnderstanding: routerResult,
    });

    const conceptsForFilter = [
      ...(routerResult.concept_keywords || []),
      ...(routerResult.entity_mentions || []),
    ];

    const filtered = filterListHits(clientRetr.hits, conceptsForFilter);

    console.log(
      `[V2 route] list filter: kept ${filtered.length}/${clientRetr.hits.length} ` +
      `(concepts=[${conceptsForFilter.join(', ')}])`
    );

    if (filtered.length === 0) {
      const payload = await buildListResponse({
        handlerResult: { items: [] },
        clientId,
        industry,
      });
      return { routerResult, handlerResult: { items: [] }, payload };
    }

    const handlerResult = await buildListItems(filtered);
    const payload = await buildListResponse({ handlerResult, clientId, industry });
    return { routerResult, handlerResult, payload };
  }

  // ── 4. INFERENCE / DECISION — full retrieval + deterministic filter ─
  const [clientRetr, customHits] = await Promise.all([
    retrieveClientSignals(question, clientId, industry, {
      precomputedUnderstanding: routerResult,
    }),
    retrieveCustomSourceHits(question, clientId),
  ]);

  const conceptsForFilter = [
    ...(routerResult.concept_keywords || []),
    ...(routerResult.entity_mentions || []),
  ];

  const isFrameworkQuestion = /\b(swot|pestle|pestel|five\s*forces|5\s*forces|porter|risk\s*analysis|risk\s*categor)/i.test(question);

  const keptClient = isFrameworkQuestion
    ? clientRetr.hits
    : filterForInferenceOrDecision(clientRetr.hits, conceptsForFilter);

  const keptCustom = customHits;

  const keptClientWithSec = secInjectChunks.length
    ? [...secInjectChunks, ...keptClient]
    : keptClient;

  const materialCount = routerResult.type === 'decision'
    ? keptClientWithSec.length + keptCustom.length
    : keptClient.length + keptCustom.length;
  const hasMaterial = materialCount > 0;

  console.log(
    `[V2 route] ${routerResult.type} filter: kept client=${keptClient.length}/${clientRetr.hits.length} ` +
    `sec=${secInjectChunks.length} custom=${keptCustom.length} (concepts=[${conceptsForFilter.join(', ')}])`
  );

  // ── Confidence gate ─────────────────────────────────────────────────
  // Runs for inference and decision. Skipped when:
  //   - SEC framework chunks were injected (SEC-side authority)
  //   - hasMaterial is false (handled below as no_data anyway)
  if (hasMaterial && secInjectChunks.length === 0) {
    const gate = evaluateConfidence({
      clientHits: keptClient,
      customHits: keptCustom,
      routerResult,
    });
    if (!gate.pass) {
      console.log(`[V2 route] confidence gate BLOCKED — ${gate.reason}`);
      if (routerResult.type === 'inference') {
        const payload = await buildInferenceResponse({
          handlerResult: { _empty: true, _reason: 'retrieved context is not confident enough to answer this question' },
          clientId,
        });
        return { routerResult, payload };
      }
      const payload = await buildDecisionResponse({
        handlerResult: { _empty: true, _reason: 'retrieved context is not confident enough to answer this question' },
        clientId,
      });
      return { routerResult, payload };
    }
    console.log(`[V2 route] confidence gate PASSED — ${gate.reason}`);
  }

  if (!hasMaterial) {
    if (routerResult.type === 'inference') {
      const payload = await buildInferenceResponse({
        handlerResult: { _empty: true, _reason: 'no relevant content matched this question' },
        clientId,
      });
      return { routerResult, payload };
    }
    const payload = await buildDecisionResponse({
      handlerResult: { _empty: true, _reason: 'no relevant content matched this question' },
      clientId,
    });
    return { routerResult, payload };
  }

  if (routerResult.type === 'inference') {
    const handlerResult = await buildInferenceAnswer(question, keptClient, keptCustom);
    const payload = await buildInferenceResponse({ handlerResult, clientId });
    return { routerResult, handlerResult, payload };
  }

  const handlerResult = await buildDecisionAnswer(question, keptClientWithSec, keptCustom);
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

      let conversationId = incomingConversationId;
      if (!conversationId) {
        conversationId = await createConversation({
          clientId,
          userId,
          firstQuestion: question,
        });
      }

      await appendMessage({ conversationId, role: 'user', content: question });

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

  // ───────────────────────────────────────────────────────────────────────
  // chatContext-wrapped chat.
  // ───────────────────────────────────────────────────────────────────────
  app.post('/decision-intelligence-v2/chat-with-memory', async (req, res) => {
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

      let conversationId = incomingConversationId;
      if (!conversationId) {
        conversationId = await createConversation({
          clientId,
          userId,
          firstQuestion: question,
        });
      }

      let currentState = {};
      try {
        currentState = await loadState(conversationId);
      } catch (err) {
        console.log(`[chat-with-memory] loadState failed: ${err.message}`);
      }

      await appendMessage({ conversationId, role: 'user', content: question });

      let resolverResult;
      try {
        resolverResult = await resolveContext({
          conversationId,
          userMessage: question,
          currentState,
        });
      } catch (err) {
        console.log(`[chat-with-memory] resolver threw, using raw question: ${err.message}`);
        resolverResult = {
          kind: 'new_question',
          standalone_query: question,
          references: [],
          context_used: [],
          new_constraints: [],
          _fallback: true,
        };
      }

      const skipStateUpdate =
        resolverResult.kind === 'greeting' ||
        resolverResult.kind === 'off_topic' ||
        resolverResult.kind === 'clarification';

      const queryForPipeline = skipStateUpdate
        ? question
        : resolverResult.standalone_query;

      console.log(
        `[chat-with-memory] kind=${resolverResult.kind} ` +
        `skipUpdater=${skipStateUpdate} ` +
        `query="${queryForPipeline.slice(0, 120)}"`
      );

      let result;
      try {
        result = await runV2Pipeline({
          question: queryForPipeline,
          clientId,
          industry,
          forcedType: providedType || null,
        });
      } catch (err) {
        console.error('[chat-with-memory] pipeline error:', err.message);
        return res.status(500).json({ error: err.message });
      }

      const { payload, routerResult } = result;

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
        console.log(`[chat-with-memory] failed to persist assistant message: ${err.message}`);
      }

      let finalState = currentState;
      if (!skipStateUpdate) {
        try {
          const updaterResult = await updateState({
            conversationId,
            userMessage: queryForPipeline,
            answer: assistantContent,
            currentState,
          });
          finalState = updaterResult.updatedState;
        } catch (err) {
          console.log(`[chat-with-memory] state updater failed: ${err.message}`);
        }
      }

      return res.json({
        ...payload,
        conversationId,
        classifierReasoning: routerResult.primary_intent || null,
        resolver: {
          kind: resolverResult.kind,
          standalone_query: resolverResult.standalone_query,
          references: resolverResult.references,
          context_used: resolverResult.context_used,
          new_constraints: resolverResult.new_constraints,
        },
        state: finalState,
      });

    } catch (err) {
      console.error('[DecisionIntelligenceV2 chat-with-memory] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerDecisionIntelligenceV2Route, runV2Pipeline };