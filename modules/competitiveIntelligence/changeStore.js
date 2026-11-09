/**
 * modules/competitiveIntelligence/changeStore.js
 *
 * STEP 3 of the daily news run: SAVE a checked change.
 *
 *   1. Same event already saved?  (same competitor, within 7 days, very similar title, or same link)
 *        yes -> add this article as extra proof ("2 signals" badge) = MERGED
 *        no  -> new row in public.competitor_changes (status 'pending') + its proof row
 *   2. Write it to Qdrant (the DI chat's database): point id = change id, so it can never duplicate.
 *   3. Read it back from Qdrant. Only then status -> 'verified'.
 *      The CI tab and the chat show ONLY verified changes (view competitor_changes_live).
 *   4. If Qdrant fails: stays 'pending', the repair job tries again (max 3 times, then 'failed').
 *
 * Postgres is the truth. Qdrant is a copy for the chat.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { CI_MODULE_ID, LIMITS, QDRANT } = require('./constants');
const { hostOf, norm, clean } = require('./webTools');
const { callLLM } = require('../llmClient');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
  timeout: 30000,
});

// ---------------------------------------------------------------------
// Embeddings: the SAME model the rest of the pipeline uses (MiniLM, 384 numbers)
// Uses the pipeline's own loaded model when llmRelevanceProcessor exports embedText.
// ---------------------------------------------------------------------
let embedFn = null;
async function embed(text) {
  if (!embedFn) {
    try {
      const shared = require('../llmRelevanceProcessor');
      if (typeof shared.embedText === 'function') embedFn = shared.embedText;
    } catch (e) { /* fall back below */ }
    if (!embedFn) {
      const { pipeline } = require('@xenova/transformers');
      const p = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      embedFn = async (t) => Array.from((await (await p)(t, { pooling: 'mean', normalize: true })).data);
    }
  }
  return embedFn(text);
}
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0); // vectors are already normalised

// ---------------------------------------------------------------------
// Text written to Qdrant. Starts with the competitor name, has the type + signal words
// (the chat's word filter needs them) and the date.
// ---------------------------------------------------------------------
const niceDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function buildChatText(comp, c) {
  const title = c.title.replace(/[.\s]+$/, '');
  const starts = norm(title).startsWith(norm(comp.name));
  const summary = c.summary.replace(/[.\s]+$/, '');
  return `${starts ? '' : `${comp.name} - `}${title}. ${summary} (${niceDate(c.event_date)}). ${c.signal.category}: ${c.signal.name}. Importance: ${c.importance}.`;
}

function contentHash(comp, c) {
  const key = [comp.id, c.signal.submodule_id, c.event_date, norm(c.title).replace(/[^a-z0-9]+/g, ' ').trim()].join('|');
  return crypto.createHash('sha1').update(key).digest('hex');
}

const OWN_SOURCES = new Set(['press', 'own_site', 'blog']);
const RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };

// ---------------------------------------------------------------------
// Find the same event already saved
// ---------------------------------------------------------------------
async function findSameEvent(clientId, comp, c, url, skipSameLink = false, sourceTitle = '', publishedDate = null) {
  const day = (d, plus) => new Date(new Date(`${String(d).slice(0, 10)}T12:00:00Z`).getTime() + plus * 864e5).toISOString().slice(0, 10);
  const W = 2 * LIMITS.MERGE_WINDOW_DAYS;
  // cards near the EVENT date ...
  // (twice the window: only a join on exact figures or the same quarterly results may use the extra days;
  //  a press release often comes out a week after the event it reports, e.g. a record on Oct 6, release on Oct 14)
  const { data: byEvent, error } = await supabase.from('competitor_changes')
    .select('id, submodule_id, signal_title, summary, importance, confidence, status, event_date')
    .eq('client_id', clientId).eq('competitor_id', comp.id).eq('is_duplicate', false)
    .in('status', ['pending', 'verified'])
    .gte('event_date', day(c.event_date, -W))
    .lte('event_date', day(c.event_date, W));
  if (error) throw new Error(`change lookup failed: ${error.message}`);
  // ... and cards with a signal PUBLISHED near this article's date
  // (one article says "dispatch began October 13", another "in October": the event dates differ, the news day is the same)
  let byPublished = [];
  if (publishedDate) {
    const { data: near } = await supabase.from('competitor_change_evidence').select('change_id')
      .eq('client_id', clientId).gte('published_date', day(publishedDate, -LIMITS.MERGE_WINDOW_DAYS)).lte('published_date', day(publishedDate, LIMITS.MERGE_WINDOW_DAYS));
    const ids = [...new Set((near || []).map((e) => e.change_id))].filter((id) => !(byEvent || []).some((r) => r.id === id));
    if (ids.length) {
      const { data: more } = await supabase.from('competitor_changes')
        .select('id, submodule_id, signal_title, summary, importance, confidence, status, event_date')
        .eq('competitor_id', comp.id).eq('is_duplicate', false).in('status', ['pending', 'verified']).in('id', ids);
      byPublished = more || [];
    }
  }
  const rows = [...(byEvent || []), ...byPublished];
  if (!rows.length) return null;

  // same link already used as proof for one of them -> same event for sure
  const { data: ev } = await supabase.from('competitor_change_evidence')
    .select('change_id').eq('client_id', clientId).eq('url', url).in('change_id', rows.map((r) => r.id));
  if (!skipSameLink && ev && ev.length) return { row: rows.find((r) => r.id === ev[0].change_id), score: 1, by: 'same link' };

  // each card is also compared through its own signals: one article is closer to a new article than the mixed card text
  const { data: sigRows } = await supabase.from('competitor_change_evidence')
    .select('change_id, signal_title, title, summary, key_facts, published_date').in('change_id', rows.map((r) => r.id));
  // "near" = event dates within the window, OR one of the card's signals was published within the window of this article
  const pubGap = (id) => (publishedDate ? Math.min(...(sigRows || []).filter((e) => e.change_id === id && e.published_date)
    .map((e) => Math.abs(new Date(e.published_date) - new Date(String(publishedDate).slice(0, 10))) / 864e5), 999) : 999);
  const sigsOf = (id) => (sigRows || []).filter((e) => e.change_id === id).slice(0, 6)
    .map((e) => ({ title: [e.signal_title, e.title].filter(Boolean).join('. '), summary: e.summary || '', key_facts: e.key_facts }));
  const hit = await pickSameEvent(comp, { ...c, source_title: sourceTitle }, rows.map((r) => ({ row: r, pubGap: pubGap(r.id), title: r.signal_title, summary: r.summary, submodule_id: r.submodule_id, signals: sigsOf(r.id) })));
  return hit.match ? { row: hit.match.row, score: hit.score, by: hit.by } : null;
}

// ---------------------------------------------------------------------
// SAME EVENT? (topic check) - used by the real run AND by scripts/ci-stage-view.js
//   1. very alike (title + summary)            -> same event, no AI needed
//   2. somewhat alike (between ASK and SURE)   -> ask the AI one yes/no question
//      (two articles about one event often get different titles and different signals,
//       e.g. "Sunrun settles with Connecticut..." and "Attorney General Tong announces settlements with SunRun...")
//   3. not alike                               -> different event
// ---------------------------------------------------------------------
const MERGE_ASK_AI_FROM = LIMITS.MERGE_ASK_AI_FROM || 0.55;

async function askSameEvent(compName, a, b) {
  const prompt = `Two short news items about the company ${compName}.\n\nA: ${a.title}. ${a.summary}\n\nB: ${b.title}. ${b.summary}\n\n`
    + 'Do A and B describe the SAME single event (the same announcement, deal, result, lawsuit, settlement, launch or opening)? '
    + 'Two different events of the same kind (for example two different deals) are NOT the same. Answer with one word: YES or NO.';
  try {
    const raw = await callLLM([{ role: 'user', content: prompt }], { temperature: 0, max_tokens: 5, timeout: 30000 });
    return /^\W*yes/i.test(String(raw || ''));
  } catch (e) {
    return false; // AI down -> keep them apart (safe: worst case one extra row)
  }
}

/**
 * @param comp        competitor row
 * @param c           new change {title, summary, signal}
 * @param candidates  [{title, summary, submodule_id, vec?, row?}]  (same competitor, within the date window)
 * @returns {{match, score, by, closest:[{title, score, need, ai}]}}
 */
// figures that name one event: "$1.23 billion", "23%", "16.5 GW", "101 of 117" (years and small numbers are ignored)
const FIGURE = /(?:(?:[$€£¥₹₩]|RM|R\$|S\$)\s?\d[\d,.]*(?:\s?(?:billion|million|bn|m)\b)?|\d[\d,.]{3,}\s?(?:円|yen\b|won\b|원|euros?\b|EUR\b|USD\b)|\d[\d,.]*\s?(?:%|percent\b|billion\b|million\b|gw\b|mw\b|gigawatts?\b|megawatts?\b)|\b\d+ (?:of|out of)(?: the)? \d+\b)/gi;
function figuresOf(...parts) {
  const text = parts.flat().filter(Boolean).join(' ');
  return new Set((text.match(FIGURE) || []).map((f) => f.toLowerCase().replace(/[\s,]/g, '').replace(/percent$/, '%')
    .replace(/gigawatts?$/, 'gw').replace(/megawatts?$/, 'mw').replace(/outof|ofthe/, 'of').replace(/\.$/, '')));
}

// quarterly results: every article about "Q3 results" of one company in the same week is ONE event
const RESULTS_WORDS = /\b(results?|earnings|revenue|sales|eps|profit|net income|guidance|outlook|quarterly)\b/i;
const QUARTER_WORD = { first: 'q1', second: 'q2', third: 'q3', fourth: 'q4' };
function resultsPeriods(...parts) {
  const text = parts.flat().filter(Boolean).join(' ');
  if (!RESULTS_WORDS.test(text)) return new Set();
  const out = new Set();
  for (const m of text.matchAll(/\b(?:q([1-4])|([1-4])q|(first|second|third|fourth)[- ]quarter)\b/gi)) out.add(m[1] || m[2] ? `q${m[1] || m[2]}` : QUARTER_WORD[m[3].toLowerCase()]);
  return out;
}

// "raises its outlook" twice in one week by one company = the same update
const GUIDANCE = /\b(rais|lift|cut|lower|boost|trim|reaffirm|downgrad|upgrad|revis)\w*\b[^.]{0,40}\b(outlook|forecasts?|guidance|targets?)\b/i;
// company-form words ("ESTEE LAUDER COMPANIES INC", "Form 10-Q") are never a campaign / product name
const NAME_STOP = new Set(['companies','corp','corporation','holdings','plc','sa','ag','gmbh','kk','form','period','ended','annual','quarterly','fiscal','earnings','sec','filing','10-q','10-k','8-k','international','beauty','brands','the','a','an','and','of','for','in','on','to','new','global','initiative','campaign','launch','launches','launched','press','release','news','inc','llc','nyse','nasdaq','ceo','cfo','ltd','co','group','company','announces','limited','edition','collection','program','programme','report','results','quarter','first','second','third','fourth','fiscal','year']);
// a named campaign, product or programme in quotes or capitals: 'I'M FINE', "Sengan Serum"
function namedThings(comp, ...parts) {
  const text = parts.flat().filter(Boolean).join(' ');
  const own = norm(comp.name).replace(/[^a-z0-9 ]/g, '');
  const clean1 = (x) => norm(x).replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const raw = [];
  for (const m of text.matchAll(/["“”«「『]([^"“”«»「」『』]{3,40})["“”»」』]/g)) raw.push(m[1]);                       // "Sengan Serum", “I'M FINE”
  for (const m of text.matchAll(/(?<![\p{L}])(\p{Lu}[\p{Lu}0-9'’&]*(?: \p{Lu}[\p{Lu}0-9'’&]*)+)(?![\p{L}])/gu)) raw.push(m[1]); // I'M FINE, MAKE ME BLUSH
  const out = new Set();
  for (const r of raw) {
    const x = clean1(r);
    const words = x.split(' ').filter((w) => w && !own.split(' ').includes(w));
    const real = words.filter((w) => !NAME_STOP.has(w));
    if (x.length >= 4 && words.length >= 1 && words.length <= 6 && real.length >= 1 && !own.includes(x)) out.add(words.join(' '));
  }
  return out;
}

const phraseText = (t) => ` ${norm(t).replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
// a name found in one text (quoted / capitals) that the other text also writes, in any spelling or case
const sharedName = (namesA, textB, namesB, textA) => [...namesA].find((x) => x.includes(' ') && phraseText(textB).includes(` ${x} `))
  || [...namesB].find((x) => x.includes(' ') && phraseText(textA).includes(` ${x} `)) || null;

async function pickSameEvent(comp, c, candidates) {
  const v = await embed(`${c.title}. ${c.summary}`);
  const myFigures = figuresOf(c.title, c.summary, c.key_facts || []);
  const myPeriods = resultsPeriods(c.title, c.source_title, c.summary, c.key_facts || []);
  const myGuidance = GUIDANCE.test(`${c.title} ${c.source_title || ''} ${c.summary}`);
  const myNames = namedThings(comp, c.title, c.source_title, c.summary, c.key_facts || []);
  const gapDays = (k) => Math.min(k.row && k.row.event_date && c.event_date ? Math.abs(new Date(k.row.event_date) - new Date(c.event_date)) / 864e5 : 0,
    k.pubGap === undefined ? 999 : k.pubGap);
  const scored = [];
  for (const k of candidates) {
    const vec = k.vec || await embed(`${k.title}. ${k.summary}`);
    let score = cosine(v, vec);
    // the card's own signals: the best one counts
    for (const sg of k.signals || []) score = Math.max(score, cosine(v, await embed(`${sg.title}. ${sg.summary}`)));
    const theirs = figuresOf(k.title, k.summary, ...(k.signals || []).map((sg) => [sg.title, sg.summary, sg.key_facts || []]));
    const shared = [...myFigures].filter((f) => theirs.has(f));
    const sure = k.submodule_id === c.signal.submodule_id ? LIMITS.MERGE_SIMILARITY_SAME_TYPE : LIMITS.MERGE_SIMILARITY_ANY_TYPE;
    const theirPeriods = resultsPeriods(k.title, k.summary, ...(k.signals || []).map((sg) => [sg.title, sg.summary, sg.key_facts || []]));
    const period = [...myPeriods].find((q) => theirPeriods.has(q)) || null;
    const near = gapDays(k) <= LIMITS.MERGE_WINDOW_DAYS;
    const theirText = [k.title, k.summary, ...(k.signals || []).map((sg) => `${sg.title} ${sg.summary}`)].join(' ');
    const guidance = near && myGuidance && GUIDANCE.test(theirText);
    const theirNames = namedThings(comp, k.title, k.summary, ...(k.signals || []).map((sg) => [sg.title, sg.summary, sg.key_facts || []]));
    const name = near ? sharedName(myNames, theirText, theirNames, `${c.title} ${c.source_title || ''} ${c.summary} ${(c.key_facts || []).join(' ')}`) : null;
    scored.push({ k, score, sure, shared, period, near, guidance, name });
  }
  const strong = (x) => x.shared.length >= 2 || !!x.period || x.guidance || !!x.name;
  scored.sort((a, b) => strong(b) - strong(a) || b.score - a.score);
  const closest = [];
  for (const s of scored.slice(0, 3)) {
    const line = { title: s.k.title, score: s.score, need: s.sure, ai: null, shared: s.shared };
    closest.push(line);
    if (s.near && s.score >= s.sure) return { match: s.k, score: s.score, by: 'very similar', closest, vec: v };
    // two or more of the same exact figures (same competitor, within the date window) = the same announcement
    if (s.guidance && s.score >= 0.5) return { match: s.k, score: s.score, by: 'same outlook / guidance update', closest, vec: v };
    if (s.name && s.score >= 0.5) return { match: s.k, score: s.score, by: `same named campaign / product ("${s.name}")`, closest, vec: v };
    if (s.period && s.score >= 0.45) return { match: s.k, score: s.score, by: `same quarterly results (${s.period.toUpperCase()})`, closest, vec: v };
    if (s.shared.length >= 2 && s.score >= 0.45) return { match: s.k, score: s.score, by: `same figures (${s.shared.slice(0, 3).join(', ')})`, closest, vec: v };
    const askFrom = s.k.submodule_id === c.signal.submodule_id ? MERGE_ASK_AI_FROM : Math.max(MERGE_ASK_AI_FROM, 0.75);
    if (s.near && s.score >= askFrom) {
      line.ai = await askSameEvent(comp.name, c, s.k) ? 'YES' : 'NO';
      if (line.ai === 'YES') return { match: s.k, score: s.score, by: 'AI says same event', closest, vec: v };
    }
  }
  return { match: null, score: scored.length ? scored[0].score : 0, by: null, closest, vec: v };
}

// ---------------------------------------------------------------------
// Qdrant
// ---------------------------------------------------------------------
let indexesReady = false;
async function ensureQdrantIndexes() {
  if (indexesReady) return;
  for (const field of QDRANT.INDEX_FIELDS) {
    try {
      await qdrant.createPayloadIndex(QDRANT.COLLECTION, { field_name: field, field_schema: 'keyword', wait: true });
    } catch (e) {
      if (!/already exists/i.test(e.message || '')) console.log(`[CI qdrant] index note for '${field}': ${e.message}`);
    }
  }
  indexesReady = true;
}

/**
 * Write one change to Qdrant, read it back, then mark it verified.
 * @returns {Promise<boolean>} true = verified
 */
async function syncChangeToQdrant(changeId) {
  const { data: ch, error } = await supabase.from('competitor_changes').select('*').eq('id', changeId).single();
  if (error || !ch) throw new Error(`change ${changeId} not found`);
  const { data: ev } = await supabase.from('competitor_change_evidence')
    .select('url, source_kind, published_date').eq('change_id', changeId).order('published_date', { ascending: true });
  const { data: client } = await supabase.schema('admin').from('clients').select('industry').eq('id', ch.client_id).maybeSingle();
  const first = (ev || [])[0];
  if (!first) {
    await markSyncProblem(ch, 'no proof row for this change');
    return false;
  }

  try {
    await ensureQdrantIndexes();
    const payload = {
      article_id: ch.article_id,
      change_id: ch.id,
      client_id: ch.client_id,
      industry: (client && client.industry) || null,
      module_id: CI_MODULE_ID,
      submodule_id: ch.submodule_id,
      signal_id: ch.signal_id,
      kind: 'change',
      competitor: ch.organization,
      competitor_id: ch.competitor_id,
      category: ch.category,
      signal_name: ch.signal_name,
      importance: ch.importance,
      confidence: ch.confidence,
      published_date: `${ch.event_date}T00:00:00.000Z`,
      title: ch.signal_title,
      url: first.url,
      source_count: (ev || []).length,
      chunk_index: 0,
      chunk_text: ch.chat_text,
    };
    const vector = await embed(ch.chat_text);
    await qdrant.upsert(QDRANT.COLLECTION, { wait: true, points: [{ id: ch.id, vector, payload }] });

    // read back: only a point we can see counts
    const back = await qdrant.retrieve(QDRANT.COLLECTION, { ids: [ch.id], with_payload: true });
    if (!back || !back[0] || !back[0].payload || back[0].payload.change_id !== ch.id) throw new Error('point not found when read back');

    const { error: uErr } = await supabase.from('competitor_changes')
      .update({ status: 'verified', qdrant_synced_at: new Date().toISOString(), status_reason: null })
      .eq('id', ch.id).in('status', ['pending', 'verified']);
    if (uErr) throw new Error(`could not mark verified: ${uErr.message}`);
    return true;
  } catch (e) {
    await markSyncProblem(ch, clean(e.message, 200));
    return false;
  }
}

async function markSyncProblem(ch, reason) {
  const attempts = (ch.sync_attempts || 0) + 1;
  const patch = { sync_attempts: attempts, status_reason: `chat database write failed: ${reason}` };
  // a verified change keeps showing (its old copy is in Qdrant); a new one fails after 3 tries
  if (ch.status === 'pending' && attempts >= LIMITS.QDRANT_MAX_ATTEMPTS) patch.status = 'failed';
  await supabase.from('competitor_changes').update(patch).eq('id', ch.id);
  console.log(`[CI store] Qdrant problem for change ${ch.id} (try ${attempts}): ${reason}`);
}

/** Retry job: pending changes that never reached Qdrant (server restart, Qdrant down...) */
async function repairPendingChanges(limit = 50) {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // leave very new ones to their own run
  const { data, error } = await supabase.from('competitor_changes').select('id')
    .eq('status', 'pending').lt('sync_attempts', LIMITS.QDRANT_MAX_ATTEMPTS).lt('updated_at', cutoff).limit(limit);
  if (error) throw new Error(error.message);
  let fixed = 0;
  for (const r of data || []) if (await syncChangeToQdrant(r.id)) fixed++;
  return { checked: (data || []).length, fixed };
}

// ---------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------
async function addEvidence(changeId, clientId, item, change) {
  const c = change || {};
  const { error } = await supabase.from('competitor_change_evidence').upsert({
    change_id: changeId,
    client_id: clientId,
    url: item.url,
    title: clean(item.title, 300) || null,
    source_domain: hostOf(item.url) || null,
    source_kind: item.section,
    published_date: item.publishedDate ? item.publishedDate.slice(0, 10) : null,
    // this source's own details (shown under "Signals" in the card)
    signal_title: c.title ? clean(c.title, 300) : null,
    summary: c.summary ? clean(c.summary, 1000) : null,
    category: c.signal ? c.signal.category : null,
    signal_name: c.signal ? c.signal.name : null,
    importance: c.importance || null,
    key_facts: Array.isArray(c.key_facts) ? c.key_facts : null,
    event_date: c.event_date || null,
  }, { onConflict: 'change_id,url', ignoreDuplicates: true });
  if (error) throw new Error(`proof row failed: ${error.message}`);
}

/** card numbers for the screen: how many signals, newest signal date; the card text must be written again */
// ---------------------------------------------------------------------
// COPIES INSIDE A CARD: several sites repeating the same news = ONE signal
// The best one is kept: the company's own source (own site, press page, blog, product page, or a press wire
// like Business Wire) first, otherwise the newest. A signal that adds NEW facts (2+ new figures) is kept too.
// Copies are not deleted (is_copy = true): the "already seen" link check still finds them, the screen hides them.
// ---------------------------------------------------------------------
const SIGNAL_COPY_SIMILARITY = LIMITS.SIGNAL_COPY_SIMILARITY || 0.8;
const WIRE_HOSTS = /(^|\.)(businesswire|globenewswire|prnewswire|accesswire|newswire|prweb|mynewsdesk|presseportal)\.[a-z.]+$/i;
const domainCache = new Map();
async function ownDomains(competitorId) {
  if (domainCache.has(competitorId)) return domainCache.get(competitorId);
  const out = new Set();
  const { data: comp } = await supabase.schema('admin').from('competitors').select('*').eq('id', competitorId).maybeSingle();
  for (const k of ['shop_domain', 'website', 'domain', 'website_url', 'corporate_domain']) {
    if (comp && comp[k]) { const h = hostOf(String(comp[k]).includes('://') ? comp[k] : `https://${comp[k]}`); if (h) out.add(h.replace(/^www\./, '')); }
  }
  const { data: srcs } = await supabase.schema('admin').from('competitor_sources').select('domain, url, source_type').eq('competitor_id', competitorId);
  for (const r of srcs || []) {
    if (r.source_type === 'news') continue;
    const h = r.domain || (r.url ? hostOf(r.url) : null);
    if (h) out.add(String(h).replace(/^www\./, ''));
  }
  const list = [...out];
  domainCache.set(competitorId, list);
  return list;
}
// which kind of source this really is (a "news" article on the company's own site is its own site)
function realKind(e, domains) {
  if (e.source_kind && e.source_kind !== 'news') return e.source_kind;
  const h = (hostOf(e.url) || '').replace(/^www\./, '');
  if (WIRE_HOSTS.test(h)) return 'press';
  if (domains.some((d) => h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`))) return /press|news-?release|media|newsroom|investor/i.test(e.url || '') ? 'press' : 'own_site';
  return e.source_kind || 'news';
}

// ---------------------------------------------------------------------
// SAME NEWS, OTHER SITE - checked BEFORE the AI reads the article (saves AI calls)
// The article (title + first lines) is compared with (a) articles already kept in this run and
// (b) signals already saved for this competitor in the last CARD_WINDOW_DAYS days.
// Very alike AND no 2 new figures in its title/first lines = the same news -> dropped, no AI call.
// Sections run press -> blog -> own site -> news, and news newest first, so the copy that is kept
// is the company's own one, otherwise the newest.
// ---------------------------------------------------------------------
// MD / PO / FO use 0.68 on title + first 400 characters (modules/topicDedup.js). CI compares articles of ONE
// competitor, and two different launches of one brand are often worded alike ("YSL launches X" / "YSL launches Y"),
// so CI uses a higher bar, plus an exact-title check and the "2 new figures = new news" guard.
const SAME_NEWS_SIMILARITY = Number(process.env.CI_SAME_NEWS_SIMILARITY) || LIMITS.SAME_NEWS_SIMILARITY || 0.78;
const titleKey = (t) => norm(String(t || '').replace(/\s+[|\-–·]\s+[^|\-–·]{2,60}$/, '').replace(/\s+by (reuters|bloomberg|ap|afp|dpa)$/i, '')).replace(/[^a-z0-9]+/g, ' ').trim();
async function loadKnownNews(clientId, comp) {
  const since = new Date(Date.now() - KNOWN_NEWS_DAYS * 864e5).toISOString().slice(0, 10);
  const { data: cards } = await supabase.from('competitor_changes').select('id')
    .eq('client_id', clientId).eq('competitor_id', comp.id).in('status', ['pending', 'verified']).gte('event_date', since);
  if (!cards || !cards.length) return [];
  const { data: ev } = await supabase.from('competitor_change_evidence')
    .select('url, title, signal_title, summary, key_facts, published_date').in('change_id', cards.map((c) => c.id)).eq('is_copy', false);
  const out = [];
  for (const e of ev || []) {
    const text = `${e.title || e.signal_title || ''}. ${e.summary || ''}`;
    const named = [e.title, e.signal_title, e.summary, ...(Array.isArray(e.key_facts) ? e.key_facts : [])].filter(Boolean);
    out.push({ url: e.url, title: e.title || e.signal_title, date: e.published_date, text: named.join(' '), names: namedThings(comp, named), periods: resultsPeriods(named), guidance: GUIDANCE.test(named.join(' ')), vec: await embed(text), figs: figuresOf([e.title, e.signal_title, e.summary, ...(Array.isArray(e.key_facts) ? e.key_facts : [])].filter(Boolean)) });
  }
  return out;
}
/** @returns {{url, title, score}|null} the saved / kept article this one repeats */
async function findSameNews(item, known, comp) {
  // NOTE: an empty list must NOT return early - the vector is still made below, so this article is remembered
  // for the rest of the run (the old early return meant nothing was ever remembered after a reset)
  known = known || [];
  // same named campaign / product ("I'M FINE") within a week = the same news, in ANY language (embeddings only know English)
  const d = (x) => (x ? new Date(String(x).slice(0, 10)).getTime() / 864e5 : null);
  const myText = `${item.title || ''} ${String(item.text || '').slice(0, 500)}`;
  const myNames = comp ? namedThings(comp, [item.title, String(item.text || '').slice(0, 500)]) : new Set();
  for (const k of known) {
    if (!k.names || d(item.publishedDate) == null || d(k.date) == null || Math.abs(d(item.publishedDate) - d(k.date)) > LIMITS.MERGE_WINDOW_DAYS) continue;
    const nm = sharedName(k.names, myText, myNames, k.text || '');
    if (nm) return { url: k.url, title: k.title, score: 1, why: `same named campaign / product "${nm}"` };
  }
  // exact same title (source name removed) = the same news
  const tk = titleKey(item.title);
  const exact = tk.length > 15 && known.find((k) => titleKey(k.title) === tk);
  if (exact) return { url: exact.url, title: exact.title, score: 1, why: 'same title' };
  const lead = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const vec = await embed(`${item.title || ''}. ${lead}`);
  const figs = figuresOf([item.title, lead].filter(Boolean));
  // same quarterly results / same outlook update / 2+ same exact figures within a week, AND the texts are
  // somewhat alike (same bars as the card join) = the same news told by another site
  const myPeriods = resultsPeriods(myText);
  const myGuidance = GUIDANCE.test(myText);
  const myFigs = figuresOf([item.title, String(item.text || '').slice(0, 1500)]);
  for (const k of known) {
    if (!k.vec || d(item.publishedDate) == null || d(k.date) == null || Math.abs(d(item.publishedDate) - d(k.date)) > LIMITS.MERGE_WINDOW_DAYS) continue;
    const score = cosine(vec, k.vec);
    const q = [...myPeriods].find((x) => k.periods && k.periods.has(x));
    if (q && score >= 0.5) return { url: k.url, title: k.title, score, why: `same quarterly results (${q.toUpperCase()}), ${score.toFixed(2)}` };
    if (myGuidance && k.guidance && score >= 0.55) return { url: k.url, title: k.title, score, why: `same outlook / guidance update, ${score.toFixed(2)}` };
    const sameFigs = [...myFigs].filter((f) => k.figs && k.figs.has(f));
    if (sameFigs.length >= 2 && score >= 0.5) return { url: k.url, title: k.title, score, why: `same figures (${sameFigs.slice(0, 3).join(', ')}), ${score.toFixed(2)}` };
  }
  let best = null;
  for (const k of known) {
    const score = cosine(vec, k.vec);
    if (score >= SAME_NEWS_SIMILARITY && [...figs].filter((f) => !k.figs.has(f)).length < 2 && (!best || score > best.score)) best = { url: k.url, title: k.title, score };
  }
  if (best) return best;
  item._newsVec = vec; item._newsFigs = figs; // kept: remember it for the rest of this run
  return null;
}
const rememberNews = (item, known, comp, change) => {
  if (!item._newsVec) return;
  const parts = [item.title, change && change.title, change && change.summary, ...((change && change.key_facts) || [])].filter(Boolean);
  const text = parts.join(' ');
  known.push({ url: item.url, title: item.title, date: item.publishedDate, text, names: comp ? namedThings(comp, parts) : new Set(),
    periods: resultsPeriods(parts), guidance: GUIDANCE.test(text), vec: item._newsVec,
    figs: new Set([...(item._newsFigs || []), ...figuresOf(parts)]) });
};

async function dedupeCardSignals(changeId) {
  const { data: ev } = await supabase.from('competitor_change_evidence')
    .select('id, url, source_kind, signal_title, title, summary, key_facts, published_date, event_date, is_copy, copy_of').eq('change_id', changeId);
  if (!ev || !ev.length) return 0;
  const { data: card } = await supabase.from('competitor_changes').select('competitor_id').eq('id', changeId).maybeSingle();
  const domains = card ? await ownDomains(card.competitor_id) : [];
  const { data: compRow } = card ? await supabase.schema('admin').from('competitors').select('id, name').eq('id', card.competitor_id).maybeSingle() : { data: null };
  const items = ev.map((e) => {
    const kind = realKind(e, domains);
    const parts = [e.signal_title || e.title, e.summary, ...(Array.isArray(e.key_facts) ? e.key_facts : [])].filter(Boolean);
    return { e, kind, fullText: parts.join(' '), names: compRow ? namedThings(compRow, parts) : new Set(), own: OWN_SOURCES.has(kind) || kind === 'product', date: String(e.published_date || e.event_date || ''), text: `${e.signal_title || e.title || ''}. ${e.summary || ''}`, figs: figuresOf(parts) };
  });
  // best first: the company's own source, then the newest
  items.sort((a, b) => (b.own - a.own) || b.date.localeCompare(a.date));
  const kept = [];
  const copyOf = new Map();
  for (const it of items) {
    if (ev.length >= 2) {
      it.vec = await embed(it.text);
      const near = (k) => Math.abs(new Date(k.date || 0) - new Date(it.date || 0)) / 864e5 <= LIMITS.MERGE_WINDOW_DAYS;
      const same = kept.find((k) => (cosine(k.vec, it.vec) >= SIGNAL_COPY_SIMILARITY && [...it.figs].filter((f) => !k.figs.has(f)).length < 2)
        || (compRow && near(k) && sharedName(k.names, it.fullText, it.names, k.fullText)));
      if (same) { copyOf.set(it.e.id, same.e.id); continue; }
    }
    kept.push(it);
  }
  let changed = 0;
  for (const it of items) {
    const want = copyOf.get(it.e.id) || null;
    const patch = {};
    if (!!it.e.is_copy !== !!want || (it.e.copy_of || null) !== want) Object.assign(patch, { is_copy: !!want, copy_of: want });
    if (it.kind !== it.e.source_kind) patch.source_kind = it.kind;
    if (Object.keys(patch).length) { await supabase.from('competitor_change_evidence').update(patch).eq('id', it.e.id); changed++; }
  }
  return changed;
}

async function refreshCardCounts(changeId) {
  try { await dedupeCardSignals(changeId); } catch (e) { console.log(`[CI copies] ${changeId}: ${e.message}`); }
  const { data: evAll } = await supabase.from('competitor_change_evidence')
    .select('event_date, published_date, category, signal_name, source_kind, is_copy').eq('change_id', changeId);
  const ev = (evAll || []).filter((e) => !e.is_copy);
  const dates = (ev || []).map((e) => e.event_date || e.published_date).filter(Boolean).sort();
  const patch = { signal_count: Math.max(1, (ev || []).length), card_written_at: null };
  if (dates.length) patch.last_signal_at = dates[dates.length - 1];
  // the card's type = what most of its signals say (own press release counts double, "General Updates" only wins when nothing else is there)
  // e.g. 2x "Acquisitions & mergers" + 1x "Restructuring" -> the card is "Acquisitions & mergers"
  const votes = {};
  for (const e of ev || []) {
    if (!e.signal_name) continue;
    const w = (OWN_SOURCES.has(e.source_kind) ? 2 : 1) * (/general updates/i.test(e.category || '') ? 0.4 : 1);
    votes[e.signal_name] = (votes[e.signal_name] || 0) + w;
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  if (best && (ev || []).length >= 2) {
    const { data: sig } = await supabase.schema('admin').from('signals').select('id, submodule_id, signal_name')
      .eq('module_id', CI_MODULE_ID).eq('signal_name', best[0]).maybeSingle();
    const pick = (ev || []).find((e) => e.signal_name === best[0]);
    if (sig && pick) Object.assign(patch, { signal_id: sig.id, submodule_id: sig.submodule_id, signal_name: sig.signal_name, category: pick.category });
  }
  await supabase.from('competitor_changes').update(patch).eq('id', changeId);
}

// ---------------------------------------------------------------------
// AFTER A RUN: join cards that turned out to be the same event
// Articles arrive one by one, so the first two articles of an event can start two cards before the
// article that links them arrives. With ALL signals in hand the strong rules are checked again,
// card against card; the smaller card's signals move into the bigger card.
// ---------------------------------------------------------------------
function strongSameEvent(A, B) {
  const day = (d) => new Date(String(d).slice(0, 10)).getTime() / 864e5;
  const eventGap = A.c.event_date && B.c.event_date ? Math.abs(day(A.c.event_date) - day(B.c.event_date)) : 999;
  let pubGap = 999;
  for (const a of A.pubs) for (const b of B.pubs) pubGap = Math.min(pubGap, Math.abs(day(a) - day(b)));
  const near = Math.min(eventGap, pubGap) <= LIMITS.MERGE_WINDOW_DAYS;
  const wide = Math.min(eventGap, pubGap) <= 2 * LIMITS.MERGE_WINDOW_DAYS;
  const figs = [...A.figures].filter((f) => B.figures.has(f));
  if (wide && figs.length >= 2) return `same figures (${figs.slice(0, 3).join(', ')})`;
  const q = [...A.periods].find((x) => B.periods.has(x));
  if (wide && q) return `same quarterly results (${q.toUpperCase()})`;
  if (near && A.guidance && B.guidance) return 'same outlook / guidance update';
  const nm = near ? sharedName(A.names, B.text, B.names, A.text) : null;
  if (nm) return `same named campaign / product ("${nm}")`;
  return null;
}

async function joinSplitCards(clientId, comp) {
  const since = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const { data: cards } = await supabase.from('competitor_changes')
    .select('id, category, signal_name, signal_title, summary, event_date, importance, confidence')
    .eq('client_id', clientId).eq('competitor_id', comp.id).eq('is_duplicate', false)
    .in('status', ['pending', 'verified']).gte('event_date', since);
  if (!cards || cards.length < 2) return { joined: 0, notes: [] };
  const { data: ev } = await supabase.from('competitor_change_evidence')
    .select('change_id, signal_title, title, summary, key_facts, published_date, event_date, is_copy').in('change_id', cards.map((c) => c.id));
  const info = cards.map((c) => {
    const sigs = (ev || []).filter((e) => e.change_id === c.id);
    const parts = [c.signal_title, c.summary, ...sigs.flatMap((e) => [e.signal_title, e.title, e.summary, ...(Array.isArray(e.key_facts) ? e.key_facts : [])])].filter(Boolean);
    const text = parts.join(' ');
    return { c, n: sigs.length, text, figures: figuresOf(parts), periods: resultsPeriods(parts), guidance: GUIDANCE.test(text),
      names: namedThings(comp, parts), pubs: sigs.map((e) => e.published_date).filter(Boolean),
      days: sigs.filter((e) => !e.is_copy).map((e) => e.event_date || e.published_date).filter(Boolean).map(dayNum).concat(c.event_date ? [dayNum(c.event_date)] : []) };
  });
  // the card with most signals keeps its id
  info.sort((a, b) => (b.n - a.n) || String(a.c.event_date).localeCompare(String(b.c.event_date)));
  const gone = new Set();
  const notes = [];
  for (let i = 0; i < info.length; i++) {
    const A = info[i];
    if (gone.has(A.c.id)) continue;
    for (let j = i + 1; j < info.length; j++) {
      const B = info[j];
      if (gone.has(B.c.id)) continue;
      // both cards together must still cover at most CARD_WINDOW_DAYS (first signal to last signal)
      const all = [...A.days, ...B.days];
      const span = all.length ? Math.max(...all) - Math.min(...all) : 999;
      let why = A.c.category === B.c.category && span <= CARD_WINDOW_DAYS ? `same competitor + same sub-type within ${CARD_WINDOW_DAYS} days (${A.c.signal_name})` : null;
      // catch-all cards ("Company Updates" / "Others") join only when it is really the same event
      if (why && (isCatchAll(A.c.signal_name) || isCatchAll(B.c.signal_name))) {
        const strong = strongSameEvent(A, B);
        why = strong ? `same event (${strong})` : null;
      } else if (why && A.c.signal_name !== B.c.signal_name) {
        why = null;   // different sub-type (launch vs sunset) -> stay 2 cards
      }
      if (!why) continue;
      await supabase.from('competitor_change_evidence').update({ change_id: A.c.id }).eq('change_id', B.c.id);
      await supabase.from('competitor_changes').update({ is_duplicate: true, status_reason: `joined into ${A.c.id}: ${why}` }).eq('id', B.c.id);
      const patch = {};
      if (RANK[B.c.importance] > RANK[A.c.importance]) patch.importance = B.c.importance;
      if (A.c.confidence === 'low') patch.confidence = 'high';
      if (Object.keys(patch).length) await supabase.from('competitor_changes').update(patch).eq('id', A.c.id);
      try { await qdrant.delete(QDRANT.COLLECTION, { wait: true, points: [B.c.id] }); } catch (e) { /* chat copy is removed by the repair job later */ }
      await refreshCardCounts(A.c.id); // card is written again (with all signals) by the card writer
      // A now carries B's facts too
      A.text += ` ${B.text}`; A.n += B.n; A.pubs.push(...B.pubs); A.days.push(...B.days);
      B.figures.forEach((f) => A.figures.add(f)); B.periods.forEach((f) => A.periods.add(f)); B.names.forEach((f) => A.names.add(f));
      A.guidance = A.guidance || B.guidance;
      gone.add(B.c.id);
      notes.push(`"${B.c.signal_title}" joined into "${A.c.signal_title}" (${why})`);
    }
  }
  if (notes.length) console.log(`[CI join] ${comp.name}: ${notes.length} card(s) joined`);
  return { joined: notes.length, notes };
}

// joint events (e.g. a partnership between two tracked competitors): link the two changes
async function linkRelated(changeId, clientId, url) {
  const { data: same } = await supabase.from('competitor_change_evidence')
    .select('change_id').eq('client_id', clientId).eq('url', url).neq('change_id', changeId);
  const others = [...new Set((same || []).map((r) => r.change_id))];
  if (!others.length) return;
  const { data: rows } = await supabase.from('competitor_changes')
    .select('id, related_change_ids').in('id', [changeId, ...others]);
  for (const r of rows || []) {
    const want = r.id === changeId ? others : [changeId];
    const merged = [...new Set([...(r.related_change_ids || []), ...want])].filter((x) => x !== r.id);
    if (merged.length !== (r.related_change_ids || []).length) {
      await supabase.from('competitor_changes').update({ related_change_ids: merged }).eq('id', r.id);
    }
  }
}

/**
 * Save one checked change (or merge it into the same event).
 * @returns {{outcome: 'saved'|'merged', changeId, verified, mergedBy?}}
 */
// ---------------------------------------------------------------------
// ONE CARD = ONE COMPETITOR + ONE TYPE (main category) within CARD_WINDOW_DAYS (default 15)
// e.g. "Estée Lauder - Partnerships & Alliances": the Microsoft deal and the Nykaa deal are 2 signals of it.
// The WHOLE card may cover at most CARD_WINDOW_DAYS: first signal to last signal. A launch last month and a
// launch this month are 2 cards (old news must not sit inside this month's card). Set CI_CARD_WINDOW_DAYS in .env to change.
// ---------------------------------------------------------------------
const CARD_WINDOW_DAYS = Number(process.env.CI_CARD_WINDOW_DAYS) || LIMITS.CARD_WINDOW_DAYS || 15;
const KNOWN_NEWS_DAYS = 37; // the same-news check looks this far back (separate from the card window)
// signals that only mean "something else happened" - never a reason on their own to put two items in one card
const isCatchAll = (name) => /^(company updates|others?|general updates?)$/i.test(String(name || '').trim());
const dayNum = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).getTime() / 864e5;

/** first and last date of a card's own signals (copies left out) */
async function cardSpan(changeId) {
  const { data } = await supabase.from('competitor_change_evidence')
    .select('event_date, published_date, is_copy').eq('change_id', changeId);
  const days = (data || []).filter((e) => !e.is_copy).map((e) => e.event_date || e.published_date).filter(Boolean).map(dayNum);
  return days.length ? { min: Math.min(...days), max: Math.max(...days) } : null;
}
/** would the card still cover at most CARD_WINDOW_DAYS with this date added? */
const fitsWindow = (span, d) => !span || (Math.max(span.max, d) - Math.min(span.min, d) <= CARD_WINDOW_DAYS);

async function findCategoryCard(clientId, comp, c) {
  const day = (d, plus) => new Date(new Date(`${String(d).slice(0, 10)}T12:00:00Z`).getTime() + plus * 864e5).toISOString().slice(0, 10);
  const { data } = await supabase.from('competitor_changes')
    .select('id, submodule_id, signal_name, signal_title, summary, importance, confidence, status, event_date, last_signal_at')
    .eq('client_id', clientId).eq('competitor_id', comp.id).eq('is_duplicate', false)
    .in('status', ['pending', 'verified']).eq('category', c.signal.category)
    .gte('event_date', day(c.event_date, -CARD_WINDOW_DAYS)).lte('event_date', day(c.event_date, CARD_WINDOW_DAYS))
    .order('event_date', { ascending: false }).limit(5);
  const mine = dayNum(c.event_date);
  // a catch-all item ("Company Updates") may be about an event that already has a card of a REAL type
  // (e.g. "Shiseido shows 60 new items" as Company Updates, while "...60 debut items at the expo" is a launch card):
  // look at the competitor's other cards too, and join only if it is the same event
  if (isCatchAll(c.signal.name)) {
    const { data: others } = await supabase.from('competitor_changes')
      .select('id, submodule_id, signal_name, signal_title, summary, importance, confidence, status, event_date, last_signal_at')
      .eq('client_id', clientId).eq('competitor_id', comp.id).eq('is_duplicate', false)
      .in('status', ['pending', 'verified']).neq('category', c.signal.category)
      .gte('event_date', day(c.event_date, -LIMITS.MERGE_WINDOW_DAYS)).lte('event_date', day(c.event_date, LIMITS.MERGE_WINDOW_DAYS))
      .limit(10);
    const cands = [];
    for (const r of others || []) if (fitsWindow(await cardSpan(r.id), mine)) cands.push({ row: r, title: r.signal_title, summary: r.summary, submodule_id: r.submodule_id, pubGap: Math.abs(dayNum(r.event_date) - mine) });
    if (cands.length) {
      const hit = await pickSameEvent(comp, c, cands);
      if (hit.match) return { row: hit.match.row, score: hit.score, by: `same event as a ${hit.match.row.signal_name} card (${hit.by})` };
    }
  }
  // closest card first; it is used only if ALL its signals + this one fit in CARD_WINDOW_DAYS
  const rows = (data || []).sort((a, b) => Math.abs(dayNum(a.event_date) - mine) - Math.abs(dayNum(b.event_date) - mine));
  for (const r of rows) {
    if (!fitsWindow(await cardSpan(r.id), mine)) continue;
    // a catch-all signal ("Company Updates", "Others") says nothing about WHAT happened:
    // a store opening and a celebrity look are both "Company Updates". Join those only when it is the SAME event.
    if (isCatchAll(c.signal.name) || isCatchAll(r.signal_name)) {
      const hit = await pickSameEvent(comp, c, [{ row: r, title: r.signal_title, summary: r.summary, submodule_id: r.submodule_id, pubGap: Math.abs(dayNum(r.event_date) - mine) }]);
      if (hit.match) return { row: r, score: hit.score, by: `same event (${hit.by})` };
      continue;
    }
    // different sub-type (e.g. "New product launches" vs "Product sunsets") -> its own card
    if (r.signal_name !== c.signal.name) continue;
    return { row: r, score: 1, by: `same competitor + same sub-type within ${CARD_WINDOW_DAYS} days (${c.signal.name})` };
  }
  return null;
}

async function saveChange({ clientId, comp, item, change, runId, country, noMerge = false, skipSameLink = false }) {
  // 1) the card of this competitor + this type (last CARD_WINDOW_DAYS days)
  const same = noMerge ? null : await findCategoryCard(clientId, comp, change);
  if (same) {
    await addEvidence(same.row.id, clientId, item, change);
    await refreshCardCounts(same.row.id);
    const patch = {};
    const { count } = await supabase.from('competitor_change_evidence')
      .select('id', { count: 'exact', head: true }).eq('change_id', same.row.id);
    if (same.row.confidence === 'low' && ((count || 0) >= 2 || OWN_SOURCES.has(item.section))) patch.confidence = 'high';
    if (RANK[change.importance] > RANK[same.row.importance]) patch.importance = change.importance;
    if (Object.keys(patch).length) await supabase.from('competitor_changes').update(patch).eq('id', same.row.id);
    await linkRelated(same.row.id, clientId, item.url);
    // the chat copy shows the number of sources -> refresh it
    const verified = await syncChangeToQdrant(same.row.id);
    return { outcome: 'merged', changeId: same.row.id, verified, mergedBy: `${same.by} (${same.score.toFixed(2)})` };
  }

  // 2) new change
  const row = {
    client_id: clientId,
    module_id: CI_MODULE_ID,
    submodule_id: change.signal.submodule_id,
    signal_id: change.signal.id,
    competitor_id: comp.id,
    organization: comp.name,
    category: change.signal.category,
    signal_name: change.signal.name,
    signal_title: change.title,
    summary: change.summary,
    chat_text: buildChatText(comp, change),
    importance: change.importance,
    // one news article alone = low confidence; the competitor's own site/press = high
    confidence: OWN_SOURCES.has(item.section) ? 'high' : 'low',
    event_date: change.event_date,
    source_kind: item.section,
    country: change.country || country || null,
    status: 'pending',
    content_hash: contentHash(comp, change),
    run_id: runId || null,
  };
  const { data: ins, error } = await supabase.from('competitor_changes').insert(row).select('id').single();
  if (error) {
    // same fingerprint already saved (e.g. run twice) -> treat as merge, never a second row
    if (/duplicate key|competitor_changes_hash_unique/i.test(error.message)) {
      const { data: old } = await supabase.from('competitor_changes').select('id')
        .eq('client_id', clientId).eq('content_hash', row.content_hash).maybeSingle();
      if (old) {
        await addEvidence(old.id, clientId, item, change);
        const verified = await syncChangeToQdrant(old.id);
        return { outcome: 'merged', changeId: old.id, verified, mergedBy: 'same fingerprint' };
      }
    }
    throw new Error(`save failed: ${error.message}`);
  }
  try {
    await addEvidence(ins.id, clientId, item, change);
    await refreshCardCounts(ins.id);
  } catch (e) {
    // a change without proof must not stay: remove it, the article is retried next run
    await supabase.from('competitor_changes').delete().eq('id', ins.id);
    throw e;
  }
  await linkRelated(ins.id, clientId, item.url);
  const verified = await syncChangeToQdrant(ins.id);
  return { outcome: 'saved', changeId: ins.id, verified };
}

module.exports = { loadKnownNews, findSameNews, rememberNews, dedupeCardSignals, joinSplitCards, refreshCardCounts, saveChange, syncChangeToQdrant, repairPendingChanges, buildChatText, contentHash, embed, cosine, pickSameEvent };