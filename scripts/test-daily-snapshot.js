require('dotenv').config();
const { buildDailySnapshot } = require('../modules/dailySnapshotBuilder');

const CLIENT_ID  = process.argv[2];
const INDUSTRY   = process.argv[3] || 'Renewable Energy';

if (!CLIENT_ID) {
  console.error('Usage: node scripts/test-daily-snapshot.js <clientId> [industry]');
  process.exit(1);
}

const MODULE_IDS = [
  '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960',
  '55c5ee19-bfca-468b-81b3-b89ca4f303c8',
  '2eb989fd-0ea0-4320-b73a-f7eb8b970473',
];

(async () => {
  for (const moduleId of MODULE_IDS) {
    console.log(`\n===== Building snapshot for module ${moduleId} =====`);
    const result = await buildDailySnapshot(CLIENT_ID, moduleId, INDUSTRY);
    console.log('Result:', result);
  }
  console.log('\nDone. Check public.daily_module_snapshots.');
  process.exit(0);
})();