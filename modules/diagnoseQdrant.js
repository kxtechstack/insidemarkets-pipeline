require('dotenv').config();
const { QdrantClient } = require('@qdrant/js-client-rest');

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const POLICY_COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';
const CLIENT_ID = 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const POLICY_MODULE_ID = '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960';

(async () => {
  // 1) Everything for this client_id + module_id, regardless of industry value —
  //    so we can see what industry strings actually got stored.
  const scrollResult = await qdrant.scroll(POLICY_COLLECTION, {
    filter: {
      must: [
        { key: 'client_id', match: { value: CLIENT_ID } },
        { key: 'module_id', match: { value: POLICY_MODULE_ID } },
      ],
    },
    limit: 100,
    with_payload: true,
    with_vector: false,
  });

  console.log(`\nTotal points found for this client+module: ${scrollResult.points.length}`);

  const industries = new Set();
  scrollResult.points.forEach(p => industries.add(p.payload.industry));
  console.log(`Distinct industry values stored: ${JSON.stringify([...industries])}`);

  console.log(`\nTitles found:`);
  scrollResult.points.forEach(p => {
    console.log(`  - "${p.payload.title}" | industry="${p.payload.industry}"`);
  });

  // 2) Specifically look for the China/Korea articles we know exist on the dashboard
  const targets = ['China Introduces New Cosmetics Launch', 'Korea Enacts Dedicated Law'];
  console.log(`\n--- Checking for known dashboard articles ---`);
  targets.forEach(t => {
    const found = scrollResult.points.filter(p => p.payload.title && p.payload.title.includes(t));
    console.log(`"${t}": ${found.length} match(es) in Qdrant for this client+module`);
  });
})();