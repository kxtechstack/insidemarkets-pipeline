/**
 * test-dedup-race.js
 * ====================
 * Proves (or disproves) the topic-dedup race condition using your
 * REAL topicDedup.js functions against your TEST Qdrant instance.
 *
 * Run from your project root (so `require('./modules/topicDedup')` resolves):
 *   node test-dedup-race.js
 *
 * Make sure your .env (test environment) is loaded -- e.g.:
 *   node -r dotenv/config test-dedup-race.js
 *
 * WHAT THIS DOES:
 *   1. Simulates two "submodule pipelines" that both fetch the SAME
 *      dummy article at nearly the same time.
 *   2. Both call removeSameTopicArticles() -- the "check" step -- at
 *      the same moment, BEFORE either one calls commitTopicSeen().
 *   3. Prints whether BOTH passed the check (= race condition confirmed)
 *      or only one did (= dedup is working fine, problem is elsewhere).
 *   4. Cleans up after itself (deletes the dummy article's dedup record).
 *
 * Uses a fake client_id/module_id so it never touches real client data.
 */

const { removeSameTopicArticles, commitTopicSeen } = require('./modules/topicDedup');
const { QdrantClient } = require('@qdrant/js-client-rest');

const TEST_CLIENT_ID = 'dummy-test-client-race-check';
const TEST_MODULE_ID = 'dummy-test-module-race-check';

const dummyArticle = {
  title: 'World Bank backs Morocco hydropower storage with $265m',
  url: 'https://example-mirror-1.com/world-bank-morocco',
  text: 'RABAT, MOROCCO / MENA Newswire / -- The World Bank has approved $265 million to support Morocco\'s Ifahsa Pumped Hydropower Storage Project, a 300-megawatt clean energy facility.',
  publishedDate: '2026-07-03T00:00:00.000Z',
};

// A second copy with a DIFFERENT url (like your screenshots), SAME title/text
const dummyArticleMirror = {
  ...dummyArticle,
  url: 'https://example-mirror-2.com/world-bank-morocco-copy',
};

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const cleanup = async () => {
  try {
    await qdrant.delete('dedup_titles', {
      filter: {
        must: [
          { key: 'client_id', match: { value: TEST_CLIENT_ID } },
          { key: 'module_id', match: { value: TEST_MODULE_ID } },
        ],
      },
    });
    console.log('[cleanup] Removed dummy test records from dedup_titles.');
  } catch (err) {
    console.log('[cleanup] Nothing to clean or cleanup failed (non-fatal):', err.message);
  }
};

const runTest = async () => {
  console.log('=== TEST 1: Sequential (commit happens BEFORE second check) ===');
  console.log('This is the "should work" case -- proves dedup logic itself is sound.\n');

  await cleanup();

  const firstCheck = await removeSameTopicArticles([dummyArticle], TEST_CLIENT_ID, TEST_MODULE_ID);
  console.log(`First check: ${firstCheck.length} article(s) passed (expect 1)`);

  // Commit BEFORE the second check -- simulates submodule A finishing
  // its full pipeline (LLM + storage) before submodule B even starts.
  await commitTopicSeen(dummyArticle, TEST_CLIENT_ID, TEST_MODULE_ID);
  console.log('Committed first article to dedup collection.');

  const secondCheck = await removeSameTopicArticles([dummyArticleMirror], TEST_CLIENT_ID, TEST_MODULE_ID);
  console.log(`Second check (same title, diff url): ${secondCheck.length} article(s) passed (expect 0 -- should be caught as duplicate)`);

  if (secondCheck.length === 0) {
    console.log('✅ PASS -- when commit happens first, dedup correctly blocks the duplicate.\n');
  } else {
    console.log('❌ FAIL -- dedup let a duplicate through even in the sequential case! Bug is in the matching logic itself, not just timing.\n');
  }

  await cleanup();

  console.log('=== TEST 2: Concurrent (both checks happen BEFORE either commits) ===');
  console.log('This simulates two submodule pipelines racing -- the real-world scenario.\n');

  // Fire BOTH checks at the same time, neither has committed yet.
  const [checkA, checkB] = await Promise.all([
    removeSameTopicArticles([dummyArticle], TEST_CLIENT_ID, TEST_MODULE_ID),
    removeSameTopicArticles([dummyArticleMirror], TEST_CLIENT_ID, TEST_MODULE_ID),
  ]);

  console.log(`Submodule A check: ${checkA.length} article(s) passed`);
  console.log(`Submodule B check: ${checkB.length} article(s) passed`);

  if (checkA.length === 1 && checkB.length === 1) {
    console.log('❌ RACE CONDITION CONFIRMED -- both submodules think the article is new.');
    console.log('   This is why you see duplicate "World Bank Morocco" signals in your dashboard.');
  } else {
    console.log('✅ No race detected in this run (timing can vary -- try running the test a few times).');
  }

  await cleanup();
  console.log('\nDone.');
};

runTest().catch(err => {
  console.error('Test crashed:', err);
  cleanup();
});