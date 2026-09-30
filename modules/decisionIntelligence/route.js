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
const { retrieveCustomSourceData } = require('./customSourceRetrieval');
const { extractIntent, retrieveForIntent, getAllCompanies } = require('./secRetrieval');
const { generateAnswer } = require('./generateAnswer');
const { getVerifiedSuggestions } = require('./suggestionEngine');
const { buildListAnswer } = require('./buildListAnswer');
const { generateInferenceAnswer } = require('./generateInferenceAnswer');
const { classifyQuestion } = require('./classifyQuestion');
const { enrichSourcesWithSignalIds } = require('./enrichSources');
const {
  createConversation, appendMessage,
  listConversations, loadConversation, deleteConversation,
  getSuggestedQuestions,
} = require('./chatHistory');


/**
 * Handles a 'list' question: client data only, no LLM.
 *
 * FALLBACK: always fetch custom sources in parallel. If the client-signal
 * list comes back thin (fewer than 3 items) BUT custom sources have hits,
 * route to the Inference answer generator instead of returning a sparse
 * or unhelpful list.
 */
async function handleList(question, clientId, industry, forceList = false) {
  const modules = detectTargetModules(question);

  const [searchResults, customSourceResults] = await Promise.all([
    retrieveClientData(question, clientId, industry, 10, modules, Number(process.env.LIST_SCORE_FLOOR) || 0.35, true),
    retrieveCustomSourceData(question, clientId),
  ]);

  let clientItems = [];
  if (searchResults.length > 0) {
    try {
      clientItems = await buildListAnswer(searchResults);
    } catch (err) {
      console.log(`[handleList] buildListAnswer failed: ${err.message}`);
      clientItems = [];
    }
  }

  const MIN_RICH_LIST_SIZE = 3;
  const hasTimeWindow = Boolean(detectTimeWindow(question));
  const useCustomSources =
    !hasTimeWindow && clientItems.length < MIN_RICH_LIST_SIZE && customSourceResults.length > 0;

  console.log(
    `[handleList] client=${clientId} | signals=${searchResults.length} (${clientItems.length} items) | customSource=${customSourceResults.length} | route=${useCustomSources ? 'custom->inference' : 'list'}`
  );

  // If the user explicitly asked for a list (e.g. clicked a List card
  // in the Question Library, or set type='list' in the request), we
  // MUST return a list. Do NOT fall back to inference — that would
  // change the response shape and surprise the frontend.
  if (forceList) {
    console.log(`[handleList] forceList=true — returning list even if empty`);
    return { type: 'list', items: clientItems };
  }

  // If the user explicitly asked for a list (e.g. clicked a List card
  // in the Question Library, or set type='list' in the request), we
  // MUST return a list. Do NOT fall back to inference — that would
  // change the response shape and surprise the frontend.
  if (forceList) {
    console.log(`[handleList] forceList=true — returning list even if empty`);
    return { type: 'list', items: clientItems };
  }

  if (!useCustomSources) {
    return { type: 'list', items: clientItems };
  }

  const { report, sources, _empty, _reason } = await generateInferenceAnswer(
    question,
    [],
    customSourceResults
  );

  if (_empty) {
    return { type: 'list', items: clientItems };
  }

  return { type: 'inference', report, sources };
}

/**
 * Handles an 'inference' question: client data + LLM synthesis.
 * Returns { type: 'inference', report: {...}, sources: [...] }
 */
async function handleInference(question, clientId, industry) {
  const [searchResults, customSourceResults] = await Promise.all([
    retrieveClientData(question, clientId, industry),
    retrieveCustomSourceData(question, clientId),
  ]);
  console.log(`[handleInference] client=${clientId} | signals=${searchResults.length} | customSource=${customSourceResults.length}`);
  const { report, sources, _empty, _reason } = await generateInferenceAnswer(
    question,
    searchResults,
    customSourceResults
  );
  if (_empty) {
    return {
      type: 'inference',
      report: null,
      sources: [],
      _empty: true,
      _reason: _reason || null,
    };
  }
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

  const [secRetrieval, customSourceResults] = await Promise.all([
    intent.tickers.length
      ? retrieveForIntent(question, intent)
      : Promise.resolve({ chunks: [], facts: [] }),
    retrieveCustomSourceData(question, clientId),
  ]);
  const { chunks, facts } = secRetrieval;

  console.log(`[handleDecision] client=${clientId} | secChunks=${chunks.length} | facts=${facts.length} | customSource=${customSourceResults.length}`);

  const { report, sources, chart: autoChart, chartMeta: autoChartMeta, clientContextCount, _empty, _reason } = await generateAnswer(
    question, intent, chunks, facts, clientId, industry, customSourceResults
  );

  // If generateAnswer flagged the answer as empty (e.g. LLM said no_data),
  // short-circuit and let the caller show the "no data" redirect.
  if (_empty) {
    return {
      type: 'decision',
      report: null,
      sources: [],
      chart: null,
      chartMeta: null,
      _empty: true,
      _reason: _reason || null,
    };
  }

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
  // HALLUCINATION GUARD: if we retrieved zero context (no chunks, no
  // facts, no resolved sources), then anything the LLM produced is
  // fabricated -- the report may look full and plausible, but none of
  // it is grounded. Mark as empty so the handler responds with the
  // "no data" message instead of showing invented content.
  const hadNoContext =
    (!chunks || chunks.length === 0) &&
    (!facts || facts.length === 0) &&
    (!sources || sources.length === 0) &&
    (!clientContextCount || clientContextCount === 0) &&
    (!customSourceResults || customSourceResults.length === 0);

  if (hadNoContext) {
    console.log(
      `[handleDecision] Discarding report for "${question}" -- zero context retrieved (chunks=${chunks?.length || 0}, facts=${facts?.length || 0}, sources=${sources?.length || 0})`
    );
    return { type: 'decision', report: null, sources: [], chart: null, chartMeta: null, _empty: true };
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

                  // 2b. LLM-driven intent classification: greeting / off_topic /
      // clarification / market_intelligence. Replaces the hardcoded
      // greeting regex. If not market_intelligence, respond with the
      // LLM-generated message plus optional suggestions and skip the
      // full pipeline.
      const { classifyIntent } = require('./classifyIntent');
      const intentResult = await classifyIntent(question);

      if (intentResult.intent !== 'market_intelligence') {
        // Fetch client's suggested questions to offer as next steps
        let suggestions = [];
        try {
          const homeQs = await getSuggestedQuestions({
            clientId,
            surface: 'home',
            industry,
            companyName: null,
          });
          suggestions = (homeQs || []).slice(0, 4).map((q) => q.question).filter(Boolean);
        } catch (err) {
          console.log(`[DI intent] Failed to load suggestions: ${err.message}`);
        }

        const reply = intentResult.message
          || 'Hey! Ask me a question about your market intelligence data to get started.';

        const payload = {
          type: 'list',
          items: [],
          greeting: intentResult.intent === 'greeting',
          no_data: intentResult.intent === 'off_topic' || intentResult.intent === 'clarification',
          message: reply,
          suggestions,
        };

        await appendMessage({
          conversationId,
          role: 'assistant',
          content: reply,
          type: 'list',
          payload,
        });

        return res.json({ ...payload, conversationId });
      }

      // 3. Classify (same as before)
      let type = providedType;
      let classifierReasoning = null;
      const typeWasExplicit = Boolean(providedType); // frontend told us the type
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
        result = await handleList(question, clientId, industry, typeWasExplicit);
      } else if (type === 'inference') {
        result = await handleInference(question, clientId, industry);
      } else {
        result = await handleDecision(question, clientId, industry);
      }

      if (classifierReasoning) result.classifierReasoning = classifierReasoning;
            if (result.sources && result.sources.length) {
        try {
          result.sources = await enrichSourcesWithSignalIds(result.sources, clientId);
        } catch (err) {
          console.log(`[DI] enrichSources failed: ${err.message}`);
        }
      }

      // 4b. Detect "no relevant data" outcomes and steer the user toward
      // working questions. Only fires when the result is *truly* empty --
      // if the LLM produced any content (even a "no data" narrative),
      // we keep that instead of overriding it.
      const NO_DATA_PATTERNS = [
        /no (specific|relevant|publicly[\s-]?available|reported) (developments?|information|data|coverage|insights?)/i,
        /context (lacks|does not contain|does not provide|provides no)/i,
        /not documented in the (provided|given|available) context/i,
        /no insights? (are|is) available/i,
        /cannot (identify|determine|find|locate) (any )?(drivers|signals|information|developments?)/i,
        /no relevant information/i,
      ];
      const textSaysNoData = (text) =>
        typeof text === 'string' && NO_DATA_PATTERNS.some((p) => p.test(text));

      const isEmptyResult = (() => {
        if (!result) return true;
        if (result._empty) return true;

        if (result.type === 'list') {
          return !result.items || result.items.length === 0;
        }

        if (result.type === 'inference' || result.type === 'decision') {
          const r = result.report || {};

          // If the LLM wrote a "no data" narrative, treat as empty.
          const outlookText = Array.isArray(r.outlook) ? r.outlook.join(' ') : (r.outlook || '');
          if (textSaysNoData(outlookText) || textSaysNoData(r.bodyText) || textSaysNoData(r.bottom_line)) {
            return true;
          }

          const hasTitle = Boolean(r.title && r.title.trim());
          const hasOutlook = Array.isArray(r.outlook)
            ? r.outlook.length > 0
            : Boolean(r.outlook && String(r.outlook).trim());
          const hasBody = Boolean(r.bodyText && r.bodyText.trim());
          const hasTable = Boolean(
            r.key_movement_analysis &&
              r.key_movement_analysis.rows &&
              r.key_movement_analysis.rows.length > 0
          );
          const hasDrivers = Array.isArray(r.driving_factors) && r.driving_factors.length > 0;
          const hasSources = Array.isArray(result.sources) && result.sources.length > 0;
          return !(hasTitle || hasOutlook || hasBody || hasTable || hasDrivers || hasSources);
        }

        return false;
      })();

      if (isEmptyResult) {
        let suggestions = [];
        try {
          suggestions = await getVerifiedSuggestions(clientId, industry, 4);
        } catch (err) {
          console.log(`[DI] getVerifiedSuggestions failed: ${err.message}`);
        }

        if (suggestions.length === 0) {
          try {
            const homeQs = await getSuggestedQuestions({
              clientId,
              surface: 'home',
              industry,
              companyName: null,
            });
            suggestions = (homeQs || []).slice(0, 4).map((q) => q.question).filter(Boolean);
          } catch (err) {
            console.log(`[DI] Failed to load suggestions for empty result: ${err.message}`);
          }
        }

        if (suggestions.length === 0) {
          suggestions = [
            'What are the major policy changes affecting my industry?',
            'What recent market activity is happening in my sector?',
          ];
        }

        const reply =
          result._reason
            ? `I don't have relevant data on that in your current dataset (${result._reason}). Would you like to explore one of these instead?`
            : "I don't have relevant data on that in your current dataset. Would you like to explore one of these instead?";

        const enriched = {
          type: 'list',
          items: [],
          no_data: true,
          message: reply,
          suggestions,
        };

        await appendMessage({
          conversationId,
          role: 'assistant',
          content: reply,
          type: 'list',
          payload: enriched,
        });

        return res.json({ ...enriched, conversationId });
      }

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