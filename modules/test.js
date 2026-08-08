// test-insight-collection.js
require('dotenv').config();
const { setupInsightCentroidCollection } = require('./marketInsights'); // ADJUST PATH if needed

const run = async () => {
  console.log('Calling setupInsightCentroidCollection()...');
  await setupInsightCentroidCollection();
  console.log('Done. Check your Qdrant dashboard for a collection named "market_insights_centroids".');
};

run().catch(console.error);