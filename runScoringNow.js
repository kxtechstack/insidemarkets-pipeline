// runScoringNow.js
//
// Manually triggers runWeeklyScoring for a given module/client/industry,
// without needing to run the full /run pipeline. Useful after a bulk data
// correction (like reclassifyHorizons.js) so trend rings + snapshots pick
// up the fix immediately, instead of waiting for the next scheduled run.
//
// Usage: node runScoringNow.js <moduleId> <clientId> <industry>

require('dotenv').config();
const { runWeeklyScoring } = require('./modules/trendClustering');

const main = async () => {
  const [moduleId, clientId, industry] = process.argv.slice(2);
  if (!moduleId || !clientId || !industry) {
    console.error('Usage: node runScoringNow.js <moduleId> <clientId> <industry>');
    process.exit(1);
  }

  console.log(`\nRunning weekly scoring for module=${moduleId}, client=${clientId}, industry=${industry}...\n`);
  await runWeeklyScoring(moduleId, clientId, industry);
  console.log('\nDone.\n');

  process.exit(0);
};

main();