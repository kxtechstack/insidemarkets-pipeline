require('dotenv').config();
const readline = require('readline');
const { runV2Pipeline } = require('../modules/decisionIntelligenceV2/route');

const TEST_CLIENT_ID = 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const TEST_INDUSTRY = 'Cosmetics';

const QUESTIONS = [
  // ── Comparison: Both sides present ────────────────────────────────
  'How does Estée Lauder perform against L\'Oreal',
  'Compare Estée Lauder and L\'Oreal revenue',
  'Estée Lauder vs L\'Oreal',
  'Compare Apple and Microsoft revenue',

  // ── Comparison: One side missing ──────────────────────────────────
  'How does Estée Lauder perform against Lakme',
  'Estée Lauder vs Lakme',
  'Compare Estée Lauder against Nykaa',
  'Estée Lauder versus Himalaya',

  // ── Non-comparison single entity with data ────────────────────────
  'What is Estée Lauder\'s revenue',
  'What is the update about Estée Lauder',
  'Tell me about Estée Lauder',

  // ── Non-comparison single entity without data ─────────────────────
  'What is the update about Lakme',
  'Tell me about Lakme',
  'What is Lakme revenue',

  // ── Rare keyword (not a comparison) ───────────────────────────────
  'What is Operation Soundarya',
  'KanuFresh',

  // ── Missing data non-comparison ───────────────────────────────────
  'Eyeliner trend in Japan',
  'Skincare trends in Cambodia',
];

async function runOne(question) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`❓ ${question}`);
  console.log(`${'='.repeat(80)}`);

  try {
    const result = await runV2Pipeline({
      question,
      clientId: TEST_CLIENT_ID,
      industry: TEST_INDUSTRY,
      forcedType: null,
    });

    const { payload } = result;

    // Print classification summary
    console.log(`\n📊 CLASSIFICATION:`);
    console.log(`   Type: ${result.routerResult?.type || 'unknown'}`);
    console.log(`   Entities: [${(result.routerResult?.entity_mentions || []).join(', ')}]`);

    // Print result summary
    if (payload.no_data) {
      console.log(`\n❌ NO DATA: ${payload.message?.slice(0, 100)}`);
    } else if (payload.report) {
      const isPartial = payload.report.bottom_line?.match(/could not find data|no data for|not available/i);
      console.log(`\n✅ ${isPartial ? '🟡 PARTIAL' : '✅ FULL'} REPORT`);
      console.log(`   Title: ${payload.report.title}`);
      console.log(`   Sections: ${payload.report.sections?.length || 0}`);
      console.log(`   Bottom line: ${payload.report.bottom_line?.slice(0, 150)}`);
      console.log(`   Sources: ${payload.sources?.length || 0}`);
    } else if (payload.items) {
      console.log(`\n✅ LIST (${payload.items.length} items)`);
    }

  } catch (err) {
    console.log(`\n💥 ERROR: ${err.message}`);
  }
}

async function runAll() {
  console.log(`\nRunning ${QUESTIONS.length} comparison scenarios...\n`);

  const results = [];
  for (const q of QUESTIONS) {
    await runOne(q);
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`✅ All ${QUESTIONS.length} tests complete.`);
  console.log(`${'='.repeat(80)}\n`);

  process.exit(0);
}

runAll();