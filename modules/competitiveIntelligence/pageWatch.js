/**
 * modules/competitiveIntelligence/pageWatch.js
 *
 * PAGE WATCH for Competitive Radar: single pages of a competitor's website
 * (product pages, pricing pages, plan pages, any page the admin adds).
 *
 * Every check:
 *   1. FETCH    open the page (direct, Firecrawl if blocked)
 *   2. CLEAN    keep only the main text (no menus, header, footer, cookie banners, scripts)
 *               + product data hidden in the page code (JSON-LD: name, price, currency)
 *   3. COMPARE  fingerprint of the clean text vs the last stored copy of this page
 *                 - first time        -> store as the starting point, report nothing
 *                 - same fingerprint  -> nothing changed, no AI, nothing stored
 *                 - different         -> list the lines that were REMOVED and ADDED
 *   4. AI       looks only at the removed / added lines: is this a real change
 *               (price, new version, new plan, feature added or removed, product removed, offer)?
 *               what was it BEFORE, what is it NOW?
 *   5. CHECK    code: the "before" text must really be in the removed lines, the "now" text in the
 *               added lines, numbers must be on the page, signal must be valid and ticked
 *   6. SAVE     new page copy is stored; a real change is saved like a news change
 *               (competitor_changes + chat copy). Never joined to another change: each page change is its own event.
 *
 * Postgres keeps every version of the page that changed: public.competitor_page_snapshots.
 * A blocked or empty page is NEVER compared (it would look like "everything was removed").
 */

const crypto = require('crypto');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../llmClient');
const { LIMITS } = require('./constants');
const { clean, norm, makeCounter, fetchPage } = require('./webTools');
const collector = require('./collector');
const reader = require('./reader');
const store = require('./changeStore');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = () => supabase.schema('admin');

const PROMPT_ID = 'ci_page_change_v1';
const MIN_PAGE_CHARS = 300;        // less clean text than this = page blocked / empty, never compared
const MAX_SNAPSHOT_CHARS = 40000;  // stored copy of the page
const MAX_DIFF_LINES = 80;         // removed / added lines shown to the AI (each side)
const MAX_DIFF_CHARS = 7000;
const DUE_HOURS = { daily: 20, weekly: 6.5 * 24, monthly: 29 * 24 };
const IMPORTANCE = ['Critical', 'High', 'Medium', 'Low'];
const DROP_WORDS = ['no_change', 'layout_only', 'rotating_content', 'page_error', 'other_page'];

// ---------------------------------------------------------------------
// 2. CLEAN: html -> list of text lines
// ---------------------------------------------------------------------
function productDataLines(html) {
  const $ = cheerio.load(html);
  const lines = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const type = [].concat(o['@type'] || []).join(',');
    if (/Offer|AggregateOffer/i.test(type)) {
      const price = o.price ?? o.lowPrice;
      if (price !== undefined) {
        lines.push(`Product data: price ${price}${o.highPrice ? ` to ${o.highPrice}` : ''} ${o.priceCurrency || ''}${o.name ? ` (${clean(o.name, 80)})` : ''}${o.sku ? ` sku ${o.sku}` : ''}`.replace(/\s+/g, ' ').trim());
      }
      // stock status on its own line: "in stock / sold out" flips often and is not news by itself
      if (o.availability) lines.push(`Product data: availability ${String(o.availability).replace(/^.*\//, '')}${o.sku ? ` sku ${o.sku}` : ''}`);
    } else if (/Product|SoftwareApplication|Service/i.test(type) && o.name) {
      lines.push(`Product data: product ${clean(o.name, 120)}${o.softwareVersion ? ` version ${o.softwareVersion}` : ''}`);
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try { walk(JSON.parse($(el).contents().text())); } catch (e) { /* bad json on the page - skip */ }
  });
  return [...new Set(lines)];
}

const NOISE_LINE = [
  /^\d{1,2}[:.]\d{2}(\s?[ap]m)?$/i,            // a clock time
  /\b\d+\s*(seconds?|minutes?|mins?|hours?|hrs?)\s+ago\b/i, // "5 minutes ago"
  /\bcookies?\b/i,
  /^(share|tweet|print|email|copy link|back to top|skip to (main )?content|menu|close|search)$/i,
];

function pageText(html) {
  const data = productDataLines(html);
  const $ = cheerio.load(String(html).replace(/</g, ' <'));
  $('script, style, noscript, svg, iframe, template, form, button, select, nav, aside, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true]').remove();
  $('[class*=cookie], [id*=cookie], [class*=consent], [id*=consent], [class*=newsletter], [class*=breadcrumb]').remove();
  // header / footer of the whole site (not the header of the product itself)
  $('header, footer').filter((_, el) => !$(el).closest('main, article').length).remove();
  const root = $('main').length ? $('main').first() : $('body');
  root.find('br').replaceWith('\n');
  root.find('p, div, li, h1, h2, h3, h4, h5, h6, tr, td, th, section, article, dd, dt, figcaption, label').each((_, el) => { $(el).append('\n'); });
  const seen = new Set();
  const lines = [];
  for (const raw of root.text().split('\n')) {
    const l = raw.replace(/\s+/g, ' ').trim();
    if (l.length < 2 || NOISE_LINE.some((r) => r.test(l))) continue;
    const k = l.toLowerCase();
    if (seen.has(k)) continue; // the same line twice (desktop + mobile menu) counts once
    seen.add(k);
    lines.push(l);
  }
  const title = clean($('title').first().text() || $('h1').first().text(), 200);
  return { title, lines: [...data, ...lines] };
}

const fingerprint = (lines) => crypto.createHash('sha1').update(lines.join('\n').toLowerCase()).digest('hex');

// A line that can carry business meaning: page code data, a price / amount with a unit, or a real sentence/name (3+ words).
// Short page bits ("of", "Sale", "Sold out", "( 0 in cart)", "NaN", "Quantity") are buttons and labels, never compared.
const MONEY_OR_UNIT = /[$€£₹¥]\s?\d|\d[\d.,]*\s?(usd|eur|gbp|inr|rs\.?|aud|cad|%|w|kw|kwh|wh|mah|v|gb|tb|mb|mm|cm|m|kg|g|ml|l|oz|lb|months?|years?|days?|users?|seats?|members?)\b/i;
function isMeaningful(line) {
  const l = String(line || '');
  if (/^Product data:/i.test(l)) return true;
  if (/\b(nan|undefined|null)\b/i.test(l) && l.length < 20) return false;
  if (MONEY_OR_UNIT.test(l)) return true;
  return (l.match(/[A-Za-zÀ-ÿ]{2,}/g) || []).length >= 3;
}
const STOCK_WORDS = /\b(availability|in ?stock|out ?of ?stock|sold out|back in stock|pick ?up|pickup|delivery|shipping|ships in|low stock|only \d+ left)\b/i;

// ---------------------------------------------------------------------
// 3. COMPARE: which lines were removed, which were added
// ---------------------------------------------------------------------
function diffLines(oldLines, newLines) {
  const key = (l) => norm(l).replace(/\s+/g, ' ');
  const oldSet = new Set(oldLines.map(key));
  const newSet = new Set(newLines.map(key));
  // each changed line + the nearest unchanged line above it (e.g. the plan name "Plus" above "$10 per member")
  const withPlace = (lines, otherSet) => {
    const out = [];
    let lastSame = '';
    for (const l of lines) {
      if (otherSet.has(key(l))) { lastSame = l; continue; }
      out.push({ line: l, near: lastSame });
    }
    return out;
  };
  const removed = withPlace(oldLines, newSet);
  const added = withPlace(newLines, oldSet);
  const share = (removed.length + added.length) / Math.max(1, oldLines.length + newLines.length);
  return { removed, added, changedShare: share };
}

const cap = (items) => {
  const out = [];
  let chars = 0;
  for (const it of items.slice(0, MAX_DIFF_LINES)) {
    if (chars + it.line.length > MAX_DIFF_CHARS) break;
    out.push(it);
    chars += it.line.length;
  }
  return out;
};
const showLines = (items, sign) => (items.length
  ? items.map((it) => `${sign} ${it.line}${it.near ? `      [under: ${clean(it.near, 80)}]` : ''}`).join('\n')
  : '(none)');

// ---------------------------------------------------------------------
// 4. AI
// ---------------------------------------------------------------------
let promptCache = { text: null, at: 0 };
async function getPagePrompt() {
  if (promptCache.text && Date.now() - promptCache.at < 5 * 60 * 1000) return promptCache.text;
  const { data, error } = await supabase.from('prompts').select('prompt_template').eq('id', PROMPT_ID).eq('is_active', true).maybeSingle();
  if (error || !data || !data.prompt_template) throw new Error(`Prompt '${PROMPT_ID}' not found or not active in public.prompts (run sql/ci_005_page_watch.sql)`);
  promptCache = { text: data.prompt_template, at: Date.now() };
  return data.prompt_template;
}
const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
function parseJson(raw) {
  const s = String(raw || '').replace(/```(json)?/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}
const squash = (s) => norm(s).replace(/[‘’“”"'`]/g, '').replace(/[^a-z0-9%.]+/g, ' ').trim();
const numbersOf = (s) => (String(s || '').match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,/g, ''));

/** code checks on ONE change from the AI answer -> {ok, ...} or {problems} */
function checkOneChange(ch, i, ctx) {
  const tag = `Change ${i + 1}:`;
  const problems = [];
  let signal = ctx.signals.all.find((s) => s.n === Number(ch.signal_number));
  const byName = ch.signal_name ? ctx.signals.all.find((s) => squash(s.name) === squash(ch.signal_name)) : null;
  if (byName && byName !== signal) signal = byName;
  if (!signal) problems.push(`${tag} "signal_number" must be one number from 1 to ${ctx.signals.all.length}.`);

  const before = clean(ch.before, 400);
  const after = clean(ch.after, 400);
  const removedText = squash(ctx.removed.map((x) => x.line).join(' \n '));
  const addedText = squash(ctx.added.map((x) => x.line).join(' \n '));
  if (!before && !after) problems.push(`${tag} "before" and "after" are both empty. Copy the old text from the REMOVED lines and the new text from the ADDED lines.`);
  // stock / pickup / delivery status alone is not news (it changes all the time)
  if ([before, after].filter(Boolean).every((t) => STOCK_WORDS.test(t)) && !(signal && /price/i.test(signal.name))) {
    return { skip: `${tag} only stock / pickup / delivery status - not news` };
  }
  // the quoted text must be a real line, not a button or label ("of", "NaN", "Sale")
  if ([before, after].filter(Boolean).every((t) => !isMeaningful(t))) {
    return { skip: `${tag} only a small page label changed ("${clean(before || after, 40)}") - not news` };
  }
  if (before && !removedText.includes(squash(before))) problems.push(`${tag} "before" must be copied word for word from the REMOVED lines (not the [under: ...] part).`);
  if (after && !addedText.includes(squash(after))) problems.push(`${tag} "after" must be copied word for word from the ADDED lines (not the [under: ...] part).`);

  const title = clean(ch.title, 160);
  const summary = clean(ch.summary, 600);
  if (title.length < 10) problems.push(`${tag} "title" is missing or too short.`);
  if (!summary) problems.push(`${tag} "summary" is missing.`);

  // every number in the title / summary must be on the old or the new page
  const pageNumbers = new Set([...numbersOf(ctx.oldText), ...numbersOf(ctx.newText)]);
  const missing = [...new Set(numbersOf(`${title} ${summary}`))].filter((x) => !pageNumbers.has(x) && x.length > 1);
  if (missing.length) problems.push(`${tag} these numbers are not on the page: ${missing.join(', ')}. Copy numbers exactly as written.`);

  // a price change needs a price before AND after, and they must differ
  if (signal && /price increases or cuts/i.test(signal.name)) {
    const nb = numbersOf(before);
    const na = numbersOf(after);
    if (!nb.length || !na.length) problems.push(`${tag} a price change needs the old price in "before" and the new price in "after".`);
    else if (nb.join() === na.join()) problems.push(`${tag} "before" and "after" show the same price. That is not a price change.`);
  }
  if (problems.length) return { problems };
  const importance = IMPORTANCE.includes(ch.importance) ? ch.importance : 'Medium';
  return { ok: true, signal, title, summary, before, after, importance };
}

/** code checks on the whole AI answer: {drop} or {changes:[ok...], problems:[...]} */
function checkPageAnswer(ans, ctx) {
  if (!ans) return { problems: ['The answer was not valid JSON.'], changes: [] };
  const list = Array.isArray(ans.changes) ? ans.changes.slice(0, 3) : [];
  if (ans.real_change === false || (ans.real_change === true && !list.length && ans.drop_reason)) {
    const why = String(ans.drop_reason || '').toLowerCase().trim();
    return { drop: `no real change: ${DROP_WORDS.includes(why) ? why : clean(ans.drop_reason, 120) || 'not given'}` };
  }
  if (ans.real_change !== true) return { problems: ['"real_change" must be true or false.'], changes: [] };
  if (!list.length) return { problems: ['"changes" must list 1 to 3 changes.'], changes: [] };
  const good = [];
  const problems = [];
  const skipped = [];
  list.forEach((ch, i) => {
    const r = checkOneChange(ch || {}, i, ctx);
    if (r.ok) good.push(r); else if (r.skip) skipped.push(r.skip); else problems.push(...r.problems);
  });
  if (!good.length && !problems.length && skipped.length) return { drop: `no real change: ${skipped.join(' | ')}` };
  return { changes: good, problems, skipped };
}

async function askAi(ctx, vars) {
  const messages = [{ role: 'user', content: fill(await getPagePrompt(), vars) }];
  const trace = [];
  let verdict = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw;
    try {
      raw = await callLLM(messages, { temperature: 0, max_tokens: 900, timeout: 90000 });
    } catch (e) {
      return { failed: `AI call failed: ${clean(e.message, 150)}`, trace };
    }
    verdict = checkPageAnswer(parseJson(raw), ctx);
    const done = verdict.drop || !verdict.problems.length;
    trace.push({
      attempt,
      raw_answer: clean(raw, 3000),
      code_said: verdict.drop ? `DROP - ${verdict.drop}`
        : !verdict.problems.length ? `OK - ${verdict.changes.length} change(s) passed all checks`
        : `PROBLEMS - ${verdict.problems.join(' | ')}${verdict.changes.length ? ` (${verdict.changes.length} other change(s) were OK)` : ''}`,
    });
    if (done) break;
    messages.push({ role: 'assistant', content: clean(raw, 3000) });
    messages.push({ role: 'user', content: `Your answer has problems:\n- ${verdict.problems.join('\n- ')}\nFix them and answer again with the full JSON only (all changes).` });
  }
  return { verdict, trace };
}

// ---------------------------------------------------------------------
// One page: compare old and new text. Used by the daily run AND by scripts/ci-page-watch-test.js
// ---------------------------------------------------------------------
/**
 * @param ctx  {client, comp, signals, terms}
 * @param page {url, name}
 * @param oldSnap  {lines, seen_at} or null (first time)
 * @param fresh    {title, lines}  clean text of the page now
 * @returns {{outcome: 'baseline'|'same'|'dropped'|'keep'|'failed', reason?, diff?, trace?, changes?}}
 *   changes: 1 to 3 checked changes (a page can change in more than one way at once, e.g. new price AND new feature)
 */
async function comparePage(ctx, page, oldSnap, fresh) {
  if (!oldSnap) return { outcome: 'baseline', reason: `first time this page is read${fresh.via ? ` this way (${fresh.via})` : ''} - becomes the starting point` };
  if (fingerprint(oldSnap.lines) === fingerprint(fresh.lines)) return { outcome: 'same', reason: 'page text is exactly the same as last time' };

  // read in a different way than last time (direct vs Firecrawl): the text can differ for that reason alone
  if (oldSnap.fetch_method && fresh.via && oldSnap.fetch_method !== fresh.via) {
    return { outcome: 'baseline', reason: `page was read a different way than last time (${oldSnap.fetch_method} -> ${fresh.via}) - new starting point, nothing reported` };
  }

  const rawDiff = diffLines(oldSnap.lines, fresh.lines);
  // more than half of the page changed = redesign or a different page layout, not one business change
  if (rawDiff.changedShare > 0.5) {
    return { outcome: 'baseline', reason: `${Math.round(rawDiff.changedShare * 100)}% of the page changed (redesign or different layout) - new starting point, nothing reported` };
  }
  // only lines that can carry meaning are compared (no buttons, labels, counters)
  let diff = { ...rawDiff, removed: rawDiff.removed.filter((x) => isMeaningful(x.line)), added: rawDiff.added.filter((x) => isMeaningful(x.line)) };
  if (!diff.removed.length && !diff.added.length) {
    return { outcome: 'same', store: true, reason: 'only small page bits changed (buttons, labels, counters) - nothing to report' };
  }

  // read the page a second time: a real change is there both times; moving parts (widgets, rotating blocks) are not
  if (typeof page.refetch === 'function') {
    const again = await page.refetch();
    if (again && again.ok) {
      const key = (l) => norm(l).replace(/\s+/g, ' ');
      const againSet = new Set(again.lines.map(key));
      diff = { ...diff, removed: diff.removed.filter((x) => !againSet.has(key(x.line))), added: diff.added.filter((x) => againSet.has(key(x.line))) };
      if (!diff.removed.length && !diff.added.length) {
        return { outcome: 'same', reason: 'the difference was gone when the page was read again (moving parts of the page) - nothing to report' };
      }
    }
  }

  // only the stock status changed (in stock <-> sold out): no AI, not news, but the new copy is stored
  if ([...diff.removed, ...diff.added].every((x) => STOCK_WORDS.test(x.line) && !MONEY_OR_UNIT.test(x.line.replace(/only \d+ left/i, '')))) {
    return { outcome: 'dropped', reason: 'only the stock status changed (in stock / sold out) - not reported as news', diff: {
      removed: diff.removed.map((x) => x.line), added: diff.added.map((x) => x.line),
      removed_total: diff.removed.length, added_total: diff.added.length, changed_share: diff.changedShare,
    } };
  }

  const removed = cap(diff.removed);
  const added = cap(diff.added);
  const checkCtx = { ...ctx, removed, added, oldText: oldSnap.lines.join('\n'), newText: fresh.lines.join('\n') };
  const today = new Date().toISOString().slice(0, 10);
  const vars = {
    competitor: ctx.comp.name,
    client_industry: ctx.client.industry || 'not given',
    client_country: ctx.client.country || 'not given',
    page_url: page.url,
    page_name: page.name || fresh.title || page.url,
    old_date: /^\d{4}-\d{2}-\d{2}/.test(String(oldSnap.seen_at || '')) ? String(oldSnap.seen_at).slice(0, 10) : 'earlier',
    new_date: today,
    changed_share: `${Math.round(diff.changedShare * 100)}%`,
    signals: ctx.signals.text,
    signal_count: ctx.signals.all.length,
    removed_lines: showLines(removed, '-'),
    added_lines: showLines(added, '+'),
  };
  const ai = await askAi(checkCtx, vars);
  const shownDiff = {
    removed: removed.map((x) => x.line), added: added.map((x) => x.line),
    removed_total: diff.removed.length, added_total: diff.added.length, changed_share: diff.changedShare,
  };
  if (ai.failed) return { outcome: 'failed', reason: ai.failed, diff: shownDiff, trace: ai.trace };
  if (ai.verdict.drop) return { outcome: 'dropped', reason: ai.verdict.drop, diff: shownDiff, trace: ai.trace };

  const kept = [];
  const notes = [...ai.verdict.problems, ...(ai.verdict.skipped || [])];
  // the same change listed twice (e.g. "Notion Agent" and "Notion Agent (chat, generate...)"): keep the fuller one
  const sameThing = (a, b) => squash(a.title) === squash(b.title) || a.signal === b.signal && [[a.after, b.after], [a.before, b.before]].some(([x, y]) => {
    const p = squash(x || ''); const q = squash(y || '');
    return p && q && (p.includes(q) || q.includes(p));
  });
  const unique = [];
  for (const v of ai.verdict.changes) {
    const twin = unique.findIndex((u) => sameThing(u, v));
    if (twin < 0) { unique.push(v); continue; }
    const longer = `${v.before}${v.after}`.length > `${unique[twin].before}${unique[twin].after}`.length ? v : unique[twin];
    notes.push(`same change listed twice - kept "${longer.title}"`);
    unique[twin] = longer;
  }
  for (const v of unique) {
    if (!v.signal.enabled) { notes.push(`signal not ticked for this client: ${v.signal.name}`); continue; }
    const title = collector.brandMentions(v.title, ctx.terms) === 0 ? `${ctx.comp.name}: ${v.title}` : v.title;
    kept.push({
      signal: v.signal,
      title,
      summary: v.summary,
      importance: /^others$/i.test(v.signal.name) ? 'Low' : v.importance,
      event_date: today,               // the day we saw the change on the page
      event_date_from: 'page check',
      country: ctx.client.country || null,
      key_facts: [v.before ? `Before: ${v.before}` : null, v.after ? `Now: ${v.after}` : null].filter(Boolean),
      also_involves: [],
    });
  }
  if (!kept.length) {
    return { outcome: 'dropped', reason: `AI answer failed checks: ${notes.join(' ')}`.slice(0, 400), diff: shownDiff, trace: ai.trace };
  }
  return { outcome: 'keep', diff: shownDiff, trace: ai.trace, changes: kept, change: kept[0], notes };
}

// ---------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------
/** last stored copy of the page READ THE SAME WAY (direct vs Firecrawl give slightly different text, never mix them) */
async function lastSnapshot(sourceId, url, via) {
  let q = supabase.from('competitor_page_snapshots').select('id, text, seen_at, fetch_method').order('seen_at', { ascending: false }).limit(1);
  q = sourceId ? q.eq('source_id', sourceId) : q.eq('url', url);
  if (via) q = q.eq('fetch_method', via);
  const { data } = await q.maybeSingle();
  return data ? { ...data, lines: String(data.text || '').split('\n').filter(Boolean) } : null;
}

async function saveSnapshot(row) {
  const { data, error } = await supabase.from('competitor_page_snapshots').insert(row).select('id').single();
  if (error) throw new Error(`could not store the page copy: ${error.message}`);
  return data.id;
}

async function updateHealth(source, health, note) {
  const failed = health === 'failed' || health === 'blocked';
  const patch = {
    last_checked_at: new Date().toISOString(),
    last_status: health === 'blocked' ? 'blocked' : health,
    last_error: health === 'ok' ? null : clean(note, 300),
    consecutive_failures: failed ? (source.consecutive_failures || 0) + 1 : 0,
  };
  if (failed && patch.consecutive_failures >= 3 && source.status === 'active') patch.status = 'broken';
  await admin().from('competitor_sources').update(patch).eq('id', source.id);
}

const isDue = (src) => {
  if (!src.last_checked_at) return true;
  const hours = (Date.now() - new Date(src.last_checked_at).getTime()) / 3600e3;
  return hours >= (DUE_HOURS[src.check_frequency] || DUE_HOURS.daily);
};

/** open a page and clean it; null text = blocked / empty */
async function readPage(url, budget, counter) {
  const p = await fetchPage(url, budget, counter);
  if (!p.ok) return { ok: false, via: p.via, error: p.error || `status ${p.status}` };
  const t = pageText(p.html);
  const chars = t.lines.join('\n').length;
  if (chars < MIN_PAGE_CHARS) return { ok: false, via: p.via, error: `too little text on the page (${chars} characters)` };
  return { ok: true, via: p.via, title: t.title, lines: t.lines, chars };
}

// ---------------------------------------------------------------------
// One competitor
// ---------------------------------------------------------------------
async function runPagesForCompetitor(competitorId, opts = {}) {
  const dryRun = !!opts.dryRun;
  const { data: comp } = await admin().from('competitors').select('*').eq('id', competitorId).maybeSingle();
  if (!comp) throw new Error(`competitor ${competitorId} not found`);
  const result = { competitor: comp.name, competitor_id: comp.id, dryRun, pages: [] };
  if (!comp.is_active) return { ...result, skipped: 'competitor is switched off' };

  const { data: sources } = await admin().from('competitor_sources').select('*')
    .eq('competitor_id', comp.id).eq('status', 'active').eq('source_type', 'product');
  const due = (sources || []).filter((s) => opts.force || dryRun || isDue(s));
  if (!due.length) return { ...result, skipped: (sources || []).length ? 'no page is due today' : 'no pages to watch' };

  const client = opts.client || await require('./newsRun').loadClient(comp.client_id);
  const signals = opts.signals || await reader.loadSignals(comp.client_id);
  const ctx = { client, comp, signals, terms: collector.brandTerms(comp) };
  const counter = makeCounter();
  // pages of sites that block normal reading need Firecrawl EVERY day (1 call per page, 2 when a change is re-checked).
  // The news limit (3) was too small: pages 4, 5, 6 of a competitor were never read. Own limit, can be set in .env.
  const budget = { firecrawl: Number(process.env.CI_PAGE_FIRECRAWL_MAX) || 15 };
  const counts = { pages: due.length, baseline: 0, same: 0, changed: 0, saved: 0, dropped: 0, failed: 0, blocked: 0 };

  let runId = null;
  if (!dryRun) {
    const { data: run } = await supabase.from('competitor_runs')
      .insert({ client_id: comp.client_id, competitor_id: comp.id, section: 'product', triggered_by: opts.triggeredBy || 'manual', status: 'running' })
      .select('id').single();
    runId = run ? run.id : null;
  }

  for (const src of due) {
    const line = { url: src.url, name: src.product_name || null };
    try {
      const now = await readPage(src.url, budget, counter);
      if (!now.ok) {
        counts.blocked++;
        result.pages.push({ ...line, outcome: 'blocked', reason: now.error });
        if (!dryRun) await updateHealth(src, 'blocked', now.error);
        continue;
      }
      const old = await lastSnapshot(src.id, src.url, now.via);
      // the page had product data (name / price) and now has none: the product was removed or the link now opens
      // another page (e.g. the homepage). Never compared (it would look like a big change); 3 times in a row -> 'broken'.
      const hasProduct = (lines) => (lines || []).some((l) => /^Product data:/.test(l));
      if (old && hasProduct(old.lines) && !hasProduct(now.lines)) {
        const why = 'product data is gone from the page (product removed, or the link now opens another page)';
        counts.blocked++;
        result.pages.push({ ...line, outcome: 'gone', reason: why, via: now.via });
        if (!dryRun) await updateHealth(src, 'failed', why);
        continue;
      }
      const refetch = () => readPage(src.url, { firecrawl: now.via === 'firecrawl' ? 1 : 0 }, counter);
      const r = await comparePage(ctx, { url: src.url, name: src.product_name, refetch }, old, now);
      const shown = { ...line, outcome: r.outcome, reason: r.reason, diff: r.diff, trace: r.trace, chars: now.chars, via: now.via, last_copy: old ? String(old.seen_at).slice(0, 10) : null };

      let changeId = null;
      let saveOutcome = r.outcome;
      if (r.outcome === 'keep') {
        counts.changed++;
        shown.changes = r.changes;
        shown.notes = r.notes;
        if (dryRun) saveOutcome = 'would save';
        else {
          saveOutcome = 'saved';
          shown.saved = [];
          for (const ch of r.changes) {
            const s = await store.saveChange({
              // may join a card about the same event (e.g. the launch news) - but never just because it is the same page
              clientId: comp.client_id, comp, change: ch, runId, country: client.country, skipSameLink: true,
              item: { url: `${src.url}#checked-${ch.event_date}`, title: src.product_name || now.title, section: 'product', publishedDate: new Date().toISOString() },
            });
            if (!changeId) changeId = s.changeId;
            shown.saved.push({ title: ch.title, change_id: s.changeId, in_chat: s.verified });
          }
        }
        counts.saved += r.changes.length;
      } else if (r.outcome === 'baseline') counts.baseline++;
      else if (r.outcome === 'same') counts.same++;
      else if (r.outcome === 'failed') counts.failed++;
      else { counts.dropped++; counts.changed++; }
      shown.outcome = saveOutcome;
      result.pages.push(shown);

      if (!dryRun) {
        // store a new copy when it is the first one or the text changed (also when the AI said "no real change",
        // so tomorrow we compare with today and do not ask again about the same small difference)
        if ((r.outcome !== 'same' && r.outcome !== 'failed') || r.store) {
          await saveSnapshot({
            client_id: comp.client_id, competitor_id: comp.id, source_id: src.id, url: src.url,
            content_hash: fingerprint(now.lines), text: now.lines.join('\n').slice(0, MAX_SNAPSHOT_CHARS),
            text_chars: now.chars, fetch_method: now.via, is_baseline: r.outcome === 'baseline', change_id: changeId, run_id: runId,
          });
        }
        await updateHealth(src, 'ok');
        const logOutcome = { keep: 'saved', saved: 'saved', baseline: 'skipped', same: 'skipped', dropped: 'dropped', failed: 'failed' }[r.outcome] || 'skipped';
        await supabase.from('competitor_ingestion_log').insert({
          run_id: runId, client_id: comp.client_id, competitor_id: comp.id, source_id: src.id, source_kind: 'product',
          url: src.url, title: clean(src.product_name || now.title, 300) || null, outcome: logOutcome, change_id: changeId,
          reason: r.outcome === 'keep' ? null : r.reason,
          details: { step: 'page watch', via: now.via, diff_removed: r.diff ? r.diff.removed_total : 0, diff_added: r.diff ? r.diff.added_total : 0 },
        });
      }
    } catch (e) {
      counts.failed++;
      result.pages.push({ ...line, outcome: 'failed', reason: clean(e.message, 200) });
      if (!dryRun) await updateHealth(src, 'failed', e.message).catch(() => {});
    }
  }

  Object.assign(counts, { exa_calls: counter.exa, firecrawl_calls: counter.firecrawl });
  result.counts = counts;
  if (runId) {
    await supabase.from('competitor_runs').update({ status: 'completed', counts, finished_at: new Date().toISOString() }).eq('id', runId);
    try {
      result.cards = await require('./cardWriter').writeDueCards(comp.client_id, { competitorId: comp.id });
    } catch (e) {
      console.error(`[CI cards] ${comp.name}: ${e.message}`);
    }
  }
  console.log(`[CI pages] ${comp.name}: ${JSON.stringify(counts)}`);
  return result;
}

// ---------------------------------------------------------------------
// One client
// ---------------------------------------------------------------------
const running = new Set();
async function runPagesForClient(clientId, opts = {}) {
  if (running.has(clientId)) return { clientId, skipped: 'page watch already running for this client' };
  running.add(clientId);
  try {
    const { loadClient } = require('./newsRun');
    const client = await loadClient(clientId);
    const signals = await reader.loadSignals(clientId);
    if (!signals.enabledCount) return { clientId, skipped: 'no Competitive Intelligence signals ticked (Monitoring Scope)' };
    let q = admin().from('competitors').select('id, name').eq('client_id', clientId).eq('is_active', true).order('name');
    if (opts.competitorId) q = q.eq('id', opts.competitorId);
    const { data: comps } = await q;
    const out = [];
    for (const c of comps || []) {
      try {
        out.push(await runPagesForCompetitor(c.id, { ...opts, client, signals }));
      } catch (e) {
        out.push({ competitor: c.name, error: e.message });
      }
    }
    // page changes can add cards too -> update "who is moving where"
    if (!opts.dryRun) await require('./activity').refreshActivitySafe(clientId);
    return { clientId, client: client.company_name, competitors: out };
  } finally {
    running.delete(clientId);
  }
}

/** Is this link a LIST page (blog / news category with many posts) or a SINGLE page (product, pricing)? */
async function detectPageType(url) {
  const p = await fetchPage(url, { firecrawl: 1 }, makeCounter());
  if (!p.ok) return { type: 'product', note: 'page could not be read - watched as a single page' };
  const links = collector.postLinksFromList(p.html, url);
  const dated = links.filter((l) => l.date).length;
  let path = '';
  try { path = new URL(url).pathname.replace(/\/$/, ''); } catch (e) { /* bad link */ }
  const under = links.filter((l) => path && new URL(l.url).pathname.startsWith(`${path}/`)).length;
  if (dated >= 3 || under >= 5) return { type: 'blog', note: `list page: ${links.length} post links (${dated} with dates)` };
  return { type: 'product', note: 'single page: its content is compared on every check' };
}

module.exports = {
  lastSnapshot,
  runPagesForClient, runPagesForCompetitor, comparePage, readPage, pageText, diffLines, fingerprint, detectPageType,
  checkPageAnswer, MIN_PAGE_CHARS,
};