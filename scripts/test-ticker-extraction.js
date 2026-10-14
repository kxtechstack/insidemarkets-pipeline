/**
 * scripts/test-sector-normalization.js
 *
 * Verifies subsector resolver normalizations map the sector words we
 * expect to the correct allowlist tickers.
 */

const { findAllowlistTickers, NORMALIZE_SECTOR } = require('../modules/decisionIntelligenceV2/sec/subsectorResolver');

const CASES = [
  // input                           expected allowlist head
  { input: 'cosmetics',                expect: ['EL','ULTA','COTY'] },
  { input: 'cosmetic',                 expect: ['EL','ULTA','COTY'] },
  { input: 'beauty',                   expect: ['EL','ULTA','COTY'] },
  { input: 'beauty & personal care',   expect: ['EL','ULTA','COTY'] },
  { input: 'beauty and personal care', expect: ['EL','ULTA','COTY'] },
  { input: 'personal care',            expect: ['EL','ULTA','COTY'] },
  { input: 'banks',                    expect: ['JPM','BAC','WFC'] },
  { input: 'airlines',                 expect: ['DAL','UAL','AAL'] },
  { input: 'semiconductors',           expect: ['NVDA','AVGO','AMD'] },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const tickers = findAllowlistTickers(c.input);
  const ok = Array.isArray(tickers) && c.expect.every(t => tickers.includes(t));
  console.log(`${ok ? '✓' : '✗'}  "${c.input}" → [${(tickers || []).slice(0, 3).join(', ')}...]`);
  if (ok) pass++; else fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);