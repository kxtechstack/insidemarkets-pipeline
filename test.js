// testFetcherDateSanitize.js
// Standalone test against the REAL fetcher.js and REAL source APIs.
// Only calls fetchArticles() -- no Redis, no Supabase, no pipeline writes.
// Safe to run on test env. Uses a small lookbackDays + a query likely to
// surface some volatile/regulatory articles (good chance of hitting the
// deadline/effective-date bug pattern).
//
// Run with (from wherever fetcher.js lives, e.g. modules/):
//   node testFetcherDateSanitize.js
//
// Requires your .env to already have EXA_API_KEY / TAVILY_API_KEY /
// PARALLEL_API_KEY set (same env this script runs in).

require('dotenv').config();
const { fetchArticles } = require('./modules/fetcher'); // adjust path if this script sits elsewhere

const SOURCES_TO_TEST = ['Exa']; // add 'Tavily', 'Parallel' once you want to test those too
const TEST_QUERY = 'new government regulation compliance deadline';
const LOOKBACK_DAYS = 30;

const run = async () => {
  for (const source of SOURCES_TO_TEST) {
    console.log(`\n=== Testing source: ${source} ===`);
    try {
      const articles = await fetchArticles(source, TEST_QUERY, LOOKBACK_DAYS);
      console.log(`Fetched ${articles.length} articles.\n`);

      const now = Date.now();
      let nulled = 0;
      let futureBeforeSanitize = 0; // just for visibility, can't detect after the fact -- see console logs above

      articles.slice(0, 20).forEach((a, i) => {
        const dateStr = a.publishedDate || 'null (rejected or missing)';
        if (!a.publishedDate) nulled++;
        console.log(`${i + 1}. [${dateStr}] ${a.title}`);
      });

      console.log(`\n${nulled} of ${Math.min(articles.length, 20)} shown articles have publishedDate = null`);
      console.log(`(Check the [DateSanitize] log lines above for exactly which ones got rejected and why)`);

    } catch (err) {
      console.error(`Error testing ${source}:`, err.message);
    }
  }
};

run();