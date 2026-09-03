// test-fixes.js
require('dotenv').config(); // adjust if your env loading differs

const { findExistingInsight } = require('./marketInsights');
const { removeSameTopicArticles } = require('./topicDedup');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@xenova/transformers');

const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY });

let embedderPromise = null;
const embedText = async (text) => {
  if (!embedderPromise) embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const embedder = await embedderPromise;
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

// ── Real IDs from your actual run's logs ────────────────────────────────────
const CLIENT_ID = '0e4d0b7c-b2ed-4a7e-b898-4accd66cd4ac';       // Vellure Cosmetics Group
const MODULE_ID = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';       // Market Dynamics
const SUBMODULE_ID = '89304c37-09d1-4d85-b6a6-78e3d234b94f';    // Technology Adoption Signals
const MEGA_CARD_ID = '2291ae67-1af3-4593-a0e0-e960619e6031';    // the over-merged card

async function testOrgCheck() {
  console.log('\n========== TEST 1: Org-overlap gate ==========\n');

  // Reuse an embedding close to the mega-card's own topic ("AI in beauty").
  // We fetch one real article's synthesized text that's already a member of
  // this card, so the embedding is guaranteed to score high on similarity —
  // that isolates the ORG CHECK as the only variable being tested.
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const { data: signals } = await supabase
    .from('market_dynamics_signals')
    .select('article_id, organization, signal_title')
    .eq('insight_id', MEGA_CARD_ID)
    .limit(1);

  if (!signals || signals.length === 0) {
    console.log('Could not find any signal for the mega card — check MEGA_CARD_ID.');
    return;
  }

  const { data: fullArticle } = await supabase
    .from('policy_articles_full')
    .select('full_text')
    .eq('article_id', signals[0].article_id)
    .single();

  const sampleText = fullArticle?.full_text || signals[0].signal_title;
  const realOrg = signals[0].organization;
  console.log(`Using real article from this card. Its actual organization: "${realOrg}"\n`);

  const embedding = await embedText(sampleText.slice(0, 4000));

  console.log(`--- Case A: same organization ("${realOrg}") — should MATCH the existing card ---`);
  const resultSameOrg = await findExistingInsight(CLIENT_ID, MODULE_ID, SUBMODULE_ID, embedding, realOrg);
  console.log(resultSameOrg
    ? `RESULT: Matched card "${resultSameOrg.title}" (id: ${resultSameOrg.id}) ✅`
    : `RESULT: No match returned ❌ (expected a match here)`);

  console.log(`\n--- Case B: different organization ("Totally Unrelated Corp") — should NOT match, should create new ---`);
  const resultDiffOrg = await findExistingInsight(CLIENT_ID, MODULE_ID, SUBMODULE_ID, embedding, 'Totally Unrelated Corp');
  console.log(resultDiffOrg
    ? `RESULT: Matched card "${resultDiffOrg.title}" ❌ (should NOT have matched — org check failed)`
    : `RESULT: No match — will create a new card ✅ (org check worked)`);
}

async function testExactTitleDedup() {
  console.log('\n========== TEST 2: Exact-title duplicate catch ==========\n');

  // Use throwaway IDs so this never touches your real client's dedup pool
  const TEST_CLIENT = 'test-dedup-client-safe-to-delete';
  const TEST_MODULE = 'test-dedup-module-safe-to-delete';

  // The exact two Noli articles from your real run that slipped through
  const articles = [
    {
      title: 'Noli Uses Ai to Beat the Beauty Jungle and Find Your Perfect Match | Accenture',
      text: 'Noli is an AI-powered beauty matchmaking platform that helps consumers find personalized skincare and cosmetics recommendations based on their unique skin profile, preferences, and needs, using machine learning models trained on dermatological data.',
      url: 'https://example.com/noli-1',
      publishedDate: '2026-06-27T00:00:00.000Z',
    },
    {
      title: 'Noli Uses Ai to Beat the Beauty Jungle and Find Your Perfect Match | Accenture',
      text: 'A completely different scraped snippet from a mirrored copy of this same press release, with different site navigation boilerplate, related article links, and a slightly different lede paragraph than the original source page had.',
      url: 'https://example.com/noli-2-mirror',
      publishedDate: '2026-06-27T00:00:00.000Z',
    },
  ];

  console.log('Running both identical-title articles through removeSameTopicArticles()...\n');
  const result = await removeSameTopicArticles(articles, TEST_CLIENT, TEST_MODULE);

  console.log(`\nRESULT: ${result.length} unique article(s) out of ${articles.length} input`);
  console.log(result.length === 1
    ? 'PASS ✅ — the duplicate was correctly caught this time.'
    : 'FAIL ❌ — both articles still passed through as unique.');

  // Cleanup: remove the test points so this doesn't leave junk in your dedup_titles collection
  console.log('\nCleaning up test data from dedup_titles...');
  await qdrant.delete('dedup_titles', {
    filter: { must: [{ key: 'client_id', match: { value: TEST_CLIENT } }] },
  });
  console.log('Cleanup done.');
}

(async () => {
  try {
    await testOrgCheck();
    await testExactTitleDedup();
  } catch (err) {
    console.error('\nTest script error:', err);
  }
  process.exit(0);
})();