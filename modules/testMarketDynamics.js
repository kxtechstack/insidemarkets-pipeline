require('dotenv').config();
const { processArticlesForRelevance, MARKET_DYNAMICS_MODULE_ID } = require('./llmRelevanceProcessor');

const CLIENT_ID = 'b61b4d3b-caeb-457b-9971-636c83688ee4'; // Lumière Beauty Group
const INDUSTRY = 'Cosmetics';
const SUBMODULE_ID = null; // batch-level param only, not used for actual classification

const fakeArticles = [
  // ── Funding rounds announced (enabled) — 4 articles, same topic, tests enrichment ──
  { title: 'Scalp-serum brand closes Series A', text: 'A clinical scalp-care startup raised $8M in a Series A round led by a health-focused VC fund, aiming to expand dermatologist-backed product lines.', url: 'https://example.com/1', publishedDate: '2026-07-20', author: 'Staff' },
  { title: 'Series B round closed for eco-friendly packaging startup', text: 'A sustainable cosmetics packaging company secured $15M to scale biodegradable polymer production facilities.', url: 'https://example.com/2', publishedDate: '2026-07-21', author: 'Staff' },
  { title: 'Pre-seed activity surges in personalized skincare diagnostics', text: 'Five early-stage skincare diagnostic startups closed pre-seed rounds this month, focused on AI-driven skin analysis.', url: 'https://example.com/3', publishedDate: '2026-07-22', author: 'Staff' },
  { title: 'Clean beauty brand raises Series C', text: 'A clean beauty label raised $22M in Series C funding to expand retail distribution across Southeast Asia.', url: 'https://example.com/4', publishedDate: '2026-07-23', author: 'Staff' },

  // ── Venture capital investments (enabled) — 4 articles ──
  { title: 'Average VC round size in beauty tech up 35% YoY', text: 'Analysts report beauty-tech VC round sizes grew 35% year over year, concentrated in dermatologist-backed formulation startups.', url: 'https://example.com/5', publishedDate: '2026-07-19', author: 'Staff' },
  { title: 'Late-stage VC capital concentrating in clean chemistry', text: 'Investors are favoring established clean-chemistry cosmetics brands over pre-revenue hype products in the current environment.', url: 'https://example.com/6', publishedDate: '2026-07-18', author: 'Staff' },
  { title: 'Corporate VC arms launch targeted beauty-tech funds', text: 'Major cosmetics incumbents are shifting from direct R&D to active early-stage VC investment in adjacent beauty-tech startups.', url: 'https://example.com/7', publishedDate: '2026-07-17', author: 'Staff' },
  { title: 'VC funding for fragrance-tech doubles', text: 'Venture funding into fragrance formulation technology has doubled over the past two quarters, per industry trackers.', url: 'https://example.com/8', publishedDate: '2026-07-16', author: 'Staff' },

  // ── Mergers & acquisitions (enabled) — 4 articles ──
  { title: 'PE buyout of heritage natural skincare brand finalized', text: 'A private equity buyout of a heritage natural skincare brand aims to optimize supply chain and expand digital distribution in APAC.', url: 'https://example.com/9', publishedDate: '2026-07-15', author: 'Staff' },
  { title: 'Major cosmetics group acquires indie fragrance house', text: 'A large cosmetics conglomerate announced the acquisition of a boutique fragrance house to expand its niche perfume portfolio.', url: 'https://example.com/10', publishedDate: '2026-07-14', author: 'Staff' },
  { title: 'Skincare roll-up firm buys three regional brands', text: 'A skincare roll-up company acquired three regional brands in a single week, consolidating market share in the mid-tier segment.', url: 'https://example.com/11', publishedDate: '2026-07-13', author: 'Staff' },
  { title: 'Haircare conglomerate merges with clean beauty label', text: 'Two mid-sized haircare and clean-beauty companies announced a merger to combine R&D and retail footprints.', url: 'https://example.com/12', publishedDate: '2026-07-12', author: 'Staff' },

  // ── Mass hiring initiatives (enabled) — 3 articles ──
  { title: 'Cosmetics brand announces 500 new retail hires', text: 'A major cosmetics retailer announced plans to hire 500 new staff across flagship stores in preparation for holiday season.', url: 'https://example.com/13', publishedDate: '2026-07-11', author: 'Staff' },
  { title: 'Beauty-tech firm doubles R&D headcount', text: 'A dermatology-tech company announced it will double its R&D headcount over the next two quarters to accelerate product development.', url: 'https://example.com/14', publishedDate: '2026-07-10', author: 'Staff' },
  { title: 'Skincare manufacturer opens new plant, hires 300', text: 'A skincare manufacturer opened a new production facility and is hiring 300 workers to meet rising demand.', url: 'https://example.com/15', publishedDate: '2026-07-09', author: 'Staff' },

  // ── GDP growth forecasts (enabled) — 3 articles ──
  { title: 'APAC GDP growth forecast raised for 2027', text: 'Economists raised APAC GDP growth forecasts for 2027, citing strong consumer spending in personal care categories.', url: 'https://example.com/16', publishedDate: '2026-07-08', author: 'Staff' },
  { title: 'UK GDP growth outlook steady amid consumer spending', text: 'The UK GDP growth outlook remained steady this quarter, supported by resilient consumer discretionary spending including beauty and personal care.', url: 'https://example.com/17', publishedDate: '2026-07-07', author: 'Staff' },
  { title: 'India GDP forecast revised upward', text: 'India\'s GDP growth forecast was revised upward, with analysts citing rising disposable income boosting premium cosmetics demand.', url: 'https://example.com/18', publishedDate: '2026-07-06', author: 'Staff' },

  // ── AI adoption (enabled) — 4 articles ──
  { title: 'Beauty brands roll out AI skin-analysis tools', text: 'Several major beauty brands launched AI-powered skin analysis tools in-store and online to personalize product recommendations.', url: 'https://example.com/19', publishedDate: '2026-07-05', author: 'Staff' },
  { title: 'AI-driven formulation shortens R&D cycles', text: 'Cosmetics R&D teams are adopting AI-driven formulation software, cutting new-product development cycles significantly.', url: 'https://example.com/20', publishedDate: '2026-07-04', author: 'Staff' },
  { title: 'Retailers deploy AI chatbots for beauty consultations', text: 'Major beauty retailers are deploying AI chatbots to handle virtual beauty consultations, reducing reliance on in-store staff.', url: 'https://example.com/21', publishedDate: '2026-07-03', author: 'Staff' },
  { title: 'AI adoption in supply chain forecasting grows', text: 'Cosmetics manufacturers are increasingly adopting AI for demand forecasting across their supply chains.', url: 'https://example.com/22', publishedDate: '2026-07-02', author: 'Staff' },

  // ── Cloud migration (enabled) — 3 articles ──
  { title: 'Global beauty retailer completes cloud migration', text: 'A global beauty retail chain completed migration of its inventory systems to the cloud, citing improved scalability during peak seasons.', url: 'https://example.com/23', publishedDate: '2026-07-01', author: 'Staff' },
  { title: 'Cosmetics ERP systems move to cloud-native platforms', text: 'Several mid-size cosmetics manufacturers are migrating legacy ERP systems to cloud-native platforms to improve supply chain visibility.', url: 'https://example.com/24', publishedDate: '2026-06-30', author: 'Staff' },
  { title: 'Beauty e-commerce platform shifts to multi-cloud', text: 'A leading beauty e-commerce platform announced a shift to a multi-cloud infrastructure to improve uptime during sales events.', url: 'https://example.com/25', publishedDate: '2026-06-29', author: 'Staff' },

  // ── NOT enabled for this client — should be rejected by scope validation ──
  { title: 'PE fund closes first beauty-tech vehicle', text: 'A regional private equity fund closed its first dedicated beauty-tech investment vehicle, expecting more diagnostics-led entrants.', url: 'https://example.com/26', publishedDate: '2026-06-28', author: 'Staff' }, // Private equity investments — disabled
  { title: 'Cosmetics sector sees early consolidation signals', text: 'Minor mergers and strategic repositioning among mid-tier cosmetics players suggest early sector consolidation.', url: 'https://example.com/27', publishedDate: '2026-06-27', author: 'Staff' }, // Market consolidation — disabled
  { title: 'Major cosmetics brand names new CMO', text: 'A leading cosmetics company appointed a new Chief Marketing Officer to lead its global brand strategy.', url: 'https://example.com/28', publishedDate: '2026-06-26', author: 'Staff' }, // CEO/CXO appointments — disabled
  { title: 'Central bank holds interest rates steady', text: 'The central bank held interest rates steady this quarter, citing balanced inflation and growth outlooks.', url: 'https://example.com/29', publishedDate: '2026-06-25', author: 'Staff' }, // Interest rate changes — disabled
];

(async () => {
  console.log(`Running Market Dynamics test with ${fakeArticles.length} fake articles for client ${CLIENT_ID}...\n`);
  const result = await processArticlesForRelevance(
    fakeArticles, CLIENT_ID, INDUSTRY, `test_job_${Date.now()}`, MARKET_DYNAMICS_MODULE_ID, SUBMODULE_ID
  );
  console.log('\n=== DONE ===', result);
  process.exit(0);
})();