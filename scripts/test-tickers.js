require('dotenv').config();
const { extractIntent, getAllCompanies } = require('../modules/decisionIntelligenceV2/sec/secRetrieval');

(async () => {
  const cases = [
    'IBM 2025 revenue',
    'ibm 2025 revenue',
    'AMD revenue 2024',
    'UPS revenue',
    'are you sure',
    'at what time',
    'on the market',
    'it services trends',
    'compare IBM and Microsoft revenue',
  ];

  for (const q of cases) {
    const intent = await extractIntent(q, getAllCompanies);
    console.log('[' + q + '] -> tickers: [' + intent.tickers.join(', ') + ']');
  }
  process.exit(0);
})();