/**
 * modules/competitiveIntelligence/discovery.js
 *
 * "Find sources" for ONE competitor. Runs once per competitor (on onboarding /
 * when a competitor is added / when the admin presses "Find sources again").
 * Daily and weekly runs later only USE what is saved here.
 *
 * Steps (same logic as scripts/ci-discovery-test-v2.cjs, with its fixes):
 *   0. If another client tracks the same brand in the same country and was
 *      discovered recently -> copy its result (no Exa / Firecrawl cost).
 *   1. Shop website  - Exa search by name, CLIENT-LOCATION country version first.
 *   2. Company site  - where press releases live (corp. / investors. / parent group).
 *                      Wire services are skipped. Not confident -> 'needs_check'.
 *   3. Press page    - common paths + in-site search; a real list = 3+ dates.
 *   4. Product pages - sitemap + in-site search; SINGLE product pages only;
 *                      kept only if a TRUSTED price (JSON-LD / price tags) is found.
 *   5. Save: admin.competitors (domains + status) and admin.competitor_sources.
 *
 * Nothing here writes changes/prices - that is the news/price runs (later steps).
 */

const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');
const { LIMITS, PRESS_PATHS, COUNTRY_CODES, GENERIC_TLDS } = require('./constants');
const {
  nameKey, nameWords, hostOf, rootDomain, sameSite, isSkippedHost, clean,
  countryProfileFor, makeCounter, exaSearch, exaRead, fetchDirect, fetchPage,
  looksBlocked, fetchFirecrawl, DATE_RE, daysAgoIso, countDates, looksSingleProduct, readPriceFromHtml,
} = require('./webTools');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = () => supabase.schema('admin');

// ---------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------
async function loadCompetitor(competitorId) {
  const { data, error } = await admin().from('competitors').select('*').eq('id', competitorId).single();
  if (error || !data) throw new Error(`competitor ${competitorId} not found: ${error && error.message}`);
  return data;
}

// Client location decides which country version of a competitor's site we use.
// Looks in admin.clients first, then the onboarding answers (client_icp).
const LOCATION_FIELDS = ['location', 'headquarters', 'hq_location', 'country', 'region', 'city'];
const pickLocation = (obj) => {
  if (!obj) return null;
  const parts = LOCATION_FIELDS.map((f) => obj[f]).filter((v) => typeof v === 'string' && v.trim());
  return parts.length ? parts.join(', ') : null;
};
async function getClientLocation(clientId) {
  const { data: client } = await admin().from('clients').select('*').eq('id', clientId).maybeSingle();
  const fromClient = pickLocation(client);
  if (fromClient) return fromClient;
  const { data: icp } = await admin().from('client_icp').select('context_json').eq('client_id', clientId).maybeSingle();
  return pickLocation(icp && icp.context_json);
}

async function setCompetitor(competitorId, fields) {
  const { error } = await admin().from('competitors').update(fields).eq('id', competitorId);
  if (error) throw new Error(`update competitor failed: ${error.message}`);
}

async function startRun(comp, triggeredBy) {
  const { data, error } = await supabase.from('competitor_runs').insert({
    client_id: comp.client_id,
    competitor_id: comp.id,
    section: 'discovery',
    triggered_by: triggeredBy,
    status: 'running',
  }).select('id').single();
  if (error) throw new Error(`competitor_runs insert failed: ${error.message}`);
  return data.id;
}

async function finishRun(runId, status, counts, errorMessage = null) {
  const { error } = await supabase.from('competitor_runs').update({
    status, counts, error_message: errorMessage, finished_at: new Date().toISOString(),
  }).eq('id', runId);
  if (error) console.error(`[CI discovery] finishRun failed: ${error.message}`);
}

/**
 * Save found sources. Rules:
 *  - match on (type + url) for links, (type) for searches
 *  - a source the ADMIN added or changed keeps its status (we only refresh health fields)
 *  - nothing is deleted
 */
const RETIRED_NOTE = 'Not found in the latest discovery (website changed) - switched off automatically.';

async function saveSources(comp, found) {
  const { data: existing, error } = await admin()
    .from('competitor_sources')
    .select('id, source_type, url, origin, status, last_error')
    .eq('competitor_id', comp.id);
  if (error) throw new Error(`read sources failed: ${error.message}`);

  const keyOf = (s) => `${s.source_type}|${s.url || ''}`;
  const byKey = new Map((existing || []).map((s) => [keyOf(s), s]));
  let inserted = 0;
  let updated = 0;

  for (const s of found) {
    const row = {
      competitor_id: comp.id,
      client_id: comp.client_id,
      source_type: s.source_type,
      url: s.url || null,
      domain: s.domain || (s.url ? hostOf(s.url) : null),
      query_text: s.query_text || null,
      product_name: s.product_name || null,
      check_frequency: s.check_frequency || 'daily',
      origin: 'auto',
      status: s.status,
      found_via: s.found_via || null,
      fetch_method: s.fetch_method || null,
      last_checked_at: new Date().toISOString(),
      last_status: s.last_status || 'ok',
      last_error: s.last_error || null,
      consecutive_failures: 0,
    };
    const old = byKey.get(keyOf(s));
    if (!old) {
      const { error: insErr } = await admin().from('competitor_sources').insert(row);
      if (insErr && !/duplicate key/i.test(insErr.message)) throw new Error(`insert source failed: ${insErr.message}`);
      inserted++;
    } else {
      const patch = { ...row };
      delete patch.competitor_id; delete patch.client_id; delete patch.origin;
      // admin decision wins; a source WE switched off earlier may come back
      const retiredByUs = old.status === 'rejected' && old.last_error === RETIRED_NOTE;
      if (old.origin === 'admin' || (old.status === 'rejected' && !retiredByUs)) delete patch.status;
      if (old.origin === 'admin') delete patch.query_text;
      const { error: upErr } = await admin().from('competitor_sources').update(patch).eq('id', old.id);
      if (upErr) throw new Error(`update source failed: ${upErr.message}`);
      updated++;
    }
  }

  // Old automatic sources that this discovery did NOT find again (e.g. the company
  // website changed from elcompanies.com to loreal.com) are switched off, so the
  // daily run does not keep reading the wrong site. Sources the admin added stay.
  const foundKeys = new Set(found.map(keyOf));
  let retired = 0;
  for (const old of existing || []) {
    if (old.origin !== 'auto' || old.status === 'rejected' || foundKeys.has(keyOf(old))) continue;
    if (!['press', 'blog', 'product'].includes(old.source_type)) continue;
    const { error: rErr } = await admin().from('competitor_sources')
      .update({ status: 'rejected', last_error: RETIRED_NOTE })
      .eq('id', old.id);
    if (rErr) throw new Error(`retire source failed: ${rErr.message}`);
    retired++;
  }
  return { inserted, updated, retired };
}

// ---------------------------------------------------------------------
// Step 0 - copy from another client (same brand + same country, recent)
// ---------------------------------------------------------------------
async function tryCopyFromOtherClient(comp, profile) {
  const since = new Date(Date.now() - LIMITS.COPY_FROM_OTHER_CLIENT_DAYS * 864e5).toISOString();
  const { data: others, error } = await admin()
    .from('competitors')
    .select('*')
    .eq('name_key', comp.name_key)
    .neq('client_id', comp.client_id)
    .in('discovery_status', ['ready', 'needs_check'])
    .gte('last_discovered_at', since)
    .order('last_discovered_at', { ascending: false });
  if (error || !others) return null;

  let donor = null;
  for (const o of others) {
    if (countryProfileFor(await getClientLocation(o.client_id)).key === profile.key) { donor = o; break; }
  }
  if (!donor) return null;

  const { data: srcs, error: sErr } = await admin()
    .from('competitor_sources')
    .select('source_type, url, domain, query_text, product_name, check_frequency, status, fetch_method, last_status')
    .eq('competitor_id', donor.id)
    .neq('status', 'rejected');
  if (sErr) return null;

  return {
    donor,
    competitorFields: {
      shop_domain: comp.shop_domain || donor.shop_domain,
      company_domain: comp.company_domain || donor.company_domain,
      parent_group: comp.parent_group || donor.parent_group,
      aliases: (comp.aliases && comp.aliases.length) ? comp.aliases : donor.aliases,
    },
    sources: (srcs || []).map((s) => ({ ...s, found_via: 'copied' })),
    status: donor.discovery_status,
    note: `Copied from the same brand tracked for another client${donor.discovery_note ? ' - ' + donor.discovery_note : ''}`,
  };
}

// ---------------------------------------------------------------------
// Step 1 - shop website (client-location based)
// ---------------------------------------------------------------------
function brandScore(host, name) {
  const h = host.replace(/[^a-z0-9]/g, '');
  if (h.includes(nameKey(name))) return 3;
  return Math.min(2, nameWords(name).filter((w) => h.includes(w)).length);
}
/**
 * How well does this website match the CLIENT's country?
 *   +5 client's country (.co.uk, au.puma.com, .com for a US client)
 *   +1 plain .com (global site - may have a country section like samsung.com/in/)
 *    0 generic ending (.io, .co ...)
 *   -3 ANOTHER country (burgerking.co.uk / us.puma.com for a Singapore / Australia client)
 */
function countryBonus(host, profile) {
  const labels = host.split('.');
  const first = labels[0];
  const last = labels[labels.length - 1];
  const twoPartTld = labels.length >= 3 && /^(co|com|net|org|gov|ac)$/.test(labels[labels.length - 2]);
  const ccTld = twoPartTld ? last : (last.length === 2 && !GENERIC_TLDS.has(last) ? last : null);
  const subCountry = labels.length >= 3 && first.length === 2 && COUNTRY_CODES.has(first) ? first : null;

  if (profile.key === 'global') return ccTld ? 0 : 1;
  const mine = (code) => code && (profile.paths.includes(code) || profile.tlds.includes(code) || code === profile.key);
  if (profile.tlds.some((t) => t !== 'com' && host.endsWith('.' + t))) return 5;
  if (mine(subCountry)) return 5;
  if (subCountry || (ccTld && !mine(ccTld))) return -3;
  if (profile.key === 'us' && last === 'com') return 5;
  return last === 'com' ? 1 : 0;
}

function scoreShopResults(results, comp, profile, seen) {
  for (const r of results) {
    const host = hostOf(r.url);
    if (!host || isSkippedHost(host) || seen.has(host)) continue;
    if (/^(help|support|investors?|ir|corp|corporate|about|news|newsroom|careers|jobs|locations|restaurants|stores?-?locator|developer|docs|status|community)\./.test(host)) continue;
    const b = brandScore(host, comp.name);
    if (b === 0) continue;
    const c = countryBonus(host, profile);
    seen.set(host, { host, brand: b, country: c, total: b + c });
  }
}

// samsung.com -> is there a samsung.com/in/ for an India client?
async function findCountryPath(host, profile) {
  const base = `https://${host === rootDomain(host) ? 'www.' + host : host}`;
  const tries = [...profile.paths.filter((p) => p.length === 2), ...profile.paths.filter((p) => p.includes('-'))].slice(0, 3);
  for (const p of tries) {
    const r = await fetchDirect(`${base}/${p}/`);
    const final = (r.finalUrl || '').toLowerCase();
    if (r.ok && final.includes(`/${p}`)) return `/${p}/`;
  }
  return null;
}

async function findShopSite(comp, profile, counter) {
  const name = comp.search_name || comp.name;
  const seen = new Map();
  scoreShopResults(await exaSearch(`${name} official website`, { numResults: 10 }, counter), comp, profile, seen);
  let best = [...seen.values()].sort((a, b) => b.total - a.total)[0];

  // no site for the client's country yet -> ask again WITH the country name
  if (profile.name && (!best || best.country < 5)) {
    scoreShopResults(await exaSearch(`${name} ${profile.name} official website`, { numResults: 10 }, counter), comp, profile, seen);
  }
  const list = [...seen.values()].sort((a, b) => b.total - a.total);
  best = list[0] || null;

  // a website of ANOTHER country is never picked automatically
  if (best && best.country < 0) {
    return { host: null, countryMatched: false, countryPath: null, wrongCountryOnly: true, candidates: list.slice(0, 6) };
  }

  // open the top websites: skip dead ones, follow redirects (theordinary.co.uk -> theordinary.com/en-gb/)
  let countryPath = null;
  let picked = null;
  for (const c of list.filter((x) => x.country >= 0).slice(0, 3)) {
    const r = await fetchDirect(`https://${c.host === rootDomain(c.host) ? 'www.' + c.host : c.host}/`);
    if (r.status === 0 || r.status === 404 || r.status >= 500) continue;          // not a working website
    const finalHost = hostOf(r.finalUrl || '');
    if (finalHost && rootDomain(finalHost) !== rootDomain(c.host)) {
      if (brandScore(finalHost, comp.name) === 0) continue;                         // parked / sold domain
      // big brands send you to YOUR country's site (nike.com -> nike.in when run from India).
      // That depends on where the code runs, not on the client - ignore those redirects.
      if (countryBonus(finalHost, profile) < 0) { picked = c; break; }
      const firstSeg = (pathOf(r.finalUrl).split('/').filter(Boolean)[0] || '').toLowerCase();
      if (profile.paths.includes(firstSeg)) countryPath = `/${firstSeg}/`;
      picked = { ...c, host: finalHost, country: countryPath ? 5 : countryBonus(finalHost, profile), redirectedFrom: c.host };
    } else {
      picked = c;
    }
    break;
  }
  best = picked || best;
  if (best && best.country < 5 && !countryPath && profile.paths.length) countryPath = await findCountryPath(best.host, profile);
  return {
    host: best ? best.host : null,
    countryMatched: !!best && (best.country === 5 || !!countryPath),
    countryPath,
    candidates: list.slice(0, 6),
  };
}

// ---------------------------------------------------------------------
// Step 2 + 3 - company site + press page
// ---------------------------------------------------------------------
const CORP_PREFIX = /^(corp|corporate|group|investors?|ir|media|press|news|newsroom)\./;

const PRESS_PATH = /news|press|media|newsroom|release|stories|investor/i;
// words a COMPANY uses for its own press area (trade magazines mostly just use /news/)
const STRONG_PRESS_PATH = /press-?releases?|press-?room|newsroom|\/press\/|media-?cent(re|er)|news-and-media|investors?\//i;
const pathOf = (u) => { try { return new URL(u).pathname; } catch (e) { return ''; } };

/**
 * Where does this brand publish its press releases?
 * Two searches + the shop-search results. Group sites (loreal.com for Lancôme)
 * are allowed ONLY if the search results on that site name the brand.
 * Returns ranked candidates: [{host, score, urls:[...], why}]
 */
async function findCompanySiteAuto(comp, shopHost, shopCandidates, counter) {
  const name = comp.search_name || comp.name;
  const words = [nameKey(comp.name), ...nameWords(comp.name)];
  const mentionsBrand = (text) => {
    const t = nameKey(text);
    return words.some((w) => w && t.includes(w));
  };
  const shopRoot = shopHost ? rootDomain(shopHost) : '';

  let results = [];
  for (const q of [`${name} corporate newsroom press releases`, `${name} press release announces`]) {
    try {
      results = results.concat(await exaSearch(q, { numResults: 15 }, counter));
    } catch (e) {
      console.log(`[CI discovery] company search failed for ${comp.name}: ${e.message}`);
    }
  }

  const byHost = new Map();
  const get = (host) => {
    if (!byHost.has(host)) byHost.set(host, { host, hits: 0, pressHits: 0, strongHits: 0, brandHits: 0, urls: [] });
    return byHost.get(host);
  };
  for (const r of results) {
    const host = hostOf(r.url);
    if (!host || isSkippedHost(host)) continue;
    const h = get(host);
    h.hits++;
    const path = pathOf(r.url);
    if (PRESS_PATH.test(path)) { h.pressHits++; h.urls.push(r.url); }
    if (STRONG_PRESS_PATH.test(path)) h.strongHits++;
    if (mentionsBrand(`${r.title || ''} ${r.url}`)) h.brandHits++;
  }
  // corp./group sites seen while looking for the shop (corp.shiseido.com, groupeclarins.com)
  for (const c of shopCandidates || []) {
    if (CORP_PREFIX.test(c.host) || /group|corporate/.test(c.host)) {
      const h = get(c.host);
      h.fromShopSearch = true;
      h.brandHits++;
    }
  }

  const list = [];
  for (const h of byHost.values()) {
    const ownBrand = brandScore(h.host, comp.name) > 0;
    const corp = CORP_PREFIX.test(h.host) || /group|corporate/.test(h.host);
    const isShop = rootDomain(h.host) === shopRoot && !corp;
    let score = Math.min(3, h.pressHits) * 2 + (corp ? 2 : 0) + (ownBrand ? 1 : 0) + (h.fromShopSearch ? 2 : 0);
    if (isShop) score -= 2;                     // the shop itself is tried last, separately
    if (!ownBrand && h.brandHits === 0) continue; // a group site must talk about this brand
    if (!ownBrand && !corp && !h.fromShopSearch && h.strongHits === 0) continue; // ...and look like a company, not a magazine
    if (score < 2) continue;
    list.push({ host: h.host, score, urls: h.urls.slice(0, 6), group: !ownBrand });
  }
  list.sort((x, y) => y.score - x.score);
  return { candidates: list.slice(0, 5) };
}

// A single article is not a list page (corp.asics.com/jp/press/article/2026-10-26)
const ARTICLE_URL = /\/article\/|\/\d{4}[-/]\d{2}[-/]\d{2}|\/\d{4}\/\d{2}\/|\.pdf$/i;

// How many links on the page go to other pages under the same site that look like posts
function countPostLinks(html, pageUrl) {
  let base;
  try { base = new URL(pageUrl); } catch (e) { return 0; }
  const $ = cheerio.load(html);
  const seen = new Set();
  $('a[href]').each((_, el) => {
    let u;
    try { u = new URL($(el).attr('href'), base); } catch (e) { return; }
    if (rootDomain(u.hostname) !== rootDomain(base.hostname)) return;
    const path = u.pathname.replace(/\/$/, '');
    if (path === base.pathname.replace(/\/$/, '') || path.split('/').filter(Boolean).length < 2) return;
    if (PRESS_PATH.test(path) || path.startsWith(base.pathname.replace(/\/$/, '') + '/')) seen.add(path + u.search); // detail.html?n=1, ?n=2 are different posts
  });
  return seen.size;
}

async function checkPressList(url, allowExa, counter) {
  if (ARTICLE_URL.test(pathOf(url))) return { ok: false, url, via: 'direct', reason: 'single article' };
  const r = await fetchDirect(url);
  if (!looksBlocked(r)) {
    const { dates, textLength } = countDates(r.text);
    const posts = countPostLinks(r.text, r.finalUrl || url);
    if (dates >= 3 && posts >= 3) return { ok: true, url: r.finalUrl || url, dates, posts, via: 'direct' };
    if (textLength > 500) return { ok: false, url, dates, posts, via: 'direct', reason: dates >= 3 ? 'few post links' : 'few dates', status: r.status };
  }
  if (!allowExa) return { ok: false, url, via: 'direct', reason: `blocked (${r.status})`, status: r.status };
  const text = await exaRead(url, counter);
  const dates = new Set(text.match(DATE_RE) || []).size;
  return dates >= 3 ? { ok: true, url, dates, via: 'exa' } : { ok: false, url, via: 'exa', reason: 'blocked or few dates' };
}

// Parent "list" pages of real press-release links, most common first.
// e.g. loreal.com/en/press-release/finance/xyz -> loreal.com/en/press-release/finance/, loreal.com/en/press-release/
function parentListPages(urls, minCount) {
  const score = new Map();
  for (const raw of urls) {
    let u;
    try { u = new URL(raw); } catch (e) { continue; }
    const parts = u.pathname.split('/').filter(Boolean);
    for (let keep = parts.length - 1; keep >= 1; keep--) {
      const lastSeg = parts[keep - 1];
      if (!PRESS_PATH.test(lastSeg)) continue;           // only levels named like news / press / newsroom
      const parent = `${u.origin}/${parts.slice(0, keep).join('/')}/`;
      score.set(parent, (score.get(parent) || 0) + (STRONG_PRESS_PATH.test(`/${lastSeg}/`) ? 2 : 1));
    }
  }
  return [...score.entries()].filter(([, n]) => n >= minCount).sort((a, b) => b[1] - a[1]).map(([u]) => u);
}

// Links in the company homepage menu that point to news / press / newsroom
// (this is how www.elcompanies.com leads to investors.elcompanies.com/.../newsroom)
async function pressLinksFromHomepage(companyHost, budget, counter) {
  const host = companyHost === rootDomain(companyHost) ? `www.${companyHost}` : companyHost;
  const page = await fetchPage(`https://${host}/`, budget, counter);
  if (!page.ok) return [];
  const $ = cheerio.load(page.html);
  const root = rootDomain(companyHost);
  const found = new Map();
  $('a[href]').each((_, el) => {
    let href;
    try { href = new URL($(el).attr('href'), `https://${host}/`).toString().replace(/#.*$/, ''); } catch (e) { return; }
    if (!/^https?:/.test(href) || rootDomain(hostOf(href)) !== root || /\.(pdf|jpg|png|zip)$/i.test(href)) return;
    const text = clean($(el).text(), 60).toLowerCase();
    const path = pathOf(href);
    if (ARTICLE_URL.test(path)) return;
    let sc = 0;
    if (/press-?releases?|press-?room|newsroom|\/press\/?$|media-?cent(re|er)|news-and-media/i.test(path) || /newsroom|press release|press room|media cent/.test(text)) sc = 3;
    else if (/news|press|media|stories/i.test(path) || /^(news|press|media|stories|latest news)$/.test(text)) sc = 2;
    else if (/investor/i.test(path)) sc = 1;      // investor pages: only if nothing better (often reports, not news)
    if (!sc) return;
    if (path.split('/').filter(Boolean).length > 4) sc -= 1;   // deep links are single articles, not the list
    const add = (u, v) => { if (!found.has(u) || found.get(u) < v) found.set(u, v); };
    if (href.includes('?')) add(href.replace(/\?.*$/, ''), sc + 0.5);   // '?year=2026' goes stale - prefer the plain page
    add(href, sc);
  });
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, 5);
}

// Last option: no list page we can read, but Exa has recent news pages on this site
// about this brand -> the daily press run will SEARCH this site instead of reading one page.
async function pressBySiteSearch(comp, companyHost, counter) {
  const words = [nameKey(comp.name), ...nameWords(comp.name)];
  const own = brandScore(companyHost, comp.name) > 0;
  let res = [];
  try {
    res = await exaSearch(`${comp.search_name || comp.name} news announcement`, {
      includeDomains: [rootDomain(companyHost)], startPublishedDate: daysAgoIso(365), numResults: 10,
    }, counter);
  } catch (e) {
    return null;
  }
  const hits = res.filter((r) => {
    if (!r.publishedDate) return false;
    if (own) return true;
    const t = nameKey(`${r.title || ''} ${r.url}`);
    return words.some((w) => w && t.includes(w));     // group site: must be about this brand
  });
  if (hits.length < 2) return null;
  return { ok: true, url: `https://${companyHost === rootDomain(companyHost) ? 'www.' + companyHost : companyHost}/`, dates: hits.length, via: 'exa', mode: 'site_search' };
}

async function pressListGuesses(comp, companyHost, knownUrls, counter) {
  const fromKnown = parentListPages((knownUrls || []).filter((u) => hostOf(u) === hostOf(`https://${companyHost}`)), 1);
  if (fromKnown.length) return fromKnown;
  let results = [];
  try {
    results = await exaSearch(`${comp.search_name || comp.name} press release`, { includeDomains: [rootDomain(companyHost)], numResults: 10 }, counter);
  } catch (e) {
    return [];
  }
  return parentListPages(results.map((r) => r.url), 2);
}

async function findPressPage(companyHost, comp, counter, knownUrls = [], budget = null) {
  const host = companyHost === rootDomain(companyHost) ? `www.${companyHost}` : companyHost;

  // 1) links from the homepage menu (also finds press pages on other subdomains)
  const menu = await pressLinksFromHomepage(companyHost, budget, counter);
  for (const url of menu) {
    const chk = await checkPressList(url, false, counter);
    if (chk.ok) return { ...chk, found_via: 'home_links' };
  }

  // 2) the usual paths
  const tried = [];
  let noAnswer = 0;
  for (const p of PRESS_PATHS) {
    const chk = await checkPressList(`https://${host}${p}`, false, counter);
    tried.push(chk);
    if (chk.ok) return { ...chk, found_via: 'common_path' };
    noAnswer = chk.status === 0 ? noAnswer + 1 : 0;
    if (noAnswer >= 2) break;            // site not answering - don't wait 15s x 14 paths
  }

  // 3) list pages guessed from real press-release links + blocked pages, read through Exa (max 3)
  const blocked = tried.filter((x) => x.status === 403 || x.status === 200).map((x) => x.url);
  const guesses = await pressListGuesses(comp, companyHost, knownUrls, counter);
  const toRead = [...new Set([...menu.slice(0, 1), ...guesses.slice(0, 2), ...blocked.slice(0, 1)])].slice(0, 3);
  for (const url of toRead) {
    const again = await checkPressList(url, true, counter);
    if (again.ok) return { ...again, found_via: 'exa_search' };
  }

  // 4) search this site for news instead of reading one page
  const search = await pressBySiteSearch(comp, companyHost, counter);
  if (search) return { ...search, found_via: 'exa_site_search' };
  return null;
}

// ---------------------------------------------------------------------
// Step 4 - product pages with a trusted price
// ---------------------------------------------------------------------
async function readSitemapUrls(shopHost) {
  const base = `https://${shopHost === rootDomain(shopHost) ? 'www.' + shopHost : shopHost}`;
  const robots = await fetchDirect(`${base}/robots.txt`);
  let files = robots.ok && !/captcha|access denied/i.test(robots.text.slice(0, 2000))
    ? [...robots.text.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1])
    : [];
  if (!files.length) files = [`${base}/sitemap.xml`, `${base}/sitemap_index.xml`];

  const prio = (f) => (/product|pdp|catalog/i.test(f) ? 2 : /news|blog|article|content|page/i.test(f) ? -1 : 0);
  const queue = [...files];
  const seen = new Set();
  const urls = [];
  let read = 0;
  while (queue.length && read < LIMITS.MAX_SITEMAP_FILES && urls.length < LIMITS.MAX_SITEMAP_URLS) {
    queue.sort((a, b) => prio(b) - prio(a));
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const r = await fetchDirect(f);
    read++;
    if (!r.ok || !/<loc/i.test(r.text)) continue;
    const locs = [...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => m[1].trim().replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(r.text)) queue.push(...locs);
    else urls.push(...locs);
  }
  return urls;
}

const LOCALE_SEG = /^[a-z]{2}([-_][a-z]{2})?$/i;

// theordinary.com/en-us/x.html -> theordinary.com/en-gb/x.html for a UK client
function toClientLocale(url, profile) {
  let u;
  try { u = new URL(url); } catch (e) { return [url]; }
  const parts = u.pathname.split('/');
  const i = parts.findIndex((x) => x);           // first real segment
  const seg = i >= 0 ? parts[i] : '';
  if (!seg || !LOCALE_SEG.test(seg) || !profile.paths.length) return [url];
  if (profile.paths.includes(seg.toLowerCase())) return [url];
  const sep = seg.includes('-') ? '-' : seg.includes('_') ? '_' : '';
  const options = profile.paths.filter((p) => (sep ? p.includes(sep) : !p.includes('-') && !p.includes('_')));
  return options.slice(0, 2).map((p) => {
    const copy = parts.slice();
    copy[i] = seg === seg.toUpperCase() ? p.toUpperCase() : p;
    return `${u.origin}${copy.join('/')}${u.search}`;
  });
}

function productKey(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.toLowerCase().split('/').filter(Boolean);
    if (parts.length && LOCALE_SEG.test(parts[0])) parts.shift();
    return `${u.hostname.replace(/^www\./, '')}/${parts.join('/')}`;
  } catch (e) {
    return url;
  }
}

// parts of a brand's site that are never the shop (help pages, merchandise, investor pages...)
const NOT_SHOP_SUB = /^(merch|help|support|custcare|community\w*|careers|jobs|ir|investors?|corp|corporate|about|news|newsroom|blog|static|cdn|assets|ics-resources|locations|restaurants|developer|docs|status|pep|zettle\w*)\./;

async function findProductPages(comp, shopHost, profile, budget, counter, countryPath = null, keepUrls = []) {
  const name = comp.search_name || comp.name;
  const prefersCountry = (u) => {
    const low = u.toLowerCase();
    if (countryPath && low.includes(countryPath)) return 2;
    return profile.paths.some((p) => low.includes(`/${p}/`)) ? 1 : 0;
  };
  const okHost = (u) => {
    const h = hostOf(u);
    return !!h && sameSite(h, shopHost) && !NOT_SHOP_SUB.test(h);
  };

  const fromSitemap = (await readSitemapUrls(shopHost))
    .filter((u) => okHost(u) && looksSingleProduct(u));

  let fromSearch = [];
  const queries = [`${name} best selling product`, `buy ${name} product price`];
  if (profile.name) queries.unshift(`${name} ${profile.name} buy online price`);
  for (const q of queries) {
    if (fromSearch.length >= LIMITS.PRODUCTS_WANTED * 2) break;
    try {
      const res = await exaSearch(q, { includeDomains: [rootDomain(shopHost)], numResults: 15 }, counter);
      fromSearch = fromSearch.concat(res.map((r) => r.url).filter((u) => okHost(u) && looksSingleProduct(u)));
    } catch (e) {
      console.log(`[CI discovery] product search failed for ${comp.name}: ${e.message}`);
    }
  }

  // client-country versions first, same page never twice
  const candidates = [];
  const seen = new Set();
  // products we already track come FIRST: same products every time = a real price history
  const kept = (keepUrls || []).filter((u) => okHost(u));
  for (const u of kept) {
    const key = u.toLowerCase().replace(/[?#].*$/, '');
    if (!seen.has(key)) { seen.add(key); candidates.push(u); }
  }
  for (const u of [...fromSearch, ...fromSitemap].sort((a, b) => prefersCountry(b) - prefersCountry(a))) {
    for (const v of toClientLocale(u, profile)) {
      const key = v.toLowerCase().replace(/[?#].*$/, '');
      if (!seen.has(key)) { seen.add(key); candidates.push(v); }
    }
  }

  const good = [];
  const rejected = [];
  const names = new Set();
  let opened = 0;
  let rendered = 0;
  let renderWorks = false;   // once Firecrawl showed a price on this shop, keep using it (budget allowing)
  const openedKeys = new Set();
  for (const url of candidates) {
    if (good.length >= LIMITS.PRODUCTS_WANTED || opened >= LIMITS.MAX_PRODUCT_CHECKS) break;
    // /uk/product/x and /gb/product/x are the same product - open only one of them
    const pKey = productKey(url);
    if (openedKeys.has(pKey)) continue;
    openedKeys.add(pKey);
    opened++;
    let page = await fetchPage(url, budget, counter);
    if (!page.ok) { rejected.push({ url, reason: page.error }); continue; }
    let price = readPriceFromHtml(page.html);
    // some shops add the price with JavaScript: open the page once more in a real browser (Firecrawl), max 2 tries
    if (price.status === 'NO_TRUSTED_PRICE' && page.via === 'direct' && (rendered < 2 || renderWorks) && budget && budget.firecrawl > 0) {
      rendered++;
      budget.firecrawl--;
      const fc = await fetchFirecrawl(url, counter);
      if (fc.ok && fc.text.length > 2000) {
        const again = readPriceFromHtml(fc.text);
        if (again.status === 'JSONLD_PRICE' || again.status === 'META_PRICE') { price = again; page = { ...page, via: 'firecrawl' }; renderWorks = true; }
      }
    }
    if (price.status !== 'JSONLD_PRICE' && price.status !== 'META_PRICE') {
      rejected.push({ url, reason: price.detail ? `${price.status}: ${price.detail}` : price.status });
      continue;
    }
    const currency = price.variants[0].currency;
    if (profile.currency && currency !== profile.currency) { rejected.push({ url, reason: `price in ${currency}, client needs ${profile.currency}` }); continue; }
    const nk = nameKey(price.name || url);
    if (names.has(nk)) { rejected.push({ url, reason: 'same product again' }); continue; }
    names.add(nk);
    good.push({ url, name: price.name, via: page.via, variants: price.variants.length, currency });
  }
  return { good, rejected, candidates: candidates.length };
}

// ---------------------------------------------------------------------
// The finding itself - NO database. Used by discoverCompetitor() and by the
// multi-client test script (scripts/ci-discovery-batch-test.js).
// comp needs: name, search_name?, shop_domain?, company_domain?
// ---------------------------------------------------------------------
async function findSources(comp, profile, { resetDomains = false, counter = makeCounter(), budget = { firecrawl: LIMITS.MAX_FIRECRAWL_PER_RUN }, skipProducts = false, keepProductUrls = [] } = {}) {
  const notes = [];
  const found = [];

  // ---- Step 1: shop website ----
  let shopHost = resetDomains ? null : comp.shop_domain;
  let shopCandidates = [];
  let shopCountryUnsure = false;
  let shopCountryPath = null;
  if (!shopHost) {
    const shop = await findShopSite(comp, profile, counter);
    shopHost = shop.host;
    shopCandidates = shop.candidates;
    shopCountryPath = shop.countryPath;
    if (!shopHost && shop.wrongCountryOnly) notes.push(`Only other-country websites found (${shop.candidates.slice(0, 3).map((c) => c.host).join(', ')}) - please add the ${profile.name} website.`);
    else if (!shopHost) notes.push('Shop website not found - please add it.');
    else if (!shop.countryMatched && profile.key !== 'global') shopCountryUnsure = true;
  }

  // ---- Step 2 + 3: company site + press page ----
  let companyHost = resetDomains ? null : comp.company_domain;
  let press = null;
  let companyCandidates = [];
  let companyGuessed = false;
  if (companyHost) {
    press = await findPressPage(companyHost, comp, counter, [], budget);
  } else {
    // nobody gave the company website: we GUESS, but a guess is only a suggestion
    // (tests picked nasdaq.com / marksandspencer.com for some brands - never auto-trust it)
    const auto = await findCompanySiteAuto(comp, shopHost, shopCandidates, counter);
    companyCandidates = auto.candidates;
    for (const c of auto.candidates.slice(0, 2)) {
      press = await findPressPage(c.host, comp, counter, c.urls, budget);
      if (press) { companyHost = c.host; companyGuessed = true; break; }
    }
  }
  if (!companyHost) {
    notes.push('Company website not given - please add it (for group brands, the group website, e.g. loreal.com for Lancôme).');
  } else if (companyGuessed) {
    notes.push(`Company website guessed as ${companyHost} - please confirm or correct it.`);
  } else if (!press) {
    notes.push(`No news found on ${companyHost}. Please check the company website.`);
  } else if (press.mode === 'site_search') {
    notes.push(`No news list page on ${companyHost} - its news will be found by searching the site.`);
  }
  if (press && brandScore(hostOf(`https://${companyHost}`), comp.name) === 0) {
    notes.push(`News comes from a group site (${companyHost}) - only items about ${comp.name} will be kept.`);
  }

  // ---- Step 4: product pages ----
  let products = { good: [], rejected: [], candidates: 0 };
  if (shopHost && !skipProducts) {
    products = await findProductPages(comp, shopHost, profile, budget, counter, shopCountryPath, keepProductUrls);
    if (!products.good.length) {
      notes.push(`No product pages with a reliable ${profile.currency || ''} price found - price tracking off for this competitor.`.replace('  ', ' '));
    }
  }
  // a .com site is fine if it sells in the client's currency (e.g. theordinary.com/en-gb)
  if (shopCountryUnsure && !(products.good.length && profile.currency)) {
    notes.unshift(`No ${profile.key.toUpperCase()} website found - using ${shopHost}. Please check.`);
  }

  // ---- Step 5: the source list to save ----
  const name = comp.search_name || comp.name;
  found.push({
    source_type: 'news', query_text: `${name} latest news and announcements`,
    status: 'active', found_via: 'auto_query', check_frequency: 'daily',
  });
  if (shopHost) {
    found.push({
      source_type: 'own_site', domain: rootDomain(shopHost), query_text: `${name} new product launch, offer, announcement`,
      status: 'active', found_via: 'auto_query', check_frequency: 'daily',
    });
  }
  if (press) {
    found.push({
      source_type: 'press', url: press.url, status: companyGuessed ? 'suggested' : 'active',
      found_via: press.found_via || 'common_path', fetch_method: press.via, check_frequency: 'daily',
    });
  }
  for (const p of products.good) {
    found.push({
      source_type: 'product', url: p.url, product_name: p.name, status: 'active', found_via: 'sitemap_or_search',
      fetch_method: p.via, check_frequency: 'weekly',
    });
  }
  const needsCheck = !shopHost || !press || companyGuessed || notes.some((n) => /please (add|check|confirm)/i.test(n));
  const status = needsCheck ? 'needs_check' : 'ready';
  return { shopHost, shopCountryPath, shopCandidates, companyHost, companyGuessed, companyCandidates, press, products, notes, found, status, counter };
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
/**
 * @param {string} competitorId
 * @param {{triggeredBy?: 'manual'|'onboarding'|'retry', force?: boolean, resetDomains?: boolean}} opts
 *   force        - run even if recently done / copy available
 *   resetDomains - forget saved shop/company domains and find them again
 */
async function discoverCompetitor(competitorId, opts = {}) {
  const triggeredBy = opts.triggeredBy || 'manual';
  let comp = await loadCompetitor(competitorId);

  // already running? (and not stuck)
  const stuckMs = LIMITS.STUCK_FINDING_MINUTES * 60 * 1000;
  if (comp.discovery_status === 'finding' && Date.now() - new Date(comp.updated_at).getTime() < stuckMs && !opts.force) {
    return { competitor: comp.name, skipped: 'already running' };
  }
  if (!comp.is_active) return { competitor: comp.name, skipped: 'competitor is switched off' };

  const location = await getClientLocation(comp.client_id);
  const profile = countryProfileFor(location);
  const counter = makeCounter();
  const budget = { firecrawl: LIMITS.MAX_FIRECRAWL_PER_RUN };
  await setCompetitor(comp.id, { discovery_status: 'finding', discovery_note: null });
  const runId = await startRun(comp, triggeredBy);

  try {
    // ---- Step 0: copy ----
    if (!opts.force && !opts.resetDomains) {
      const copy = await tryCopyFromOtherClient(comp, profile);
      if (copy) {
        await setCompetitor(comp.id, copy.competitorFields);
        const saved = await saveSources(comp, copy.sources);
        await setCompetitor(comp.id, { discovery_status: copy.status, discovery_note: copy.note, last_discovered_at: new Date().toISOString() });
        await finishRun(runId, 'completed', { copied_from: copy.donor.id, ...saved, ...counter });
        return { competitor: comp.name, status: copy.status, copied: true, note: copy.note };
      }
    }

    // keep tracking the same product pages (only re-checked, replaced if they no longer work)
    const { data: keepRows } = await admin().from('competitor_sources')
      .select('url').eq('competitor_id', comp.id).eq('source_type', 'product').eq('status', 'active');
    const keepProductUrls = (keepRows || []).map((r) => r.url).filter(Boolean);
    const r = await findSources(comp, profile, { resetDomains: !!opts.resetDomains, counter, budget, keepProductUrls });
    const { shopHost, shopCandidates, companyHost, press, products, notes, found, status } = r;
    const saved = await saveSources(comp, found);

    await setCompetitor(comp.id, {
      shop_domain: shopHost,
      company_domain: companyHost,
      discovery_status: status,
      discovery_note: notes.join(' ') || null,
      last_discovered_at: new Date().toISOString(),
    });

    const counts = {
      country: profile.key, client_location: location || null,
      shop_candidates: shopCandidates.length, press_found: press ? 1 : 0,
      product_candidates: products.candidates, products_found: products.good.length,
      products_rejected: products.rejected.length, ...saved, ...counter,
    };
    await finishRun(runId, 'completed', counts);
    console.log(`[CI discovery] ${comp.name}: ${status} | shop=${shopHost} company=${companyHost || '-'} press=${press ? 'yes' : 'no'} products=${products.good.length} | exa=${counter.exa} firecrawl=${counter.firecrawl}`);
    return { competitor: comp.name, status, shopHost, companyHost, press: press && press.url, products: products.good, notes, counts };
  } catch (err) {
    console.error(`[CI discovery] ${comp.name} failed: ${err.message}`);
    await setCompetitor(comp.id, { discovery_status: 'failed', discovery_note: clean(err.message, 300) }).catch(() => {});
    await finishRun(runId, 'failed', { ...counter }, clean(err.message, 500));
    return { competitor: comp.name, status: 'failed', error: err.message };
  }
}

/**
 * Discover every active competitor of a client, one after another.
 * @param {{onlyPending?: boolean, force?: boolean, triggeredBy?: string}} opts
 */
async function discoverClient(clientId, opts = {}) {
  const { data: comps, error } = await admin()
    .from('competitors')
    .select('id, name, discovery_status, updated_at')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .order('name');
  if (error) throw new Error(`read competitors failed: ${error.message}`);

  const retry = opts.includeFailed === false ? ['pending'] : ['pending', 'failed'];
  // 'finding' for too long = the server stopped in the middle (restart / deploy) -> do it again
  const stuckMs = LIMITS.STUCK_FINDING_MINUTES * 60 * 1000;
  const isStuck = (c) => c.discovery_status === 'finding' && Date.now() - new Date(c.updated_at).getTime() > stuckMs;
  const todo = (comps || []).filter((c) => !opts.onlyPending || retry.includes(c.discovery_status) || isStuck(c));
  const results = [];
  for (const c of todo) {
    results.push(await discoverCompetitor(c.id, { triggeredBy: opts.triggeredBy, force: opts.force }));
  }
  return results;
}

module.exports = { discoverCompetitor, discoverClient, findSources };