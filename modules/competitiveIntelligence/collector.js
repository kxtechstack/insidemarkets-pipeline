/**
 * modules/competitiveIntelligence/collector.js
 *
 * STEP 1 of the daily news run: COLLECT articles for one competitor.
 * No AI here and nothing is saved here. It only answers:
 *   "which new articles are there about this competitor since the last run?"
 *
 *   news      -> Exa news search with the source's search sentence
 *   own_site  -> Exa search INSIDE the competitor's own website
 *   press     -> read the press list page and open the new posts
 *                (page blocked / no list page -> Exa search inside the press site)
 *
 * Every article comes back in the same shape:
 *   { url, title, text, publishedDate (ISO or null), section, sourceId, via }
 * plus "precheck" problems found by code (no date, too short, not about the brand...)
 * so the AI only reads articles that can really become a change.
 */

const cheerio = require('cheerio');
const { LIMITS, NEWS_SKIP_HOSTS } = require('./constants');
const {
  norm, nameKey, hostOf, rootDomain, clean, exaSearch, exaContents, fetchPage, looksSingleProduct, DATE_RE,
} = require('./webTools');

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** '2026-10-29', '29/10/2026', 'Oct 29, 2026', '29 October 2026' -> ISO, or null */
function parseLooseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let y; let m; let d;
  let x = t.match(/^(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
  if (x) { y = +x[1]; m = +x[2] - 1; d = +x[3]; }
  if (!x) {
    x = t.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})/);
    if (x) {
      const a = +x[1]; const b = +x[2];
      y = +x[3];
      if (b > 12) { m = a - 1; d = b; } else { d = a; m = b - 1; } // day first unless impossible (UK / India style)
    }
  }
  if (!x) {
    x = t.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (20\d{2})/);
    if (x && MONTHS[x[1].toLowerCase()] !== undefined) { m = MONTHS[x[1].toLowerCase()]; d = +x[2]; y = +x[3]; } else x = null;
  }
  if (!x) {
    x = t.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.? (20\d{2})/);
    if (x && MONTHS[x[2].toLowerCase()] !== undefined) { d = +x[1]; m = MONTHS[x[2].toLowerCase()]; y = +x[3]; } else x = null;
  }
  if (!x) {
    const p = Date.parse(t); // full ISO with time, e.g. 2026-10-29T08:00:00Z
    return Number.isNaN(p) ? null : checkDate(new Date(p));
  }
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  return checkDate(new Date(Date.UTC(y, m, d, 12)));
}

// never in the future (1 day grace for time zones), never before 2000
function checkDate(dt) {
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getTime() > Date.now() + 864e5) return null;
  if (dt.getUTCFullYear() < 2000) return null;
  return dt.toISOString();
}

// ---------------------------------------------------------------------
// Reading one article page (HTML) -> title, text, date
// ---------------------------------------------------------------------
function articleFromHtml(html) {
  const $ = cheerio.load(html);
  let date = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (date) return;
    try {
      const data = JSON.parse($(el).contents().text());
      const nodes = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
      for (const n of nodes) if (n && n.datePublished) { date = parseLooseDate(n.datePublished); if (date) break; }
    } catch (e) { /* broken JSON-LD */ }
  });
  const metas = ['meta[property="article:published_time"]', 'meta[name="article:published_time"]', 'meta[name="pubdate"]',
    'meta[name="publishdate"]', 'meta[name="date"]', 'meta[name="DC.date.issued"]', 'meta[itemprop="datePublished"]'];
  for (const sel of metas) {
    if (date) break;
    date = parseLooseDate($(sel).attr('content'));
  }
  if (!date) date = parseLooseDate($('time[datetime]').first().attr('datetime'));

  const title = clean($('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text(), 250);
  $('script, style, noscript, nav, header, footer, aside, form, iframe, svg, button').remove();
  const main = $('article').first().text().trim().length > 300 ? $('article').first()
    : ($('main').first().text().trim().length > 300 ? $('main').first() : $('body'));
  const text = main.text().replace(/\s+/g, ' ').trim();

  // last option: a date written near the top of the article
  if (!date) {
    const m = text.slice(0, 800).match(DATE_RE);
    if (m) date = parseLooseDate(m[0]);
  }
  return { title, text, date };
}

/** Open one article: our own load first (Firecrawl if blocked, within budget), then Exa. */
async function readArticle(url, budget, counter) {
  const page = await fetchPage(url, budget, counter);
  if (page.ok) {
    const a = articleFromHtml(page.html);
    if (a.text.length >= LIMITS.MIN_ARTICLE_CHARS) return { ...a, via: page.via };
  }
  const x = await exaContents(url, counter);
  return { title: clean(x.title, 250), text: (x.text || '').replace(/\s+/g, ' ').trim(), date: parseLooseDate(x.publishedDate), via: 'exa' };
}

// ---------------------------------------------------------------------
// Brand checks
// ---------------------------------------------------------------------
const GENERIC_WORDS = new Set(['the', 'and', 'beauty', 'group', 'company', 'companies', 'inc', 'ltd', 'plc', 'limited',
  'international', 'global', 'holdings', 'corp', 'corporation', 'brands', 'brand', 'cosmetics', 'paris', 'london', 'new', 'york']);

/** All the ways an article may write this competitor: name, search name, aliases, and a distinctive first word */
function brandTerms(comp) {
  const full = [comp.name, comp.search_name, ...(comp.aliases || [])].filter(Boolean);
  const terms = new Set(full.map((n) => nameKey(n)).filter((k) => k.length >= 3));
  // first word of the main name, if it is distinctive: 'ysl' for YSL Beauty, 'estee' for Estée Lauder
  // (not for 'New Balance' -> 'new', and never from aliases: 'Yves' would also match Yves Rocher)
  const first = norm(comp.name).split(/[^a-z0-9]+/).filter(Boolean)[0] || '';
  if (first.length >= 3 && !GENERIC_WORDS.has(first)) terms.add(first);
  return [...terms];
}

/** How many times the competitor is named in this text */
function brandMentions(text, terms) {
  const t = norm(text).replace(/[^a-z0-9]+/g, ' ');
  const squashed = t.replace(/ /g, '');
  let n = 0;
  for (const term of terms) {
    // multi-word names are matched without spaces ('esteelauder'), single words as whole words
    const re = new RegExp(`(^| )${term}( |$)`, 'g');
    const hits = (t.match(re) || []).length;
    n = Math.max(n, hits || (term.length >= 6 ? squashed.split(term).length - 1 : 0));
  }
  return n;
}

// ---------------------------------------------------------------------
// Code checks BEFORE the AI (saves AI calls, and keeps rubbish out)
// ---------------------------------------------------------------------
const LAUNCH_WORDS = /\b(new|launch|launches|launched|introduc|unveil|just (in|landed|dropped)|limited edition|now available|coming soon|exclusive)/i;

// a notice that only gives the date / time of results or a call, or says results are "on the website": not news
const DATE_NOTICE = /\b(announces?|sets?|schedules?|confirms?)\s+(the\s+)?(dates?|times?)\b|\bto (announce|report|release|host|discuss)\b[^.]{0,70}\b(results|earnings)\b[^.]{0,40}\b(on|in|at)\b|\b(conference call|webcast)\b|\b(declares?|announces?)\s+(a\s+)?(regular\s+|quarterly\s+|cash\s+)*dividend\b|\bresults available (on|at)\b|available on (the )?company'?s website|\bresults?\s+dates?\b|\b(earnings|results)\s+(release\s+)?(date|time|schedule)\b/i;
// share-market chatter: stock moves, analyst views, short interest. Never an action by the company.
const MARKET_CHATTER = /\bstocks?\b|\banalysts?\b|price targets?|short interest|52-week|\bnarratives?\b|\bETF\b|\b(call|put) options\b|\boptions (data|volume|activity|trading)\b|\binvestors? (buy|bought|purchase|sell|sold)\b|\bhedge funds?\b|\bshort sellers?\b/i;
// a headline that is a question ("Is X using Y to reframe its brand?") is commentary, not an announcement
// "Enphase Surges 9%, Sunrun Climbs 7%, SolarEdge Rallies 6% ..." = share-price round-up
const PRICE_MOVE = /\b(surges?|climbs?|rall(?:y|ies)|jumps?|spikes?|soars?|gains?|slips?|slides?|tumbles?|sinks?|plunges?|drops?|falls?)\s+\d+(?:\.\d+)?%/gi;
const isPriceRoundup = (t) => (t.match(PRICE_MOVE) || []).length >= 2 || ((t.match(PRICE_MOVE) || []).length >= 1 && /\b(rebound|rally|sell-?off|rout|shares|trading|premarket|pre-market)\b/i.test(t));
// "First Solar Jumps 9% After Democratic Sweep" = share price only. "Sunrun soars 7% as ... growth in Q3" = real results, keep.
const BUSINESS_NEWS = /\b(q[1-4]|quarter|results|earnings|revenue|sales|launch\w*|acquir\w*|deal|contract|order|opens?|plant|factory|layoffs?|recall)\b/i;
const isPriceOnly = (t) => (t.match(PRICE_MOVE) || []).length >= 1 && !BUSINESS_NEWS.test(t);
const isMarketChatter = (title) => { const t = String(title || ''); return MARKET_CHATTER.test(t) || isPriceRoundup(t) || isPriceOnly(t) || /\?\s*(\|.*)?$/.test(t.trim()); };
 // ---------------------------------------------------------------------
// LANGUAGE (quality filter, before the AI): only English articles are read
// Not English = a lot of non-Latin script (Japanese, Chinese, Korean, Cyrillic, Arabic, Thai...)
// or too few common English words in the first ~300 words (Spanish, French, German, Italian, Indonesian...).
// ---------------------------------------------------------------------
const NON_LATIN = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0e00-\u0e7f\u0900-\u097f]/g;
const EN_COMMON = new Set(['the', 'and', 'of', 'to', 'in', 'for', 'with', 'is', 'are', 'was', 'were', 'on', 'that', 'this', 'by', 'at', 'from', 'as', 'it', 'its', 'be', 'has', 'have', 'will', 'an', 'which', 'their', 'new']);
// Same check as the MD / PO / FO quality filter (modules/qualityFilter.js): franc-min on the article text,
// 'eng' or 'und' (undetermined) passes. The word count below is only the fallback if franc-min cannot load.
let francFn = null;
try { francFn = require('franc-min').franc || require('franc-min'); } catch (e) { francFn = null; }
function isEnglishArticle(title, text) {
  const body = String(text || title || '').trim();
  if (francFn && body.length >= 10) {
    try { const lang = francFn(body); return lang === 'eng' || lang === 'und'; } catch (e) { /* fall back below */ }
  }
  return isEnglishByWords(title, text);
}
function isEnglishByWords(title, text) {
  const sample = `${title || ''} ${String(text || '').slice(0, 2000)}`;
  const letters = (sample.match(/\p{L}/gu) || []).length || 1;
  if ((sample.match(NON_LATIN) || []).length / letters > 0.15) return false;
  const words = sample.toLowerCase().match(/\p{L}+/gu) || [];
  const first = words.slice(0, 300);
  if (first.length < 30) return true; // too short to judge - other checks decide
  return first.filter((w) => EN_COMMON.has(w)).length / first.length >= 0.08;
}
// own website "how to" / "best X" / guide pages are evergreen advice, never news
const isEvergreen = (url, title) => /(^|[\/-])(how-to|guide|guides|a-guide-to|tips|best|what-is|what-are|routine|ways-to|faq)([\/.-]|$)/i.test(String(url || '').replace(/^https?:\/\/[^/]+/, ''))
  || /^(how to|how do|what is|what are|why do|best |top \d+|\d+ (ways|tips)|a guide|the guide|your .{0,30}routine)/i.test(String(title || '').trim());
// job adverts: not news today (they are kept out until the hiring tracker is built)
const isJobPage = (url, title) => /^https?:\/\/(jobs|careers?)\./i.test(url || '') || /\/(jobs?|careers?|job-details?)\//i.test(url || '') || /\bjob details\b/i.test(title || '');
// a page that only lists articles ("Articles published by First Solar, Inc.", "Press releases", "News releases")
const LIST_PAGE_TITLE = /^(all |latest |recent )?(articles|news|stories|posts|press releases|news releases|announcements)( published)? (by|from|about|on)\b|^(press|news) releases?\s*(\||-|::|$)|^(newsroom|news|press releases?|news releases?)$/i;
const isDateNotice = (title) => DATE_NOTICE.test(String(title || ''));

// stock price / quote / analysis pages are never news
const STOCK_PAGE = /simplywall\.st|\/quote\/|tradingview\.com\/symbols|\/stock-reference|\/stock-price/i;

/** a year written as a folder in the link (/2011/...) that is older than the article year = an old page with a wrong date */
function oldYearInUrl(url, publishedDate) {
  const m = String(url).match(/\/((?:19|20)\d{2})(?=\/)/);
  if (!m) return null;
  const y = +m[1];
  const d = new Date(publishedDate);
  const py = d.getUTCFullYear();
  if (y < py && !(y === py - 1 && d.getUTCMonth() <= 1)) return y;
  return null;
}

/**
 * @returns {string|null} reason to drop, or null = send to the AI
 */
function precheck(item, comp, terms, since, opts = {}) {
  if (!item.url || !/^https?:/i.test(item.url)) return 'no link';
  const h = hostOf(item.url);
  if (NEWS_SKIP_HOSTS.some((s) => h === s || h.endsWith('.' + s))) return 'social media or shop page';
  if (!item.text || item.text.length < LIMITS.MIN_ARTICLE_CHARS) return 'too little text (page blocked or empty)';
  if (!isEnglishArticle(item.title, item.text)) return 'not in English';
  if (!item.publishedDate) return 'no date';
  if (!opts.ignoreAge && new Date(item.publishedDate).getTime() < new Date(since).getTime() - 864e5) return 'older than this run';
  if (STOCK_PAGE.test(item.url)) return 'stock price page, not news';
  if ((opts.ownSite || opts.ownBlog) && isEvergreen(item.url, item.title)) return 'how-to / guide page, not news';
  if (isJobPage(item.url, item.title)) return 'job advert, not news (for the hiring tracker later)';
  const oy = oldYearInUrl(item.url, item.publishedDate);
  if (oy) return `old page (the link says ${oy}) - history, not news`;
  if (isDateNotice(item.title)) return 'only gives the date of a results release or call - not news';
  if (isMarketChatter(item.title)) return 'share-market talk (stock, analysts) - not an action by the company';
  if (LIST_PAGE_TITLE.test(String(item.title || '').trim())) return 'a page that lists many articles, not one article';
  const mentions = brandMentions(`${item.title} ${item.text}`, terms);
  item.mentions = mentions;
  if (!opts.ownSite && !opts.ownBlog && mentions === 0) return 'competitor not named'; // own blog posts often do not repeat the company name
  // own website: a plain product page is not news unless it says it is new
  if (opts.ownSite && looksSingleProduct(item.url)) { // shop pages have no real news date, so they are never news
    return 'product page, not news';
  }
  return null;
}

// ---------------------------------------------------------------------
// Collect per section
// ---------------------------------------------------------------------
const fromExa = (r, section, sourceId) => ({
  url: r.url,
  title: clean(r.title, 250),
  text: (r.text || '').replace(/\s+/g, ' ').trim(),
  publishedDate: parseLooseDate(r.publishedDate),
  section,
  sourceId,
  via: 'exa',
});

async function collectNews(source, since, counter) {
  const res = await exaSearch(source.query_text, {
    startPublishedDate: since, numResults: LIMITS.NEWS_RESULTS_PER_SEARCH, category: 'news', text: true,
  }, counter);
  return res.map((r) => fromExa(r, 'news', source.id));
}

async function collectOwnSite(source, comp, since, counter) {
  const domain = source.domain || comp.shop_domain;
  if (!domain) return [];
  const res = await exaSearch(source.query_text, {
    includeDomains: [rootDomain(domain)], startPublishedDate: since, numResults: LIMITS.NEWS_RESULTS_PER_SEARCH, text: true,
  }, counter);
  // the site search came back full of job adverts -> one more search for news pages only
  const jobs = res.filter((r) => isJobPage(r.url, r.title)).length;
  if (res.length && jobs >= res.length / 2) {
    const more = await exaSearch(source.query_text, {
      includeDomains: [rootDomain(domain)], startPublishedDate: since, numResults: LIMITS.NEWS_RESULTS_PER_SEARCH, category: 'news', text: true,
    }, counter).catch(() => []);
    const seen = new Set(res.map((r) => r.url));
    res.push(...more.filter((r) => !seen.has(r.url) && !isJobPage(r.url, r.title)));
  }
  return res.map((r) => fromExa(r, 'own_site', source.id));
}

const SKIP_LINK = /\/(tag|tags|category|categories|page|author|search|login|account|subscribe|contact|careers?|jobs)(\/|$)|#|\.(jpg|jpeg|png|zip|mp4)$/i;

/** Links to single posts on a press list page, with the date written next to them (if any) */
function postLinksFromList(html, pageUrl) {
  const $ = cheerio.load(String(html).replace(/</g, ' <')); // space between tags, so 'Europe' + '29 Oct' do not stick together
  let base;
  try { base = new URL(pageUrl); } catch (e) { return []; }
  const listPath = base.pathname.replace(/\/$/, '');
  const out = new Map();
  $('a[href]').each((_, el) => {
    let u;
    try { u = new URL($(el).attr('href'), base); } catch (e) { return; }
    if (!/^https?:/.test(u.protocol) || rootDomain(u.hostname) !== rootDomain(base.hostname)) return;
    const path = u.pathname.replace(/\/$/, '');
    if (!path || path === listPath || SKIP_LINK.test(u.href) || path.split('/').filter(Boolean).length < 2) return;
    if (/[?&](page|year|filter|sort)=/i.test(u.search)) return;
    const text = clean($(el).text(), 250);
    // the date usually sits in the same card / row as the link
    let date = null;
    let node = $(el);
    for (let up = 0; up < 4 && !date; up++) {
      const t = node.text().replace(/\s+/g, ' ');
      if (t.length > 600) break;
      const m = t.match(DATE_RE);
      if (m) date = parseLooseDate(m[0]);
      node = node.parent();
    }
    const key = u.origin + path + u.search;
    const old = out.get(key);
    if (!old || (!old.date && date) || (old.text.length < text.length && !!date === !!old.date)) {
      out.set(key, { url: key, text: text || (old && old.text) || '', date: date || (old && old.date) || null });
    }
  });
  // real posts have a title-like link text
  const all = [...out.values()].filter((l) => l.text.length >= 15 || l.date);
  // a link that is the start of other links (e.g. /newsroom and /newsroom/press-releases/...) is a list page, not a post
  return all.filter((l) => !all.some((o) => o.url !== l.url && o.url.startsWith(l.url.replace(/\/$/, '') + '/')));
}

async function collectPressBySearch(source, comp, since, counter) {
  const host = hostOf(source.url) || source.domain;
  if (!host) return [];
  const res = await exaSearch(`${comp.search_name || comp.name} press release announcement news`, {
    includeDomains: [host], startPublishedDate: since, numResults: LIMITS.NEWS_RESULTS_PER_SEARCH, text: true,
  }, counter);
  return res.map((r) => ({ ...fromExa(r, 'press', source.id), via: 'exa_site_search' }));
}

/**
 * Press: read the list page, pick posts since `since`, open each post.
 * Falls back to an Exa search inside the press site when the page cannot be read.
 * @returns {{items, health: 'ok'|'blocked'|'empty', note}}
 */
async function collectPress(source, comp, since, maxItems, budget, counter) {
  const searchOnly = source.found_via === 'exa_site_search' || source.fetch_method === 'exa';
  if (!searchOnly) {
    const page = await fetchPage(source.url, budget, counter);
    if (page.ok) {
      const links = postLinksFromList(page.html, source.url);
      const sinceMs = new Date(since).getTime() - 864e5;
      const dated = links.filter((l) => l.date);
      // list shows dates -> take the new ones; no dates on the list -> open the first few and read their dates
      // no dates on the list: only links UNDER the list page (/news/xyz), not menu links (/about-us)
      const listPath = new URL(source.url).pathname.replace(/\/$/, '');
      const under = links.filter((l) => listPath && new URL(l.url).pathname.startsWith(`${listPath}/`));
      const pick = dated.length >= 3
        ? dated.filter((l) => new Date(l.date).getTime() >= sinceMs).sort((a, b) => b.date.localeCompare(a.date))
        : (under.length >= 3 ? under : links).slice(0, Math.min(8, maxItems));
      const items = [];
      for (const l of pick.slice(0, maxItems)) {
        const a = await readArticle(l.url, budget, counter);
        items.push({
          url: l.url, title: a.title || l.text, text: a.text, publishedDate: a.date || l.date,
          section: 'press', sourceId: source.id, via: `list+${a.via}`,
        });
      }
      if (links.length) return { items, health: 'ok', note: `${links.length} posts on the list, ${pick.length} new` };
    }
    // page blocked or changed -> search inside the press site instead (same day, no gap)
    const items = await collectPressBySearch(source, comp, since, counter);
    return { items, health: page.ok ? 'empty' : 'blocked', note: page.ok ? 'no post links on the page - used site search' : `page blocked (${page.error || page.status}) - used site search` };
  }
  const items = await collectPressBySearch(source, comp, since, counter);
  return { items, health: 'ok', note: 'site search' };
}

module.exports = { isEnglishArticle, isEvergreen,
  parseLooseDate, isDateNotice, isMarketChatter, articleFromHtml, readArticle, brandTerms, brandMentions, precheck,
  collectNews, collectOwnSite, collectPress, postLinksFromList,
};