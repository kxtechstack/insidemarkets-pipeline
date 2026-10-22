require('dotenv').config();
const { QdrantClient } = require('@qdrant/js-client-rest');

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const COLLECTION = process.env.SEC10K_QDRANT_COLLECTION || 'sec10k_chunks';

async function run() {
  for (const ticker of ['AAPL', 'AMZN']) {
    console.log(`\n=== Checking ${ticker} in ${COLLECTION} ===`);
    
    const total = await qdrant.count(COLLECTION, {
      filter: { must: [{ key: 'ticker', match: { value: ticker } }] },
      exact: true,
    });
    console.log(`Total chunks for ${ticker}: ${total.count}`);

    if (total.count > 0) {
      // Sample the first 5 to see their item_code and fiscal_year
      const sample = await qdrant.scroll(COLLECTION, {
        filter: { must: [{ key: 'ticker', match: { value: ticker } }] },
        limit: 5,
        with_payload: true,
      });

      for (const p of sample.points || []) {
        console.log(`  FY${p.payload.fiscal_year} | ${p.payload.item_code} | ${p.payload.title || p.payload.section_title || 'untitled'}`);
      }

      // Count by item_code
      const allPoints = await qdrant.scroll(COLLECTION, {
        filter: { must: [{ key: 'ticker', match: { value: ticker } }] },
        limit: 10000,
        with_payload: true,
      });

      const itemCodeCounts = {};
      const yearCounts = {};
      for (const p of allPoints.points || []) {
        const ic = p.payload.item_code || 'UNKNOWN';
        const fy = p.payload.fiscal_year || 'UNKNOWN';
        itemCodeCounts[ic] = (itemCodeCounts[ic] || 0) + 1;
        yearCounts[fy] = (yearCounts[fy] || 0) + 1;
      }
      console.log(`  By item_code: ${JSON.stringify(itemCodeCounts)}`);
      console.log(`  By fiscal_year: ${JSON.stringify(yearCounts)}`);
    }
  }

  process.exit(0);
}

run();