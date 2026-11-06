/**
 * scripts/ci-reset-qdrant.js
 * Removes the CHAT copies (Qdrant) of this client's Competitive Intelligence changes,
 * so the DI chat does not keep old cards after ci_reset_test_client.sql.
 *
 * Run it on a machine that can reach Qdrant (your laptop got "fetch failed", so use the server):
 *   node scripts/ci-reset-qdrant.js 19174b66-5ad9-44fa-8071-b30a90c15ea2
 *
 * Only points with client_id = this client AND module_id = CI AND kind = 'change' are removed.
 */
try { require('dotenv').config(); } catch (e) { /* env already loaded */ }
const { QdrantClient } = require('@qdrant/js-client-rest');
const { CI_MODULE_ID, QDRANT } = require('../modules/competitiveIntelligence/constants');

const clientId = process.argv[2];
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId || '')) {
  console.error('Usage: node scripts/ci-reset-qdrant.js <client uuid>');
  process.exit(1);
}

(async () => {
  const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false, timeout: 30000 });
  const filter = {
    must: [
      { key: 'client_id', match: { value: clientId } },
      { key: 'module_id', match: { value: CI_MODULE_ID } },
      { key: 'kind', match: { value: 'change' } },
    ],
  };
  const before = await qdrant.count(QDRANT.COLLECTION, { filter, exact: true });
  console.log(`Chat copies found for this client: ${before.count}`);
  if (!before.count) return;
  await qdrant.delete(QDRANT.COLLECTION, { wait: true, filter });
  const after = await qdrant.count(QDRANT.COLLECTION, { filter, exact: true });
  console.log(`Left after delete: ${after.count}`);
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });