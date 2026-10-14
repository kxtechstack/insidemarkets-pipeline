/**
 * modules/decisionIntelligenceV2/responseBuilder.js
 *
 * Converts the router + handler output into the exact payload shape the
 * frontend DecisionIntelligencePane expects. Handles:
 *   - greeting / off_topic / clarification short-circuit replies
 *   - list response
 *   - inference response
 *   - decision response
 *   - empty-result responses (no_data + suggestions)
 *
 * Reuses:
 *   - modules/decisionIntelligence/chatHistory.js      (conversations/messages)
 *   - modules/decisionIntelligence/suggestionEngine.js (verified suggestions)
 *   - modules/decisionIntelligence/enrichSources.js    (signal_id attachment)
 */

const { getSuggestedQuestions } = require('../decisionIntelligence/chatHistory');
const { getVerifiedSuggestions } = require('../decisionIntelligence/suggestionEngine');
const { enrichSourcesWithSignalIds } = require('../decisionIntelligence/enrichSources');
const { getSmartSuggestions } = require('./suggestions/smartSuggestions');

const DEFAULT_NO_DATA_SUGGESTIONS = [
  'What are the major policy changes affecting my industry?',
  'What recent market activity is happening in my sector?',
];

// ─────────────────────────────────────────────────────────────────────────
// Suggestion loaders
// ─────────────────────────────────────────────────────────────────────────

async function loadHomeSuggestions(clientId, industry) {
  // industry kept in the signature for backwards-compat with existing callers.
  try {
    const smart = await getSmartSuggestions(clientId);
    if (smart && smart.length) return smart;
  } catch (err) {
    console.log(`[V2 responseBuilder] smart suggestions failed (home): ${err.message}`);
  }
  return DEFAULT_NO_DATA_SUGGESTIONS;
}

async function loadVerifiedSuggestions(clientId) {
  try {
    const smart = await getSmartSuggestions(clientId);
    if (smart && smart.length) return smart;
  } catch (err) {
    console.log(`[V2 responseBuilder] smart suggestions failed (verified): ${err.message}`);
  }
  return DEFAULT_NO_DATA_SUGGESTIONS;
}

// ─────────────────────────────────────────────────────────────────────────
// Source enrichment — attach signal_id for client sources so the frontend
// can make them clickable and jump to the right tab.
// ─────────────────────────────────────────────────────────────────────────

async function prepareSources(sources, clientId) {
  if (!Array.isArray(sources) || sources.length === 0) return [];
  try {
    return await enrichSourcesWithSignalIds(sources, clientId);
  } catch (err) {
    console.log(`[V2 responseBuilder] enrichSources failed: ${err.message}`);
    return sources;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Builders per response kind
// ─────────────────────────────────────────────────────────────────────────

async function buildGreetingResponse({ routerResult, clientId, industry }) {
  const suggestions = await loadHomeSuggestions(clientId, industry);
  return {
    type: 'list',
    items: [],
    no_data: true,
    greeting: true,
    message:
      routerResult.primary_intent ||
      'Hi! What would you like to know about your market data?',
    suggestions,
  };
}

async function buildOffTopicResponse({ routerResult, clientId, industry }) {
  const suggestions = await loadHomeSuggestions(clientId, industry);
  return {
    type: 'list',
    items: [],
    no_data: true,
    message:
      routerResult.primary_intent ||
      "I focus on market and business intelligence. Ask me about your industry data instead.",
    suggestions,
  };
}

async function buildClarificationResponse({ routerResult, clientId, industry }) {
  const suggestions = await loadHomeSuggestions(clientId, industry);
  return {
    type: 'list',
    items: [],
    no_data: true,
    message:
      routerResult.primary_intent ||
      'Could you give me a bit more to go on? Try asking about recent developments in your industry.',
    suggestions,
  };
}

async function buildListResponse({ handlerResult, clientId, industry }) {
  if (!handlerResult || !handlerResult.items || handlerResult.items.length === 0) {
    const suggestions = await loadVerifiedSuggestions(clientId);
    return {
      type: 'list',
      items: [],
      no_data: true,
      message: "I don't have relevant data on that in your current dataset. Would you like to explore one of these instead?",
      suggestions,
    };
  }

  return {
    type: 'list',
    items: handlerResult.items,
  };
}

async function buildInferenceResponse({ handlerResult, clientId }) {
  if (!handlerResult || handlerResult._empty || !handlerResult.report) {
    const suggestions = await loadVerifiedSuggestions(clientId);
    return {
      type: 'list',
      items: [],
      no_data: true,
      message:
        handlerResult?._reason ||
        "I don't have relevant data on that in your current dataset. Would you like to explore one of these instead?",
      suggestions,
    };
  }

  const sources = await prepareSources(handlerResult.sources || [], clientId);
  return {
    type: 'inference',
    report: handlerResult.report,
    sources,
  };
}

async function buildDecisionResponse({ handlerResult, clientId }) {
  if (!handlerResult || handlerResult._empty || !handlerResult.report) {
    const suggestions = await loadVerifiedSuggestions(clientId);
    return {
      type: 'list',
      items: [],
      no_data: true,
      message:
        handlerResult?._reason ||
        "I don't have relevant data on that in your current dataset. Would you like to explore one of these instead?",
      suggestions,
    };
  }

  const sources = await prepareSources(handlerResult.sources || [], clientId);

  // Guard: if every section is empty, treat as no_data
  const sections = handlerResult.report.sections || [];
  const allEmpty =
    sections.length > 0 &&
    sections.every((s) =>
      (s.points || []).every((p) =>
        typeof p === 'string' &&
        /no relevant data/i.test(p)
      )
    );

  if (allEmpty) {
    const suggestions = await loadVerifiedSuggestions(clientId);
    return {
      type: 'list',
      items: [],
      no_data: true,
      message:
        "I don't have relevant data on that in your current dataset. Would you like to explore one of these instead?",
      suggestions,
    };
  }

  return {
    type: 'decision',
    report: handlerResult.report,
    sources,
    chart: null,
    chartMeta: null,
  };
}

module.exports = {
  buildGreetingResponse,
  buildOffTopicResponse,
  buildClarificationResponse,
  buildListResponse,
  buildInferenceResponse,
  buildDecisionResponse,
  prepareSources,
  loadHomeSuggestions,
  loadVerifiedSuggestions,
};