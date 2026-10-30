/**
 * modules/competitiveIntelligence/webTools.js
 *
 * Small, shared tools for reading the web. Used by discovery now,
 * and by the news / press / price runs later.
 *   - name + url helpers
 *   - fetchPage(): our own load, falls back to Firecrawl when blocked
 *   - exaSearch() / exaRead()
 *   - readPriceFromHtml(): TRUSTED prices only (JSON-LD or price tags, never plain text)
 */

const zlib = require('zlib');
const cheerio = require('cheerio');
const { LIMITS, SKIP_HOSTS, COUNTRY_PROFILES, DEFAULT_COUNTRY } = require('./constants');

// ---------------------------------------------------------------------
// Names + urls
// ---------------------------------------------------------------------
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// 'Estée Lauder' -> 'esteelauder'  (used for admin.competitors.name_key)
const nameKey = (s) => norm(s).replace(/[^a-z0-9]+/g, '');
const nameWords = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

const hostOf = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
};

// 'investors.elcompanies.com' -> 'elcompanies.com', 'lancome.co.uk' -> 'lancome.co.uk'
const TWO_PART_TLDS = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'com.sg', 'com.my', 'co.in', 'com.sa', 'com.br', 'com.hk', 'co.jp', 'co.kr', 'com.ph']);
const rootDomain = (host) => {
  const parts = String(host || '').replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return TWO_PART_TLDS.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
};
const sameSite = (a, b) => !!a && !!b && rootDomain(a) === rootDomain(b);
const isSkippedHost = (h) => SKIP_HOSTS.some((s) => h === s || h.endsWith('.' + s));

const clean = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daysAgoIso = (d) => new Date(Date.now() - d * 864e5).toISOString();

// Client location text ('London, United Kingdom') -> country profile
const countryProfileFor = (location) =>
  COUNTRY_PROFILES.find((p) => p.match.test(String(location || ''))) || DEFAULT_COUNTRY;

// ---------------------------------------------------------------------
// Call counter (so each run can log what it cost)
// ---------------------------------------------------------------------
function makeCounter() {
  return { exa: 0, firecrawl: 0 };
}

// ---------------------------------------------------------------------
// Exa
// ---------------------------------------------------------------------
async function exaPost(endpoint, body, counter) {
  if (counter) counter.exa++;
  const res = await fetch('https://api.exa.ai' + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.EXA_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Exa HTTP ${res.status}: ${raw.slice(0, 200)}`);
  return JSON.parse(raw);
}

async function exaSearch(query, opts = {}, counter) {
  const body = { query, numResults: opts.numResults || 10 };
  if (opts.includeDomains) body.includeDomains = opts.includeDomains;
  if (opts.startPublishedDate) body.startPublishedDate = opts.startPublishedDate;
  if (opts.category) body.category = opts.category;
  if (opts.highlights) body.contents = { highlights: true };
  const r = await exaPost('/search', body, counter);
  return r.results || [];
}

async function exaRead(url, counter) {
  try {
    const r = await exaPost('/contents', { urls: [url], text: true, maxAgeHours: 0 }, counter);
    return (r.results && r.results[0] && r.results[0].text) || '';
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------
// Load a page
// ---------------------------------------------------------------------
async function fetchDirect(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(LIMITS.FETCH_TIMEOUT_MS),
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
    await sleep(LIMITS.PAUSE_BETWEEN_PAGES_MS);
  }
}

// Bot-protection pages often come back as 200 with a "challenge" page
const looksBlocked = (r) => !r || !r.ok || r.text.length < 2000 ||
  /access denied|captcha|cf-chl|just a moment|attention required|request unsuccessful|incapsula|perimeterx/i
    .test(r.text.slice(0, 5000));

async function fetchFirecrawl(url, counter, attempt = 1) {
  if (!process.env.FIRECRAWL_API_KEY) return { ok: false, status: 0, text: '', error: 'FIRECRAWL_API_KEY missing' };
  if (counter && attempt === 1) counter.firecrawl++;
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
      body: JSON.stringify({ url, formats: ['rawHtml'], timeout: 30000 }),
      signal: AbortSignal.timeout(LIMITS.FIRECRAWL_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    // too many calls in one minute: wait and try again (max 3 times)
    if (res.status === 429 && attempt < 3) {
      await sleep(15000 * attempt);
      return fetchFirecrawl(url, counter, attempt + 1);
    }
    if (!res.ok || !data.success) return { ok: false, status: res.status, text: '', error: clean(data.error || JSON.stringify(data), 150) };
    return { ok: true, status: 200, text: (data.data && data.data.rawHtml) || '' };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.message };
  }
}

/**
 * Load a page as raw HTML. Tries our own load first, then Firecrawl if blocked
 * (only while the run's Firecrawl budget lasts).
 * @returns {{ok, html, via: 'direct'|'firecrawl'|'none', status, error}}
 */
async function fetchPage(url, budget, counter) {
  const direct = await fetchDirect(url);
  if (!looksBlocked(direct)) return { ok: true, html: direct.text, via: 'direct', status: direct.status };
  if (!budget || budget.firecrawl <= 0) return { ok: false, html: '', via: 'none', status: direct.status, error: 'blocked (no Firecrawl budget left)' };
  budget.firecrawl--;
  const fc = await fetchFirecrawl(url, counter);
  if (!fc.ok || fc.text.length < 2000) return { ok: false, html: '', via: 'firecrawl', status: direct.status, error: fc.error || 'blocked even for Firecrawl' };
  return { ok: true, html: fc.text, via: 'firecrawl', status: 200 };
}

// ---------------------------------------------------------------------
// Press list pages: 3+ different dates = a real list of posts
// ---------------------------------------------------------------------
const DATE_RE = /\b(?:20\d{2}[.\/-]\d{1,2}[.\/-]\d{1,2}|\d{1,2}[.\/-]\d{1,2}[.\/-]20\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? 20\d{2}|\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* 20\d{2})\b/gi;

function countDates(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ');
  return { dates: new Set(text.match(DATE_RE) || []).size, textLength: text.length };
}

// ---------------------------------------------------------------------
// Product pages
// ---------------------------------------------------------------------
const LIST_WORDS = /(catalog|best-?sellers?|collections?|categor|shop-?all|search|loyalty|account|store-?locator|gift-?guide|offers|new-and|new-now|featured|discover)/i;
const YEAR_ONLY = /^(19|20)\d{2}$/;

/** Does this address look like ONE product (not a list)? The page check later is the real proof. */
function looksSingleProduct(u) {
  let p;
  try { p = new URL(u).pathname.toLowerCase(); } catch (e) { return false; }
  if (/\/node\/\d+/.test(p)) return false;                 // CMS pages like /node/15378
  if (/\/(c|category|categories|articles?|blog|support|cshelp|help)\//.test(p)) return false; // asics.com/au/en-au/best-sellers/c/au80128000/
  if (/\/product\/\d+\/\d+/.test(p)) return true;           // Estee style: /product/689/77491/...
  const parts = p.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  if (LIST_WORDS.test(last)) return false;
  // Shopify / headless style: /products/pillow-talk-lipstick, /uk/product/magic-cream, /p/slug
  const prev = parts[parts.length - 2] || '';
  if (/^(products?|p)$/.test(prev) && /[a-z]/.test(last) && last.includes('-')) return true;
  const numbers = (last.match(/\d{4,}/g) || []).filter((n) => !YEAR_ONLY.test(n)); // '2014' is a year, not an id
  return numbers.length > 0;
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

function offersToVariants(offers, productName) {
  const out = [];
  for (const o of [].concat(offers || [])) {
    if (!o || typeof o !== 'object') continue;
    if (hasType(o, 'aggregateoffer')) {
      if (o.offers) out.push(...offersToVariants(o.offers, productName));
      continue; // a price RANGE is not one price - never stored
    }
    const raw = o.price ?? (o.priceSpecification && o.priceSpecification.price);
    const currency = o.priceCurrency ?? (o.priceSpecification && o.priceSpecification.priceCurrency);
    const price = Number(String(raw ?? '').replace(/,/g, ''));
    if (!(price > 0) || !currency) continue;
    const label = clean(o.name || o.size || '', 60) || null;
    out.push({
      variant_key: clean(o.sku || o.gtin13 || o.gtin || label || 'default', 80),
      variant_label: label,
      price,
      currency: String(currency).toUpperCase().slice(0, 3),
      price_text: String(raw),
    });
  }
  return out;
}

/**
 * TRUSTED prices only.
 * @returns {{status:'JSONLD_PRICE'|'META_PRICE'|'LIST_PAGE'|'NO_TRUSTED_PRICE', name?, variants?: [{variant_key, variant_label, price, currency, price_text}]}}
 */
function readPriceFromHtml(html) {
  const $ = cheerio.load(html);
  const nodes = jsonLdNodes($);
  const products = nodes.filter((n) => hasType(n, 'product') || hasType(n, 'productgroup'));
  // A product page often ALSO lists "you may also like" products. Find the page's own product:
  // the one whose name is in the page title / heading, or whose link is the page link.
  const title = nameKey(`${$('meta[property="og:title"]').attr('content') || ''} ${$('h1').first().text()} ${$('title').text()}`);
  const canonical = String($('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content') || '').replace(/[?#].*$/, '').replace(/\/$/, '');
  const pathOfU = (u) => { try { return new URL(u, 'https://x.y').pathname.replace(/\/$/, ''); } catch (e) { return ''; } };
  let main = null;
  if (products.length === 1) main = products[0];
  else if (products.length > 1) {
    main = (canonical && products.find((p) => (p.url || p['@id']) && pathOfU(p.url || p['@id']) === pathOfU(canonical)))
      || products.find((p) => p.name && nameKey(p.name).length >= 4 && title.includes(nameKey(p.name)))
      || null;
  }
  const hasItemList = nodes.some((n) => hasType(n, 'itemlist'));
  if (!main && (hasItemList || products.length > 1)) return { status: 'LIST_PAGE' };

  if (main) {
    const p = main;
    let variants = offersToVariants(p.offers, p.name);
    if (!variants.length && Array.isArray(p.hasVariant)) {
      for (const v of p.hasVariant) variants.push(...offersToVariants(v.offers, v.name || p.name));
    }
    // same variant twice -> keep first
    const seen = new Set();
    variants = variants.filter((v) => (seen.has(v.variant_key) ? false : seen.add(v.variant_key)));
    if (variants.length) return { status: 'JSONLD_PRICE', name: clean(p.name, 150), variants: variants.slice(0, 20) };
  }

  const metaPrice = $('meta[property="product:price:amount"]').attr('content')
    || $('meta[property="og:price:amount"]').attr('content')
    || $('[itemprop="price"]').attr('content');
  const metaCur = $('meta[property="product:price:currency"]').attr('content')
    || $('meta[property="og:price:currency"]').attr('content')
    || $('[itemprop="priceCurrency"]').attr('content');
  const price = Number(String(metaPrice || '').replace(/[^\d.]/g, ''));
  if (price > 0 && metaCur) {
    return {
      status: 'META_PRICE',
      name: clean($('meta[property="og:title"]').attr('content') || $('title').text(), 150),
      variants: [{ variant_key: 'default', variant_label: null, price, currency: String(metaCur).toUpperCase().slice(0, 3), price_text: String(metaPrice) }],
    };
  }
  const detail = products.length ? 'product data has no price + currency'
    : nodes.length ? `structured data without a product (${[...new Set(nodes.map((n) => [].concat(n['@type'] || '?')[0]))].slice(0, 4).join(', ')})`
      : 'no structured data on the page';
  return { status: 'NO_TRUSTED_PRICE', detail };
}

module.exports = {
  norm, nameKey, nameWords, hostOf, rootDomain, sameSite, isSkippedHost, clean, sleep, daysAgoIso,
  countryProfileFor, makeCounter,
  exaSearch, exaRead,
  fetchDirect, fetchFirecrawl, fetchPage, looksBlocked,
  DATE_RE, countDates, looksSingleProduct, readPriceFromHtml,
};