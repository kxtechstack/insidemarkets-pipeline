/**
 * scripts/test-playground.js
 * Clean terminal playground with Stage-by-Stage Diagnostics & Chunk Viewer.
 * Run: node scripts/test-playground.js
 */

require('dotenv').config();
const readline = require('readline');
const routeModule = require('../modules/decisionIntelligenceV2/route');
const { runV2Pipeline } = routeModule;

// Hook into internal functions
const { retrieveClientSignals } = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');
const { retrieveCustomSourceHits } = require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval');
const { filterListHits } = require('../modules/decisionIntelligenceV2/retrieval/filterListHits');
const { checkTopicalCoverage } = require('../modules/decisionIntelligenceV2/handlers/topicalCoverage');
const { route } = require('../modules/decisionIntelligenceV2/routing/router');

const TEST_CLIENT_ID = 'b61b4d3b-caeb-457b-9971-636c83688ee4'; // YOUR CLIENT ID
const TEST_INDUSTRY = 'Cosmetics';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper to print a chunk cleanly
function printChunk(hit, index) {
  const title = hit.title || 'Untitled';
  const score = hit.score ? hit.score.toFixed(3) : 'N/A';
  const text = hit.chunk_text || '';
  const preview = text.replace(/\n/g, ' ').slice(0, 150);
  console.log(`   [${index}] Score: ${score} | Title: "${title}"`);
  console.log(`       Preview: "${preview}..."\n`);
}

async function runDeepDiagnostic(question) {
  console.log(`\n======================================================`);
  console.log(`🚀 DIAGNOSTIC FOR: "${question}"`);
  console.log(`======================================================\n`);

  // ---------------------------------------------------------
  // STAGE 1: ROUTER
  // ---------------------------------------------------------
  console.log(`--- STAGE 1: ROUTER ---`);
  let routerResult;
  try {
    routerResult = await route(question, TEST_INDUSTRY);
    console.log(`Concepts Extracted : [${routerResult.concept_keywords?.join(', ') || 'NONE'}]`);
    console.log(`Entities Extracted : [${routerResult.entity_mentions?.join(', ') || 'NONE'}]`);
    console.log(`Type Classified    : ${routerResult.type}`);
  } catch (e) {
    console.log(`Router Error: ${e.message}`);
  }
  console.log(`\n`);

  // ---------------------------------------------------------
  // STAGE 2: RAW VECTOR RETRIEVAL
  // ---------------------------------------------------------
  console.log(`--- STAGE 2: RAW VECTOR RETRIEVAL (Qdrant) ---`);
  let clientRetr;
  let rawHits = [];
  try {
    // We pass the router result to force it to use the exact same understanding
    const testEntities = routerResult.entity_mentions?.length > 0 
        ? routerResult.entity_mentions 
        : [question];

    clientRetr = await retrieveClientSignals(question, TEST_CLIENT_ID, TEST_INDUSTRY, {
      precomputedUnderstanding: { 
        ...routerResult, 
        concept_keywords: routerResult.concept_keywords || [], 
        entity_mentions: testEntities 
      }
    });
    rawHits = clientRetr.hits;
    
    console.log(`Returned ${rawHits.length} raw hits.\n`);
    rawHits.slice(0, 5).forEach((h, i) => printChunk(h, i + 1));
    if (rawHits.length > 5) console.log(`   ... and ${rawHits.length - 5} more.\n`);

  } catch (e) {
    console.log(`Retrieval Error: ${e.message}`);
    return;
  }

  // ---------------------------------------------------------
  // STAGE 3: DETERMINISTIC FILTER
  // ---------------------------------------------------------
  console.log(`--- STAGE 3: DETERMINISTIC FILTER ---`);
  const conceptsForFilter = [
    ...(routerResult.concept_keywords || []),
    ...(routerResult.entity_mentions || []),
  ];
  
  let filteredHits = [];
  try {
    filteredHits = filterListHits(rawHits, conceptsForFilter);
    console.log(`Concepts used to filter: [${conceptsForFilter.join(', ')}]`);
    console.log(`Kept ${filteredHits.length} out of ${rawHits.length} hits.\n`);
    
    if (filteredHits.length > 0) {
      filteredHits.slice(0, 5).forEach((h, i) => printChunk(h, i + 1));
    }
  } catch (e) {
    console.log(`Filter Error: ${e.message}`);
  }

  // ---------------------------------------------------------
  // STAGE 4: TOPICAL COVERAGE (THE GATEKEEPER)
  // ---------------------------------------------------------
  if (filteredHits.length > 0) {
    console.log(`--- STAGE 4: TOPICAL COVERAGE CHECK ---`);
    try {
      const coverage = await checkTopicalCoverage(question, filteredHits, []);
      console.log(`Coverage Decision : ${coverage.covered ? '✅ PASS' : '❌ FAIL'}`);
      console.log(`Reason from LLM   : "${coverage.reason}"`);
      if (!coverage.covered) {
        console.log(`   (This is why you see "No Data" in the UI)`);
      }
    } catch (e) {
      console.log(`Coverage Error: ${e.message}`);
    }
  } else {
    console.log(`--- STAGE 4: TOPICAL COVERAGE CHECK ---`);
    console.log(`Skipped: Filter dropped all hits.`);
  }
  
  // ---------------------------------------------------------
  // STAGE 5: ACTUAL PIPELINE RESULT
  // ---------------------------------------------------------
  console.log(`\n--- STAGE 5: FINAL PIPELINE OUTPUT ---`);
  try {
    const result = await runV2Pipeline({
      question,
      clientId: TEST_CLIENT_ID,
      industry: TEST_INDUSTRY,
      forcedType: null,
    });
    
    if (result.payload.no_data) {
      console.log(`RESULT: NO DATA ❌`);
    } else {
      console.log(`RESULT: SUCCESS ✅ (${result.payload.type})`);
    }

    // ── NEW: Print the suggestions that would be shown to the user ──
    if (result.payload.suggestions && result.payload.suggestions.length > 0) {
      console.log(`\n💡 SUGGESTED FOLLOW-UPS:`);
      result.payload.suggestions.forEach((s, i) => {
        console.log(`   ${i + 1}. ${s}`);
      });
    } else {
      console.log(`\n💡 SUGGESTED FOLLOW-UPS: (none)`);
    }
    // ────────────────────────────────────────────────────────────────
  } catch (e) {
    console.log(`Pipeline Error: ${e.message}`);
  }

  console.log(`\n======================================================\n`);
}

function promptUser() {
  rl.question('Press ENTER to run diagnostics on the 3 failing questions, or type a custom question (or "exit"): ', async (input) => {
    const text = input.trim();
    if (text.toLowerCase() === 'exit' || text.toLowerCase() === 'quit') {
      rl.close();
      process.exit(0);
    }

    if (text.length > 0) {
      await runDeepDiagnostic(text);
    } else {
      // Run the 3 specific failing questions automatically
      await runDeepDiagnostic("what is Operation Soundarya");
      await runDeepDiagnostic("eyeliner trend in japan");
      await runDeepDiagnostic("skincare trends in cambodia");
    }
    
    promptUser();
  });
}

console.log('Deep Diagnostics Playground Started.');
promptUser();