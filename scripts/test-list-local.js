/**
 * scripts/test-list-local.js
 * 
 * Run this locally to test the list path without the frontend.
 * Usage: node scripts/test-list-local.js
 */

require('dotenv').config();
const { runV2Pipeline } = require('../modules/decisionIntelligenceV2/route');

// Replace these with a real client ID and industry from your database
const TEST_CLIENT_ID = 'b61b4d3b-caeb-457b-9971-636c83688ee4'; 
const TEST_INDUSTRY = 'Cosmetics';

const questions = [
  "List recent leadership changes in the beauty sector.",
  "List recent product launches in cosmetics.",
  "List recent regulatory changes in the beauty industry.",
  "List recent technology adoptions or AI initiatives in cosmetics.",
  "List recent mergers and acquisitions in the beauty sector.",
  "List recent private equity investments in beauty.",
  "List recent funding rounds for startups in the cosmetics industry.",
  "List new brands that have entered the beauty market.",
  "List recent expansions of beauty companies into new markets.",
  "List recent partnerships or joint ventures in the cosmetics sector.",
  "List recent private equity investments in beauty.",
"List recent news about L'Oreal.",
"List funding rounds."
];

async function runTests() {
  console.log(`Running list tests for client: ${TEST_CLIENT_ID}\n`);

  for (const q of questions) {
    console.log(`\n======================================================`);
    console.log(`Q: ${q}`);
    console.log(`======================================================`);
    
    try {
      const result = await runV2Pipeline({
        question: q,
        clientId: TEST_CLIENT_ID,
        industry: TEST_INDUSTRY,
        forcedType: 'list' // Force it to test the list path directly
      });

      const payload = result.payload;

      if (payload.no_data) {
        console.log(`Result: NO DATA (${payload.message})`);
      } else if (payload.type === 'list') {
        console.log(`Result: LIST (${payload.items.length} items)`);
        payload.items.forEach((item, i) => {
          console.log(`  [${i + 1}] ${item.title}`);
          console.log(`      Category: ${item.category} | Module: ${item.module}`);
        });
      } else {
        console.log(`Result: UNEXPECTED TYPE (${payload.type})`);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  }
}

runTests();