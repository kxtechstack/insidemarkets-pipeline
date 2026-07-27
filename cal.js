// testWeeklyScoring.js
require('dotenv').config();
const { runWeeklyScoring } = require('./modules/trendClustering');

const MODULE_ID = '2eb989fd-0ea0-4320-b73a-f7eb8b970473'; // Forward Outlook
const CLIENT_ID = 'ada4186b-6aee-4c68-97ac-7fdd96bb1ac0';  // Logistics test client
const INDUSTRY = 'Logistics';

const run = async () => {
  await runWeeklyScoring(MODULE_ID, CLIENT_ID, INDUSTRY);
  console.log('\nDone — check trend_snapshots in Supabase now.');
};

run();