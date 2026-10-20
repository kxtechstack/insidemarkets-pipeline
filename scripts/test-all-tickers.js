require('dotenv').config();
const { extractIntent, getAllCompanies } = require('../modules/decisionIntelligenceV2/sec/secRetrieval');

(async () => {
  const companies = await getAllCompanies();
  console.log('Total companies:', companies.length);

  const failures = [];
  const ambiguities = [];
  let ok = 0;

  for (const c of companies) {
    const question = `What is ${c.company_name} 2025 revenue?`;

    let intent;
    try {
      intent = await extractIntent(question, getAllCompanies);
    } catch (err) {
      failures.push({ ticker: c.ticker, name: c.company_name, reason: `threw: ${err.message}` });
      continue;
    }

    const tickers = intent.tickers || [];

    if (!tickers.includes(c.ticker)) {
      if (tickers.length > 0) {
        ambiguities.push({
          expected: c.ticker,
          name: c.company_name,
          got: tickers,
          question,
        });
      } else {
        failures.push({
          ticker: c.ticker,
          name: c.company_name,
          reason: 'no ticker matched at all',
        });
      }
    } else if (tickers.length > 1) {
      ambiguities.push({
        expected: c.ticker,
        name: c.company_name,
        got: tickers,
        question,
      });
      ok++;
    } else {
      ok++;
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('═══════════════════════════════════════════════');
  console.log(`Matched correctly (ticker found, possibly with extras): ${ok}`);
  console.log(`Total failures (ticker not found at all):               ${failures.length}`);
  console.log(`Ambiguities (matched + extras, or wrong company):       ${ambiguities.length}`);

  if (failures.length > 0) {
    console.log('');
    console.log('── FAILURES (no ticker matched) ──');
    failures.forEach(f => {
      console.log(`  ${f.ticker} (${f.name}): ${f.reason}`);
    });
  }

  if (ambiguities.length > 0) {
    console.log('');
    console.log('── AMBIGUITIES (matched, but suspicious) ──');
    ambiguities.forEach(a => {
      console.log(`  Expected ${a.expected} (${a.name})`);
      console.log(`    Got: [${a.got.join(', ')}]`);
      console.log(`    Q: "${a.question}"`);
      console.log('');
    });
  }

  process.exit(0);
})();