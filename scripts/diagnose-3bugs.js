require('dotenv').config();
const { extractIntent, getAllCompanies } = require('../modules/decisionIntelligenceV2/sec/secRetrieval');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

(async () => {
  console.log('═══════════════════════════════════════');
  console.log('1. EXTRACTION TEST');
  console.log('═══════════════════════════════════════');

  const cases = [
    'Williams-Sonoma 2025 revenue',
    'J.M. Smucker 2025 revenue',
    'are you sure about revenue',
  ];

  for (const q of cases) {
    const intent = await extractIntent(q, getAllCompanies);
    console.log('');
    console.log(`Q: "${q}"`);
    console.log(`   tickers: [${intent.tickers.join(', ')}]`);
    console.log(`   metric:  ${intent.metric}`);
    console.log(`   years:   [${intent.allYears.join(', ')}]`);
    console.log(`   category: ${intent.questionCategory}`);
    console.log(`   isNumeric: ${intent.isNumericQuestion}`);
  }

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('2. DB FACTS FOR WSM & SJM');
  console.log('═══════════════════════════════════════');

  for (const ticker of ['WSM', 'WMB', 'SJM']) {
    const { data } = await supabase
      .from('financial_facts')
      .select('fiscal_year, metric_name, metric_value')
      .eq('ticker', ticker)
      .eq('metric_name', 'Revenue')
      .order('fiscal_year', { ascending: false })
      .limit(5);

    console.log('');
    console.log(`Ticker ${ticker} — Revenue facts:`);
    if (!data || data.length === 0) {
      console.log('   (none found)');
    } else {
      for (const row of data) {
        console.log(`   FY${row.fiscal_year}: $${(row.metric_value / 1e9).toFixed(2)}B`);
      }
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('3. QDRANT CHUNKS FOR WSM & SJM');
  console.log('═══════════════════════════════════════');

  for (const ticker of ['WSM', 'SJM']) {
    const { data } = await supabase
      .from('chunks_meta')
      .select('fiscal_year, item_code')
      .eq('ticker', ticker)
      .limit(10);

    console.log('');
    console.log(`Ticker ${ticker} — chunks_meta rows: ${data?.length || 0}`);
    if (data && data.length > 0) {
      const years = [...new Set(data.map(r => r.fiscal_year))];
      console.log(`   Years present: [${years.join(', ')}]`);
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('4. COMPANY NAMES IN DB');
  console.log('═══════════════════════════════════════');

  const { data: companies } = await supabase
    .from('companies')
    .select('ticker, company_name')
    .in('ticker', ['WSM', 'WMB', 'SJM']);

  for (const c of companies || []) {
    console.log(`  ${c.ticker}: "${c.company_name}"`);
  }

  process.exit(0);
})();