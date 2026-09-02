/**
 * test_dedup_real.js
 * ====================
 * Same as test_dedup.js, but built entirely from REAL rows pulled from
 * policy_signals and market_dynamics_signals -- not synthetic data.
 *
 * 7 known duplicate clusters (18 articles) + 18 genuinely distinct
 * real articles as a false-positive control group. 36 articles total.
 *
 * USAGE: node test_dedup_real.js   (run inside the app container)
 */

const { removeSameTopicArticles } = require('./modules/topicDedup');
const { QdrantClient } = require('@qdrant/js-client-rest');

const TEST_CLIENT_ID = 'test-client-dedup-real';
const TEST_MODULE_ID = 'test-module-dedup-real';

// Helper to map DB rows -> the {title, text, url, publishedDate} shape
// removeSameTopicArticles() expects.
const a = (signal_title, summary, source_url, published_date) => ({
  title: signal_title,
  text: summary,
  url: source_url,
  publishedDate: published_date,
});

const articles = [
  // ---- Cluster 1: Korea Cosmetics Law (3 real duplicates, from policy_signals) ----
  a(
    "Korea Enacts Dedicated Law to Boost Cosmetics Industry",
    "South Korea's National Assembly has passed a new law aimed at fostering the cosmetics sector, creating a dedicated legal framework separate from the existing Cosmetics Act. The legislation grants the Ministry of Health and Welfare formal authority to support the entire K-beauty ecosystem, including brand developers, manufacturers, packaging suppliers, raw material innovators, and distribution networks.",
    "https://example-a.com/korea-law-1", "2026-08-21"
  ),
  a(
    "Korea Enacts Dedicated Law to Boost Cosmetics Sector",
    "The Korean National Assembly has passed a new Act on the Fostering and Support of the Cosmetics Industry, creating a dedicated legal framework separate from the existing Cosmetics Act. This legislation aims to transform the cosmetics sector into a primary engine of national economic growth by providing targeted support for brand developers, manufacturers, packaging suppliers, raw material innovators, and distribution networks.",
    "https://example-b.com/korea-law-2", "2026-08-21"
  ),
  a(
    "Korea Enacts Dedicated Law to Boost Cosmetics Sector",
    "The Korean National Assembly has passed a new Act on the Fostering and Support of the Cosmetics Industry, establishing a legal framework aimed at accelerating the growth of the country's cosmetics sector. This legislation operates separately from the existing Cosmetics Act, which has historically focused on safety and compliance, and introduces a five-year strategic plan to nurture the industry.",
    "https://example-c.com/korea-law-3", "2026-08-21"
  ),

  // ---- Cluster 2: Venture Capital Beauty (2 real duplicates) ----
  a(
    "Venture Capital Persists in Beauty Despite a Shift Toward Debt Financing",
    "The piece discusses how venture capital remains active in the beauty industry, citing investments in brands such as Reale Actives, Halo, and Wonderskin. It notes that despite a slowdown from the DTC peak, firms like Insight Partners are still funding Series A rounds, underscoring sustained interest in early-stage beauty ventures.",
    "https://www.businessoffashion.com/articles/beauty/how-beauty-can-still-woo-venture-capital/", "2026-07-22"
  ),
  a(
    "Venture Capital Persists in Beauty, Even as DTC Brands Shift Toward Debt",
    "The piece highlights that venture capital remains active in the beauty sector, citing investments in Reale Actives and Halo, and noting Wonderskin's $50 million Series A round led by Insight Partners. It underscores that early-stage beauty brands can still secure funding even as the overall VC environment has cooled.",
    "https://www.businessoffashion.com/articles/beauty/how-beauty-can-still-woo-venture-capital/", "2026-07-22"
  ),

  // ---- Cluster 3: AmorePacific AI Research Hub (3 real duplicates) ----
  a(
    "Amorepacific Launches AI-Powered Research Hub to Accelerate Cosmetic Innovation",
    "Amorepacific partnered with KT to create the 'Data Highway' project, converting decades of R&I assets into an AI-ready data hub. The resulting AI Assistant LEMON, a large language model, dramatically reduces research and regulatory review times from days to minutes.",
    "https://www.apgroup.com/int/en/news/2026-07-28-1.html", "2026-07-28"
  ),
  a(
    "KT and Amorepacific Forge AI-Driven Research Hub to Accelerate Beauty Innovation",
    "KT and Amorepacific announced a new AI platform that converts decades of research data into searchable, AI-ready information. The platform, featuring an AI assistant called LEMON, enables researchers to query ingredients, formulations, and experimental results in minutes, dramatically reducing development time.",
    "https://www.koreatimes.co.kr/business/companies/20260728/kt-amorepacific-launch-ai-platform-to-speed-up-cosmetics-rd", "2026-07-28"
  ),
  a(
    "AmorePacific Accelerates R&D Digitalization with AI-Driven Data Hub",
    "AmorePacific has integrated its 70 years of R&D data into a standardized AI-ready format through the 'Data Highway' project with KT, creating the AI Assistant Lemon (LEMON). The platform enables researchers to search, analyze, and apply data across production, quality, and regulatory tasks, cutting review time from 12 days to 5 minutes in beta tests.",
    "https://www.mk.co.kr/en/business/12109453", "2026-07-28"
  ),

  // ---- Cluster 4: Asaya Series A (3 real duplicates) ----
  a(
    "Asaya Secures ₹88 Cr Series A to Double Revenue and Expand Omnichannel Presence",
    "Asaya, a digital skincare challenger, raised ₹88 crore in a Series A round led by RPSG Capital, valuing the company at ₹400 crore. The capital will be allocated to R&D, product expansion, geographic growth, quick-commerce distribution, offline retail partnerships, and team building.",
    "https://business-news-today.com/asaya-raises-rs-88cr-series-a-as-melanin-focused-skincare-expansion-accelerates/", "2026-08-30"
  ),
  a(
    "Asaya Secures ₹88 Cr in Series A, Accelerating Growth for Melanin-Focused Skincare",
    "Asaya, a Bengaluru-based D2C skincare brand founded in 2021, raised Rs 88 crore ($9.2 million) in a Series A round led by RPSG Capital with participation from OTP Ventures, Huddle Ventures, Hyperscale Ventures, and 72 Ventures. This is Asaya's second institutional fundraise in less than a year.",
    "https://beautymatter.com/articles/indian-skincare-brand-asaya-raises-9-2-million", "2026-08-27"
  ),
  a(
    "Asaya Secures ₹88 Cr Series A, Targets Offline Retail and Rapid Expansion",
    "Asaya, a direct-to-consumer skincare brand focused on melanin-rich skin, raised ₹88 crore from existing investors RPSG Capital, OTP Ventures, Huddle Ventures, Hyperscale Ventures, and 72 Ventures in a Series A round, valuing the company at ₹400 crore.",
    "https://technologytangle.com/2026/08/24/d2c-skincare-brand-asaya-bags-88-cr-eyes-offline-retail-entry", "2026-08-24"
  ),

  // ---- Cluster 5: Sarelly $3M Target (2 real duplicates) ----
  a(
    "Sarelly Secures $3 Million to Launch U.S. Expansion via Target Partnership",
    "Sarelly, a Mexican makeup and lifestyle label, announced a $3 million funding round aimed at powering its entry into the U.S. market, including a nationwide rollout in Target's Beauty Studio.",
    "https://www.businessoffashion.com/news/beauty/sarelly-target-beauty-studio-funding/", "2026-08-26"
  ),
  a(
    "Mexican Beauty Brand Sarelly Secures $3 Million to Launch U.S. Expansion via Target Partnership",
    "Sarelly, a Mexican beauty and lifestyle brand, announced a $3 million funding round to finance its nationwide rollout in Target's Beauty Studio across the United States.",
    "https://www.businessoffashion.com/news/beauty/sarelly-target-beauty-studio-funding/", "2026-08-26"
  ),

  // ---- Cluster 6: Be Clinical Seed (2 real duplicates) ----
  a(
    "Be Clinical Secures ₹21 Cr Seed Funding to Accelerate Evidence-Based Anti-Aging Skincare Expansion",
    "Be Clinical, founded by Hemangi Dhir, secured Rs. 21 crore in a seed round led by Sauce with participation from V3 Ventures and angel investors. The capital will be used to expand product innovation, scale manufacturing, and enter new markets in India.",
    "https://www.indianretailer.com/news/funding-alert-clinical-skincare-brand-be-clinical-secures-rs-21-cr-seed-investment", "2026-08-25"
  ),
  a(
    "Be Clinical Secures ₹21 Cr Seed Funding to Accelerate Evidence-Based Anti-Aging Skincare",
    "Be Clinical, an evidence-led skincare brand, raised Rs 21 crore in a seed round led by Sauce with participation from V3 Ventures and angel investors. The capital will be used to strengthen R&D, expand the clinical skincare portfolio, scale manufacturing, and support market expansion across India.",
    "https://economictimes.indiatimes.com/small-biz/sme-sector/be-clinical-raises-rs-21-crore-in-seed-round-led-by-sauce/articleshow/133453327.cms", "2026-08-24"
  ),

  // ---- Cluster 7: KKR / Ci Flavors (3 real duplicates) ----
  a(
    "KKR's Strategic Takeover of Ci Flavors Signals a New Era for Japan's Beauty Ecosystem",
    "KKR has agreed to acquire Ci Flavors, a leading Japanese cosmetics group, from all existing shareholders including its founder and other investors. Ci Flavors operates across haircare, skincare, body care and lifestyle categories and has a growing presence in Japan and overseas markets.",
    "https://www.premiumbeautynews.com/en/kkr-acquires-japanese-beauty-and,28082", "2026-08-27"
  ),
  a(
    "KKR Secures Majority Stake in Japan's Ci FLAVORS, Amplifying Its Beauty-Sector Footprint",
    "KKR has agreed to purchase the Japanese beauty and lifestyle platform Ci FLAVORS from L Catterton, with terms undisclosed. The deal is part of KKR's Asia Pacific private equity strategy and aims to accelerate Ci FLAVORS' growth, international expansion, and talent development.",
    "https://dealroom.co/news/146699-kkr-buys-japanese-beauty-platform-ci-flavors-from-l-catterton/", "2026-08-25"
  ),
  a(
    "KKR's Strategic Entry into Japan's Beauty Sector via Ci FLAVORS Acquisition",
    "KKR, together with L Catterton, has agreed to acquire Ci FLAVORS, a Japanese beauty and lifestyle brand platform, from its existing shareholders. The deal brings Ci FLAVORS under KKR's portfolio, expanding its presence in the Asian beauty market.",
    "https://www.barchart.com/story/news/4013473/kkr-acquires-leading-japanese-beauty-platform-ci-flavors", "2026-08-25"
  ),

  // ---- Control group: 18 genuinely distinct real articles ----
  a("Dollar Shave Club Expands into Women's Personal Care with Acquisition of Truly Beauty",
    "Dollar Shave Club, owned by Nexus Capital Management, has purchased viral body care brand Truly Beauty, adding its social selling expertise and retail presence to the company's direct-to-consumer subscription model.",
    "https://www.beautyindependent.com/truly-beauty-dollar-shave-club-ceo-larry-bodner-building-another-multi-brand-platform/", "2026-09-01"),
  a("Mike Lyons Takes the Helm at Truist – A Call for Rapid Transformation",
    "Mike Lyons, formerly CEO of Fiserv and president of PNC, has been named CEO of Truist, with his official start date on September 1, 2026. The appointment follows a period of investor pressure for a reset.",
    "https://www.bankingdive.com/news/mike-lyons-truist-ceo-banking-growth-profits-southeast/829310/", "2026-09-01"),
  a("e.l.f. Beauty's €1 bn Bet on rhode: Leveraging Sephora's European Footprint for Global Scale",
    "e.l.f. Beauty, after acquiring the rhode brand for up to $1 billion, will launch the brand in 19 European markets via Sephora starting September 30.",
    "https://business-news-today.com/why-e-l-f-beauty-is-using-sephora-exclusivity-to-make-its-1bn-rhode-bet-much-bigger/", "2026-09-01"),
  a("Capitolis Strengthens Tech Leadership with Murugan Manickam as CTO",
    "Capitolis, a financial technology firm, announced the appointment of Murugan Manickam as its Chief Technology Officer. Manickam will lead the global engineering organization and oversee the company's data and AI strategy.",
    "https://markets.businessinsider.com/news/stocks/capitolis-appoints-murugan-manickam-as-chief-technology-officer-1036511008", "2026-09-01"),
  a("Sheree Martin Breaks Glass Ceiling as NCBJ's First Female CEO",
    "Sheree Martin, who served as interim CEO since January 19, 2026, has been officially appointed as the chief executive officer of National Commercial Bank Jamaica Limited.",
    "https://www.jamaicaobserver.com/2026/08/31/sheree-martin-named-first-female-ceo-ncbj-effective-sept-1/", "2026-09-01"),
  a("Skyline Beauty Group Accelerates Portfolio Expansion with Lumin and Meridian Deal",
    "Skyline Beauty Group has purchased Lumin and Meridian from Pangaea Holdings, adding brands that generated $35 million in sales last year.",
    "https://www.beautyindependent.com/skyline-beauty-group-acquires-lumin-meridian-accelerates-dealmaking/", "2026-09-01"),
  a("L'Oréal's AI-Driven Expansion with Nvidia Accelerates Beauty Personalization",
    "L'Oreal has broadened its cooperation with Nvidia, applying the NVIDIA Alchemy AI simulation platform to accelerate ingredient and formula testing in virtual environments.",
    "https://www.mk.co.kr/en/business/12140435", "2026-08-31"),
  a("SoFi Technology Solutions Positions Itself as the \"AWS of Finance\" Under New Leadership",
    "SoFi Technology Solutions has hired former Visa executive Kathleen Pierce-Gilmore as president. She plans to position the company as the \"AWS of finance.\"",
    "https://www.pymnts.com/news/payments-innovation/2026/sofi-tech-solutions-new-president-is-building-the-aws-of-finance/", "2026-08-31"),
  a("Rocket Companies Appoints Meta-Veteran Alessio Sanfilippo as Redfin CEO to Drive AI-Powered Homeownership",
    "Rocket Companies announced that Alessio Sanfilippo, formerly a Meta executive, will serve as Chief Executive Officer of Redfin effective immediately.",
    "https://aijourn.com/rocket-companies-names-alessio-sanfilippo-chief-executive-officer-of-redfin/", "2026-08-31"),
  a("Informed Appoints Veteran Fintech Executive Daniel Sogorka to Drive AI-Enabled Fraud Defense and Market Expansion",
    "Informed, an AI-powered platform for lenders, announced that fintech veteran Daniel Sogorka will become its chief executive officer.",
    "https://www.prnewswire.com/news-releases/informed-names-daniel-sogorka-as-ceo-to-accelerate-ai-powered-fraud-protection-and-faster-funding-for-lenders-302864583.html", "2026-08-31"),
  a("Genpact Elevates Product Strategy with New Chief Product and Platform Officer",
    "Genpact announced the appointment of Priya Vijayarajendran, former ASAPP CEO, as its Chief Product and Platform Officer and a member of the Leadership Council.",
    "https://www.prnewswire.com/news-releases/genpact-names-priya-vijayarajendran-chief-product-and-platform-officer-302864514.html", "2026-08-31"),
  a("Kimberly-Clark's $40 bn Kenvue Deal: EU Review Sets the Stage for a Consumer-Health Powerhouse",
    "Kimberly-Clark has formally requested European Commission approval for its $40bn purchase of Kenvue, a consumer-health company that owns brands such as Tylenol and Neutrogena.",
    "https://europeanbusinessmagazine.com/kimberly-clark-seeks-eu-approval/", "2026-08-28"),
  a("Domino Data Lab Elevates Thomas Robinson to CEO, Steering Enterprise AI Platform Expansion",
    "Domino Data Lab announced that former COO Thomas Robinson will become its CEO, replacing co-founder Nick Elprin who will serve as Chief Product Officer.",
    "https://www.prnewswire.com/news-releases/domino-appoints-thomas-robinson-ceo-to-lead-company-into-ai-solutions-era-302861277.html", "2026-08-27"),
  a("Honasa's Fluence Deal Collapse Highlights the Challenge of Merging Dermatology Credibility with Mass-Market Reach",
    "Honasa Consumer, the parent of Mamaearth, announced it had called off its proposed 58% stake purchase of Fluence Pharma due to unmet closing conditions.",
    "https://openthemagazine.com/business/honasas-fluence-deal-is-dead-is-its-inside-out-beauty-dream-still-alive", "2026-08-26"),
  a("UBA Appoints Emmanuel Nnorom as Chairman, Signaling Continuity of Pan-African Growth Strategy",
    "United Bank for Africa announced that Emmanuel Nnorom will take over as Group Chairman, succeeding Tony Elumelu after his 12-year tenure.",
    "https://shore.africa/2026/08/26/uba-welcomes-emmanuel-nnorom/", "2026-08-26"),
  a("Marqeta Strengthens Product Leadership with Eugenia Gibbons' Appointment",
    "Marqeta, a modern card issuing platform, announced that Eugenia Gibbons will become its Chief Product Officer effective August 31, 2026.",
    "https://globalfintechseries.com/banking/digital-payments/marqeta-announces-appointment-of-eugenia-gibbons-as-chief-product-officer/", "2026-08-25"),
  a("Regent's Strategic Move: Reuniting Avon's North American Units and Appointing a New CEO",
    "Investment firm Regent announced the purchase of Avon North America's U.S. and Canada operations, bringing them under its portfolio alongside Avon International.",
    "https://www.businessoffashion.com/news/beauty/avon-north-america-acquired-by-regent-appoints-new-ceo/", "2026-08-25"),
  a("TowerBrook's Bet on Rael Signals a Shift Toward Clean, Premium Period Care",
    "TowerBrook Capital Partners has invested in Rael, a premium period-care brand, to help the company scale across channels and geographies.",
    "https://orbit.beautyindependent.com/article/towerbrook-invests-rael-period-care-challenger", "2026-08-25"),
];

// ── Expected clusters (title used to identify each) ────────────────────
const expectedDuplicateGroups = [
  {
    name: "Korea Cosmetics Law",
    titles: [
      "Korea Enacts Dedicated Law to Boost Cosmetics Industry",
      "Korea Enacts Dedicated Law to Boost Cosmetics Sector",
    ],
  },
  {
    name: "Venture Capital Beauty",
    titles: [
      "Venture Capital Persists in Beauty Despite a Shift Toward Debt Financing",
      "Venture Capital Persists in Beauty, Even as DTC Brands Shift Toward Debt",
    ],
  },
  {
    name: "AmorePacific AI Research Hub",
    titles: [
      "Amorepacific Launches AI-Powered Research Hub to Accelerate Cosmetic Innovation",
      "KT and Amorepacific Forge AI-Driven Research Hub to Accelerate Beauty Innovation",
      "AmorePacific Accelerates R&D Digitalization with AI-Driven Data Hub",
    ],
  },
  {
    name: "Asaya Series A",
    titles: [
      "Asaya Secures ₹88 Cr Series A to Double Revenue and Expand Omnichannel Presence",
      "Asaya Secures ₹88 Cr in Series A, Accelerating Growth for Melanin-Focused Skincare",
      "Asaya Secures ₹88 Cr Series A, Targets Offline Retail and Rapid Expansion",
    ],
  },
  {
    name: "Sarelly $3M Target",
    titles: [
      "Sarelly Secures $3 Million to Launch U.S. Expansion via Target Partnership",
      "Mexican Beauty Brand Sarelly Secures $3 Million to Launch U.S. Expansion via Target Partnership",
    ],
  },
  {
    name: "Be Clinical Seed",
    titles: [
      "Be Clinical Secures ₹21 Cr Seed Funding to Accelerate Evidence-Based Anti-Aging Skincare Expansion",
      "Be Clinical Secures ₹21 Cr Seed Funding to Accelerate Evidence-Based Anti-Aging Skincare",
    ],
  },
  {
    name: "KKR / Ci Flavors",
    titles: [
      "KKR's Strategic Takeover of Ci Flavors Signals a New Era for Japan's Beauty Ecosystem",
      "KKR Secures Majority Stake in Japan's Ci FLAVORS, Amplifying Its Beauty-Sector Footprint",
      "KKR's Strategic Entry into Japan's Beauty Sector via Ci FLAVORS Acquisition",
    ],
  },
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
  console.log(`Running REAL-DATA dedup test with ${articles.length} articles (7 known duplicate clusters + 18 distinct control articles)...\n`);

  const unique = await removeSameTopicArticles(articles, TEST_CLIENT_ID, TEST_MODULE_ID);

  console.log(`\n=== RESULT ===`);
  console.log(`Input: ${articles.length} articles`);
  console.log(`Kept as unique: ${unique.length}`);
  console.log(`Dropped as duplicates: ${articles.length - unique.length}`);

  console.log(`\n=== EXPECTED vs ACTUAL (duplicate clusters) ===`);
  let allPassed = true;
  for (const group of expectedDuplicateGroups) {
    const keptFromGroup = group.titles.filter(title => unique.some(a => a.title === title));
    const status = keptFromGroup.length <= 1 ? 'PASS' : 'FAIL';
    if (status === 'FAIL') allPassed = false;
    console.log(`[${status}] ${group.name} (${group.titles.length} articles) — kept ${keptFromGroup.length} (expected 1)`);
    group.titles.forEach(t => {
      const wasKept = unique.some(a => a.title === t);
      console.log(`    ${wasKept ? 'KEPT   ' : 'dropped'} - "${t}"`);
    });
  }

  const clusterTitles = new Set(expectedDuplicateGroups.flatMap(g => g.titles));
  const controlArticles = articles.filter(a => !clusterTitles.has(a.title));
  const controlKept = controlArticles.filter(a => unique.some(u => u.title === a.title));
  console.log(`\n=== FALSE POSITIVE CHECK (control group) ===`);
  console.log(`${controlKept.length} / ${controlArticles.length} genuinely distinct articles kept (expected ${controlArticles.length}/${controlArticles.length})`);
  if (controlKept.length < controlArticles.length) {
    allPassed = false;
    const dropped = controlArticles.filter(a => !unique.some(u => u.title === a.title));
    console.log('False positives (distinct articles wrongly dropped):');
    dropped.forEach(a => console.log(`    - "${a.title}"`));
  }

  console.log(`\n=== OVERALL: ${allPassed ? 'PASS' : 'FAIL'} ===`);

  await cleanupTestData();
}

run().catch(err => {
  console.error('Test script failed:', err);
  process.exit(1);
});