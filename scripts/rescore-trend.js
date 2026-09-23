// scripts/rescore-trend.js
// ===========================
// One-off: re-runs weekly scoring for a single client+module+industry,
// so trend_clusters and trend_snapshots reflect the corrected member
// count after a duplicate cleanup.
//
// Usage:
//   node scripts/rescore-trend.js <moduleId> <clientId> <industry>
//
// Example:
//   node scripts/rescore-trend.js \
//     2eb989fd-0ea0-4320-b73a-f7eb8b970473 \
//     19174b66-5ad9-44fa-8071-b30a90c15ea2 \
//     "Renewable Energy"

require('dotenv').config();
const { runWeeklyScoring } = require('../modules/trendClustering');

const [moduleId, clientId, industry] = process.argv.slice(2);

if (!moduleId || !clientId || !industry) {
  console.error('Usage: node scripts/rescore-trend.js <moduleId> <clientId> <industry>');
  process.exit(1);
}

(async () => {
  console.log('[Rescore] Running weekly scoring for:');
  console.log('  moduleId:', moduleId);
  console.log('  clientId:', clientId);
  console.log('  industry:', industry);
  console.log('');

  await runWeeklyScoring(moduleId, clientId, industry);

  console.log('');
  console.log('[Rescore] Done.');
  process.exit(0);
})().catch(err => {
  console.error('[Rescore] Failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});