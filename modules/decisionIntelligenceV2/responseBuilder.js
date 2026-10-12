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

// User-facing no-data messages. Rotated randomly so users don't see the
// same phrasing every time. Internal reasons (handlerResult._reason) are
// logged for debugging but never shown to the user.
const NO_DATA_MESSAGES = [
  "I don't have details on that yet — it may not be in your tracked sources. Here are some things I can look into instead:",
  "I couldn't find relevant data for this question in your current sources. Try exploring one of these instead:",
  "Nothing in your currently tracked sources matches this. Here are some related areas I can help with:",
];

const SYSTEM_ERROR_MESSAGE =
  "We hit a temporary snag while generating this answer. Please try again in a moment.";

function pickNoDataMessage() {
  const idx = Math.floor(Math.random() * NO_DATA_MESSAGES.length);
  return NO_DATA_MESSAGES[idx];
}

// Decides which user-facing message to show for an empty handler result.
// Technical failures get the system-error message; everything else gets
// a warm no-data variant.
function messageForEmptyHandler(handlerResult) {
  const reason = (handlerResult && handlerResult._reason) || '';
  if (/llm call failed|llm.*failed|timeout|exception/i.test(reason)) {
    return SYSTEM_ERROR_MESSAGE;
  }
  return pickNoDataMessage();
}

// ─────────────────────────────────────────────────────────────────────────
// Suggestion loaders
// ─────────────────────────────────────────────────────────────────────────

async function loadHomeSuggestions(clientId, industry) {
  try {
    const homeQs = await getSuggestedQuestions({
      clientId,
      surface: 'home',
      industry,
      companyName: null,
    });
    const list = (homeQs || [])
      .slice(0, 4)
      .map((q) => q.question)
      .filter(Boolean);
    return list.length ? list : DEFAULT_NO_DATA_SUGGESTIONS;
  } catch (err) {
    console.log(`[V2 responseBuilder] failed to load home suggestions: ${err.message}`);
    return DEFAULT_NO_DATA_SUGGESTIONS;
  }
}

async function loadVerifiedSuggestions(clientId) {
  try {
    const verified = await getVerifiedSuggestions(clientId, 4);
    if (verified && verified.length) return verified;
  } catch (err) {
    console.log(`[V2 responseBuilder] verified suggestions failed: ${err.message}`);
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
    greeting: true,
    message:
      routerResult.user_message ||
      routerResult.primary_intent ||
      'Hi! What would you like to know about your market today?',
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
      routerResult.user_message ||
      routerResult.primary_intent ||
      "I focus on market and business intelligence — I'm not the right assistant for that. Here are some things I can help you with:",
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
      routerResult.user_message ||
      routerResult.primary_intent ||
      'I couldn\u2019t quite parse that — could you say a bit more? What company, market, or topic should I look into?',
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
      message: pickNoDataMessage(),
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
    if (handlerResult?._reason) {
      console.log(`[V2 responseBuilder] inference no_data reason: ${handlerResult._reason}`);
    }
    const suggestions = await loadVerifiedSuggestions(clientId);
    return {
      type: 'list',
      items: [],
      no_data: true,
      message: messageForEmptyHandler(handlerResult),
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
    if (handlerResult?._reason) {
      console.log(`[V2 responseBuilder] decision no_data reason: ${handlerResult._reason}`);
    }
    const suggestions = await loadVerifiedSuggestions(clientId);
    return {
      type: 'list',
      items: [],
      no_data: true,
      message: messageForEmptyHandler(handlerResult),
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
      message: pickNoDataMessage(),
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