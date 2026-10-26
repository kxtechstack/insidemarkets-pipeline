require('dotenv').config();
const { generateHighlight, generateBriefingFrame } = require('../modules/highlightGenerator');
const CLIENT_ID = '19174b66-5ad9-44fa-8071-b30a90c15ea2';
const INDUSTRY = 'Renewable Energy';
const MODULE_IDS = [
  '55c5ee19-bfca-468b-81b3-b89ca4f303c8', // Market Dynamics
  '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960', // Policy & Risk
  '2eb989fd-0ea0-4320-b73a-f7eb8b970473', // Forward Outlook
];

(async () => {
  for (const id of MODULE_IDS) {
    console.log(await generateHighlight(CLIENT_ID, id, INDUSTRY));
  }
    console.log(await generateBriefingFrame(CLIENT_ID));
  process.exit(0);
})();