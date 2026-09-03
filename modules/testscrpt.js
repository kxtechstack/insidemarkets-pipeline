/**
 * testFullPipeline.js
 * =====================
 * Tests your ACTUAL reverted production code — not a reimplementation:
 *   1. topicDedup.js       -> removeSameTopicArticles (title + embedding dedup)
 *   2. marketInsights.js   -> enrichOrCreateInsight (card creation/merging)
 *
 * A pass here means the real files work. A fail means the real files are
 * broken, not a copy of them.
 *
 * ── BEFORE RUNNING: fill these in ──────────────────────────────────────────
 * Get real values from Supabase (run these once and copy the IDs):
 *
 *   select id, industry from admin.clients limit 5;
 *
 *   select id, submodule_name from admin.submodules
 *     where module_id = '55c5ee19-bfca-468b-81b3-b89ca4f303c8'; -- Market Dynamics
 *
 *   select id, signal_name, submodule_id from admin.signals
 *     where module_id = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
 *
 * Pick ONE existing client_id, and one submodule+signal id pair for an
 * "Investment Activity"-type submodule and one for an "AI Adoption"-type
 * submodule (names may differ in your DB — just pick any two submodules).
 *
 * IMPORTANT: use a client you don't mind writing test cards into — this
 * creates real rows in market_insights / market_insight_members /
 * market_dynamics_signals and real vectors in Qdrant. Re-running this
 * script multiple times will ADD to what's already there, so old test
 * cards can affect new results (e.g. a "SINGLE" event might now match
 * a leftover card from a previous run). If you want clean repeatable
 * runs, delete the test client's market_insights rows + Qdrant points
 * between runs, or use a client_id nobody else uses for real data.
 * ────────────────────────────────────────────────────────────────────────
 */

const { v4: uuidv4 } = require('uuid');
const { removeSameTopicArticles } = require('./topicDedup');
const { enrichOrCreateInsight } = require('./marketInsights');

const CLIENT_ID = process.env.TEST_CLIENT_ID || 'FILL_ME_IN';
const MODULE_ID = '55c5ee19-bfca-468b-81b3-b89ca4f303c8'; // Market Dynamics — fixed, don't change
const SUBMODULE_INVESTMENT_ID = process.env.TEST_SUBMODULE_INVESTMENT_ID || 'FILL_ME_IN';
const SUBMODULE_AI_ID = process.env.TEST_SUBMODULE_AI_ID || 'FILL_ME_IN';
const SIGNAL_INVESTMENT_ID = process.env.TEST_SIGNAL_INVESTMENT_ID || 'FILL_ME_IN';
const SIGNAL_AI_ID = process.env.TEST_SIGNAL_AI_ID || 'FILL_ME_IN';
const INDUSTRY = process.env.TEST_INDUSTRY || 'Beauty & Personal Care';

const REQUIRED = { CLIENT_ID, SUBMODULE_INVESTMENT_ID, SUBMODULE_AI_ID, SIGNAL_INVESTMENT_ID, SIGNAL_AI_ID };
const missing = Object.entries(REQUIRED).filter(([, v]) => v === 'FILL_ME_IN').map(([k]) => k);
if (missing.length > 0) {
  console.error(`❌ Fill in these before running (env var or edit the constant): ${missing.join(', ')}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────
// PART 1 — Topic Dedup test (topicDedup.js)
// ─────────────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();

const dedupTestArticles = [
  // A) exact/near-identical title pair (different source suffix) — must collapse to 1
  { title: 'Glossier closed a $57 million Series A led by Advent International', text: 'Glossier announced today it closed a $57 million Series A round led by Advent International. The funding will go toward retail expansion.', url: 'https://site-a.example.com/1', publishedDate: now() },
  { title: 'Glossier closed a $57 million Series A led by Advent International | BeautyMatter', text: 'BeautyMatter reports Glossier raised $57M in a Series A led by Advent International, to be used for retail expansion and hiring.', url: 'https://site-b.example.com/1', publishedDate: now() },

  // B) same event, differently worded — must collapse via embedding similarity
  { title: 'KKR leads $15M investment in Phitku', text: 'KKR has led a $15 million investment into Phitku, aiming to accelerate clinical research and retail distribution for the brand.', url: 'https://site-c.example.com/2', publishedDate: now() },
  { title: 'Phitku raises capital in KKR-backed round', text: 'Phitku closed a $15 million Series A led by KKR. The capital will fund inventory, retail distribution, product innovation and team expansion.', url: 'https://site-d.example.com/2', publishedDate: now() },

  // C) unrelated articles — must NOT dedup against anything
  { title: 'Estee Lauder deploys generative AI across marketing', text: 'Estee Lauder is deploying generative AI across its marketing and product functions to cut turnaround time.', url: 'https://site-e.example.com/3', publishedDate: now() },
  { title: 'Coty closed a $37 million Series A led by TSG Consumer Partners', text: 'Coty closed a $37 million Series A led by TSG Consumer Partners. The capital will fund inventory, retail distribution, product innovation and team expansion.', url: 'https://site-f.example.com/4', publishedDate: now() },
];

const runDedupTest = async () => {
  console.log('\n========== PART 1: TOPIC DEDUP TEST ==========\n');
  const result = await removeSameTopicArticles(dedupTestArticles, CLIENT_ID, MODULE_ID);

  console.log(`\nInput: ${dedupTestArticles.length} articles -> Output: ${result.length} unique kept`);
  console.log('Kept:', result.map(a => a.title));

  const expectedUnique = 4; // 1 from exact pair + 1 from paraphrase pair + 2 unrelated
  if (result.length === expectedUnique) {
    console.log(`\n✅ PASS — expected ${expectedUnique} unique articles, got ${result.length}`);
  } else {
    console.log(`\n❌ FAIL — expected ${expectedUnique} unique articles, got ${result.length}`);
    console.log('   (if this is a REPEAT run against the same client_id, leftover data from a previous run can cause this — see header notes)');
  }
};

// ─────────────────────────────────────────────────────────────────────────
// PART 2 — Market Insights card merging test (marketInsights.js)
// ─────────────────────────────────────────────────────────────────────────
// "group" here is just OUR bookkeeping label — the real code never sees it.
const insightTestSignals = [
  // SAMECO-A: same company, different phrasing — should end up as 1 card
  { group: 'SAMECO-A', submoduleId: SUBMODULE_INVESTMENT_ID, signalId: SIGNAL_INVESTMENT_ID,
    text: 'Phitku closed a $15 million Series A led by KKR. The capital will fund inventory, retail distribution, product innovation and team expansion.' },
  { group: 'SAMECO-A', submoduleId: SUBMODULE_INVESTMENT_ID, signalId: SIGNAL_INVESTMENT_ID,
    text: 'KKR has led a $15 million investment into Phitku, aiming to accelerate clinical research and retail distribution.' },

  // SAMECO-B: same company, three different AI-adoption phrasings — should end up as 1 card
  { group: 'SAMECO-B', submoduleId: SUBMODULE_AI_ID, signalId: SIGNAL_AI_ID,
    text: "Yepoda's new AI-powered tool accelerates R&D timelines, turning weeks of research into minutes." },
  { group: 'SAMECO-B', submoduleId: SUBMODULE_AI_ID, signalId: SIGNAL_AI_ID,
    text: 'Yepoda partners with an AI vendor to build conversational try-on and product discovery tools for consumers.' },
  { group: 'SAMECO-B', submoduleId: SUBMODULE_AI_ID, signalId: SIGNAL_AI_ID,
    text: 'Yepoda is deploying generative AI across its marketing and product functions to cut turnaround time and improve personalization.' },

  // SINGLE-A / SINGLE-B: unrelated events — each must stay on its OWN card
  { group: 'SINGLE-A', submoduleId: SUBMODULE_INVESTMENT_ID, signalId: SIGNAL_INVESTMENT_ID,
    text: 'Glossier closed a $57 million Series A led by Advent International. The capital will fund inventory, retail distribution, product innovation and team expansion.' },
  { group: 'SINGLE-B', submoduleId: SUBMODULE_AI_ID, signalId: SIGNAL_AI_ID,
    text: 'Estee Lauder is deploying generative AI across its marketing and product functions to cut turnaround time and improve personalization.' },
];

const runMarketInsightsTest = async () => {
  console.log('\n========== PART 2: MARKET INSIGHTS MERGE TEST ==========\n');
  const resultsByGroup = {};

  for (const sig of insightTestSignals) {
    const articleId = uuidv4();
    const result = await enrichOrCreateInsight(
      CLIENT_ID,
      MODULE_ID,
      sig.submoduleId,
      sig.signalId,
      articleId,
      sig.text,
      INDUSTRY
    );
    console.log(`[${sig.group}] -> ${result.status} insightId=${result.insightId}`);
    (resultsByGroup[sig.group] ||= new Set()).add(result.insightId);
  }

  console.log('\n--- INTENT CHECK ---');
  let allPass = true;

  for (const [group, insightIds] of Object.entries(resultsByGroup)) {
    const ok = insightIds.size === 1;
    if (!ok) allPass = false;
    console.log(`${group}: ${ok ? '✅ merged into 1 card' : `❌ SPLIT across ${insightIds.size} cards`} (${[...insightIds].join(', ')})`);
  }

  const singleAId = [...resultsByGroup['SINGLE-A']][0];
  const singleBId = [...resultsByGroup['SINGLE-B']][0];
  const samecoAIds = resultsByGroup['SAMECO-A'];
  const samecoBIds = resultsByGroup['SAMECO-B'];

  if (samecoAIds.has(singleAId) || samecoBIds.has(singleBId)) {
    allPass = false;
    console.log('❌ FAIL — a SINGLE (unrelated) event wrongly merged into another card');
  } else {
    console.log('✅ SINGLE events stayed separate from other cards');
  }

  console.log(allPass ? '\n✅ ALL MARKET INSIGHTS CHECKS PASSED' : '\n❌ SOME CHECKS FAILED — see above');
};

(async () => {
  await runDedupTest();
  await runMarketInsightsTest();
  process.exit(0);
})();