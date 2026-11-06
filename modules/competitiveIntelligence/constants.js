/**
 * modules/competitiveIntelligence/constants.js
 * Shared settings for Competitive Radar (CI). Change numbers here, not in the code.
 */

const CI_MODULE_ID = '5e953748-931d-4212-99e9-08c9a050cfef';

const LIMITS = {
  PRODUCTS_WANTED: 5,          // good product pages kept per competitor
  MAX_PRODUCT_CHECKS: 10,      // product pages opened per competitor during discovery
  MAX_FIRECRAWL_PER_RUN: 6,    // Firecrawl calls per competitor discovery (they cost credits)
  MAX_SITEMAP_FILES: 8,
  MAX_SITEMAP_URLS: 40000,
  FETCH_TIMEOUT_MS: 15000,
  FIRECRAWL_TIMEOUT_MS: 45000,
  PAUSE_BETWEEN_PAGES_MS: 300, // be polite to websites
  COPY_FROM_OTHER_CLIENT_DAYS: 30, // reuse another client's discovery if newer than this
  STUCK_FINDING_MINUTES: 15,   // a 'finding' status older than this is treated as stuck

  // ---- daily news run (news / own website / press) ----
  NEWS_FIRST_RUN_DAYS: 30,     // first run for a competitor looks back 30 days, so the tab is not empty
  NEWS_MIN_DAYS: 2,            // normal daily run looks back at least 2 days (overlap is safe: links are checked)
  NEWS_MAX_DAYS: 7,            // ...and at most 7 days, even if the server was off for longer
  NEWS_RESULTS_PER_SEARCH: 20, // links asked from Exa per search
  MAX_AI_READS_PER_SECTION: 15,      // articles the AI reads per competitor per section per run
  MAX_AI_READS_FIRST_RUN: 25,        // ...on the first (30 day) run
  MAX_FIRECRAWL_PER_NEWS_RUN: 3,     // press pages that block us
  ARTICLE_CHARS_FOR_AI: 6000,        // article text sent to the AI (start of the article)
  MIN_ARTICLE_CHARS: 400,            // less text than this = nothing to read
  MAX_EVENT_AGE_DAYS: 60,            // event older than this (vs article date) = history story, dropped
  MERGE_WINDOW_DAYS: 7,              // same competitor + same event within 7 days = one change
  MERGE_SIMILARITY_SAME_TYPE: 0.8,   // how alike two titles must be to join them (same change type)
  MERGE_SIMILARITY_ANY_TYPE: 0.9,    // ...or very alike, even if the AI picked another type
  RETRY_FAILED_DAYS: 7,              // articles that failed (AI down etc.) are tried again for 7 days
  QDRANT_MAX_ATTEMPTS: 3,            // after 3 failed writes to the chat database -> 'failed'
  RUN_STUCK_HOURS: 2,                // a 'running' run older than this is marked failed
};

// Prompts (rows in public.prompts). The text lives in the database, never in code.
const PROMPTS = {
  CHANGE_READER: 'ci_change_reader_v1',
};

// Qdrant: CI changes go into the same collection the DI chat searches
const QDRANT = {
  COLLECTION: process.env.POLICY_QDRANT_COLLECTION || 'policy_articles',
  INDEX_FIELDS: ['article_id', 'client_id', 'industry', 'module_id', 'change_id', 'submodule_id', 'signal_id',
    'competitor', 'competitor_id', 'category', 'importance', 'kind'],
};

// Never read as news (social media, shops, video)
const NEWS_SKIP_HOSTS = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'youtube.com', 'tiktok.com',
  'pinterest.com', 'reddit.com', 'quora.com', 'amazon.com', 'amazon.co.uk', 'amazon.in', 'ebay.com', 'ebay.co.uk',
];

// Never the competitor's own website (shops, social, media, wire services)
const SKIP_HOSTS = [
  'wikipedia.org', 'linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 'amazon.com', 'amazon.co.uk', 'amazon.in',
  'sephora.com', 'sephora.co.uk', 'ulta.com', 'macys.com', 'nordstrom.com', 'boots.com',
  'lookfantastic.com', 'cultbeauty.co.uk', 'johnlewis.com', 'selfridges.com', 'harrods.com', 'nykaa.com',
  'bloomberg.com', 'reuters.com', 'crunchbase.com', 'glassdoor.com', 'indeed.com', 'wwd.com',
  'allure.com', 'vogue.com', 'byrdie.com', 'cosmeticsdesign.com', 'cosmeticsbusiness.com',
  'fashionunited.com', 'beautypackaging.com', 'forbes.com', 'cnbc.com', 'ft.com', 'wsj.com',
  // press-release wire services: carry company news, but are NOT the company's site
  'businesswire.com', 'prnewswire.com', 'globenewswire.com', 'newswire.ca', 'newswire.com',
  'accesswire.com', 'einpresswire.com', 'prweb.com', 'marketscreener.com', 'finance.yahoo.com',
];

// Where company news usually lives
const PRESS_PATHS = [
  '/en/news', '/news', '/newsroom', '/en/newsroom', '/press', '/en/press',
  '/press-releases', '/en/press-releases', '/en/press-release', '/media', '/en/media',
  '/en/news-and-media/newsroom', '/en/group/news', '/en/media/press-releases',
];

// Client location -> which country version of a competitor's website to pick
const COUNTRY_PROFILES = [
  { key: 'uk', name: 'United Kingdom', match: /united kingdom|\buk\b|england|scotland|wales|london/i, tlds: ['co.uk', 'uk'], paths: ['en-gb', 'en_gb', 'uk', 'gb'], currency: 'GBP' },
  { key: 'in', name: 'India', match: /india|bengaluru|bangalore|mumbai|delhi|chennai|hyderabad|kochi/i, tlds: ['co.in', 'in'], paths: ['en-in', 'en_in', 'in'], currency: 'INR' },
  { key: 'sg', name: 'Singapore', match: /singapore/i, tlds: ['com.sg', 'sg'], paths: ['en-sg', 'en_sg', 'sg'], currency: 'SGD' },
  { key: 'my', name: 'Malaysia', match: /malaysia|kuala lumpur/i, tlds: ['com.my', 'my'], paths: ['en-my', 'en_my', 'my'], currency: 'MYR' },
  { key: 'ae', name: 'UAE', match: /united arab emirates|\buae\b|dubai|abu dhabi/i, tlds: ['ae'], paths: ['en-ae', 'en_ae', 'ae'], currency: 'AED' },
  { key: 'sa', name: 'Saudi Arabia', match: /saudi|riyadh|jeddah|\bksa\b/i, tlds: ['com.sa', 'sa'], paths: ['en-sa', 'en_sa', 'sa'], currency: 'SAR' },
  { key: 'au', name: 'Australia', match: /australia|sydney|melbourne/i, tlds: ['com.au', 'au'], paths: ['en-au', 'en_au', 'au'], currency: 'AUD' },
  { key: 'ca', name: 'Canada', match: /canada|toronto|vancouver/i, tlds: ['ca'], paths: ['en-ca', 'en_ca', 'ca'], currency: 'CAD' },
  { key: 'us', name: 'United States', match: /united states|\busa\b|\bu\.s\.|new york|california|texas/i, tlds: ['com'], paths: ['en-us', 'en_us', 'us'], currency: 'USD' },
];
const DEFAULT_COUNTRY = { key: 'global', name: '', tlds: ['com'], paths: [], currency: null };

// 2-letter country codes seen in website names (us.puma.com, burgerking.co.uk, nike.com/au/...)
const COUNTRY_CODES = new Set(('us uk gb au in ca sg my ae sa eu de fr es it pt nl be ch at se no dk fi ie pl cz jp cn kr hk tw ph id th vn nz za ng ke eg ma tr ru ua br mx ar cl co pe qa kw bh om pk bd lk gh').split(' '));
// 2-letter endings used as normal brand websites, not countries
const GENERIC_TLDS = new Set(['io', 'co', 'ai', 'me', 'tv', 'app', 'xyz', 'gg', 'ly', 'to', 'fm']);

module.exports = { CI_MODULE_ID, LIMITS, PROMPTS, QDRANT, NEWS_SKIP_HOSTS, SKIP_HOSTS, PRESS_PATHS, COUNTRY_PROFILES, DEFAULT_COUNTRY, COUNTRY_CODES, GENERIC_TLDS };