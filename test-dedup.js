/**
 * test_dedup.js
 * ==============
 * Standalone test for topicDedup.js. Runs ~40 sample articles through the
 * REAL removeSameTopicArticles() function, using a fake client_id/module_id
 * so it never touches real data. Several clusters below are deliberately
 * "same story, different outlet" so you can see whether they get caught.
 *
 * USAGE (run from the app root, e.g. ~/app-test, so requires resolve):
 *   node test_dedup.js
 *
 * After the run, it deletes all test points it created from Qdrant so
 * nothing lingers in the dedup_titles collection.
 */

const { removeSameTopicArticles } = require('./modules/topicDedup');
const { QdrantClient } = require('@qdrant/js-client-rest');

const TEST_CLIENT_ID = 'test-client-dedup-run';
const TEST_MODULE_ID = 'test-module-dedup-run';

// ── Test data: 40 articles across clusters ──────────────────────────────
// Clusters marked [DUP-A], [DUP-B] etc. are the SAME underlying story,
// written differently (as if from different outlets). Everything else
// is meant to be genuinely distinct.

const articles = [
  // ---- Cluster DUP-A: Fed stress test results (3 versions) ----
  {
    title: "Fed's 2026 Stress Test Shows Banks Well Capitalized Despite Severe Scenario",
    text: "The Federal Reserve released results of its annual stress test on Wednesday, finding that the 32 largest US banks would remain well capitalized even under a severe hypothetical recession. The aggregate capital decline was smaller than in 2025, driven by higher net interest income across the sector.",
    url: "https://example-outlet-a.com/fed-stress-test-2026",
    publishedDate: "2026-08-25",
  },
  {
    title: "Large Banks Pass Federal Reserve Stress Test With Room to Spare",
    text: "All 32 banks subject to this year's Federal Reserve stress test cleared the bar comfortably, regulators said Wednesday. The projected drop in capital ratios was less severe than last year's exercise, a result analysts attributed to stronger net interest income.",
    url: "https://example-outlet-b.com/banks-pass-stress-test",
    publishedDate: "2026-08-25",
  },
  {
    title: "Banking Sector Resilience Confirmed in Latest Fed Capital Review",
    text: "In its yearly capital adequacy review, the Federal Reserve concluded that major US banks could withstand a severe economic downturn. This year's projected capital decline was smaller than 2025's, largely thanks to improved net interest margins.",
    url: "https://example-outlet-c.com/banking-resilience-fed-review",
    publishedDate: "2026-08-26",
  },

  // ---- Cluster DUP-B: Consumer fraud survey (2 versions) ----
  {
    title: "New Survey Finds 78 Million Americans Hit by Fraud in 2024",
    text: "A new module of the CFPB's Making Ends Meet Survey shows roughly 78 million US adults experienced fraud or a scam last year, with online shopping and phishing scams among the most common. Total exposure before recovery reached over $67 billion.",
    url: "https://example-outlet-a.com/fraud-survey-2024",
    publishedDate: "2026-07-11",
  },
  {
    title: "Fraud Hit Nearly 1 in 3 US Adults Last Year, Consumer Survey Shows",
    text: "According to newly released survey data, close to 78 million adults in the United States were victims of fraud or scams in 2024. Phishing and online shopping scams ranked among the top categories, with total losses before recovery exceeding $67 billion.",
    url: "https://example-outlet-d.com/consumer-fraud-nearly-third",
    publishedDate: "2026-07-12",
  },

  // ---- Cluster DUP-C: GSIB surcharge proposal (2 versions) ----
  {
    title: "Regulators Propose Changes to GSIB Surcharge Calculation",
    text: "Federal banking regulators unveiled a proposal Tuesday to revise how the GSIB surcharge is calculated for the largest global banks, aiming to reduce volatility in year-over-year capital requirements.",
    url: "https://example-outlet-b.com/gsib-surcharge-proposal",
    publishedDate: "2026-08-27",
  },
  {
    title: "New Rule Proposed for Calculating Global Systemically Important Bank Surcharges",
    text: "US regulators on Tuesday proposed a rule change to the methodology used for setting capital surcharges on globally systemically important banks, intended to smooth out swings in requirements from year to year.",
    url: "https://example-outlet-c.com/gsib-surcharge-methodology",
    publishedDate: "2026-08-27",
  },

  // ---- 33 distinct, unrelated articles ----
  {
    title: "Regional Bank Reports Record Quarterly Earnings",
    text: "A mid-sized regional bank posted its highest quarterly profit in company history, driven by strong loan growth and lower provisions for credit losses.",
    url: "https://example-outlet-a.com/regional-bank-earnings",
    publishedDate: "2026-07-15",
  },
  {
    title: "Central Bank Holds Interest Rates Steady at July Meeting",
    text: "Policymakers voted unanimously to keep the benchmark interest rate unchanged, citing mixed signals on inflation and labor market cooling.",
    url: "https://example-outlet-b.com/rates-steady-july",
    publishedDate: "2026-07-30",
  },
  {
    title: "Fintech Startup Raises $40M Series B for Payments Platform",
    text: "A payments-focused fintech company announced a $40 million Series B funding round led by a growth-equity firm, with plans to expand into new international markets.",
    url: "https://example-outlet-c.com/fintech-series-b",
    publishedDate: "2026-08-01",
  },
  {
    title: "Major Bank Faces Lawsuit Over Overdraft Fee Practices",
    text: "A class-action lawsuit filed this week alleges a large national bank charged customers overdraft fees in violation of its own disclosed policies.",
    url: "https://example-outlet-d.com/overdraft-lawsuit",
    publishedDate: "2026-08-02",
  },
  {
    title: "Credit Union Membership Grows 5% Year Over Year",
    text: "Industry data shows credit union membership nationwide grew by 5% compared to last year, outpacing growth at traditional retail banks.",
    url: "https://example-outlet-a.com/credit-union-growth",
    publishedDate: "2026-08-03",
  },
  {
    title: "Bank Announces Layoffs Amid Branch Consolidation",
    text: "A national bank confirmed plans to close 120 branches and reduce headcount by roughly 2% as part of a broader digital transformation strategy.",
    url: "https://example-outlet-b.com/bank-layoffs-branches",
    publishedDate: "2026-08-04",
  },
  {
    title: "New Data Privacy Rule Targets Financial Institutions",
    text: "A federal agency proposed new data privacy requirements specifically for financial institutions, focused on how customer transaction data is shared with third parties.",
    url: "https://example-outlet-c.com/data-privacy-rule-finance",
    publishedDate: "2026-08-05",
  },
  {
    title: "Mobile Banking App Outage Frustrates Customers Nationwide",
    text: "A major bank's mobile app experienced a multi-hour outage Tuesday, preventing customers from checking balances or making transfers.",
    url: "https://example-outlet-d.com/mobile-banking-outage",
    publishedDate: "2026-08-06",
  },
  {
    title: "Study Finds Rising Use of Buy Now, Pay Later Among Young Adults",
    text: "A new consumer finance study found that buy-now-pay-later usage has nearly doubled among adults under 30 over the past two years.",
    url: "https://example-outlet-a.com/bnpl-young-adults",
    publishedDate: "2026-08-07",
  },
  {
    title: "Bank Partners With University on Financial Literacy Program",
    text: "A regional bank announced a new partnership with a state university to offer free financial literacy courses to first-generation college students.",
    url: "https://example-outlet-b.com/bank-financial-literacy",
    publishedDate: "2026-08-08",
  },
  {
    title: "Commercial Real Estate Loan Defaults Tick Up in Q2",
    text: "Default rates on commercial real estate loans rose modestly in the second quarter, driven primarily by weakness in the office property sector.",
    url: "https://example-outlet-c.com/cre-defaults-q2",
    publishedDate: "2026-08-09",
  },
  {
    title: "Bank Launches AI-Powered Fraud Detection Tool",
    text: "A large bank unveiled a new machine-learning-based fraud detection system it says can flag suspicious transactions in real time with fewer false positives.",
    url: "https://example-outlet-d.com/ai-fraud-detection-launch",
    publishedDate: "2026-08-10",
  },
  {
    title: "Small Business Lending Rebounds After Slow Start to Year",
    text: "Small business loan originations picked up in the second quarter after a sluggish start to 2026, according to new industry data.",
    url: "https://example-outlet-a.com/small-business-lending-rebound",
    publishedDate: "2026-08-11",
  },
  {
    title: "Bank Stock Rallies After Better-Than-Expected Earnings",
    text: "Shares of a major bank jumped 6% after the company reported earnings that beat analyst expectations on both revenue and profit.",
    url: "https://example-outlet-b.com/bank-stock-rally-earnings",
    publishedDate: "2026-08-12",
  },
  {
    title: "Consumer Watchdog Warns of Rise in Romance Scams",
    text: "A consumer protection agency issued a warning about a sharp increase in romance scams targeting older adults through social media and dating apps.",
    url: "https://example-outlet-c.com/romance-scam-warning",
    publishedDate: "2026-08-13",
  },
  {
    title: "Bank Expands Into New State With Branch Openings",
    text: "A regional bank announced plans to open 15 new branches in a neighboring state as part of its geographic expansion strategy.",
    url: "https://example-outlet-d.com/bank-expansion-new-state",
    publishedDate: "2026-08-14",
  },
  {
    title: "Report: Cybersecurity Spending by Banks Hits Record High",
    text: "Banks collectively spent a record amount on cybersecurity in the past year, according to a new industry report, as threats grow more sophisticated.",
    url: "https://example-outlet-a.com/cybersecurity-spending-record",
    publishedDate: "2026-08-15",
  },
  {
    title: "Bank Reverses Course on Controversial Fee Policy",
    text: "Following public backlash, a national bank announced it would reverse a recently introduced fee on certain checking accounts.",
    url: "https://example-outlet-b.com/bank-reverses-fee-policy",
    publishedDate: "2026-08-16",
  },
  {
    title: "Digital-Only Bank Surpasses 5 Million Customers",
    text: "A digital-only bank announced it has surpassed 5 million customers, citing growth in younger demographics drawn to no-fee accounts.",
    url: "https://example-outlet-c.com/digital-bank-5-million",
    publishedDate: "2026-08-17",
  },
  {
    title: "Bank Faces Regulatory Scrutiny Over Anti-Money Laundering Gaps",
    text: "A federal regulator flagged deficiencies in a large bank's anti-money laundering controls, ordering the institution to strengthen its compliance program.",
    url: "https://example-outlet-d.com/aml-regulatory-scrutiny",
    publishedDate: "2026-08-18",
  },
  {
    title: "Bank Introduces New High-Yield Savings Product",
    text: "A major bank launched a new high-yield savings account offering a competitive interest rate in an effort to attract deposits.",
    url: "https://example-outlet-a.com/high-yield-savings-launch",
    publishedDate: "2026-08-19",
  },
  {
    title: "Survey: Small Businesses Cite Access to Credit as Top Concern",
    text: "A new survey of small business owners found access to credit remains their top financial concern, ahead of inflation and labor costs.",
    url: "https://example-outlet-b.com/small-business-credit-survey",
    publishedDate: "2026-08-20",
  },
  {
    title: "Bank Settles Discrimination Lawsuit Over Lending Practices",
    text: "A national bank agreed to a multimillion-dollar settlement resolving allegations of discriminatory lending practices in several metro areas.",
    url: "https://example-outlet-c.com/lending-discrimination-settlement",
    publishedDate: "2026-08-21",
  },
  {
    title: "Bank Holding Company Announces Merger With Regional Rival",
    text: "Two regional bank holding companies announced a merger agreement that would create one of the largest banks in the southeastern United States.",
    url: "https://example-outlet-d.com/bank-merger-regional-rival",
    publishedDate: "2026-08-22",
  },
  {
    title: "New Study Links Financial Stress to Workplace Productivity Loss",
    text: "Researchers found a significant correlation between employee financial stress and reduced workplace productivity, based on survey data from over 5,000 workers.",
    url: "https://example-outlet-a.com/financial-stress-productivity",
    publishedDate: "2026-08-23",
  },
  {
    title: "Bank Pilots Blockchain-Based Settlement System",
    text: "A major bank began piloting a blockchain-based system for interbank settlements, aiming to reduce transaction times from days to minutes.",
    url: "https://example-outlet-b.com/blockchain-settlement-pilot",
    publishedDate: "2026-08-24",
  },
  {
    title: "Bank Reports Increase in Elder Financial Exploitation Cases",
    text: "A large bank reported a notable increase in flagged cases of elder financial exploitation over the past year, prompting new staff training initiatives.",
    url: "https://example-outlet-c.com/elder-financial-exploitation",
    publishedDate: "2026-08-25",
  },
  {
    title: "Bank Launches Green Bond Program to Fund Renewable Projects",
    text: "A bank announced a new green bond program aimed at financing renewable energy and sustainability projects for corporate clients.",
    url: "https://example-outlet-d.com/green-bond-program",
    publishedDate: "2026-08-26",
  },
  {
    title: "Bank Faces Criticism Over Slow Rollout of Fraud Refunds",
    text: "Consumer advocates criticized a bank for delays in refunding customers affected by a recent wave of fraudulent transactions.",
    url: "https://example-outlet-a.com/fraud-refund-delays",
    publishedDate: "2026-08-27",
  },
  {
    title: "Bank Expands Wealth Management Division With New Hires",
    text: "A bank announced the expansion of its wealth management division, adding a dozen senior advisors from competing firms.",
    url: "https://example-outlet-b.com/wealth-management-expansion",
    publishedDate: "2026-08-28",
  },
  {
    title: "Report: Bank Branch Closures Accelerate in Rural Areas",
    text: "A new report found bank branch closures have accelerated in rural communities over the past three years, raising concerns about banking access.",
    url: "https://example-outlet-c.com/rural-branch-closures",
    publishedDate: "2026-08-29",
  },
  {
    title: "Bank Unveils New Mobile Check Deposit Feature",
    text: "A regional bank rolled out an updated mobile check deposit feature that uses AI to detect and flag potentially fraudulent checks before processing.",
    url: "https://example-outlet-d.com/mobile-check-deposit-ai",
    publishedDate: "2026-08-30",
  },
  {
    title: "Bank CEO Testifies Before Congress on Consumer Protection",
    text: "The CEO of a major bank testified before a congressional committee on the institution's consumer protection practices and recent enforcement actions.",
    url: "https://example-outlet-a.com/ceo-congress-testimony",
    publishedDate: "2026-08-31",
  },
  {
    title: "Bank Reports Growth in International Remittance Volume",
    text: "A bank reported double-digit growth in international remittance transaction volume over the past year, citing expanded partnerships in Latin America.",
    url: "https://example-outlet-b.com/remittance-volume-growth",
    publishedDate: "2026-09-01",
  },
];

// ── Expected clusters (for scoring the test result) ─────────────────────
const expectedDuplicateGroups = [
  ["Fed's 2026 Stress Test Shows Banks Well Capitalized Despite Severe Scenario",
   "Large Banks Pass Federal Reserve Stress Test With Room to Spare",
   "Banking Sector Resilience Confirmed in Latest Fed Capital Review"],
  ["New Survey Finds 78 Million Americans Hit by Fraud in 2024",
   "Fraud Hit Nearly 1 in 3 US Adults Last Year, Consumer Survey Shows"],
  ["Regulators Propose Changes to GSIB Surcharge Calculation",
   "New Rule Proposed for Calculating Global Systemically Important Bank Surcharges"],
];

async function cleanupTestData() {
  const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY });
  try {
    await qdrant.delete('dedup_titles', {
      filter: { must: [{ key: 'client_id', match: { value: TEST_CLIENT_ID } }] },
    });
    console.log('\n[Cleanup] Removed all test points from dedup_titles.');
  } catch (err) {
    console.log('\n[Cleanup] Failed to clean up test points:', err.message);
  }
}

async function run() {
  console.log(`Running dedup test with ${articles.length} articles...\n`);

  const unique = await removeSameTopicArticles(articles, TEST_CLIENT_ID, TEST_MODULE_ID);

  console.log(`\n=== RESULT ===`);
  console.log(`Input: ${articles.length} articles`);
  console.log(`Kept as unique: ${unique.length}`);
  console.log(`Dropped as duplicates: ${articles.length - unique.length}`);

  console.log(`\n=== EXPECTED vs ACTUAL ===`);
  for (const group of expectedDuplicateGroups) {
    const keptFromGroup = group.filter(title => unique.some(a => a.title === title));
    const status = keptFromGroup.length === 1 ? 'PASS' : 'FAIL';
    console.log(`[${status}] Cluster of ${group.length} — kept ${keptFromGroup.length} (expected 1)`);
    group.forEach(t => {
      const wasKept = unique.some(a => a.title === t);
      console.log(`    ${wasKept ? 'KEPT   ' : 'dropped'} - "${t}"`);
    });
  }

  await cleanupTestData();
}

run().catch(err => {
  console.error('Test script failed:', err);
  process.exit(1);
});