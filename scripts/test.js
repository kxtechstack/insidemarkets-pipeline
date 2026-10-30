/**
 * Competitive Radar - URL DISCOVERY test, VERSION 2 (LOCAL TEST ONLY, nothing goes to the database)
 *
 * Put this file at:  scripts/ci-discovery-test-v2.cjs
 * Run all:           node scripts/ci-discovery-test-v2.cjs
 * Run one:           node scripts/ci-discovery-test-v2.cjs lancome
 *
 * Needs in .env: EXA_API_KEY, FIRECRAWL_API_KEY. Uses cheerio (already in your project). Node 18+.
 * Results: printed on screen + saved in scripts/discovery-test-output-v2/
 *
 * What is new in v2 (what went wrong in v1, and the fix):
 *  1. v1 picked the first 3 country websites (USA, France, Japan).
 *     v2 picks the shop website for the CLIENT'S country first (UK -> .co.uk).
 *  2. v1 looked for press pages on shop websites. Shop websites have no press pages.
 *     v2 looks for a separate COMPANY website (for group brands: the parent, e.g. L'Oreal).
 *     It shows what it found by itself AND checks the company site we expect (as if the admin ticked it).
 *  3. v1 treated list pages (best sellers, collections) as product pages.
 *     v2 only keeps SINGLE product pages, and only trusts a price from the hidden
 *     Google data (JSON-LD) or price tags. Prices in plain text are NOT trusted
 *     (v1 found "pay in 4" amounts like $6.27 that look like real prices).
 *  4. v1 could not read Lancome / YSL (403 blocked).
 *     v2 tries Firecrawl for blocked pages (raw page, so the hidden price data is kept).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cheerio = require('cheerio');

try { require('dotenv').config(); } catch (e) { /* ok */ }
for (const k of ['EXA_API_KEY', 'FIRECRAWL_API_KEY']) {
  if (!process.env[k]) { console.error(`${k} not found in .env - add it and run again.`); process.exit(1); }
}

// ---------------------------------------------------------------
// 1. SETUP (edit freely)
// ---------------------------------------------------------------
const CLIENT = {
  name: 'Lumière Beauty Group',
  countryTlds: ['co.uk', 'uk'],          // preferred shop website endings
  countryPaths: ['en-gb', 'en_gb', 'uk', 'gb'], // preferred country folders inside a website
  expectedCurrency: 'GBP',
};

// expectCompany = the company/press website we EXPECT (what the admin would confirm).
// The script still tries to find one by itself first, and shows if it matched.
const COMPETITORS = [
  { name: 'Lancôme',      expectCompany: 'loreal.com' },        // L'Oreal brand
  { name: 'YSL Beauty',   expectCompany: 'loreal.com' },        // L'Oreal brand
  { name: 'Shiseido',     expectCompany: 'corp.shiseido.com' },
  { name: 'Estée Lauder', expectCompany: 'elcompanies.com' },
];

const PRODUCTS_WANTED = 5;        // stop when this many good product pages are found
const MAX_PRODUCT_CHECKS = 8;     // product pages opened per competitor
const MAX_FIRECRAWL_PER_COMP = 6; // Firecrawl calls per competitor (they cost credits)
const MAX_SITEMAP_FILES = 8;
const MAX_SITEMAP_URLS = 40000;
const TIMEOUT_MS = 15000;
const PAUSE_MS = 300;

const SKIP_HOSTS = [
  'wikipedia.org', 'linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 'amazon.com', 'amazon.co.uk',
  'sephora.com', 'sephora.co.uk', 'ulta.com', 'macys.com', 'nordstrom.com', 'boots.com',
  'lookfantastic.com', 'cultbeauty.co.uk', 'johnlewis.com', 'selfridges.com', 'harrods.com',
  'bloomberg.com', 'reuters.com', 'crunchbase.com', 'glassdoor.com', 'indeed.com', 'wwd.com',
  'allure.com', 'vogue.com', 'byrdie.com', 'cosmeticsdesign.com', 'cosmeticsbusiness.com',
  'businesswire.com', 'prnewswire.com', 'globenewswire.com', 'fashionunited.com', 'beautypackaging.com',
];

// Places where press/news usually lives on a company website
const PRESS_PATHS = [
  '/en/news', '/news', '/newsroom', '/en/newsroom', '/press', '/en/press',
  '/press-releases', '/en/press-releases', '/en/press-release', '/media', '/en/media',
  '/en/news-and-media/newsroom', '/en/group/news', '/en/media/press-releases',
];

// ---------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------
const OUT = path.join(__dirname, 'discovery-test-output-v2');
fs.mkdirSync(OUT, { recursive: true });

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '');
const nameWords = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (name, data) => fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(data, null, 2));
const daysAgoIso = (d) => new Date(Date.now() - d * 864e5).toISOString();
const isSkipped = (h) => SKIP_HOSTS.some((s) => h === s || h.endsWith('.' + s));

const DATE_RE = /\b(?:20\d{2}[.\/-]\d{1,2}[.\/-]\d{1,2}|\d{1,2}[.\/-]\d{1,2}[.\/-]20\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? 20\d{2}|\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* 20\d{2})\b/gi;

let exaCalls = 0;
let firecrawlCalls = 0;

async function exa(endpoint, body) {
  exaCalls++;
  const res = await fetch('https://api.exa.ai' + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.EXA_API_KEY },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Exa HTTP ${res.status} ${raw.slice(0, 200)}`);
  return JSON.parse(raw);
}

async function fetchRaw(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let body = buf;
    if (buf[0] === 0x1f && buf[1] === 0x8b) { try { body = zlib.gunzipSync(buf); } catch (e) { /* not gzip */ } }
    return { ok: res.ok, status: res.status, text: body.toString('utf8'), finalUrl: res.url || url };
  } catch (e) {
    return { ok: false, status: 0, text: '', finalUrl: url, error: e.message };
  } finally {
    await sleep(PAUSE_MS);
  }
}

// Bot-protection pages often come back as 200 with a "challenge" page
const looksBlocked = (r) => !r.ok || r.text.length < 2000 ||
  /access denied|captcha|cf-chl|just a moment|attention required|request unsuccessful|incapsula|perimeterx/i.test(r.text.slice(0, 5000));

// Raw page through Firecrawl (keeps <script> tags, so the hidden price data is kept)
async function firecrawlRawHtml(url) {
  firecrawlCalls++;
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
      body: JSON.stringify({ url, formats: ['rawHtml'], timeout: 30000 }),
      signal: AbortSignal.timeout(45000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) return { ok: false, status: res.status, text: '', error: clean(data.error || JSON.stringify(data), 150) };
    return { ok: true, status: 200, text: data.data?.rawHtml || '' };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.message };
  }
}

async function readViaExa(url) {
  try {
    const r = await exa('/contents', { urls: [url], text: true, maxAgeHours: 0 });
    return (r.results && r.results[0] && r.results[0].text) || '';
  } catch (e) { return ''; }
}

// ---------------------------------------------------------------
// 3. STEP 1 - shop website for the client's country
// ---------------------------------------------------------------
function brandScore(host, name) {
  const h = host.replace(/[^a-z0-9]/g, '');
  if (h.includes(slug(name))) return 3;
  return Math.min(2, nameWords(name).filter((w) => h.includes(w)).length);
}
const countryBonus = (host) => (CLIENT.countryTlds.some((t) => host.endsWith('.' + t)) ? 5 : host.endsWith('.com') ? 1 : 0);

async function findShopSite(c) {
  const r = await exa('/search', { query: `${c.name} official website`, numResults: 10 });
  const seen = new Map();
  for (const res of r.results || []) {
    const host = hostOf(res.url);
    if (!host || isSkipped(host) || seen.has(host)) continue;
    const b = brandScore(host, c.name);
    if (b === 0) continue;
    seen.set(host, { host, brand: b, country: countryBonus(host), total: b + countryBonus(host) });
  }
  const list = [...seen.values()].sort((a, b) => b.total - a.total);
  return { candidates: list, picked: list[0] ? list[0].host : null };
}

// ---------------------------------------------------------------
// 4. STEP 2 - company / press website
// ---------------------------------------------------------------
async function findCompanySiteAuto(c, shopHost) {
  const r = await exa('/search', { query: `${c.name} corporate newsroom press releases`, numResults: 10 });
  const shopRoot = shopHost ? shopHost.split('.').slice(-2)[0] : '';
  const seen = new Map();
  for (const res of r.results || []) {
    const host = hostOf(res.url);
    if (!host || isSkipped(host)) continue;
    let score = 0;
    if (/news|press|media|investor/i.test(res.url)) score += 2;
    if (/^(corp|group|investors?|media|press|news)\./.test(host)) score += 2;
    if (brandScore(host, c.name) > 0) score += 1;
    if (shopRoot && host.includes(shopRoot) && !/^(corp|group|investors?|media|press|news)\./.test(host)) score -= 1; // the shop itself
    const cur = seen.get(host);
    if (!cur || cur.score < score) seen.set(host, { host, score, example: res.url });
  }
  const list = [...seen.values()].filter((x) => x.score >= 2).sort((a, b) => b.score - a.score);
  return { candidates: list.slice(0, 5), picked: list[0] ? list[0].host : null };
}

async function checkPressList(url, allowExa) {
  const r = await fetchRaw(url);
  let text = '';
  let method = 'direct';
  if (!looksBlocked(r)) {
    const $ = cheerio.load(r.text);
    $('script, style, noscript').remove();
    text = $('body').text().replace(/\s+/g, ' ');
  }
  if (text.length < 500 && allowExa) { text = await readViaExa(url); method = text ? 'exa' : 'failed'; }
  const dates = [...new Set(text.match(DATE_RE) || [])];
  const status = dates.length >= 3 ? 'LIST_OK' : text.length < 500 ? 'BLOCKED_OR_EMPTY' : 'FEW_DATES';
  return { url, status, method, httpStatus: r.status, dates: dates.length };
}

async function findPressPage(companyHost) {
  const tried = [];
  let exaUsed = 0;
  for (const p of PRESS_PATHS) {
    const url = `https://${companyHost.startsWith('www.') || companyHost.split('.').length > 2 ? companyHost : 'www.' + companyHost}${p}`;
    const chk = await checkPressList(url, false);
    tried.push(chk);
    if (chk.status === 'LIST_OK') return { found: chk, tried };
  }
  // Nothing readable directly: read the first blocked ones through Exa
  for (const chk of tried.filter((t) => t.httpStatus === 403 || t.httpStatus === 200).slice(0, 2)) {
    exaUsed++;
    const again = await checkPressList(chk.url, true);
    tried.push({ ...again, retry: true });
    if (again.status === 'LIST_OK') return { found: again, tried };
  }
  return { found: null, tried };
}

// How many recent pages on the company site really mention THIS brand?
// (loreal.com writes about all L'Oreal brands, so this matters)
async function brandMentions(c, companyHost) {
  try {
    const r = await exa('/search', {
      query: `${c.name} announcement`,
      includeDomains: [companyHost],
      startPublishedDate: daysAgoIso(120),
      numResults: 10,
      contents: { highlights: true },
    });
    const words = [slug(c.name), ...nameWords(c.name)];
    const res = r.results || [];
    const hits = res.filter((x) => {
      const t = norm(`${x.title} ${(x.highlights || []).join(' ')}`).replace(/[^a-z0-9]/g, '');
      return words.some((w) => w && t.includes(w));
    });
    return { results: res.length, mentionBrand: hits.length, examples: hits.slice(0, 3).map((x) => clean(x.title, 90)) };
  } catch (e) { return { error: clean(e.message, 120) }; }
}

// ---------------------------------------------------------------
// 5. STEP 3 - single product pages + trusted price
// ---------------------------------------------------------------
const LIST_WORDS = /(catalog|best-?sellers?|collections?|categor|shop-?all|search|loyalty|account|store-?locator|gift-?guide|offers|new-and|new-now|featured|discover)/i;
function looksSingleProduct(u) {
  let p;
  try { p = new URL(u).pathname.toLowerCase(); } catch (e) { return false; }
  const last = p.split('/').filter(Boolean).pop() || '';
  // A product id at the end, or Estee-style /product/<num>/<num>/..., wins over list words in the folders.
  // (The real proof is later: the page's hidden data must describe ONE product, else it is marked LIST_PAGE.)
  if (/\/product\/\d+\/\d+/.test(p)) return true;
  if (LIST_WORDS.test(last)) return false;
  return /\d{4,}/.test(last) || /[a-z]+-\d{5,}\.html$/.test(last) || /\d{4,}\.html$/.test(last);
}
const preferCountryPath = (u) => (CLIENT.countryPaths.some((c) => u.toLowerCase().includes(`/${c}/`)) ? 1 : 0);

async function readSitemapProducts(domain) {
  const base = `https://www.${domain.replace(/^www\./, '')}`;
  const robots = await fetchRaw(base + '/robots.txt');
  let files = !looksBlocked({ ...robots, text: robots.text.padEnd(2000) }) ? [...robots.text.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1]) : [];
  if (!files.length) files = [base + '/sitemap.xml', base + '/sitemap_index.xml'];
  const prio = (f) => (/product|pdp|catalog/i.test(f) ? 2 : /news|blog|article|content|page/i.test(f) ? -1 : 0);
  const queue = [...files];
  const seen = new Set();
  const urls = [];
  let read = 0;
  let blocked = 0;
  while (queue.length && read < MAX_SITEMAP_FILES && urls.length < MAX_SITEMAP_URLS) {
    queue.sort((a, b) => prio(b) - prio(a));
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const r = await fetchRaw(f);
    read++;
    if (!r.ok) { blocked++; continue; }
    if (!/<loc/i.test(r.text)) continue;
    const locs = [...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => m[1].trim().replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(r.text)) queue.push(...locs);
    else urls.push(...locs);
  }
  return { filesRead: read, filesBlocked: blocked, urls };
}

function jsonLdNodes($) {
  const nodes = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    nodes.push(n);
    if (n['@graph']) walk(n['@graph']);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try { walk(JSON.parse($(el).contents().text())); } catch (e) { /* bad JSON on the page */ }
  });
  return nodes;
}
const hasType = (n, t) => [].concat(n['@type'] || []).some((x) => String(x).toLowerCase() === t);

function offersToPrices(offers) {
  const list = [].concat(offers || []);
  const out = [];
  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    if (hasType(o, 'aggregateoffer')) {
      if (o.lowPrice) out.push({ price: Number(o.lowPrice), currency: o.priceCurrency || null, note: 'lowest of range' });
      if (o.offers) out.push(...offersToPrices(o.offers));
      continue;
    }
    const price = o.price ?? o.priceSpecification?.price;
    const currency = o.priceCurrency ?? o.priceSpecification?.priceCurrency;
    const n = Number(String(price ?? '').replace(/,/g, ''));
    if (n > 0) out.push({ price: n, currency: currency || null, sku: o.sku || null, size: o.name || null });
  }
  return out;
}

function readPriceFromHtml(html) {
  const $ = cheerio.load(html);
  const nodes = jsonLdNodes($);
  const products = nodes.filter((n) => hasType(n, 'product') || hasType(n, 'productgroup'));
  const isList = nodes.some((n) => hasType(n, 'itemlist')) || new Set(products.map((p) => norm(p.name))).size > 1;
  if (isList) return { status: 'LIST_PAGE', products: products.length };

  if (products.length) {
    const p = products[0];
    let prices = offersToPrices(p.offers);
    if (!prices.length && Array.isArray(p.hasVariant)) for (const v of p.hasVariant) prices.push(...offersToPrices(v.offers));
    if (prices.length) return { status: 'JSONLD_PRICE', name: clean(p.name, 80), prices: prices.slice(0, 6) };
  }

  const metaPrice = $('meta[property="product:price:amount"]').attr('content')
    || $('meta[property="og:price:amount"]').attr('content')
    || $('[itemprop="price"]').attr('content');
  const metaCur = $('meta[property="product:price:currency"]').attr('content')
    || $('meta[property="og:price:currency"]').attr('content')
    || $('[itemprop="priceCurrency"]').attr('content');
  const n = Number(String(metaPrice || '').replace(/[^\d.]/g, ''));
  if (n > 0) return { status: 'META_PRICE', name: clean($('title').text(), 80), prices: [{ price: n, currency: metaCur || null }] };

  return { status: 'NO_TRUSTED_PRICE' };
}

async function checkProduct(url, budget) {
  const direct = await fetchRaw(url);
  if (!looksBlocked(direct)) return { url, via: 'direct', http: direct.status, ...readPriceFromHtml(direct.text) };
  if (budget.firecrawl <= 0) return { url, via: 'none', http: direct.status, status: 'BLOCKED_NO_BUDGET' };
  budget.firecrawl--;
  const fc = await firecrawlRawHtml(url);
  if (!fc.ok || fc.text.length < 2000) return { url, via: 'firecrawl', http: direct.status, status: 'BLOCKED_EVEN_FIRECRAWL', error: fc.error };
  return { url, via: 'firecrawl', http: direct.status, ...readPriceFromHtml(fc.text) };
}

// ---------------------------------------------------------------
// 6. Run one competitor
// ---------------------------------------------------------------
async function runCompetitor(c) {
  const exaStart = exaCalls;
  const fcStart = firecrawlCalls;
  const out = { competitor: c.name };
  console.log(`\n${'='.repeat(70)}\n${c.name}\n${'='.repeat(70)}`);

  // STEP 1 - shop website
  const shop = await findShopSite(c);
  out.shop = shop;
  console.log('STEP 1 - shop website (client country first)');
  for (const x of shop.candidates.slice(0, 6)) console.log(`   ${x.host.padEnd(26)} brand ${x.brand} + country ${x.country} = ${x.total}`);
  console.log(`   -> picked: ${shop.picked || '(none)'}`);

  // STEP 2 - company website + press page
  console.log('STEP 2 - company / press website');
  const auto = await findCompanySiteAuto(c, shop.picked);
  out.companyAuto = auto;
  console.log(`   found by itself: ${auto.picked || '(none)'}   candidates: ${auto.candidates.map((x) => `${x.host}(${x.score})`).join(', ') || '-'}`);
  console.log(`   expected:        ${c.expectCompany}   ${auto.picked === c.expectCompany ? 'MATCH' : 'DIFFERENT - admin would need to fix this'}`);

  out.press = {};
  for (const host of [...new Set([auto.picked, c.expectCompany].filter(Boolean))]) {
    const pr = await findPressPage(host);
    out.press[host] = pr;
    const f = pr.found;
    console.log(`   ${host}: ${f ? `LIST_OK ${f.dates} dates via ${f.method}  ${f.url}` : 'no readable press list page (tried ' + pr.tried.length + ')'}`);
  }
  const companyForMentions = c.expectCompany;
  out.brandMentions = await brandMentions(c, companyForMentions);
  const bm = out.brandMentions;
  console.log(`   recent pages on ${companyForMentions} that mention ${c.name}: ${bm.error ? 'ERROR ' + bm.error : `${bm.mentionBrand} of ${bm.results}`}`);
  for (const e of bm.examples || []) console.log(`      - ${e}`);

  // STEP 3 - products
  console.log('STEP 3 - single product pages + trusted price');
  if (!shop.picked) { out.stoppedAt = 'no shop website'; return out; }
  const sm = await readSitemapProducts(shop.picked);
  out.sitemap = { filesRead: sm.filesRead, filesBlocked: sm.filesBlocked, urls: sm.urls.length };
  const smSingles = sm.urls.filter(looksSingleProduct);
  console.log(`   sitemap: ${sm.urls.length} addresses (${sm.filesRead} files, ${sm.filesBlocked} blocked) -> ${smSingles.length} look like single products`);

  let exaSingles = [];
  try {
    const r = await exa('/search', { query: `${c.name} best selling product`, includeDomains: [shop.picked], numResults: 15 });
    exaSingles = (r.results || []).map((x) => x.url).filter(looksSingleProduct);
  } catch (e) { console.log(`   exa search failed: ${clean(e.message, 100)}`); }
  console.log(`   exa search inside ${shop.picked}: ${exaSingles.length} look like single products`);

  const candidates = [...new Set([
    ...exaSingles,
    ...smSingles.sort((a, b) => preferCountryPath(b) - preferCountryPath(a)),
  ])];
  out.productChecks = [];
  const budget = { firecrawl: MAX_FIRECRAWL_PER_COMP };
  let good = 0;
  for (const u of candidates.slice(0, MAX_PRODUCT_CHECKS)) {
    if (good >= PRODUCTS_WANTED) break;
    const chk = await checkProduct(u, budget);
    out.productChecks.push(chk);
    const okPrice = chk.status === 'JSONLD_PRICE' || chk.status === 'META_PRICE';
    if (okPrice) good++;
    const priceTxt = okPrice ? chk.prices.map((p) => `${p.currency || '?'} ${p.price}`).join(' / ') : '';
    const curFlag = okPrice && chk.prices.some((p) => p.currency && p.currency !== CLIENT.expectedCurrency) ? ' (not ' + CLIENT.expectedCurrency + ')' : '';
    console.log(`   ${String(chk.status).padEnd(22)} via ${chk.via.padEnd(9)} ${clean(priceTxt + curFlag, 34).padEnd(34)} ${clean(u, 110)}`);
  }
  if (!candidates.length) console.log('   (no single product pages found)');

  out.exaCalls = exaCalls - exaStart;
  out.firecrawlCalls = firecrawlCalls - fcStart;
  save(`v2-${slug(c.name)}`, out);
  return out;
}

// ---------------------------------------------------------------
// 7. Go
// ---------------------------------------------------------------
(async () => {
  const filter = process.argv.slice(2).map(slug);
  const list = filter.length ? COMPETITORS.filter((c) => filter.some((f) => slug(c.name).includes(f))) : COMPETITORS;
  if (!list.length) { console.error('No competitor matched. Names: ' + COMPETITORS.map((c) => c.name).join(', ')); process.exit(1); }

  console.log(`Client: ${CLIENT.name} | shop country: ${CLIENT.countryTlds.join('/')} | currency: ${CLIENT.expectedCurrency}`);
  const summary = [];
  for (const c of list) {
    try {
      const r = await runCompetitor(c);
      const count = (s) => (r.productChecks || []).filter((x) => x.status === s).length;
      summary.push({
        competitor: c.name,
        shopSite: r.shop?.picked || '-',
        companyAuto: r.companyAuto?.picked || '-',
        companyMatch: r.companyAuto?.picked === c.expectCompany ? 'yes' : 'no',
        pressPage: Object.values(r.press || {}).some((p) => p.found) ? 'found' : 'no',
        brandMentions: r.brandMentions?.error ? 'err' : `${r.brandMentions?.mentionBrand}/${r.brandMentions?.results}`,
        trustedPrices: count('JSONLD_PRICE') + count('META_PRICE'),
        listPages: count('LIST_PAGE'),
        noPrice: count('NO_TRUSTED_PRICE'),
        blocked: count('BLOCKED_EVEN_FIRECRAWL') + count('BLOCKED_NO_BUDGET'),
        viaFirecrawl: (r.productChecks || []).filter((x) => x.via === 'firecrawl').length,
        exa: r.exaCalls || 0,
        firecrawl: r.firecrawlCalls || 0,
      });
    } catch (e) {
      console.log(`   FAILED: ${clean(e.message, 200)}`);
      summary.push({ competitor: c.name, error: clean(e.message, 120) });
    }
  }
  console.log('\n\n===== SUMMARY =====');
  console.table(summary);
  save('summary', summary);
  console.log(`Total calls: Exa ${exaCalls}, Firecrawl ${firecrawlCalls}`);
  console.log(`Full details saved in: ${OUT}`);
})();
