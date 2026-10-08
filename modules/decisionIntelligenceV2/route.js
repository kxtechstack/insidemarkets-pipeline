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
const {
  buildGreetingResponse,
  buildOffTopicResponse,
  buildClarificationResponse,
  buildListResponse,
  buildInferenceResponse,
  buildDecisionResponse,
} = require('./responseBuilder');

// ─────────────────────────────────────────────────────────────────────────
// Deterministic filter for inference / decision.
//
// Same concept normalization as list. Keeps any hit where at least one
// clean concept appears in title OR body. If no concepts survive cleaning,
// keeps all hits (nothing to filter on).
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
  // Only runs for market_intelligence questions. Wrapped so any failure
  // in the SEC layer silently falls through to normal V2.
  //   - mode:'numeric'   → returns a full payload (numeric answer + chart)
  //   - mode:'framework' → returns injectChunks to merge into decision context
  //   - null             → not SEC-shaped, or SEC failed; V2 runs unmodified
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

  // SEC numeric answer is authoritative — return it directly.
  if (secResult && secResult.mode === 'numeric' && secResult.payload) {
    console.log(`[V2 route] SEC numeric answer returned directly`);
    return {
      routerResult,
      handlerResult: secResult.handlerResult || secResult.payload,
      payload: secResult.payload,
    };
  }

  // SEC region fallback (non-US + SEC-numeric) — return directly.
  // Either a list of region+topic-matching signals, or a no_data payload.
  if (secResult && secResult.mode === 'region_fallback' && secResult.payload) {
    console.log(`[V2 route] SEC region fallback returned directly (type=${secResult.payload.type})`);
    return {
      routerResult,
      handlerResult: secResult.payload,
      payload: secResult.payload,
    };
  }

  // SEC framework chunks (if any) will be merged into the decision context
  // further down. Held in `secResult.injectChunks`.
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

  // Framework questions (SWOT / PESTLE / Five Forces / Risk) are STRUCTURAL —
  // they apply a template to whatever data exists; they don't ask "does
  // this hit mention the framework name". The concept filter is guaranteed
  // to drop all client hits on those questions because no client signal
  // literally says "swot" / "pestle" / etc. So we skip the filter for
  // framework questions and let the writer decide relevance.
  const isFrameworkQuestion = /\b(swot|pestle|pestel|five\s*forces|5\s*forces|porter|risk\s*analysis|risk\s*categor)/i.test(question);

  const keptClient = isFrameworkQuestion
    ? clientRetr.hits
    : filterForInferenceOrDecision(clientRetr.hits, conceptsForFilter);

  const keptCustom = customHits; // custom sources always kept

  // Merge SEC chunks (if the SEC handler produced any) into the client
  // hits. SEC chunks bypass the deterministic concept filter because they
  // were retrieved by SEC-specific logic (ticker + framework item codes).
  const keptClientWithSec = secInjectChunks.length
    ? [...secInjectChunks, ...keptClient]
    : keptClient;

  // For inference, SEC chunks don't count toward material — inference
  // never consumes them. For decision, they do.
  const materialCount = routerResult.type === 'decision'
    ? keptClientWithSec.length + keptCustom.length
    : keptClient.length + keptCustom.length;
  const hasMaterial = materialCount > 0;

  console.log(
    `[V2 route] ${routerResult.type} filter: kept client=${keptClient.length}/${clientRetr.hits.length} ` +
    `sec=${secInjectChunks.length} custom=${keptCustom.length} (concepts=[${conceptsForFilter.join(', ')}])`
  );

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

  // If SEC fired a framework response, SEC chunks MUST reach the decision
  // handler (inference ignores them). Force decision dispatch regardless
  // of the router's `type`.
  const isFrameworkFromSec = secInjectChunks.length > 0;

  if (routerResult.type === 'inference' && !isFrameworkFromSec) {
    const handlerResult = await buildInferenceAnswer(question, keptClient, keptCustom);
    const payload = await buildInferenceResponse({ handlerResult, clientId });
    return { routerResult, handlerResult, payload };
  }

  // decision — SEC chunks merged in (empty array if SEC didn't fire)
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