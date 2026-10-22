require('dotenv').config();
const { QdrantClient } = require('@qdrant/js-client-rest');

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const POLICY_COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';
const TEST_CLIENT_ID = 'b61b4d3b-caeb-457b-9971-636c83688ee4'; // YOUR CLIENT ID

async function checkKeywordInQdrant(keyword) {
  console.log(`\n🔍 Searching Qdrant (${POLICY_COLLECTION}) for: "${keyword}"...`);

  try {
    // 1. We do a scroll (get all points for this client) and filter manually
    // because Qdrant text search requires specific indexing.
    const scrollResult = await qdrant.scroll(POLICY_COLLECTION, {
      filter: {
        must: [
          { key: 'client_id', match: { value: TEST_CLIENT_ID } },
        ]
      },
      limit: 10000, // Get a large batch
      with_payload: true,
    });

    const points = scrollResult.points || [];
    console.log(`Fetched ${points.length} total chunks for this client from Qdrant.`);

    const matches = points.filter(p => {
      const title = (p.payload?.title || '').toLowerCase();
      const text = (p.payload?.chunk_text || '').toLowerCase();
      return title.includes(keyword.toLowerCase()) || text.includes(keyword.toLowerCase());
    });

    if (matches.length === 0) {
      console.log(`❌ NOT FOUND IN QDRANT: "${keyword}" does not exist in any chunk.`);
      console.log(`   (If the article is in Supabase but not Qdrant, the pipeline ingestion failed to embed it)`);
    } else {
      console.log(`✅ FOUND ${matches.length} MATCHES IN QDRANT:`);
      matches.forEach((m, i) => {
        console.log(`\n   [${i + 1}] ARTICLE_ID: ${m.payload.article_id}`);
        console.log(`       TITLE: "${m.payload.title}"`);
        console.log(`       DATE:  ${m.payload.published_date}`);
        // Print 100 chars around the keyword
        const text = m.payload.chunk_text || '';
        const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
        if (idx !== -1) {
          const start = Math.max(0, idx - 50);
          const end = Math.min(text.length, idx + 100);
          console.log(`       CONTEXT: "...${text.slice(start, end)}..."`);
        }
      });
    }

  } catch (err) {
    console.log(`❌ Qdrant connection error: ${err.message}`);
  }
}

async function run() {
  console.log(`Checking Client ID: ${TEST_CLIENT_ID}`);
  
  // The keywords we need to find
  await checkKeywordInQdrant('Operation Soundarya');
  await checkKeywordInQdrant('Cambodia');
  await checkKeywordInQdrant('eyeliner');
  
  process.exit(0);
}

run();