/**
 * scripts/test-playground.js
 * Clean terminal playground.
 * Run: node scripts/test-playground.js
 */

require('dotenv').config();
const readline = require('readline');
const crypto = require('crypto');

const { runV2Pipeline } = require('../modules/decisionIntelligenceV2/route');
const { resolveContext } = require('../modules/decisionIntelligenceV2/chatContext/contextResolver');
const { updateState } = require('../modules/decisionIntelligenceV2/chatContext/stateUpdater');
const { loadState } = require('../modules/decisionIntelligenceV2/chatContext/mem0Adapter');
const { callLLM } = require('../modules/llmClient');
const { REFORMAT_PROMPT } = require('../modules/decisionIntelligenceV2/chatContext/reformatter');

const TEST_CLIENT_ID = 'b61b4d3b-caeb-457b-9971-636c83688ee4'; // YOUR CLIENT ID
const TEST_INDUSTRY = 'Cosmetics';
const CONV_ID = crypto.randomUUID();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let LAST_ANSWER = null; // Global variable to hold the previous answer

async function handleQuery(question) {
  console.log(`\n======================================================`);
  console.log(`USER: ${question}`);
  console.log(`======================================================`);

  let currentState = {};
  try {
    currentState = await loadState(CONV_ID);
    console.log(`[Memory] State loaded:`, JSON.stringify(currentState));
  } catch (err) {}

  let resolverResult;
  try {
    resolverResult = await resolveContext({
      conversationId: CONV_ID,
      userMessage: question,
      currentState,
    });
    
    console.log(`[Memory] Classified as: ${resolverResult.kind}`);
    if (resolverResult.standalone_query !== question) {
      console.log(`[Memory] Rewrote query to: "${resolverResult.standalone_query}"`);
    }
  } catch (err) {
    console.log(`[Memory] Resolver failed, using raw question.`);
    resolverResult = { standalone_query: question, kind: 'new_question' };
  }

    // ── HANDLE REFORMAT ──────────────────────────────────────────────
  if (resolverResult.kind === 'reformat') {
    console.log(`[Memory] Handling as REFORMAT instruction.`);
    
    if (!LAST_ANSWER) {
      console.log(`\n--- AI ANSWER ---`);
      console.log(`There is no previous answer to reformat.`);
      console.log(`-----------------\n`);
      return;
    }

    try {
      // Use the production reformatter logic
      const { reformatPreviousAnswer } = require('../modules/decisionIntelligenceV2/chatContext/reformatter');
      
      // We temporarily mock the database save since we aren't hitting the real API in this local test
      // (This mimics what route.js does)
      const reformatResult = await reformatPreviousAnswer({
        conversationId: CONV_ID,
        instruction: resolverResult.standalone_query,
        // We pass the previous answer directly to avoid DB lookups failing locally
        mockPreviousPayload: LAST_ANSWER 
      });

      if (reformatResult.payload) {
        console.log(`\n--- AI ANSWER ---`);
        console.log(`REPORT: ${reformatResult.payload.report?.title}`);
        (reformatResult.payload.report?.sections || []).forEach(s => {
          console.log(`    - ${s.heading}:`);
          (s.points || []).slice(0, 2).forEach(p => console.log(`        * ${p}`));
        });
        console.log(`-----------------\n`);
        LAST_ANSWER = reformatResult.payload;
      } else {
        console.log(`\n--- AI ANSWER ---`);
        console.log(`Reformat failed: No payload returned.`);
        console.log(`-----------------\n`);
      }
    } catch (err) {
      console.log(`\n--- AI ANSWER ---`);
      console.log(`Reformat error: ${err.message}`);
      console.log(`-----------------\n`);
    }
    
    return; 
  }
  // ──────────────────────────────────────────────────────────────────

  const queryForPipeline = resolverResult.standalone_query;

  let result;
  try {
    result = await runV2Pipeline({
      question: queryForPipeline,
      clientId: TEST_CLIENT_ID,
      industry: TEST_INDUSTRY,
      forcedType: null,
    });
  } catch (err) {
    console.log(`[Pipeline] Error: ${err.message}`);
    return;
  }

  const { payload } = result;
  LAST_ANSWER = payload; // Save this for the next reformat

  console.log(`\n--- AI ANSWER ---`);
  if (payload.no_data) {
    console.log(`NO DATA (${payload.message})`);
  } else if (payload.type === 'list') {
    console.log(`LIST (${payload.items.length} items)`);
    payload.items.forEach((item, i) => {
      console.log(`  [${i + 1}] ${item.title} (${item.category})`);
    });
  } else if (payload.type === 'decision' || payload.type === 'inference') {
    console.log(`REPORT: ${payload.report?.title}`);
    (payload.report?.sections || []).forEach(s => {
      console.log(`    - ${s.heading}:`);
      (s.points || []).slice(0, 2).forEach(p => console.log(`        * ${p}`));
    });
  }
  console.log(`-----------------\n`);

  // Save Memory
  if (resolverResult.kind !== 'greeting' && resolverResult.kind !== 'off_topic') {
    try {
      const answerText = payload.type === 'list' ? 'List of items' : (payload.report?.title || 'Report');
      const updaterResult = await updateState({
        conversationId: CONV_ID,
        userMessage: queryForPipeline,
        answer: answerText,
        currentState,
      });
      console.log(`[Memory] State updated to:`, JSON.stringify(updaterResult.updatedState));
    } catch (err) {
      console.log(`[Memory] Update failed: ${err.message}`);
    }
  }
}

function promptUser() {
  rl.question('You: ', async (input) => {
    const text = input.trim();
    if (text.toLowerCase() === 'exit' || text.toLowerCase() === 'quit') {
      console.log('Goodbye!');
      rl.close();
      process.exit(0);
    }
    if (text.length > 0) {
      await handleQuery(text);
    }
    promptUser();
  });
}

console.log('Clean Playground Started. Type "exit" to quit.');
promptUser();