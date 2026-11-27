/**
 * modules/dynamicRag/runWorkflow.js
 *
 * STEP 9 — run the approved list of jobs (Govind's doc, Step 9).
 *
 * Part 1 (24 Nov): the runner and the two SEARCH jobs. No AI here.
 *   - the runner takes the batches Step 8 approved, runs up to 3 jobs at
 *     the same time, each only after the jobs it needs; keeps every
 *     result under its task id (T1, T2 …) with status, time, tries and
 *     error; tries a failed job once more; a job whose input failed is
 *     "blocked" (never run on half the evidence)
 *   - retrieve_data      search by meaning in Qdrant (policy_articles),
 *                        then read each signal from Supabase
 *   - structured_search  read the newest / highest impact signals straight
 *                        from the signal tables
 * Part 2 (25 Nov): the AI jobs (extract_facts, summarise, compare, cluster,
 *   identify_patterns, identify_gaps, discover_opportunities, analyse_risks;
 *   prompts DI – 5 … DI – 12 in public.prompts) and validate_evidence (code
 *   only). How they work: see "PART 2" below.
 *
 * Rules (decided with Sneha, see claude/diChatDecisions.md 3l):
 *   - the client is ALWAYS the logged-in client from Step 1, never from
 *     the plan
 *   - only signals the user can open in a tab: Policy (not duplicate),
 *     Market Dynamics on a card, Forward Outlook in an ACTIVE trend,
 *     Competitive Radar verified
 *   - places: a region covers its countries (GCC -> UAE, Saudi …);
 *     "Global" news is never mixed into a country question, unless its
 *     own text names that country; Forward Outlook signals have no country,
 *     so their text must name it
 *   - what the user left out (not_countries / not_companies) is dropped
 *   - a company that is not on the client list and is found nowhere in the
 *     data ("K-beauty", "Gen Z") is searched by its words, never left as a
 *     filter that finds nothing (recorded)
 *   - nothing is made up: nothing found = an empty set that says so; every
 *     signal dropped is counted with its reason
 */

const { getCapability, RUN_LIMITS } = require('./capabilityRegistry');
const { standardPlace, placeCovers, placeFromAdjective, PLACES, REGION_MEMBERS } = require('../placeNames');
const {
  MODULE_IDS, SEARCH_COLLECTION, MIN_SEARCH_SCORE, SEARCH_WIDEN, RUN_TIME_LIMIT_MS, ITEM_TEXT_CHARS,
  SEARCH_MAX_PIECES, EXACT_READ_MAX_ROWS, TAGGED_MAX_SIGNALS, RARE_WORD_MAX_SIGNALS,
  JOB_PROMPT_IDS, AI_ITEM_CHARS, AI_MAX_FINDINGS_IN, CLUSTER_AI_MIN, ANSWER_AI_CALLS, AI_CALL_TIMEOUT_MS,
  REPORTED_LATER_DAYS, MIN_SUPPORTED, ANSWER_TEXT, POINT_SOURCES_CHECK_FROM,
} = require('./chatConfig');
const COMPARE_BY_CODE_POINT = ANSWER_TEXT.compare_by_code_point;

// ── Where each module keeps its signals ──────────────────────────────────
// (placeCol / companyCol: the column a signal's country / company is saved in;
// Policy has no company column, Forward Outlook no country column;
// titleCol: the title, read for a name the user typed, 26 Nov)
const TABLES = {
  policy: { table: 'policy_signals', dateCol: 'source_published_date', key: 'article_id', placeCol: 'country', titleCol: 'signal_title', textCols: ['summary', 'chat_text'] },
  market: { table: 'market_dynamics_signals', dateCol: 'published_date', key: 'article_id', placeCol: 'country', companyCol: 'organization', titleCol: 'signal_title', textCols: ['summary', 'chat_text'] },
  outlook: { table: 'trend_signals', dateCol: 'source_published_date', key: 'article_id', companyCol: 'organization', titleCol: 'signal_title', textCols: ['summary', 'chat_text'] },
  competitor: { table: 'competitor_changes', dateCol: 'event_date', key: 'id', placeCol: 'country', companyCol: 'organization', titleCol: 'signal_title', textCols: ['summary', 'chat_text'] },
};
const moduleOfId = (id) => Object.keys(MODULE_IDS).find((k) => MODULE_IDS[k] === id) || null;

// ── Reading the data (one place, so tests can use fake data) ─────────────
let store = null;
function realStore() {
  // loaded here, so the tests (fake data) need neither
  const { createClient } = require('@supabase/supabase-js');
  const { QdrantClient } = require('@qdrant/js-client-rest');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false, timeout: 20000,
  });
  let embedFn = null;
  const embed = async (text) => {
    if (!embedFn) {
      // the same model and settings the news pipeline used to save the text
      try {
        const shared = require('../llmRelevanceProcessor');
        if (typeof shared.embedText === 'function') embedFn = shared.embedText;
      } catch (e) { /* below */ }
      if (!embedFn) {
        const { pipeline } = require('@xenova/transformers');
        const p = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        embedFn = async (t) => Array.from((await (await p)(t, { pooling: 'mean', normalize: true })).data);
      }
    }
    return embedFn(text);
  };
  const inChunks = async (ids, read) => {
    const out = [];
    for (let k = 0; k < ids.length; k += 100) out.push(...await read(ids.slice(k, k + 100)));
    return out;
  };
  const must = (res, what) => {
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
    return res.data || [];
  };
  return {
    embed,
    async searchPieces({ vector, clientId, moduleIds, dateFrom, dateTo, limit, offset = 0, only = null }) {
      const base = [{ key: 'client_id', match: { value: clientId } }, { key: 'module_id', match: { any: moduleIds } }];
      // only = { articleIds, pointIds }: search by meaning among these signals only
      if (only) {
        const one = [];
        if ((only.articleIds || []).length) one.push({ key: 'article_id', match: { any: only.articleIds } });
        if ((only.pointIds || []).length) one.push({ has_id: only.pointIds });
        base.push(one.length === 1 ? one[0] : { should: one });
      }
      const dates = (dateFrom || dateTo)
        ? [{ key: 'published_date', range: { ...(dateFrom ? { gte: `${dateFrom}T00:00:00Z` } : {}), ...(dateTo ? { lte: `${dateTo}T23:59:59Z` } : {}) } }]
        : [];
      try {
        const res = await qdrant.search(SEARCH_COLLECTION, { vector, limit, offset, filter: { must: [...base, ...dates] }, with_payload: true });
        return { pieces: res, dates_in_search: dates.length > 0 };
      } catch (err) {
        if (!dates.length) throw err;
        // the date filter could not be used by Qdrant: read more without
        // it, the dates are checked on every signal below anyway
        const res = await qdrant.search(SEARCH_COLLECTION, { vector, limit, offset, filter: { must: base }, with_payload: true });
        return { pieces: res, dates_in_search: false, note: `dates checked after the search (${String(err.message).slice(0, 80)})` };
      }
    },
    async readRows(table, keyCol, ids, clientId) {
      return inChunks(ids, async (part) => must(await supabase.from(table).select('*').eq('client_id', clientId).in(keyCol, part), table));
    },
    // keys of the signals whose place / company column looks like one of the
    // patterns (SQL "ilike": _ = any one letter), newest first
    async readTagged(table, { clientId, keyCol, column, patterns, regex, dateCol, from, to, limit }) {
      const quote = (x) => `"${String(x).replace(/"/g, '')}"`;
      let q = supabase.from(table).select(keyCol).eq('client_id', clientId);
      // a regex (case-insensitive, "~*") or the ilike patterns
      q = regex ? q.filter(column, 'imatch', regex) : q.or(patterns.map((pt) => `${column}.ilike.${quote(`%${pt}%`)}`).join(','));
      if (from) q = q.gte(dateCol, from);
      if (to) q = q.lte(dateCol, `${to}T23:59:59`);
      return must(await q.order(dateCol, { ascending: false }).limit(limit), table).map((r) => r[keyCol]).filter(Boolean);
    },
    async readRecent(table, { clientId, dateCol, from, to, limit, offset = 0, orderCol }) {
      let q = supabase.from(table).select('*').eq('client_id', clientId);
      if (from) q = q.gte(dateCol, from);
      if (to) q = q.lte(dateCol, `${to}T23:59:59`);
      return must(await q.order(orderCol || dateCol, { ascending: false }).order('id', { ascending: false }).range(offset, offset + limit - 1), table);
    },
    async readActiveTrends(signalIds) {
      // Forward Outlook: a signal is shown only inside an ACTIVE trend
      const members = await inChunks(signalIds, async (part) => must(await supabase.from('trend_membership').select('trend_id, signal_id').in('signal_id', part), 'trend_membership'));
      const trendIds = [...new Set(members.map((m) => m.trend_id))];
      const trends = await inChunks(trendIds, async (part) => must(await supabase.from('trend_clusters').select('id, name, status').in('id', part), 'trend_clusters'));
      const active = new Map(trends.filter((t) => t.status === 'active').map((t) => [t.id, t]));
      const out = new Map();
      for (const m of members) if (active.has(m.trend_id) && !out.has(m.signal_id)) out.set(m.signal_id, { id: m.trend_id, name: active.get(m.trend_id).name });
      return out;
    },
    // Competitive Radar: the news (articles) on these change cards, as the
    // Competitive Radar tab shows them (competitor_signals_live)
    async readCardSignals(changeIds) {
      return inChunks(changeIds, async (part) => must(await supabase.from('competitor_signals_live')
        .select('id, change_id, signal_title, summary, published_date, event_date').in('change_id', part), 'competitor_signals_live'));
    },
    async readCards(cardIds) {
      const rows = await inChunks(cardIds, async (part) => must(await supabase.from('market_insights').select('*').in('id', part), 'market_insights'));
      return new Map(rows.map((r) => [r.id, r.title || r.insight_title || r.name || r.headline || '']));
    },
  };
}
const getStore = () => { if (!store) store = realStore(); return store; };
/** Tests give fake data here. */
function useStore(s) { store = s; }

// ── Small helpers ────────────────────────────────────────────────────────
const plain = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();
const dayOf = (d) => (d ? String(d).slice(0, 10) : null);
const cut = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
// cut at a space, never inside a word or a number ("338" never "3…")
const cutAtWord = (t, n) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const head = s.slice(0, n - 1);
  const sp = head.lastIndexOf(' ');
  return `${sp > n * 0.6 ? head.slice(0, sp) : head}…`;
};
const hasWords = (text, phrase) => {
  const p = plain(phrase);
  return p.length >= 2 && ` ${plain(text)} `.includes(` ${p} `);
};
// the core of a company name: "The Estée Lauder Companies" -> "estee lauder"
// (26 Nov, question bank: "Etraveli Group AB" — the legal forms used in
// other countries too: AB, AG, GmbH, NV, BV, SpA, Pvt, Pte, Limited)
const LEGAL = new Set(['the', 'companies', 'company', 'group', 'inc', 'ltd', 'llc', 'plc', 'corp', 'corporation', 'holdings', 'co',
  'ab', 'ag', 'gmbh', 'nv', 'bv', 'spa', 'sarl', 'llp', 'limited', 'pvt', 'pte', 'private']);
const companyCore = (n) => plain(n).split(' ').filter((w) => !LEGAL.has(w)).join(' ');
// 26 Nov (browser: "updates about kbeauty" -> nothing found, "Kbeauty market"
// -> other news; the data writes "K-Beauty"): a name written together, with a
// hyphen, a space, an apostrophe or accents is the same name ("kbeauty" =
// "K-Beauty", "loreal" = "L'Oréal", "kanu fresh" = "KanuFresh"). Only WHOLE
// words count: "kbeauty" is not inside "Milk Beauty".
const squeeze = (t) => plain(t).replace(/ /g, '');
const SQUEEZE_MIN = 4;   // shorter names are compared as written
function namesWordRun(text, name) {
  const target = squeeze(companyCore(name));
  if (target.length < SQUEEZE_MIN) return false;
  const words = plain(text).split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    let run = '';
    for (let j = i; j < Math.min(words.length, i + 4); j += 1) {
      run += words[j];
      if (run === target) return true;
      if (run.length >= target.length) break;
    }
  }
  return false;
}
function sameCompany(a, b) {
  const x = companyCore(a);
  const y = companyCore(b);
  if (!x || !y) return false;
  if (namesWordRun(y, x) || namesWordRun(x, y)) return true;
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

// Does the text name this place (or, for a region, one of its countries)?
// Long forms as words; short forms only in CAPITALS ("UAE", "KSA"; "us" is a word).
function textNamesPlace(text, place) {
  const all = [place, ...((REGION_MEMBERS && REGION_MEMBERS[place]) || [])];
  for (const p of all) {
    for (const f of [p, ...((PLACES && PLACES[p]) || [])]) {
      const s = String(f);
      if (s.length >= 4 && hasWords(text, s)) return true;
      if (s.length >= 2 && s.length < 4 && new RegExp(`(?<![A-Za-z])${s.toUpperCase().replace(/\./g, '\\.')}(?![A-Za-z])`).test(String(text))) return true;
    }
  }
  // 26 Nov (question bank, Booking Holdings): a Global news item says
  // "European Commission", "European Union", never "Europe" -> the place's
  // adjective counts too ("European" -> Europe, "Indian" -> India), with the
  // same adjective rule Step 5 uses (placeNames.placeFromAdjective)
  const wanted = new Set(all);
  return (String(text).match(/\p{L}{4,}/gu) || []).some((w) => {
    const p = placeFromAdjective(w);
    return Boolean(p && wanted.has(p));   // the place asked or one of its countries (never a bigger region)
  });
}

// ── One row -> one evidence item (the EvidenceSet shape of the job list) ─
function toItem(module, row, extra = {}) {
  const t = TABLES[module];
  const countries = String(row.country || '').split(/[,;/]/).map((x) => x.trim()).filter(Boolean)
    .map((x) => standardPlace(x) || x);
  const company = row.organization && !/^(unknown|n\/a|none|various|multiple)$/i.test(String(row.organization).trim()) ? row.organization : null;
  return {
    source_id: `${module}:${row.id}`,
    module,
    signal_id: row.id,
    article_id: row.article_id || null,
    title: cut(row.signal_title || row.title, 200),
    text: cutAtWord(row.summary || row.chat_text || '', ITEM_TEXT_CHARS),
    date: dayOf(row[t.dateCol] || row.created_at),
    url: row.source_article_url || row.source_url || row.url || extra.url || null,
    countries: module === 'outlook' ? [] : countries,
    companies: company ? [company] : [],
    impact: row.impact_level || row.importance || null,
    group: extra.group || null,
    score: extra.score == null ? null : Math.round(extra.score * 1000) / 1000,
  };
}

// Is this row one the user can see in the tab?
function visible(module, row) {
  if (row.is_duplicate === true) return false;
  if (module === 'market') return Boolean(row.insight_id);
  if (module === 'competitor') return row.status === 'verified';
  return true;   // outlook: checked against active trends separately
}

// ── The filters every search keeps (dates, places, companies, left out) ──
// Returns the items kept, and the count of dropped items per reason.
// News about a period is often written after the period ends (25 Nov:
// "How did Shiseido do in Q3 2026?" — "Shiseido returns to profitability in
// Q3 2026" is dated 30 Oct, after Q3, so it was never read). When the period
// the user typed is over, news up to REPORTED_LATER_DAYS after its end is
// read too, and kept ONLY when its text names that period as typed ("Q3
// 2026"; Q1–Q4 / H1–H2 also as "third quarter 2026": a small fixed set).
// Periods with no number ("last month", "this year") are not widened.
const PERIOD_WORDS = { q1: 'first quarter', q2: 'second quarter', q3: 'third quarter', q4: 'fourth quarter', h1: 'first half', h2: 'second half' };
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function reportedLater(inputs, understood) {
  const to = inputs.date_to;
  const today = new Date().toISOString().slice(0, 10);
  if (!to || to >= today) return null;
  const ranges = ((understood && understood.time && understood.time.ranges) || [])
    .filter((r) => r && r.text && /\d/.test(r.text) && r.to && r.to <= to && (!inputs.date_from || r.to >= inputs.date_from));
  if (!ranges.length) return null;
  const phrases = new Set();
  for (const r of ranges) {
    phrases.add(String(r.text));
    const m = String(r.text).match(/\b([qh][1-4])\b(?:\s*(?:of\s*)?((?:19|20)\d\d))?/i);
    const words = m && PERIOD_WORDS[m[1].toLowerCase()];
    if (words) {
      phrases.add(`${m[1]}${m[2] ? ` ${m[2]}` : ''}`);
      phrases.add(`${words}${m[2] ? ` ${m[2]}` : ''}`);
      if (m[2]) phrases.add(`${words} of ${m[2]}`);
    }
  }
  const until = addDays(to, REPORTED_LATER_DAYS);
  return { until: until < today ? until : today, phrases: [...phrases] };
}
// the last day a search reads (the period end, or later for reported-later news)
const readUntil = (inputs, understood) => { const l = reportedLater(inputs, understood); return l ? l.until : inputs.date_to; };

// inData: the database names a company asked (its company field or title,
// any date): then its filter is never dropped (26 Nov, see filterItems)
// the signal's company, or its text names the company
const namesCompany = (it, name) => it.companies.some((c) => sameCompany(name, c)) || hasWords(`${it.title} ${it.text}`, companyCore(name)) ||
  namesWordRun(`${it.title} ${it.text}`, name);
// 26 Nov (DB check, "What did L'Oréal do with NVIDIA?"): two or more
// companies asked together -> the news naming ALL of them comes first (it
// was the 20 newest L'Oréal news, the NVIDIA one was older); the rest after.
function allNamesFirst(items, companies) {
  if (!companies || companies.length < 2) return items;
  const all = items.filter((it) => companies.every((c) => namesCompany(it, c)));
  if (!all.length) return items;
  const set = new Set(all);
  return [...all, ...items.filter((it) => !set.has(it))];
}

// 26 Nov (dbcheck #30): "What did L'Oréal do WITH NVIDIA?" asks about the
// companies TOGETHER: then only the news naming all of them is listed (the
// list was filled up with Coty and Estée Lauder news). Together = the
// question puts "with" between two of the names, or "between" before them
// (small grammar set). "news on Lancôme and Dior" asks for either: unchanged.
function namesTogether(question, companies) {
  if (!companies || companies.length < 2) return false;
  const q = String(question || '');
  const at = companies.map((c) => {
    const rx = squeezedRegex([c]);
    const m = rx ? new RegExp(rx, 'i').exec(q) : null;
    return m ? m.index : -1;
  });
  if (at.some((x) => x < 0)) return false;   // a name not found as typed: as before
  const first = Math.min(...at);
  const last = Math.max(...at);
  const between = q.slice(first, last);
  return /(^|[^a-z])with([^a-z]|$)/i.test(between) || /(^|[^a-z])between([^a-z]|$)/i.test(q.slice(0, first));
}
// keeps only the news naming every company when they are asked together
function onlyTogether(items, inputs, ctx, reasons, notes) {
  const companies = inputs.companies || [];
  const u = (ctx && ctx.understood) || {};
  if (!namesTogether(u.question_typed || u.question_text || '', companies)) return items;
  const all = items.filter((it) => companies.every((c) => namesCompany(it, c)));
  if (!all.length) return items;               // none names them all: as before
  const left = items.length - all.length;
  if (left) {
    reasons['did not name every company asked together'] = (reasons['did not name every company asked together'] || 0) + left;
    notes.push(`the companies were asked together: only the ${all.length} news naming all of them kept`);
  }
  return all;
}

function applyFilters(items, inputs, understood, notes, inData = false) {
  const out = filterItems(items, inputs, understood, notes, inData);
  const to = inputs.date_to;
  const keptLater = to ? out.items.filter((it) => it.date > to).length : 0;
  if (keptLater) notes.push(`${keptLater} news written after the period but naming it ("${reportedLater(inputs, understood).phrases[0]}") kept`);
  return out;
}
function filterItems(items, inputs, understood, notes, inData = false) {
  const reasons = {};
  const drop = (why) => { reasons[why] = (reasons[why] || 0) + 1; return false; };
  const from = inputs.date_from || null;
  const to = inputs.date_to || null;
  const places = (inputs.countries || []).map((p) => standardPlace(p) || p);
  const notPlaces = (inputs.not_countries || []).map((p) => standardPlace(p) || p);
  const companies = inputs.companies || [];
  const notCompanies = inputs.not_companies || [];

  const later = reportedLater(inputs, understood);
  const byDatePlaceLeftOut = items.filter((it) => {
    const text = `${it.title} ${it.text}`;
    if (from && (!it.date || it.date < from)) return drop('before the dates asked');
    if (to && (!it.date || it.date > to)) {
      if (!(later && it.date <= later.until && later.phrases.some((ph) => hasWords(text, ph)))) return drop('after the dates asked');
    }
    if (places.length) {
      // a "Global" side of a comparison reads the worldwide news (no
      // country, or tagged Global); any other place needs its own country
      // (or a region holding it), or its name in the text
      const globalAsked = places.includes('Global');
      const tagged = it.countries.filter((c) => c && !/^global$/i.test(c));
      const isGlobalItem = tagged.length === 0;
      const covered = tagged.some((c) => places.some((p) => p !== 'Global' && placeCovers(p, c))) || (globalAsked && isGlobalItem);
      // 25 Nov (playground): an Oman-tagged item came into "latest regs in
      // UAE" and a South Africa one ("SA's wellness sector") into a Saudi
      // question, because their text named the place. Only news with no
      // country (or Global) and Forward Outlook may get in by its text, as the
      // rule says; news tagged with another country stays out.
      const named = isGlobalItem && places.some((p) => p !== 'Global' && textNamesPlace(text, p));
      if (!covered && !named) return drop(tagged.length ? 'another country' : 'not about the place asked (no country / Global)');
    }
    // left out: a signal only about left-out countries goes (one tagged with
    // a region, "GCC", stays: it is about the whole region)
    const onlyLeftOut = it.countries.length > 0 && it.countries.every((c) => !REGION_MEMBERS[c] && notPlaces.some((p) => placeCovers(p, c)));
    if (notPlaces.length && onlyLeftOut) return drop('a place the user left out');
    if (notCompanies.length && (it.companies.some((c) => notCompanies.some((n) => sameCompany(n, c))) || notCompanies.some((n) => hasWords(it.title, companyCore(n))))) {
      return drop('a company the user left out');
    }
    return true;
  });
  if (!companies.length) return { items: byDatePlaceLeftOut, reasons };

  // companies: the signal's company, or its text names the company
  const fz = inputs.fuzzy_rx ? new RegExp(inputs.fuzzy_rx, 'i') : null;
  const matches = (it, n) => namesCompany(it, n) || Boolean(fz && (fz.test(`${it.title} ${it.text}`) || it.companies.some((c) => fz.test(c))));
  const kept = byDatePlaceLeftOut.filter((it) => companies.some((n) => matches(it, n)) || drop('another company'));
  if (kept.length) return { items: kept, reasons };
  if (inData === 'nowhere') {
    const note = `companies: ${companies.join(', ')} found nowhere in the data (company, title or text), so nothing was found`;
    if (!notes.includes(note)) notes.push(note);
    return { items: kept, reasons };
  }

  // Nothing matched. A company the client list does not know and the data
  // never names ("K-beauty", "Gen Z") is searched by its words: the filter
  // is dropped instead of finding nothing (recorded). A known competitor
  // stays a filter: "nothing found for Lancôme" is a true answer.
  // 26 Nov (DI tab, root cause): this was decided on ONE page of 100 news.
  // "what is the update about Catalio": Catalio is the 217th newest Market
  // Dynamics item; the first page had none, so the filter was dropped and
  // the 20 newest news of the whole data were shown. "Any news on Kanufresh":
  // the same in the search by meaning (KanuFresh is in two Forward Outlook
  // titles). Now the whole database is asked first (companyLookup): a name
  // it holds keeps its filter on every page.
  if (inData) return { items: kept, reasons };
  // 26 Nov (DI tab): "what is the update about Catalio" was an EXACT read
  // (no search words): dropping the filter there gave the 20 newest news of
  // the whole data as if they were about Catalio. An exact read has no words
  // to search by, so it keeps the filter: nothing found is the true answer.
  const known = knownCompanies(understood);
  const unknown = companies.filter((n) => !known.some((k) => sameCompany(k, n)));
  if (unknown.length === companies.length && !inputs.query) {
    const note = `companies: ${unknown.join(', ')} found nowhere in the data, so nothing was found`;
    if (!notes.includes(note)) notes.push(note);
    return { items: kept, reasons };
  }
  if (unknown.length === companies.length) {
    const note = `companies: ${unknown.join(', ')} found nowhere in the data as a company, so searched by the words only`;
    if (!notes.includes(note)) notes.push(note);
    delete reasons['another company'];
    return { items: byDatePlaceLeftOut, reasons };
  }
  return { items: kept, reasons };
}

// The companies the client list knows (own company, competitors, matched names).
function knownCompanies(understood) {
  return [
    ...((understood && understood.client && understood.client.competitors) || []),
    understood && understood.client && understood.client.company_name,
    ...((understood && understood.companies) || []).filter((c) => c && c.matched).map((c) => c.matched.name),
  ].filter(Boolean);
}

// ── Signals TAGGED with the place / company asked (25 Nov) ───────────────
// The search index has no country or company on its pieces, so a search
// read the closest pieces and checked each signal: Saudi news further from
// the words than the 600 closest pieces was never seen ("Compare Saudi
// Arabia and UAE": 5 Saudi signals, stopped at the cap). So first the
// tables say which signals are tagged with the company (any country) or,
// with no company, the place (a region: the region and its countries);
// the search by meaning then runs among those signals only. The wide
// search still runs after it, for Global news whose text names the place.
// The patterns only narrow; every signal is still checked by applyFilters.
// _ = any one letter (accents: "Estee" finds "Estée"; vowels, c and y too).
const likePattern = (name, loose) => String(name).trim()
  .replace(/[%_"]/g, '')
  .replace(loose ? /[aeiouycAEIOUYC]|[^\x00-\x7F]/g : /[^\x00-\x7F]/g, '_');
// 26 Nov: every company name asked, also one the client list does not
// know ("Catalio", "Kanufresh"): a known name loose (accents), another one
// as typed with any one letter between its words ("k beauty" finds
// "K-Beauty"), so a different word ("catalog") is not taken for it.
// The name as a regex the database reads (Postgres "~*", the same text works
// in JavaScript): its letters in order, up to 2 non-letters between them
// (space, hyphen, apostrophe, dot), accents allowed, whole words only.
// "kbeauty" finds "K-Beauty", "loreal" finds "L'Oréal".
const RX_LETTER = '[a-z0-9à-öø-ÿ]';
const RX_GAP = '[^a-z0-9à-öø-ÿ]{0,2}';
const RX_ACCENTS = { a: '[aàáâãäå]', e: '[eèéêë]', i: '[iìíîï]', o: '[oòóôõöø]', u: '[uùúûü]', c: '[cç]', n: '[nñ]', y: '[yýÿ]' };
function squeezedRegex(names) {
  const one = [...new Set(names.map((n) => squeeze(companyCore(n))).filter((x) => x.length >= SQUEEZE_MIN))]
    .map((x) => x.split('').map((ch) => RX_ACCENTS[ch] || ch).join(RX_GAP));
  return one.length ? `(^|[^a-z0-9à-öø-ÿ])(${one.join('|')})([^a-z0-9à-öø-ÿ]|$)` : null;
}
// 26 Nov (question bank): a name typed with one letter left out or one
// letter changed found nothing ("notno" = Notino, "rhamsydl" = Rhamsydil,
// "faivleytech" = FaiveleyTech). Asked only when the name as written is
// nowhere: every way of writing it with one letter more or one letter
// changed, whole words only. Not for names under FUZZY_MIN letters, and not
// for a word one letter away from an English word ("cosmtics" is a typo of
// "cosmetics", not a name).
const FUZZY_MIN = 5;
const FUZZY_MAX = 20;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');
function nearEnglishWord(x) {
  for (let i = 0; i <= x.length; i += 1) {
    for (const ch of ALPHABET) {
      if (isEnglishWord(x.slice(0, i) + ch + x.slice(i))) return true;
      if (i < x.length && ch !== x[i] && isEnglishWord(x.slice(0, i) + ch + x.slice(i + 1))) return true;
    }
  }
  return false;
}
function fuzzyRegex(names) {
  const alts = new Set();
  for (const n of names) {
    const x = squeeze(companyCore(n));
    if (x.length < FUZZY_MIN || x.length > FUZZY_MAX || !/^[a-z0-9]+$/.test(x) || nearEnglishWord(x)) continue;
    for (let i = 0; i <= x.length; i += 1) {
      alts.add(`${x.slice(0, i)}${RX_LETTER}${x.slice(i)}`);                 // one letter left out
      if (i < x.length) alts.add(`${x.slice(0, i)}${RX_LETTER}${x.slice(i + 1)}`);   // one letter changed
    }
  }
  return alts.size ? `(^|[^a-z0-9à-öø-ÿ])(${[...alts].join('|')})([^a-z0-9à-öø-ÿ]|$)` : null;
}
function companyPatterns(inputs, understood) {
  const known = knownCompanies(understood);
  const pats = [];
  for (const n of inputs.companies || []) {
    const core = companyCore(n);
    if (plain(core).length < 3) continue;
    pats.push(known.some((k) => sameCompany(k, n)) ? likePattern(core, true) : likePattern(core, false).replace(/ /g, '_'));
  }
  return pats.length ? { kind: 'company', patterns: [...new Set(pats)], regex: squeezedRegex(inputs.companies || []), fuzzy: fuzzyRegex(inputs.companies || []) } : null;
}
function tagPatterns(inputs, understood, kind = null) {
  if (kind !== 'place') {
    const c = companyPatterns(inputs, understood);
    if (c || kind === 'company') return c;
  }
  const places = (inputs.countries || []).map((p) => standardPlace(p) || p);
  // a "Global" side reads worldwide news: that is most of the news, no narrowing
  if (!places.length || places.includes('Global')) return null;
  const names = new Set();
  for (const p of places) {
    for (const x of [p, ...(REGION_MEMBERS[p] || [])]) {
      names.add(x);
      // other ways it is written, long ones only ("uae" would be found inside other words)
      for (const f of PLACES[x] || []) if (f.length >= 4) names.add(f);
    }
  }
  return { kind: 'place', patterns: [...names].map((n) => likePattern(n, false)) };
}
async function readTags(tag, inputs, ctx, modules, { anyDate = false, limit = TAGGED_MAX_SIGNALS } = {}) {
  const s = getStore();
  if (!tag || typeof s.readTagged !== 'function') return null;
  const only = { kind: tag.kind, articleIds: [], pointIds: [], byModule: {} };
  await Promise.all(modules.map(async (m) => {
    const t = TABLES[m];
    // a company: its company field AND its title (KanuFresh is in the title,
    // the company field says "Lucas Meyer Cosmetics by Clariant")
    const columns = tag.kind === 'company' ? [t.companyCol, t.titleCol] : [t.placeCol];
    const keys = new Set();
    for (const column of columns.filter(Boolean)) {
      const ask = { clientId: ctx.clientId, keyCol: t.key, column, patterns: tag.patterns, dateCol: t.dateCol,
        from: anyDate ? null : inputs.date_from, to: anyDate ? null : readUntil(inputs, ctx.understood), limit };
      if ((tag.patterns || []).length) (await s.readTagged(t.table, ask)).forEach((k) => keys.add(k));
      if (tag.regex) {
        try {
          (await s.readTagged(t.table, { ...ask, regex: tag.regex })).forEach((k) => keys.add(k));
        } catch (e) {
          // the names as written still work (the ilike read above)
          if (!ctx.regexNote) { ctx.regexNote = true; console.warn(`[DynamicRAG] the name read with spaces / hyphens ignored failed: ${e.message}`); }
        }
      }
    }
    only.byModule[m] = [...keys];
    (m === 'competitor' ? only.pointIds : only.articleIds).push(...keys);
  }));
  only.articleIds = [...new Set(only.articleIds)];
  only.pointIds = [...new Set(only.pointIds)];
  if (only.articleIds.length || only.pointIds.length) return only;
  // nothing as written: the company name with one letter left out / changed
  if (tag.kind === 'company' && tag.fuzzy && !tag.isFuzzy) {
    const again = await readTags({ kind: 'company', patterns: [], regex: tag.fuzzy, isFuzzy: true }, inputs, ctx, modules, { anyDate, limit });
    if (again) again.fuzzy = tag.fuzzy;
    return again;
  }
  return null;
}
// ── Rare words of a search, looked up in the news titles (26 Nov) ────────
// "updates about kbeauty": Step 5 read "kbeauty" as a topic word, and the
// search by meaning does not know "kbeauty" (the news writes "K-Beauty"),
// so it brought other beauty news. A word of the search that is not an
// English word (data/englishWords.txt, the same free list as Step 2) and
// not a place or a company asked is looked up in the TITLES, written in any
// way (squeezedRegex: hyphens, spaces, apostrophes and accents do not
// count, whole words only); also joined with the word next to it ("kanu
// fresh" = "KanuFresh"). The news whose title holds it is searched first,
// then the wide search as always. Not a filter. A word in more titles than
// RARE_WORD_MAX_SIGNALS is common in this client's news: not used. Only
// English words in the search -> nothing changes.
let englishWordSet = null;
const englishWordRank = new Map();   // the list is most-used first: its line number
function englishWords() {
  if (englishWordSet) return englishWordSet;
  englishWordSet = new Set();
  try {
    const fs = require('fs');
    const file = require('path').join(__dirname, 'data', 'englishWords.txt');
    for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split('\n')) {
      const w = line.trim().split(' ')[0];
      if (w && /^[a-z]+$/.test(w)) { englishWordSet.add(w); if (!englishWordRank.has(w)) englishWordRank.set(w, englishWordRank.size + 1); }
    }
  } catch (e) { /* no word list: no word is rare, the search is as before */ }
  return englishWordSet;
}
const WORD_ENDINGS = ['s', 'es', 'ed', 'ing', 'ly', 'er', 'ers'];
function isEnglishWord(w) {
  const set = englishWords();
  if (!set.size || set.has(w)) return true;
  return WORD_ENDINGS.some((e) => w.length > e.length + 2 && w.endsWith(e) && set.has(w.slice(0, -e.length)));
}
function rareWordsOf(query, inputs, understood) {
  const words = plain(query).split(' ').filter(Boolean);
  const named = [...(inputs.companies || []), ...(inputs.countries || []), understood && understood.client && understood.client.company_name]
    .filter(Boolean).flatMap((n) => plain(n).split(' '));
  const skip = new Set(named);
  const out = new Set();
  const rare = (w) => !(w.length < 4 || !/[a-z]/.test(w) || /^\d/.test(w) || skip.has(w) || isEnglishWord(w) || PLACES[standardPlace(w)] || REGION_MEMBERS[standardPlace(w)]);
  words.forEach((w, i) => {
    if (!rare(w)) return;
    out.add(w);
    if (words[i + 1]) out.add(`${w} ${words[i + 1]}`);
    if (i > 0) out.add(`${words[i - 1]} ${w}`);
  });
  // a word typed with a dot, a hyphen or capitals inside is one name
  // ("Dr.Althea" -> "dralthea", although "althea" alone is an English word)
  for (const raw of String(query || '').split(/\s+/)) {
    const t = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (/[\p{L}\p{N}][.\-'’][\p{L}\p{N}]|\p{Ll}\p{Lu}/u.test(t) && rare(squeeze(t))) out.add(squeeze(t));
    // 27 Nov (dbcheck on Hy4, "What is Greek law 5317/2026?"): a code
    // number names one thing as surely as a rare word: "5317/2026",
    // "2026/909", "1223/2009", or 4+ digits that are not a year ("5317").
    // Years and counts are not looked up.
    if (/^\d{2,}\/\d{2,}$/.test(t)) out.add(t.replace('/', ''));
    else if (/^\d{4,}$/.test(t) && !(t.length === 4 && Number(t) >= 1900 && Number(t) <= 2099)) out.add(t);
  }
  return [...out];
}
async function rareWordSignals(rare, inputs, ctx, modules, fuzzy = false) {
  const s = getStore();
  // 26 Nov (question bank, "lg hair loss compound rhamsydl"): nothing as
  // written -> the single words once more with one letter left out / changed
  const regex = fuzzy ? fuzzyRegex(rare.filter((w) => !w.includes(' '))) : squeezedRegex(rare);
  if (!regex || typeof s.readTagged !== 'function') return null;
  const only = { kind: 'word', articleIds: [], pointIds: [], byModule: {} };
  try {
    await Promise.all(modules.map(async (m) => {
      const t = TABLES[m];
      if (!t.titleCol) return;
      const keys = await s.readTagged(t.table, {
        clientId: ctx.clientId, keyCol: t.key, column: t.titleCol, regex, dateCol: t.dateCol,
        from: inputs.date_from, to: readUntil(inputs, ctx.understood), limit: RARE_WORD_MAX_SIGNALS + 1,
      });
      only.byModule[m] = [...new Set(keys)];
      (m === 'competitor' ? only.pointIds : only.articleIds).push(...only.byModule[m]);
    }));
  } catch (e) {
    return null;   // the database refused the read: the search as before
  }
  only.articleIds = [...new Set(only.articleIds)];
  only.pointIds = [...new Set(only.pointIds)];
  const n = only.articleIds.length + only.pointIds.length;
  if (!n) return fuzzy ? null : rareWordSignals(rare, inputs, ctx, modules, true);
  if (n > RARE_WORD_MAX_SIGNALS) return { common: n };
  if (fuzzy) only.fuzzy = true;
  return only;
}

// Step 3 (26 Nov, dbcheck "Dr.Althea 345 relief line" asked back): the rare
// words of a question that the client's news titles hold. A question naming
// something the data has is never "too vague". A failed read -> [].
async function wordsInTitles(text, clientId) {
  const rare = rareWordsOf(text, {}, null);
  const s = getStore();
  if (!rare.length || !clientId || typeof s.readTagged !== 'function') return [];
  const single = rare.filter((w) => !w.includes(' '));
  const inTitles = async (regex) => {
    if (!regex) return false;
    const hits = await Promise.all(Object.keys(TABLES).map((m) => {
      const t = TABLES[m];
      return s.readTagged(t.table, { clientId, keyCol: t.key, column: t.titleCol, regex, dateCol: t.dateCol, limit: 1 });
    }));
    return hits.some((h) => h.length);
  };
  try {
    if (await inTitles(squeezedRegex(rare))) return single;
    // 26 Nov (question bank, "notno ai decision-making"): a name typed with
    // one letter left out / changed (Notino)
    return (await inTitles(fuzzyRegex(single))) ? single : [];
  } catch (e) {
    return [];
  }
}

// the signals to search among: tagged with the company asked, else (none
// tagged, or no company) with the place asked
async function taggedSignals(inputs, ctx, modules) {
  const byCompany = await readTags(tagPatterns(inputs, ctx.understood, 'company'), inputs, ctx, modules);
  if (byCompany) return byCompany;
  return readTags(tagPatterns(inputs, ctx.understood, 'place'), inputs, ctx, modules);
}
// Does the database name a company asked, at any date (its company field or
// title)? Asked only when the dates found none: "nothing in these dates"
// must not turn into "the data never names it" (then its words are searched).
// 26 Nov (question bank): also the news TEXT (a company named only there,
// "Etraveli Group AB"), and when the database holds the name in no field
// at all and the name has a word that is not English ("Fenbelqor
// Botanics", "Trosulrix Labs"), the answer is "nothing found" ('nowhere'):
// searching its other words ("botanics", "labs") brought unrelated news as
// if it were about that name. A name of English words only ("Gen Z") is
// still searched by its words. Found only with one letter left out or
// changed: 'fuzzy' (the filter then accepts that spelling, fuzzyOf).
async function companyInData(inputs, ctx, modules, tagged) {
  const tag = tagPatterns(inputs, ctx.understood, 'company');
  if (!tag) return false;
  if (tagged && tagged.kind === 'company') return tagged.fuzzy ? 'fuzzy' : true;
  const found = await readTags(tag, inputs, ctx, modules, { anyDate: true, limit: 1 });
  if (found) return found.fuzzy ? 'fuzzy' : true;
  if (!tag.regex) return false;
  const s = getStore();
  let readOk = true;
  for (const m of modules) {
    const t = TABLES[m];
    for (const column of t.textCols || []) {
      try {
        const got = await s.readTagged(t.table, { clientId: ctx.clientId, keyCol: t.key, column, regex: tag.regex, dateCol: t.dateCol, limit: 1 });
        if (got.length) return true;
        break;   // this table has this text column: no need for the other one
      } catch (e) { readOk = false; }
    }
  }
  const rare = (inputs.companies || []).some((n) => rareWordsOf(n, {}, ctx.understood).some((w) => !w.includes(' ')));
  return readOk && rare ? 'nowhere' : false;
}
// 27 Nov (bank run on Hy4, "faivleytech sustainable packaging"): the AI
// wrote the name as "FairleyTech" (one letter changed from what the user
// typed), and that spelling is two letters away from the data's
// "FaiveleyTech", so nothing was found. When a company asked is nowhere in
// the data, the user's own word that is at most 2 letters away from it is
// looked up the same way (company field, title, one letter left out or
// changed); found -> that word is the company searched (noted). Only a
// typed word that is not English and close to the name: another rare word
// of the question is never taken for the company.
const TYPED_NAME_MAX_LETTERS = 2;
function lettersApart(a, b) {
  if (Math.abs(a.length - b.length) > TYPED_NAME_MAX_LETTERS) return TYPED_NAME_MAX_LETTERS + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
async function typedNameFor(inputs, ctx, modules) {
  const typed = (ctx.understood && ctx.understood.question_typed) || '';
  if (!typed) return null;
  const names = (inputs.companies || []).map((n) => squeeze(companyCore(n))).filter(Boolean);
  const words = rareWordsOf(typed, { countries: inputs.countries }, ctx.understood).filter((w) => !w.includes(' '));
  for (const w of words) {
    const x = squeeze(w);
    if (names.includes(x) || !names.some((n) => lettersApart(x, n) <= TYPED_NAME_MAX_LETTERS)) continue;
    const tryInputs = { ...inputs, companies: [w] };
    const found = await readTags(tagPatterns(tryInputs, ctx.understood, 'company'), tryInputs, ctx, modules, { anyDate: true, limit: 1 });
    if (found) return w;
  }
  return null;
}
// the filter accepts a name found only with one letter left out / changed
const fuzzyOf = (inputs, only, inData) => (inData === 'fuzzy' ? (only && only.fuzzy) || fuzzyRegex(inputs.companies || []) : null);

// ── The two search jobs ──────────────────────────────────────────────────
const modulesOf = (inputs) => (inputs.modules && inputs.modules.length ? inputs.modules : Object.keys(TABLES)).filter((m) => TABLES[m]);

// Rows already read -> items the user can open in a tab (with card / trend).
async function itemsFromRows(module, rows, hits, clientId, reasons) {
  const s = getStore();
  const t = TABLES[module];
  const seen = [];
  for (const r of rows) {
    if (r.client_id && r.client_id !== clientId) continue;   // never another client's data
    if (visible(module, r)) { seen.push(r); continue; }
    const why = r.is_duplicate === true ? 'marked duplicate'
      : module === 'market' ? 'not on a Market Dynamics card' : 'competitor change not verified';
    reasons[why] = (reasons[why] || 0) + 1;
  }
  if (!seen.length) return [];
  const groups = module === 'outlook' ? await s.readActiveTrends(seen.map((r) => r.id)) : new Map();
  const cards = module === 'market' ? await s.readCards([...new Set(seen.map((r) => r.insight_id))]) : new Map();
  const items = [];
  for (const r of seen) {
    let group = null;
    if (module === 'outlook') {
      const g = groups.get(r.id);
      if (!g) { reasons['Forward Outlook signal not in an active trend'] = (reasons['Forward Outlook signal not in an active trend'] || 0) + 1; continue; }
      group = { type: 'trend', id: g.id, name: g.name };
    }
    if (module === 'market') group = { type: 'card', id: r.insight_id, name: cards.get(r.insight_id) || null };
    const hit = (hits && hits.get(r[t.key])) || {};
    items.push(toItem(module, r, { group, score: hit.score, url: hit.url }));
  }
  return items;
}

// Signals for these keys (one read per module, the modules at the same time).
async function rowsToItems(byModule, clientId, reasons) {
  const s = getStore();
  const parts = await Promise.all([...byModule].filter(([, keys]) => keys.size).map(async ([module, keys]) => {
    const t = TABLES[module];
    const rows = await s.readRows(t.table, t.key, [...keys.keys()], clientId);
    return itemsFromRows(module, rows, keys, clientId, reasons);
  }));
  return parts.flat();
}

function finish(items, label, reasons, notes, max) {
  // the same news twice (two pieces, or two modules with the same title) is kept once
  const out = [];
  const titles = new Set();
  for (const it of items) {
    const k = plain(it.title);
    if (k && titles.has(k)) { reasons['the same news twice'] = (reasons['the same news twice'] || 0) + 1; continue; }
    if (k) titles.add(k);
    out.push(it);
  }
  const kept = out.slice(0, max);
  if (out.length > max) reasons[`more than ${max} (the best ${max} kept)`] = out.length - max;
  const count = Object.values(reasons).reduce((a, b) => a + b, 0);
  return {
    label,
    items: kept,
    removed: { count, reasons },
    note: [...new Set([kept.length ? null : 'nothing found for this search', ...notes].filter(Boolean))].join('; '),
  };
}

// A search reads page after page until it has enough signals that pass
// every filter, the pieces get too far from the question, or a cap is
// reached (24 Nov, real-data check: "latest cosmetics regulations in the
// UAE" read only the newest 100 policy signals, none was about the UAE, so
// it found nothing; "Compare Saudi Arabia and UAE" kept only 4 Saudi
// signals of the first 200 pieces).
const addReasons = (into, from) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] || 0) + v; };

// 27 Nov (bank run on Hy4, "Should we be concerned about a competitor's
// safety issues with eyelash serums in the US?"): "a competitor" became the
// client's competitor list, the search was kept to their news, and it
// brought 4 Estee Lauder items (data breach, ads) with no word about
// eyelashes or serums; the news about the eyelash serums (an unnamed
// cosmetics company) was never read. When the companies of a search come
// only from the word "competitors" (the user named none) and NONE of the
// news found holds the RAREST word of the question's topics (past the
// COMMON_WORD_RANK most used English words, or not English at all:
// "eyelash"; "serum" alone is not enough, a serum launch is not about
// eyelash serums), the search is done again without the company filter,
// and only the news holding that word is kept (noted, the
// competitor news left out is counted). Competitor news that holds the
// topic word, or topics of common words only ("awards"): nothing changes.
const COMMON_WORD_RANK = 5000;
// a word's place in the most-used list (a word ending in s / ed / ing ... counts as its base word)
// one of the COMMON_WORD_RANK most used English words (Step 10 writes "the news suggests that more ..." only then)
function isCommonWord(w) { englishWords(); return wordRankOf(String(w || '').toLowerCase()) <= COMMON_WORD_RANK; }
function wordRankOf(w) {
  if (englishWordRank.has(w)) return englishWordRank.get(w);
  const base = WORD_ENDINGS.map((e) => (w.endsWith(e) ? w.slice(0, -e.length) : null)).filter((b) => b && englishWordRank.has(b));
  return base.length ? Math.min(...base.map((b) => englishWordRank.get(b))) : Infinity;
}
function uncommonTopicWords(inputs, understood) {
  const u = understood || {};
  const names = new Set([...(inputs.companies || []), ...(inputs.countries || []), u.client && u.client.company_name]
    .filter(Boolean).flatMap((n) => plain(n).split(' ')));
  const rankOf = (w) => { englishWords(); return wordRankOf(w); };
  const words = [...(u.topics || []), ...(u.products || [])].flatMap((t) => plain(t).split(' '));
  const rare = [...new Set(words.filter((w) => w.length >= 4 && /^[a-z]+$/.test(w) && !names.has(w) && rankOf(w) > COMMON_WORD_RANK))];
  return rare.sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 1);   // the rarest one
}
const stemOf = (w) => (w.length > 5 && w.endsWith('es') ? w.slice(0, -2) : w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
const holdsWord = (it, words) => { const t = ` ${plain(`${it.title} ${it.text || ''}`)}`; return words.some((w) => t.includes(` ${stemOf(w)}`)); };
async function retrieveData(inputs, ctx) {
  const out = await retrieveDataOnce(inputs, ctx);
  const u = ctx.understood || {};
  if (!u.all_competitors || (u.companies || []).length || !(inputs.companies || []).length || !out.items) return out;
  const words = uncommonTopicWords(inputs, u);
  if (!words.length || out.items.some((it) => holdsWord(it, words))) return out;
  const wide = await retrieveDataOnce({ ...inputs, companies: [] }, ctx);
  const onTopic = (wide.items || []).filter((it) => holdsWord(it, words));
  if (!onTopic.length) return out;
  const note = `none of the ${out.items.length} news of the competitors (${inputs.companies.join(', ')}) holds ${words.map((w) => `"${w}"`).join(', ')}, so they are left out and the news of other companies holding it is shown`;
  const reasons = { ...((wide.removed && wide.removed.reasons) || {}) };
  if (out.items.length) reasons['competitor news not about the topic'] = out.items.length;
  if (wide.items.length > onTopic.length) reasons['other news not about the topic'] = wide.items.length - onTopic.length;
  const count = Object.values(reasons).reduce((a, b) => a + b, 0);
  return { ...wide, items: onTopic, removed: { count, reasons }, note: [note, wide.note].filter(Boolean).join('; ') };
}
// 27 Nov (dbcheck #70 "cosmetic rules in indonesia"): 51 Indonesia news
// were close to the question (0.78 to about 0.5); the best 20 by closeness
// were kept, and the news saying the halal deadline was moved to 2028 (the
// newest, 12 Nov, 0.51) was left out, less close than ten older copies of
// "halal by October 2026": the answer gave a deadline that had passed.
// Closeness alone cannot pick it: junk ("BASF partnership", "Japanese
// skincare", 0.53-0.55) is closer (I, v58, let junk in and pushed the
// expected news of #58 "mercury in face creams" out). What makes it count:
// it UPDATES the top news. So (I2): when a search has more news than fit,
// a news of the rest takes one of the last NEWEST_PLACES places only when
//   - its closeness is within NEWEST_BAND of the last place,
//   - its title shares an uncommon word (past the COMMON_WORD_RANK most used
//     English words) with at least 2 titles of the best ones, a word that is
//     not a word of the question, a place or a company asked, or the client's
//     industry (those are what every news found shares: "cosmetic",
//     "indonesia"),
//   - and it is NEWER than every one of the best news holding that word.
// Newest first; noted. Nothing updates the top news -> nothing changes.
const NEWEST_PLACES = 5;
const NEWEST_BAND = 0.15;
function uncommonTitleWords(title) {
  englishWords();
  return new Set(plain(title).split(' ').filter((w) => w.length >= 4 && /^[a-z]+$/.test(w) && wordRankOf(w) > COMMON_WORD_RANK).map(stemOf));
}
// The closeness is the search's own rank (news found by a rare word of its
// title stays ahead of the wide search: a newer wide-search news never takes
// its place).
function newestShare(kept, max, notes, rankOf = null, asked = []) {
  const seen = new Set();
  const uniq = [];
  const copies = [];
  for (const it of kept) {
    const k = plain(it.title);
    if (k && seen.has(k)) { copies.push(it); continue; }
    if (k) seen.add(k);
    uniq.push(it);
  }
  if (uniq.length <= max || max <= NEWEST_PLACES) return kept;
  const score = rankOf || ((it) => (it.score == null ? MIN_SEARCH_SCORE : it.score));
  const bar = score(uniq[max - 1]) - NEWEST_BAND;
  const head = uniq.slice(0, max - NEWEST_PLACES);
  const rest = uniq.slice(max - NEWEST_PLACES);
  const askedWords = new Set(asked.filter(Boolean).flatMap((t) => plain(t).split(' ')).filter(Boolean).map(stemOf));
  const words = new Map(uniq.map((it) => [it, new Set([...uncommonTitleWords(it.title)].filter((w) => !askedWords.has(w)))]));
  // the topic words of the best news, and the newest date of each
  const newestOf = new Map();
  const inHead = new Map();
  for (const it of head) {
    for (const w of words.get(it)) {
      inHead.set(w, (inHead.get(w) || 0) + 1);
      const d = String(it.date || '');
      if (!newestOf.has(w) || d > newestOf.get(w)) newestOf.set(w, d);
    }
  }
  const topic = new Set([...inHead].filter(([, n]) => n >= 2).map(([w]) => w));
  const updates = (it) => [...words.get(it)].filter((w) => topic.has(w) && String(it.date || '') > newestOf.get(w));
  const newest = rest.filter((it) => score(it) >= bar && updates(it).length)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, NEWEST_PLACES);
  const moved = newest.filter((it) => rest.indexOf(it) >= NEWEST_PLACES).length;
  if (!moved) return kept;
  const picked = new Set(newest);
  const on = [...new Set(newest.flatMap(updates))].slice(0, 3).map((w) => `"${w}"`).join(', ');
  notes.push(`${moved} newer news on the topic of the best news (${on}) put in place of closer older ones`);
  return [...head, ...newest, ...rest.filter((it) => !picked.has(it)), ...copies];
}
// 27 Nov (dbcheck #74 "power grid news", Q): the plan searched "power grid
// news headlines source links"; words about the FORM of the answer pulled
// the search by meaning toward news about the news business (Kentucky
// media, ITV and Sky, Penske Media). They say what the user wants back,
// not what it is about, so they are left out of the text searched by
// meaning (a small grammar set, like the tab names). A search of only such
// words ("news updates") is searched as written. Titles, rare words and
// filters still use the search as written.
const ANSWER_FORM_WORDS = /\b(news|headlines?|sources?|links?|articles?|reports?|updates?)\b/gi;
function searchTextOf(query) {
  const q = String(query || '');
  const t = q.replace(ANSWER_FORM_WORDS, ' ').replace(/\s+/g, ' ').trim();
  return /[a-z]{3,}/i.test(t) ? t : q;
}
async function retrieveDataOnce(inputs, ctx) {
  const s = getStore();
  const notes = [];
  const reasons = {};
  const timing = {};
  const modules = modulesOf(inputs);
  const max = RUN_LIMITS.search_max_signals;
  const codeFilters = (inputs.countries || []).length || (inputs.companies || []).length ||
    (inputs.not_countries || []).length || (inputs.not_companies || []).length;
  // places and companies are not in the search index, they are checked on
  // each signal: so a search with them reads more pieces per page
  const page = RUN_LIMITS.search_pieces * (codeFilters ? SEARCH_WIDEN : 1);
  let t0 = Date.now();
  const meaningText = searchTextOf(inputs.query);
  if (meaningText !== inputs.query) timing.search_text = meaningText;
  const vector = await s.embed(meaningText);
  timing.embed_ms = Date.now() - t0;
  let useDates = true;
  const ask = (offset, only) => s.searchPieces({
    vector, clientId: ctx.clientId, moduleIds: modules.map((m) => MODULE_IDS[m]),
    dateFrom: useDates ? inputs.date_from : null, dateTo: useDates ? readUntil(inputs, ctx.understood) : null, limit: page, offset, only,
  });
  const seen = new Set();          // signals already looked at (over all pages)
  let kept = [];
  let inData = false;              // the database names a company asked (set below)
  const wordTitled = new Set();    // news found by a rare word of its title (first)
  timing.search_ms = 0;
  timing.rows_ms = 0;
  let pages = 0;
  const readPages = async (only) => {
    for (let offset = 0; offset < SEARCH_MAX_PIECES; offset += page) {
      t0 = Date.now();
      let found = await ask(offset, only);
      // Nothing at all inside the dates on the first page: maybe the saved
      // dates are written in a way the search index cannot compare. Read
      // without the date limit; the dates are checked on every signal (a real
      // "nothing in those dates" still ends empty).
      if (offset === 0 && found.dates_in_search && !(found.pieces || []).length && useDates) {
        useDates = false;
        found = await ask(0, only);
        notes.push('nothing inside the dates in the search index, so the dates were checked on each signal');
      }
      timing.search_ms += Date.now() - t0;
      if (found.note && !notes.includes(found.note)) notes.push(found.note);
      pages += 1;
      const pieces = found.pieces || [];
      // pieces -> signals (best piece score per signal)
      const byModule = new Map(modules.map((m) => [m, new Map()]));
      let lastScore = null;
      for (const p of pieces) {
        const pl = p.payload || {};
        lastScore = p.score;
        if (pl.client_id && pl.client_id !== ctx.clientId) continue;   // never another client's data
        const module = moduleOfId(pl.module_id);
        if (!module || !byModule.has(module)) continue;
        if (p.score != null && p.score < MIN_SEARCH_SCORE) { reasons['too far from the question'] = (reasons['too far from the question'] || 0) + 1; continue; }
        const key = module === 'competitor' ? (pl.change_id || p.id) : pl.article_id;
        if (!key || seen.has(`${module}:${key}`)) continue;
        const m = byModule.get(module);
        const prev = m.get(key);
        if (!prev || (p.score || 0) > prev.score) m.set(key, { score: p.score || 0, url: pl.url || null });
      }
      for (const [module, keys] of byModule) for (const k of keys.keys()) seen.add(`${module}:${k}`);
      t0 = Date.now();
      const items = await rowsToItems(byModule, ctx.clientId, reasons);
      timing.rows_ms += Date.now() - t0;
      const f = applyFilters(items, inputs, ctx.understood, notes, inData);
      addReasons(reasons, f.reasons);
      kept = kept.concat(f.items);
      // stop: enough signals, the index has no more, or the rest is too far
      if (kept.length >= max || pieces.length < page || (lastScore != null && lastScore < MIN_SEARCH_SCORE)) break;
    }
  };
  // 1) among the signals tagged with the company / place asked
  t0 = Date.now();
  let only = codeFilters ? await taggedSignals(inputs, ctx, modules) : null;
  inData = (inputs.companies || []).length ? await companyInData(inputs, ctx, modules, only) : false;
  if (inData === 'nowhere') {
    const w = await typedNameFor(inputs, ctx, modules);
    if (w) {
      notes.push(`companies: ${inputs.companies.join(', ')} found nowhere in the data; the word as typed, "${w}", is, so it is searched`);
      inputs = { ...inputs, companies: [w] };
      only = codeFilters ? await taggedSignals(inputs, ctx, modules) : null;
      inData = await companyInData(inputs, ctx, modules, only);
    }
  }
  const fz = fuzzyOf(inputs, only, inData);
  if (fz) { inputs = { ...inputs, fuzzy_rx: fz }; notes.push(`companies: ${inputs.companies.join(', ')} found in the data with one letter more or changed`); }
  // no company / place tag: the rare words of the search, in the titles
  if (!only) {
    const rare = rareWordsOf(inputs.query, inputs, ctx.understood);
    const r = rare.length ? await rareWordSignals(rare, inputs, ctx, modules) : null;
    if (r && r.common) {
      timing.rare_words_common = r.common;
    } else if (r) {
      only = r;
      timing.rare_words = rare.filter((w) => !w.includes(' '));
      notes.push(`words not in the English word list looked up in the titles: ${timing.rare_words.join(', ')} (${r.articleIds.length + r.pointIds.length} news)`);
    }
  }
  if (only) {
    timing.tagged_ms = Date.now() - t0;
    timing.tagged_signals = only.articleIds.length + only.pointIds.length;
    if (timing.tagged_signals <= max) {
      // 26 Nov (DB check, "Did Ghana seize cosmetic products?"): 8 news are
      // tagged Ghana, the search by meaning among them gave 7 and missed
      // "FDA seizes 4,504 unregistered cosmetic products" (Ghana). When the
      // database says no more than 20 are tagged, they are ALL read (no
      // closeness needed to choose among so few), then checked as always.
      const byModule = new Map(modules.map((m) => [m, new Map(((only.byModule && only.byModule[m]) || []).map((k) => [k, { score: null, url: null }]))]));
      for (const [m, keys] of byModule) for (const k of keys.keys()) seen.add(`${m}:${k}`);
      t0 = Date.now();
      let items = await rowsToItems(byModule, ctx.clientId, reasons);
      timing.rows_ms += Date.now() - t0;
      // 26 Nov (question bank, "south africn cloud market growth"): the 14
      // news tagged South Africa were read whole with no closeness, so they
      // all came first and beauty news beat the cloud news. Now they get
      // their closeness from the search index too (the search among them).
      // A place holds news on every topic: one too far from the question is
      // dropped like in any search. A company or a rare title word is
      // narrow, so its news stays. News with nothing in the search index
      // (Ghana "FDA seizes 4,504 …") stays, after the close ones (rank).
      t0 = Date.now();
      try {
        const got = await ask(0, only);
        const best = new Map();
        for (const pc of got.pieces || []) {
          const pl = pc.payload || {};
          const m = moduleOfId(pl.module_id);
          const k = `${m}:${m === 'competitor' ? (pl.change_id || pc.id) : pl.article_id}`;
          if (pc.score != null && (!best.has(k) || pc.score > best.get(k))) best.set(k, pc.score);
        }
        items = items.map((it) => {
          const k = `${it.module}:${it.module === 'competitor' ? it.signal_id : it.article_id}`;
          return best.has(k) ? { ...it, score: Math.round(best.get(k) * 1000) / 1000 } : it;
        }).filter((it) => {
          if (only.kind !== 'place' || it.score == null || it.score >= MIN_SEARCH_SCORE) return true;
          reasons['too far from the question'] = (reasons['too far from the question'] || 0) + 1;
          return false;
        });
      } catch (e) { /* no closeness: the order as read */ }
      timing.search_ms += Date.now() - t0;
      const f = applyFilters(items, inputs, ctx.understood, notes, inData);
      addReasons(reasons, f.reasons);
      kept = kept.concat(f.items);
      timing.tagged_read_all = true;
    } else {
      await readPages(only);
    }
    timing.tagged_pages = pages;
    // 26 Nov (dbcheck #63 "updates about kbeauty"): the news whose TITLE holds
    // the rare word stays ahead of the wide search, which brought closer-
    // scoring news about other things (telecoms, KKR) above the K-Beauty news
    if (only.kind === 'word') kept.forEach((it) => wordTitled.add(it.source_id));
  }
  // 2) the wide search (Global news whose text names the place, Policy news
  // naming a company, Forward Outlook): at least one page, more only while
  // there are fewer than 20 signals
  await readPages(null);
  timing.pages = pages;
  // closest first; news with nothing in the search index (no score) just
  // after the close ones; news found by a rare word of its title first
  const rank = (x) => (wordTitled.has(x.source_id) ? 10 : 0) + (x.score == null ? MIN_SEARCH_SCORE : x.score);
  kept.sort((a, b) => rank(b) - rank(a));
  kept = onlyTogether(allNamesFirst(kept, inputs.companies), inputs, ctx, reasons, notes);
  kept = newestShare(kept, max, notes, rank, [inputs.query, ctx.understood && (ctx.understood.question_text || ctx.understood.question_typed),
    ...(inputs.countries || []), ...(inputs.companies || []), ctx.understood && ctx.understood.client && ctx.understood.client.industry]);
  const out = await noteNewest(finish(kept, inputs.label || inputs.query, reasons, notes, max), inputs, ctx, modules);
  // the news found by a rare word of its title (Step 10 shows it when the AI fails)
  if (wordTitled.size) out.titled = out.items.filter((it) => wordTitled.has(it.source_id)).map((it) => it.source_id);
  out.timing = timing;
  return out;
}

const IMPACT_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

// Newest first over several modules, but every module gets its fair share
// of the places (25 Nov: "What changed in my market this month?" showed 20
// competitor changes only, because they were the newest dates). Each module
// with news gets max / modules places; places a module cannot fill go to the
// newest news left. The chosen ones come first (newest first), the rest
// after them (counted as "more than 20").
function fairShare(perModule, max, reasons) {
  const newest = (a, b) => String(b.date).localeCompare(String(a.date));
  const titles = new Set();
  const lists = perModule.map((list) => list.slice().sort(newest).filter((it) => {
    const k = plain(it.title);
    if (k && titles.has(k)) { reasons['the same news twice'] = (reasons['the same news twice'] || 0) + 1; return false; }
    if (k) titles.add(k);
    return true;
  })).filter((l) => l.length);
  if (lists.length < 2) return lists.flat();
  const share = Math.floor(max / lists.length);
  const chosen = lists.flatMap((l) => l.slice(0, share));
  const rest = lists.flatMap((l) => l.slice(share)).sort(newest);
  const fill = rest.slice(0, Math.max(0, max - chosen.length));
  return [...chosen, ...fill].sort(newest).concat(rest.slice(fill.length));
}
// 27 Nov (dbcheck on Hy4, "UK cosmetics regulation changes in 2026": the
// 19 newest news were all from 3-4 November, so 11 months were shown as 2
// days): a list over a LONG period (more than SPREAD_AFTER_DAYS) takes the
// news in turns from each month, newest month first and newest first inside
// a month (modules in turns too), so the whole period is covered. The
// chosen ones are shown newest first; the rest after them ("more than 20").
const SPREAD_AFTER_DAYS = 62;
// 27 Nov (C2, "UK cosmetics regulation changes in 2026": "UK SAG-CS Final
// Safety Opinions" was the oldest of a busy September, so newest-first
// inside the month left it out; "Lush parental leave" got its place): when
// a long-period list has more news than fit, each news item gets its
// closeness to the QUESTION from the search index (the same index as a
// search by meaning, only among these news; no AI call). News with nothing
// in the index counts as just at the bar (kept, after the close ones).
// A failed read changes nothing (newest first, as before).
async function closenessToQuestion(items, ctx, modules) {
  const s = getStore();
  const text = (ctx.understood && (ctx.understood.question_text || ctx.understood.question_typed)) || '';
  if (!String(text).trim() || typeof s.embed !== 'function') return null;
  const only = { articleIds: [], pointIds: [] };
  for (const it of items) (it.module === 'competitor' ? only.pointIds : only.articleIds).push(it.module === 'competitor' ? it.signal_id : it.article_id);
  try {
    const vector = await s.embed(text);
    const got = await s.searchPieces({ vector, clientId: ctx.clientId, moduleIds: modules.map((m) => MODULE_IDS[m]), limit: Math.min(items.length * 5, SEARCH_MAX_PIECES), offset: 0, only });
    const byKey = new Map();
    for (const pc of got.pieces || []) {
      const pl = pc.payload || {};
      const m = moduleOfId(pl.module_id);
      const k = `${m}:${m === 'competitor' ? (pl.change_id || pc.id) : pl.article_id}`;
      if (pc.score != null && (!byKey.has(k) || pc.score > byKey.get(k))) byKey.set(k, pc.score);
    }
    const out = new Map();
    for (const it of items) {
      const k = `${it.module}:${it.module === 'competitor' ? it.signal_id : it.article_id}`;
      if (byKey.has(k)) out.set(it.source_id, byKey.get(k));
    }
    return out;
  } catch (e) {
    return null;
  }
}
// 27 Nov (Sneha, frontend Key Signals): a key signal opens the ONE news
// it is in its tab. Forward Outlook, Market Dynamics and Policy news are one
// article each already. A Competitive Radar news is a whole change card
// (the search index holds one piece per card, its own text written from
// all its articles), so the chat never knew which article. For each card
// found, its articles are read and the one closest to the question gets
// open_id (the article id the tab opens inside the card): the article
// holding the most words of the question, a rarer word counting more (its
// place in the most-used English words list), the newest on a tie. A failed
// read is noted; those cards open as the card (as before).
const wordWeight = (w) => { const r = wordRankOf(w); return Math.log(Math.min(Number.isFinite(r) ? r : 100000, 100000) + 1); };
async function openSignalsOf(items, ctx, inputs, output) {
  const cards = items.filter((it) => it.module === 'competitor' && it.signal_id && !it.open_id);
  const s = getStore();
  if (!cards.length || typeof s.readCardSignals !== 'function') return;
  const u = ctx.understood || {};
  englishWords();
  const words = [...new Set(plain([u.question_text || u.question_typed, inputs && inputs.query].filter(Boolean).join(' '))
    .split(' ').filter((w) => w.length >= 3).map(stemOf))];
  let rows;
  try {
    rows = await s.readCardSignals([...new Set(cards.map((it) => it.signal_id))]);
  } catch (e) {
    output.note = [output.note, `the articles of ${cards.length} Competitive Radar cards could not be read, they open as the card (${String(e.message).slice(0, 80)})`].filter(Boolean).join('; ');
    return;
  }
  const fit = (r) => { const t = ` ${plain(`${r.signal_title || ''} ${r.summary || ''}`)}`; return words.filter((w) => t.includes(` ${w}`)).reduce((a, w) => a + wordWeight(w), 0); };
  const day = (r) => String(r.published_date || r.event_date || '');
  for (const it of cards) {
    const mine = (rows || []).filter((r) => r.change_id === it.signal_id && r.id);
    if (!mine.length) continue;
    const best = mine.map((r) => ({ r, f: fit(r) })).sort((a, b) => b.f - a.f || day(b.r).localeCompare(day(a.r)))[0].r;
    it.open_id = best.id;
  }
}
function periodDays(inputs) {
  if (!inputs.date_from) return 0;
  const to = inputs.date_to ? new Date(inputs.date_to) : new Date();
  return (to - new Date(inputs.date_from)) / 86400000;
}
function spreadOverMonths(perModule, max, reasons, closeness = null) {
  const newest = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));
  // (C2) inside a month: the news closest to the question first, then newest
  const score = (it) => (closeness && closeness.has(it.source_id) ? closeness.get(it.source_id) : MIN_SEARCH_SCORE);
  const inMonth = closeness ? (a, b) => score(b) - score(a) || newest(a, b) : newest;
  const titles = new Set();
  const all = perModule.flat().slice().sort(newest).filter((it) => {
    const k = plain(it.title);
    if (k && titles.has(k)) { reasons['the same news twice'] = (reasons['the same news twice'] || 0) + 1; return false; }
    if (k) titles.add(k);
    return true;
  });
  const byMonth = new Map();
  for (const it of all) {
    const m = String(it.date || '').slice(0, 7) || 'none';
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(it);
  }
  // inside a month: the modules in turns, each newest first
  const queues = [...byMonth.keys()].sort((a, b) => (a === 'none') - (b === 'none') || b.localeCompare(a)).map((m) => {
    const mods = new Map();
    for (const it of byMonth.get(m)) { if (!mods.has(it.module)) mods.set(it.module, []); mods.get(it.module).push(it); }
    const lists = [...mods.values()].map((l) => l.sort(inMonth));
    const out = [];
    for (let i = 0; lists.some((l) => l[i]); i += 1) lists.forEach((l) => { if (l[i]) out.push(l[i]); });
    return out;
  });
  const chosen = [];
  for (let i = 0; chosen.length < max && queues.some((q) => q[i]); i += 1) {
    for (const q of queues) { if (q[i] && chosen.length < max) chosen.push(q[i]); }
  }
  const picked = new Set(chosen.map((it) => it.source_id));
  return { items: [...chosen.sort(newest), ...all.filter((it) => !picked.has(it.source_id))], months: queues.length };
}
// 26 Nov (browser: "recent regulatory filings in last 3 days" -> nothing
// found; the newest news in the data was 17 Nov): an empty search with
// dates says when the newest news it could have read is from, so the answer
// can tell the user the dates are the reason, not a broken chat. Only the
// news a user can open counts. A read that fails changes nothing.
async function newestInData(modules, ctx) {
  const s = getStore();
  try {
    const dates = await Promise.all(modules.map(async (m) => {
      const t = TABLES[m];
      const rows = await s.readRecent(t.table, { clientId: ctx.clientId, dateCol: t.dateCol, limit: 20, offset: 0 });
      const items = await itemsFromRows(m, rows, null, ctx.clientId, {});
      return items.map((it) => it.date).filter(Boolean).sort().pop() || null;
    }));
    return dates.filter(Boolean).sort().pop() || null;
  } catch (e) {
    return null;
  }
}
async function noteNewest(out, inputs, ctx, modules) {
  if (out.items.length || !inputs.date_from) return out;
  const newest = await newestInData(modules, ctx);
  if (newest && newest < inputs.date_from) out.newest_in_data = newest;
  return out;
}

async function structuredSearch(inputs, ctx) {
  const s = getStore();
  const notes = [];
  const reasons = {};
  const timing = { rows_ms: 0, pages: 0 };
  const max = Math.min(Number(inputs.max_items) || RUN_LIMITS.search_max_signals, RUN_LIMITS.search_max_signals);
  const impact = (inputs.impact || []).map((x) => String(x).toLowerCase());
  const page = max * SEARCH_WIDEN;
  const keep = (items, inData = false) => {
    let out = items;
    if (impact.length) {
      const before = out.length;
      out = out.filter((it) => it.impact && impact.includes(String(it.impact).toLowerCase()));
      if (before > out.length) reasons[`not ${inputs.impact.join(' / ')} impact (or no impact level)`] = (reasons[`not ${inputs.impact.join(' / ')} impact (or no impact level)`] || 0) + before - out.length;
    }
    if (inputs.sub_category) {
      const before = out.length;
      out = out.filter((it) => hasWords(`${it.title} ${it.text}`, inputs.sub_category));
      if (before > out.length) reasons['not about the sub-category'] = (reasons['not about the sub-category'] || 0) + before - out.length;
    }
    const f = applyFilters(out, inputs, ctx.understood, notes, inData);
    addReasons(reasons, f.reasons);
    return f.items;
  };
  // 26 Nov: a company asked -> first the news the database says names it
  // (its company field or title, inside the dates), however old: Catalio was
  // the 217th newest Market Dynamics item, KanuFresh the 813th Forward
  // Outlook one. The newest pages are still read after it (news naming the
  // company only in its text).
  const started = Date.now();
  const modules = modulesOf(inputs);
  let named = (inputs.companies || []).length ? await readTags(tagPatterns(inputs, ctx.understood, 'company'), inputs, ctx, modules) : null;
  let inData = (inputs.companies || []).length ? await companyInData(inputs, ctx, modules, named) : false;
  if (inData === 'nowhere') {
    const w = await typedNameFor(inputs, ctx, modules);
    if (w) {
      notes.push(`companies: ${inputs.companies.join(', ')} found nowhere in the data; the word as typed, "${w}", is, so it is searched`);
      inputs = { ...inputs, companies: [w] };
      named = await readTags(tagPatterns(inputs, ctx.understood, 'company'), inputs, ctx, modules);
      inData = await companyInData(inputs, ctx, modules, named);
    }
  }
  const fz = fuzzyOf(inputs, named, inData);
  if (fz) { inputs = { ...inputs, fuzzy_rx: fz }; notes.push(`companies: ${inputs.companies.join(', ')} found in the data with one letter more or changed`); }
  if (named) timing.named_signals = named.articleIds.length + named.pointIds.length;
  // a long period is read whole (like "by impact"), then spread over its months
  const spread = inputs.order !== 'impact' && periodDays(inputs) > SPREAD_AFTER_DAYS;
  const readWhole = inputs.order === 'impact' || spread;
  // the modules are read at the same time (each page after page)
  const perModule = await Promise.all(modules.map(async (module) => {
    const t = TABLES[module];
    let got = [];
    const done = new Set();
    const keys = (named && named.byModule[module]) || [];
    if (keys.length) {
      const rows = (await s.readRows(t.table, t.key, keys, ctx.clientId))
        .sort((a, b) => String(b[t.dateCol] || '').localeCompare(String(a[t.dateCol] || '')));
      rows.forEach((r) => done.add(r.id));
      got = keep(await itemsFromRows(module, rows, null, ctx.clientId, reasons), inData);
    }
    for (let offset = 0; offset < EXACT_READ_MAX_ROWS; offset += page) {
      if (!readWhole && got.length >= max) break;
      const rows = await s.readRecent(t.table, {
        clientId: ctx.clientId, dateCol: t.dateCol, from: inputs.date_from, to: readUntil(inputs, ctx.understood), limit: page, offset,
      });
      got = got.concat(keep(await itemsFromRows(module, rows.filter((r) => !done.has(r.id)), null, ctx.clientId, reasons), inData));
      timing.pages += 1;
      // newest first: once this module has enough, older pages are not
      // needed; by impact, the whole period is read (up to the cap)
      if (rows.length < page || (!readWhole && got.length >= max)) break;
      if (offset + page >= EXACT_READ_MAX_ROWS) notes.push(`${module}: only the newest ${EXACT_READ_MAX_ROWS} signals were read`);
    }
    // the named news (read first) and the pages in one newest-first order
    if (inputs.order !== 'impact') got.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return got;
  }));
  timing.rows_ms = Date.now() - started;
  let items = perModule.flat();
  if (inputs.order === 'impact') {
    items.sort((a, b) => (IMPACT_RANK[String(b.impact || '').toLowerCase()] || 0) - (IMPACT_RANK[String(a.impact || '').toLowerCase()] || 0) || String(b.date).localeCompare(String(a.date)));
  } else if (spread) {
    const all = perModule.flat();
    const closeness = all.length > max ? await closenessToQuestion(all, ctx, modules) : null;
    const sp = spreadOverMonths(perModule, max, reasons, closeness);
    items = sp.items;
    if (sp.months > 1) notes.push(`the period is long: the news is taken in turns from each of its ${sp.months} months (${closeness ? 'closest to the question' : 'newest'} first inside a month)`);
  } else {
    items = fairShare(perModule, max, reasons);
  }
  if ((inputs.companies || []).length > 1) {
    const all = allNamesFirst(perModule.flat(), inputs.companies).filter((it) => inputs.companies.every((c) => namesCompany(it, c)));
    const set = new Set(all.map((it) => it.source_id));
    if (all.length) items = [...all.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))), ...items.filter((it) => !set.has(it.source_id))];
    items = onlyTogether(items, inputs, ctx, reasons, notes);
  }
  const out = await noteNewest(finish(items, inputs.label || 'newest signals', reasons, notes, max), inputs, ctx, modules);
  out.timing = timing;
  return out;
}

// ═════════════════════════════════════════════════════════════════════════
// PART 2 (25 Nov): the AI jobs, and the evidence check (code only)
// ═════════════════════════════════════════════════════════════════════════
// How every AI job works (Sneha OK 25 Nov):
//   - its inputs (earlier results) become numbered items: news S1, S2 …
//     (A1, B1 … for the sides of a comparison) and earlier findings F1, F2 …
//     at most 25 news items (the best of each search in turn), the rest is
//     counted as left out
//   - no news and no findings -> no AI call, an empty result that says so
//   - the prompt lives in public.prompts (DI – 5 … DI – 12), never in code
//   - the AI answers in a fixed JSON shape and names the items it used;
//     code turns the numbers back into the real signals (an earlier
//     finding F2 -> the signals F2 was based on)
//   - code removes (and counts, with the reason): a point with no source,
//     a point naming an item it was not given, a comparison cell using
//     another side's news, a point with a number that is not in its
//     sources (counts below 10 are allowed: "3 brands")
//   - code, not the AI, decides: the kind of each point (fact /
//     interpretation / hypothesis, by the job), the risk level (from the
//     impact level saved on the signals), trend or one-off event (2 or more
//     sources on different dates), the groups that already exist
//   - a reply that cannot be read: asked once more (counts as an AI call);
//     still not readable -> the job fails, never guessed
//   - the AI calls of the whole question stay within 15: Step 9 may use
//     what Steps 3–7 left, minus 1 kept for the answer (Step 10). A job that
//     would go over is "skipped" (recorded), the jobs that need it blocked.
let aiFn = null;
let promptFn = null;
/** Tests: a fake AI (messages, options) -> reply text. null = the real one. */
function useAi(fn) { aiFn = fn; }
/** Tests: fake prompt texts (id) -> text. null = public.prompts. */
function usePrompts(fn) { promptFn = fn; }
const callAi = (messages, opts) => (aiFn || require('../llmClient').callLLM)(messages, opts);
const readPrompt = async (id) => (promptFn ? promptFn(id) : require('../promptStore').getPrompt(id));

class AiLimitError extends Error {}
const failNoRetry = (msg) => { const e = new Error(msg); e.noRetry = true; return e; };

const KINDS = ['fact', 'interpretation', 'hypothesis'];
const weaker = (a, b) => (KINDS.indexOf(a) >= KINDS.indexOf(b) ? a : b);
const MODULE_NAMES = { policy: 'Policy and Risk', market: 'Market Dynamics', outlook: 'Forward Outlook', competitor: 'Competitive Radar' };
const count = (reasons, why, n = 1) => { reasons[why] = (reasons[why] || 0) + n; };

// "T3.output" -> the done result of T3 (or null)
function resultOf(ref, ctx) {
  const id = String(ref || '').split('.')[0];
  const r = ctx.results[id];
  return r && r.status === 'done' && r.output ? { id, ...r } : null;
}

// An earlier AI result as findings (text, sources, kind) for the next job.
function findingsOf(r) {
  const o = r.output || {};
  if (Array.isArray(o.findings)) {
    return o.findings.map((f) => ({
      text: [f.heading ? `${f.heading}: ` : '', f.text, f.why ? ` (based on: ${f.why})` : '', f.why_it_matters ? ` (why it matters: ${f.why_it_matters})` : '', f.level ? ` (level ${f.level})` : ''].join(''),
      sources: f.sources, kind: f.kind,
    }));
  }
  if (Array.isArray(o.patterns)) {
    return o.patterns.map((p) => ({
      text: `${p.name}: ${p.description} (${p.kind === 'trend' ? 'trend' : 'one-off event'}, ${p.source_count} sources, ${p.first_date || '?'} to ${p.last_date || '?'})`,
      sources: p.sources, kind: 'interpretation',
    }));
  }
  if (Array.isArray(o.rows)) {
    const rows = o.rows.map((row) => ({
      text: `${row.point}: ${Object.entries(row.cells).map(([label, c]) => `${label}: ${c.text || 'no news'}`).join(' | ')}`,
      sources: [...new Set(Object.values(row.cells).flatMap((c) => c.sources))], kind: 'fact',
    }));
    return rows.concat((o.differences || []).map((d) => ({ text: `difference: ${d.text}`, sources: d.sources, kind: d.kind || 'interpretation' })));
  }
  if (Array.isArray(o.groups)) {
    return o.groups.map((g) => ({ text: `group "${g.name}": ${g.sources.length} news items`, sources: g.sources, kind: 'fact' }));
  }
  return [];
}

// Several searches -> at most max items: the best of each search in turn
// (each search is already ordered best first), every signal once.
function pickItems(lists, max) {
  const seen = new Set();
  const out = [];
  let total = 0;
  const all = new Set(lists.flat().map((it) => it.source_id));
  total = all.size;
  for (let k = 0; out.length < max && lists.some((l) => k < l.length); k++) {
    for (const l of lists) {
      const it = l[k];
      if (!it || seen.has(it.source_id) || out.length >= max) continue;
      seen.add(it.source_id);
      out.push(it);
    }
  }
  return { items: out, left_out: total - out.length };
}

// The inputs of a job -> news items + earlier findings (nothing missing
// silently: refs that did not finish are listed).
function gather(refs, ctx) {
  const lists = [];
  const findings = [];
  const missing = [];
  for (const ref of [].concat(refs || [])) {
    const r = resultOf(ref, ctx);
    if (!r) { missing.push(String(ref).split('.')[0]); continue; }
    if (Array.isArray(r.output.items)) lists.push(r.output.items);
    else findings.push(...findingsOf(r));
  }
  const picked = pickItems(lists, RUN_LIMITS.max_items_to_ai);
  return { items: picked.items, left_out: picked.left_out, findings: findings.slice(0, AI_MAX_FINDINGS_IN), findings_left_out: Math.max(0, findings.length - AI_MAX_FINDINGS_IN), missing };
}

function itemLine(code, it) {
  const where = it.countries && it.countries.length ? it.countries.join(', ') : (it.module === 'outlook' ? 'no country' : 'Global');
  return [`[${code}] ${it.date || 'no date'}`, MODULE_NAMES[it.module] || it.module, where,
    ...(it.companies && it.companies.length ? [it.companies.join(', ')] : []),
    ...(it.impact ? [`impact ${it.impact}`] : []),
    `${cut(it.title, 200)}. ${cutAtWord(it.text, AI_ITEM_CHARS)}`].join(' | ');
}
// numbered items: code -> { sources (signal ids), kind }
function numbered(items, findings, letter = 'S') {
  const map = new Map();
  const lines = [];
  items.forEach((it, k) => { const code = `${letter}${k + 1}`; map.set(code, { sources: [it.source_id], kind: 'fact' }); lines.push(itemLine(code, it)); });
  (findings || []).forEach((f, k) => { const code = `F${k + 1}`; map.set(code, { sources: f.sources || [], kind: f.kind || 'fact' }); lines.push(`[${code}] earlier finding: ${cut(f.text, 400)}`); });
  return { map, text: lines.join('\n') };
}

// the client, the question and today, for every prompt
function baseVars(ctx) {
  const u = ctx.understood || {};
  const c = u.client || {};
  const client = c.company_name ? `${c.company_name}${c.industry ? ` (${c.industry} industry)` : ''}` : 'the client';
  return { client, question: u.question_typed || u.question_text || '', today: u.today || new Date().toISOString().slice(0, 10) };
}
// fills {{name}} once (text put in is never read again for placeholders)
const fillVars = (text, vars) => String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));

// the reply as it is (only the text around the object taken off), or undefined
function strictReply(text) {
  const t = String(text || '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try { const o = JSON.parse(t.slice(start, end + 1)); return o && typeof o === 'object' ? o : undefined; } catch (err) { return undefined; }
}
function readReply(text) {
  const { parseJsonLoose } = require('./planTasks');
  const t = String(text || '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0) return undefined;
  return parseJsonLoose(t.slice(start, end > start ? end + 1 : undefined)) || parseJsonLoose(t.slice(start));
}

// A reply that is not one clean JSON object is read item by item (25 Nov:
// both comparisons of the real run failed twice with "it is not one JSON
// object"; a long reply cut off in the middle loses every row). Every whole
// object inside the list "key": [ … ] is kept; a half-written last one is
// left out. Same idea as Step 7's searchItemsFrom.
function salvageList(text, key) {
  const t = String(text || '');
  const at = t.search(new RegExp(`"${key}"\\s*:\\s*\\[`));
  if (at < 0) return [];
  const { parseJsonLoose } = require('./planTasks');
  const out = [];
  let i = t.indexOf('[', at) + 1;
  let depth = 0;
  let start = -1;
  let inString = false;
  for (; i < t.length; i++) {
    const ch = t[i];
    if (inString) { if (ch === '\\') i += 1; else if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; }
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) { const o = parseJsonLoose(t.slice(start, i + 1)); if (o && typeof o === 'object') out.push(o); start = -1; }
      if (depth < 0) break;
    } else if (ch === ']' && depth === 0) break;
  }
  return out;
}

// One AI job's call(s): the prompt from the table, the reply checked;
// asked once more when it cannot be used.
async function askAi(job, vars, ctx, check, maxTokens) {
  const id = JOB_PROMPT_IDS[job];
  const template = await readPrompt(id);
  if (!template) throw failNoRetry(`the prompt ${id} is missing or switched off in the prompts table`);
  const messages = [{ role: 'user', content: fillVars(template, { ...baseVars(ctx), ...vars }) }];
  let conversation = messages;
  let problem = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (ctx.ai.used >= ctx.ai.budget) throw new AiLimitError(`not run: the AI calls for this question are used up (${ctx.ai.used} of ${ctx.ai.budget} for the jobs, 1 kept for the answer)`);
    ctx.ai.used += 1;
    ctx.job.ai_calls += 1;
    // (the second try is a little less fixed, so a reply that went round in
    // circles the first time does not do it again word for word)
    const reply = await callAi(conversation, { temperature: attempt === 0 ? 0 : 0.3, max_tokens: maxTokens, timeout: AI_CALL_TIMEOUT_MS, maxRetries: 2 });
    const r0 = String(reply || '');
    ctx.job.replies.push({ letters: r0.length, end: r0.slice(-160) });
    // 25 Nov (third real report): "Compare Lancôme and Estée Lauder" came
    // back empty: a reply cut off at its end was "repaired" by closing the
    // brackets, which turned the half-written last row into a row with no
    // cells. Now: a clean reply is used as it is; a reply that is not clean
    // is read item by item (whole items only); only when no whole item is
    // there is the repair tried.
    let parsed = strictReply(reply);
    const clean = parsed !== undefined;
    if (!clean && check.keys) {
      const saved = {};
      for (const k of check.keys) saved[k] = salvageList(reply, k);
      if (saved[check.keys[0]].length) {
        parsed = saved;
        ctx.job.ai_problems.push(`not one clean JSON object (${r0.length} letters): read item by item, ${check.keys.map((k) => `${saved[k].length} ${k}`).join(', ')} kept`);
      }
    }
    // 25 Nov (Step 10 report): "Compare Lancôme and Estée Lauder" went round
    // in circles ("and 4 new products, and 2 new products, …", 6666 letters)
    // until it was cut off; the repair kept nothing. A reply with no whole
    // item is now asked again first; the repair is only tried on the last try.
    let noWholeItem = false;
    if (parsed === undefined) {
      if (attempt === 0 && check.keys) {
        noWholeItem = true;
      } else {
        parsed = readReply(reply);
        if (parsed !== undefined && parsed !== null && typeof parsed === 'object') ctx.job.ai_problems.push(`not one clean JSON object (${r0.length} letters): repaired`);
      }
    }
    problem = noWholeItem ? 'it is not one JSON object and has no whole item'
      : parsed === undefined || parsed === null || typeof parsed !== 'object' ? 'it is not one JSON object' : check(parsed);
    if (!problem) return parsed;
    // the start and the end of the reply (a cut-off reply shows at its end)
    const r = String(reply || '');
    ctx.job.ai_problems.push(`${problem} (${r.length} letters): ${cut(r.slice(0, 200), 200)}${r.length > 400 ? ` … ${r.slice(-200)}` : ''}`);
    conversation = [...messages, { role: 'assistant', content: String(reply).slice(0, 4000) },
      { role: 'user', content: `That reply cannot be used because ${problem}. Reply again with ONLY the JSON object.` }];
  }
  throw failNoRetry(`the AI reply could not be used twice (${problem})`);
}
// the reply must hold this list; keys = the lists read item by item when
// the reply is not one clean object
const needsList = (key, ...more) => Object.assign((p) => (Array.isArray(p[key]) ? null : `it has no "${key}" list`), { keys: [key, ...more] });

// the item numbers of a point, under the names the AI uses for them
// (25 Nov real run: 5 facts of "How did Shiseido do in Q3 2026?" removed as
// "no source")
const rawSources = (x) => (x ? (x.sources ?? x.source ?? x.items ?? x.ids ?? x.refs ?? x.evidence ?? x.citations ?? null) : null);
// a removed point, kept as an example for the report (at most 3 per job)
const example = (ctx, why, raw) => { if (ctx.job && ctx.job.removed_examples.length < 3) ctx.job.removed_examples.push(`${why}: ${cut(JSON.stringify(raw), 200)}`); };

// item codes the AI named -> real signal ids (side letter checked)
function sourcesFrom(raw, n, reasons, letter = null) {
  const codes = (Array.isArray(raw) ? raw : [raw]).flatMap((x) => String(x || '').toUpperCase().match(/[A-Z]\d+/g) || []);
  const ids = new Set();
  let kind = 'fact';
  for (const code of new Set(codes)) {
    if (letter && code[0] !== letter && code[0] !== 'F') { count(reasons, 'used another side\'s news'); continue; }
    const hit = n.map.get(code);
    if (!hit) { count(reasons, 'named an item it was not given'); continue; }
    hit.sources.forEach((s) => ids.add(s));
    kind = weaker(kind, hit.kind);
  }
  return { ids: [...ids], kind };
}

// A number in a point must be in its sources (or the question). Counts
// below 10 are allowed ("3 brands"); a % or a decimal never is.
function numbersOk(texts, sourceIds, ctx) {
  const nums = texts.join(' ').match(/\d+(?:[.,]\d+)*%?/g) || [];
  const check = nums.filter((x) => /[%.,]/.test(x) || Number(x) >= 10).map((x) => x.replace(/%$/, '').replace(/,/g, ''));
  if (!check.length) return true;
  const hay = [baseVars(ctx).question, ...sourceIds.map((id) => { const it = ctx.sources.get(id); return it ? `${it.title} ${it.text} ${it.date}` : ''; })].join(' ').replace(/(\d),(\d)/g, '$1$2');
  return check.every((x) => new RegExp(`(?<![\\d.])${x.replace(/\./g, '\\.')}(?![\\d])`).test(hay));
}

// One point of a reply -> a clean point, or null (reason counted).
// ── The words of a text (also used by Step 10) ───────────────────────────
// (small fixed set of grammar words, not a topic list)
const GRAMMAR_WORDS = new Set(['with', 'that', 'this', 'from', 'have', 'been', 'also', 'into', 'their', 'they', 'these', 'those', 'which',
  'while', 'will', 'would', 'could', 'should', 'there', 'about', 'more', 'most', 'some', 'such', 'than', 'then', 'them', 'were', 'what',
  'when', 'where', 'other', 'over', 'very', 'based', 'news', 'limited', 'suggests', 'suggest', 'including', 'both', 'each', 'many', 'being']);
// one form for a word and its endings ("launched" / "launches" -> "launch",
// "acquired" / "acquires" -> "acquir", "companies" -> "company")
const stemEnd = (w) => {
  if (w.length > 5 && /ies$/.test(w)) return w.replace(/ies$/, 'y');
  if (w.length > 5 && /(?:ss|x|z|ch|sh)es$/.test(w)) return w.replace(/es$/, '');
  if (w.length > 5 && /ing$/.test(w)) return w.replace(/ing$/, '');
  if (w.length > 5 && /ed$/.test(w)) return w.replace(/ed$/, '');
  if (w.length > 5 && /[^aeiou]es$/.test(w) && !/[^aeiou]ses$/.test(w)) return w.replace(/s$/, '');
  if (/[^s]s$/.test(w)) return w.replace(/s$/, '');
  return w;
};
const stem = (w) => { const x = stemEnd(w); return x.length > 4 ? x.replace(/e$/, '') : x; };
const plainWords = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w.length >= 4 && !GRAMMAR_WORDS.has(w)).map(stem);

// 26 Nov (DI tab, "Halal cosmetics opportunities in Indonesia and Malaysia"):
// two ideas cited ALL 25 news items they were given (mercury raids, Korea
// news …): the AI named every item, or the idea took every source of the
// earlier point it was built on, and the evidence looked strong. A point
// with more than POINT_SOURCES_CHECK_FROM sources keeps only the sources
// whose TITLE shares at least 2 words with it; none -> the point goes.
function sourcesAboutPoint(ids, texts, ctx, reasons) {
  if (ids.length <= POINT_SOURCES_CHECK_FROM) return ids;
  const pw = new Set(texts.flatMap((t) => plainWords(t)));
  const kept = ids.filter((id) => {
    const it = ctx.sources.get(id);
    return it && [...new Set(plainWords(it.title))].filter((w) => pw.has(w)).length >= 2;
  });
  if (kept.length < ids.length) count(reasons, 'a source not about the point (the point cited many news items)', ids.length - kept.length);
  return kept;
}

function makePoint(raw, n, ctx, reasons, { text, kind, extra = {}, letter = null }) {
  const t = cut(text, 400);
  if (!t) { count(reasons, 'empty point'); example(ctx, 'empty point', raw); return null; }
  // a point must say something: at least 2 words ("4" or "5" alone, 25 Nov)
  if ((t.match(/\p{L}{2,}/gu) || []).length < 2) { count(reasons, 'too short to mean anything'); example(ctx, 'too short', raw); return null; }
  const s = sourcesFrom(rawSources(raw), n, reasons, letter);
  if (!s.ids.length) { count(reasons, 'no source'); example(ctx, 'no source', raw); return null; }
  s.ids = sourcesAboutPoint(s.ids, [t, ...Object.values(extra).filter((v) => typeof v === 'string')], ctx, reasons);
  if (!s.ids.length) { count(reasons, 'cited many news items, none really about it'); example(ctx, 'many sources, none about it', raw); return null; }
  if (!numbersOk([t, ...Object.values(extra).filter((v) => typeof v === 'string')], s.ids, ctx)) { count(reasons, 'a number that is not in its sources'); example(ctx, 'number not in sources', raw); return null; }
  return { text: t, kind: weaker(kind, s.kind), sources: s.ids, ...extra };
}

// The same point twice (25 Nov: "Net sales of ¥741.1 billion" and "Net
// sales of ¥741.1 billion and core operating profit of $426.7 million", both
// from the same article): a point whose words sit inside another point's
// words, with its sources inside the other's sources, is kept once (the
// longer one).
function withoutRepeats(points, reasons) {
  const kept = [];
  const inside = (a, b) => a.every((x) => b.includes(x));
  for (const f of points) {
    const t = plain(f.text);
    // (25 Nov, playground: "The new regulations, GSO 1943, include …" and
    // "The regulations, GSO 1943, include …" — all the words of one inside
    // the other, same source — were both kept; only a run of the same words
    // was checked)
    const tw = t.split(' ').filter(Boolean);
    const k = kept.findIndex((x) => {
      const u = plain(x.text);
      const uw = u.split(' ').filter(Boolean);
      const same = u.includes(t) || t.includes(u) || inside(tw, uw) || inside(uw, tw);
      return same && (inside(f.sources, x.sources) || inside(x.sources, f.sources));
    });
    if (k < 0) { kept.push(f); continue; }
    count(reasons, 'the same point twice');
    if (plain(f.text).length > plain(kept[k].text).length) kept[k] = { ...f, sources: [...new Set([...f.sources, ...kept[k].sources])] };
  }
  return kept;
}

// 26 Nov (dbcheck #26 "What are cosmetotextiles?", #32 "LG AI hair loss
// discovery"): facts from news about something else got into the answer
// (a funding round, Clarins serum). When the question names a company or a
// rare word (not in the English word list), a fact or summary point whose
// news does not name any of them is removed — only when at least one point
// does (else nothing changes: safe). Not for summaries under headings (a
// SWOT's threats are market news). The client's own company is not used.
function namedInQuestion(ctx) {
  const u = ctx.understood || {};
  const own = plain((u.client && u.client.company_name) || '');
  const companies = (u.companies || []).map((c) => (c.matched && c.matched.name) || c.name).filter((x) => x && plain(x) !== own);
  const words = rareWordsOf(baseVars(ctx).question, { companies }, u).filter((w) => !w.includes(' '));
  return { companies, words };
}
// 26 Nov (question bank, "Should we be concerned about Estée Lauder's
// increased presence in India?" -> India crackdown risks first; Rhamsydil ->
// trends about the whole industry): also for trends, gaps, ideas and risks
// (withText: a point whose own words name it counts too).
function onlyAboutAsked(findings, ctx, reasons, withText = false) {
  const { companies, words } = namedInQuestion(ctx);
  if (!findings.length || (!companies.length && !words.length)) return findings;
  const rx = words.length ? new RegExp(squeezedRegex(words), 'i') : null;
  const names = (text) => companies.some((c) => hasWords(text, companyCore(c)) || namesWordRun(text, c)) || Boolean(rx && rx.test(text));
  const about = (f) => (withText && names([f.text, f.name, f.why, f.why_it_matters].filter(Boolean).join(' '))) || f.sources.some((id) => {
    const it = ctx.sources.get(id);
    return it && (companies.some((c) => namesCompany(it, c)) || (rx && rx.test(`${it.title} ${it.text}`)));
  });
  const kept = findings.filter(about);
  if (!kept.length || kept.length === findings.length) return findings;
  count(reasons, `not about what the question names (${[...companies, ...words].join(', ')})`, findings.length - kept.length);
  return kept;
}

function finishAi(base, reasons, notes, g) {
  if (Array.isArray(base.findings)) base = { ...base, findings: withoutRepeats(base.findings, reasons) };
  const c = Object.values(reasons).reduce((a, b) => a + b, 0);
  // 25 Nov (final real run): the AI wrote points but every one was removed;
  // the limit said "found nothing: 15 more news items …", which hid why.
  if (Array.isArray(base.findings) && !base.findings.length && c > 0) notes.unshift(NOTHING_PASSED);
  if (g && g.left_out) notes.push(`${g.left_out} more news items than the ${RUN_LIMITS.max_items_to_ai} one AI job may read (the best of each search were given)`);
  if (g && g.findings_left_out) notes.push(`${g.findings_left_out} earlier findings left out (at most ${AI_MAX_FINDINGS_IN})`);
  return { ...base, removed: { count: c, reasons }, note: [...new Set(notes)].join('; ') };
}
const nothingToWorkOn = (g) => !g.items.length && !g.findings.length;
const NO_EVIDENCE = 'no evidence to work on (the searches before it found nothing), so no AI call';
const NOTHING_PASSED = 'nothing the AI wrote passed the checks';

// ── DI – 5. extract_facts ────────────────────────────────────────────────
// 26 Nov (DB check): the AI often writes a fact as a bare value or name —
// "$210 million", "Skims Beauty", "nearly ₹10 lakh" — or as a label that
// is not news at all ("Market Dynamics", "not specified"). A bare value was
// removed (25 Nov), so "How much was the Estée Lauder settlement?" lost its
// answer. Now a short fact (2 or 3 words or numbers) is replaced by the NEWS'S OWN
// sentence that holds all its words and numbers (never the AI's words, so
// the 25 Nov "€5.7 million in refills" can not come back: the sentence says
// "water infrastructure"). No such sentence in its sources -> removed.
const SHORT_FACT_WORDS = 4;   // fewer than this (and at least 2) = a short fact
// small joining words a name or a title may hold ("Packaging and Packaging
// Waste Regulation", "Bank of America") — a small fixed grammar set
const LABEL_GLUE = new Set(['and', 'of', 'the', 'for', 'in', 'on', 'at', 'to', 'a', 'an', 'by', 'with', 'de', 'la', 'le', 'du', 'des', 'et']);
const factTokens = (t) => plain(t).split(' ').filter((w) => w && (/\d/.test(w) || (w.length >= 3 && !GRAMMAR_WORDS.has(w) && !['the', 'and', 'for', 'not'].includes(w)))).map(stem);
function newsSentence(text, sourceIds, ctx) {
  const need = [...new Set(factTokens(text))];
  if (!need.length) return null;
  for (const id of sourceIds) {
    const it = ctx.sources.get(id);
    if (!it) continue;
    const sentences = `${it.title}. ${it.text}`.replace(/…$/, '').split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/);
    for (const sn of sentences) {
      const have = new Set(factTokens(sn));
      if (need.every((w) => have.has(w))) return sn.trim().replace(/\.$/, '');
    }
  }
  return null;
}

async function extractFacts(inputs, ctx) {
  const reasons = {};
  const notes = [];
  const g = gather(inputs.evidence, ctx);
  if (nothingToWorkOn(g)) return finishAi({ findings: [] }, reasons, [NO_EVIDENCE], g);
  const asked = [].concat(inputs.what_to_find || []);
  const n = numbered(g.items, g.findings);
  const p = await askAi('extract_facts', { what_to_find: asked.join(', '), evidence: n.text }, ctx, needsList('facts'), 1200);
  const findings = p.facts.slice(0, 10).map((f) => {
    const about = asked.find((a) => plain(a) === plain(f && f.about)) || null;
    // (25 Nov: a bare value "€100 million" is NOT joined with the AI's
    // "about". Tried in v28 and taken back: "Amount of money invested in
    // refills: €5.7 million" was made from a water-plant article — the number
    // was real, but the AI's "about" made a claim the news does not make.)
    let text = f && f.text;
    // (26 Nov, question bank: "144.5" is one number, it was counted as two,
    // so "Rs 144.5 crore" passed as a 4-word fact)
    const words = String(text || '').match(/\p{L}{2,}|\d+(?:[.,]\d+)*/gu) || [];
    const wordCount = words.length;
    // 26 Nov (question bank): a LABEL is not a fact either — only names and
    // numbers ("LG Household & Health Care", "The European Union's Packaging
    // and Packaging Waste Regulation"); nor a PIECE cut from a sentence
    // ("65, replacing the dates …"). Both are replaced by the news sentence
    // holding them, or removed. A fact starting with a small letter ("adds
    // migration limits …") is replaced when the news has that sentence,
    // else kept as written.
    const label = wordCount >= 2 && words.every((w) => /^\d/.test(w) || /^\p{Lu}/u.test(w) || LABEL_GLUE.has(w.toLowerCase()));
    const piece = /^\s*\d[\d.,]*\s*[,;)]/.test(String(text || ''));
    const small = /^\s*\p{Ll}/u.test(String(text || ''));
    const must = wordCount >= 2 && (wordCount < SHORT_FACT_WORDS || label || piece);
    // (one word or none: removed as "too short" by makePoint, as before;
    // no real source: makePoint says why, as before)
    const ids = must || small ? sourcesFrom(rawSources(f), n, {}, null).ids : [];
    if (ids.length) {
      const sentence = newsSentence(text, ids, ctx);
      if (!sentence && must) {
        const why = wordCount < SHORT_FACT_WORDS ? 'a short fact the news does not say in a sentence' : label ? 'a label (names only) the news does not say in a sentence' : 'a piece of a sentence the news does not say whole';
        count(reasons, why); example(ctx, why, f); return null;
      }
      if (sentence) {
        count(reasons, must ? 'a short fact, label or piece written as the news sentence holding it' : 'a fact starting in the middle written as the news sentence holding it');
        text = sentence;
      }
    }
    return makePoint(f, n, ctx, reasons, { text, kind: 'fact', extra: { about } });
  }).filter(Boolean);
  return finishAi({ findings: onlyAboutAsked(findings, ctx, reasons) }, reasons, notes, g);
}

// ── DI – 6. summarise ────────────────────────────────────────────────────
async function summarise(inputs, ctx) {
  const reasons = {};
  const notes = [];
  const g = gather(inputs.input, ctx);
  const headings = [].concat(inputs.headings || []);
  if (nothingToWorkOn(g)) return finishAi({ findings: [], empty_headings: headings }, reasons, [NO_EVIDENCE], g);
  const n = numbered(g.items, g.findings);
  const p = await askAi('summarise', { focus: inputs.focus || 'the question', headings: headings.length ? headings.join(', ') : 'none', evidence: n.text }, ctx, needsList('points'), 1200);
  // "Strengths" for the heading "SWOT: Strengths" is the same heading
  const headingOf = (h) => {
    const x = plain(h);
    if (!x) return null;
    return headings.find((k) => plain(k) === x || plain(k).endsWith(` ${x}`) || x.endsWith(` ${plain(k)}`)) || undefined;
  };
  const perHeading = {};
  const findings = [];
  for (const raw of p.points.slice(0, 12)) {
    let heading = '';
    if (headings.length) {
      heading = headingOf(raw && raw.heading);
      if (!heading) { count(reasons, 'under a heading that was not asked'); continue; }
      if ((perHeading[heading] || 0) >= 4) { count(reasons, 'more than 4 points under one heading'); continue; }
    }
    const pt = makePoint(raw, n, ctx, reasons, { text: raw && raw.text, kind: 'fact', extra: heading ? { heading } : {} });
    if (!pt) continue;
    if (heading) perHeading[heading] = (perHeading[heading] || 0) + 1;
    findings.push(pt);
  }
  const empty = headings.filter((h) => !perHeading[h]);
  if (empty.length) notes.push(`no news found for: ${empty.join(', ')}`);
  return finishAi({ findings: headings.length ? findings : onlyAboutAsked(findings, ctx, reasons), empty_headings: empty }, reasons, notes, g);
}

// ── DI – 7. compare ──────────────────────────────────────────────────────
async function compare(inputs, ctx) {
  const reasons = {};
  const notes = [];
  const letters = ['A', 'B', 'C', 'D'];
  let sides = [].concat(inputs.sides || []).slice(0, 4).map((sd, k) => {
    const r = resultOf(sd.ref, ctx);
    const all = r && Array.isArray(r.output.items) ? r.output.items : [];
    const picked = pickItems([all], Math.floor(RUN_LIMITS.max_items_to_ai / Math.max(2, (inputs.sides || []).length)));
    // how many news items the side's search found in the data: the ones it
    // kept and the ones over its limit (26 Nov: "Which competitor is the
    // busiest?" — the AI said Lancôme, 8 news items, while Estée Lauder had
    // 62; the AI cannot count, code does)
    const overLimit = r && r.output && r.output.removed && r.output.removed.reasons
      ? Object.entries(r.output.removed.reasons).filter(([why]) => /^more than \d+ \(the best \d+ kept\)$/.test(why)).reduce((a, [, v]) => a + v, 0) : 0;
    return { label: sd.label, letter: letters[k], items: picked.items, left_out: picked.left_out, found: all.length + overLimit, all };
  });
  const out = (rows, differences) => ({
    sides: sides.map((sd) => ({ label: sd.label, letter: sd.letter, items: sd.items.length, left_out: sd.left_out })),
    // made by code, never the AI: how many news items each side's search
    // found (with the side's best news as its sources); Step 10 shows it as
    // a row of the table and gives it to the short answer
    found: sides.map((sd) => ({ label: sd.label, count: sd.found, sources: sd.all.slice(0, 3).map((it) => it.source_id) })),
    rows, differences, empty_sides: sides.filter((sd) => !sd.items.length).map((sd) => sd.label),
    ...(ownNotCompared ? { own_not_compared: ownNotCompared } : {}),
  });
  // 26 Nov (question bank, "What does Estée Lauder's Skin Longevity
  // Institute mean for Lumière?"): the side "Lumière" had no news (the data
  // is news about the market, not about the client), every cell said "no
  // news found" and the answer read it as a fact ("Lumière has no news
  // items, so it may be missing opportunities"). The client's own side with
  // no news is not compared (said in plain words); the other side's news
  // goes on as it is.
  const ownName = ctx.understood && ctx.understood.client && ctx.understood.client.company_name;
  const ownEmpty = ownName ? sides.filter((sd) => !sd.items.length && sameCompany(ownName, sd.label)) : [];
  let ownNotCompared = null;
  if (ownEmpty.length && sides.some((sd) => sd.items.length)) {
    sides = sides.filter((sd) => !ownEmpty.includes(sd));
    ownNotCompared = ownName;
    notes.push(`no news about ${ownName} itself in the data, so it is not compared`);
    if (sides.length < 2) {
      // one side left: its main news (3 best, by title), made by code
      const cells = {};
      for (const sd of sides) { const top = sd.items.slice(0, 3); cells[sd.label] = { text: top.map((it) => cut(it.title, 120)).join('; '), sources: top.map((it) => it.source_id) }; }
      return finishAi({ ...out([{ point: COMPARE_BY_CODE_POINT, cells }], []) }, reasons, notes);
    }
  }
  const emptySides = sides.filter((sd) => !sd.items.length).map((sd) => sd.label);
  if (emptySides.length) notes.push(`no news found for: ${emptySides.join(', ')} (its cells stay empty)`);
  if (emptySides.length === sides.length) return finishAi(out([], []), reasons, [NO_EVIDENCE, ...notes]);
  const n = { map: new Map(), text: '' };
  const blocks = sides.map((sd) => {
    const part = numbered(sd.items, [], sd.letter);
    for (const [k, v] of part.map) n.map.set(k, v);
    return `SIDE ${sd.letter} = ${sd.label} (${sd.found} news items found in the data)\n${part.text || '(no news items for this side)'}`;
  });
  // The points to compare must not carry a side's name (25 Nov: "beauty
  // market trends in Saudi Arabia" and "... in UAE" became two rows, each
  // with one side empty, so nothing was compared). The side names (and
  // their other spellings: UAE, KSA) and the joining word left hanging are
  // taken out; points that become the same are one point.
  const sideNames = sides.flatMap((sd) => {
    const std = standardPlace(sd.label);
    return [sd.label, companyCore(sd.label), ...(std && PLACES[std] ? PLACES[std] : []), ...(std ? [std] : [])];
  }).map((x) => plain(x)).filter((x) => x.length >= 2).sort((a, b) => b.length - a.length);
  const JOIN = /^(?:in|for|of|by|at|on|from|between|and|vs|versus|the)\s+|\s+(?:in|for|of|by|at|on|from|between|and|vs|versus|the)$/;
  const dims = [];
  for (const d of [].concat(inputs.dimensions || [])) {
    let x = ` ${plain(d)} `;
    for (const nm of sideNames) x = x.split(` ${nm} `).join(' ');
    x = x.replace(/\s+/g, ' ').trim();
    for (let k = 0; k < 4; k++) x = x.replace(JOIN, '').trim();
    if (x && !dims.includes(x)) dims.push(x);
  }
  // 25 Nov (second Step 10 report): "Compare Lancôme and Estée Lauder"
  // went round in circles twice ("Absolue Longevity MD skincare range,
  // Absolue Longevity MD skincare range, …") and the comparison was lost.
  // When the AI's reply cannot be used twice, code shows the main news of
  // each side side by side (its 3 best news items, by title), said so in the
  // answer — never an empty comparison, never a made-up one.
  // The same side-by-side view when the AI's reply was read but nothing in
  // it passed the checks (25 Nov, final real run: "Compare Lancôme and
  // Estée Lauder" — the last try was repaired into one half row, that row
  // was removed, and the comparison was lost although both sides had news).
  const sideBySide = (why, differences) => {
    const cells = {};
    for (const sd of sides) {
      const top = sd.items.slice(0, 3);
      cells[sd.label] = top.length ? { text: top.map((it) => cut(it.title, 120)).join('; '), sources: top.map((it) => it.source_id) } : { text: '', sources: [] };
    }
    notes.push(`${why}; the main news of each side is shown side by side instead`);
    return finishAi({ ...out([{ point: COMPARE_BY_CODE_POINT, cells }], differences || []), made_by: 'code' }, reasons, notes);
  };
  let p;
  try {
    p = await askAi('compare', {
      sides: sides.map((sd) => `${sd.letter} = ${sd.label}`).join(', '),
      dimensions: dims.length ? dims.join(', ') : 'the up to 6 points that matter most for the question',
      evidence: blocks.join('\n\n'),
    }, ctx, needsList('rows', 'differences'), 2000);
  } catch (err) {
    if (err instanceof AiLimitError || !err.noRetry || /prompt .* is missing/.test(err.message)) throw err;
    return sideBySide(`the AI comparison could not be used (${cut(err.message, 120)})`);
  }
  const rows = [];
  for (const raw of p.rows.slice(0, 8)) {
    const point = cut(raw && raw.point, 120);
    if (!point) { count(reasons, 'empty point'); continue; }
    const cells = {};
    let any = false;
    for (const sd of sides) {
      const c = (raw.cells && (raw.cells[sd.letter] || raw.cells[sd.label])) || {};
      const text = cut(c.text, 300);
      if (!text) { cells[sd.label] = { text: '', sources: [] }; continue; }
      const s = sourcesFrom(rawSources(c), n, reasons, sd.letter);
      if (!s.ids.length) { count(reasons, 'a cell with no source of its own side (left empty)'); cells[sd.label] = { text: '', sources: [] }; continue; }
      if (!numbersOk([text], s.ids, ctx)) { count(reasons, 'a number that is not in its sources'); cells[sd.label] = { text: '', sources: [] }; continue; }
      cells[sd.label] = { text, sources: s.ids };
      any = true;
    }
    if (!any) { count(reasons, 'a row with no news for any side'); continue; }
    rows.push({ point, cells });
  }
  const differences = [].concat(p.differences || []).slice(0, 3)
    .map((d) => makePoint(d, n, ctx, reasons, { text: d && d.text, kind: 'interpretation' })).filter(Boolean);
  if (!rows.length) return sideBySide('no row of the AI comparison passed the checks', differences);
  return finishAi(out(rows, differences), reasons, notes);
}

// ── DI – 8. cluster ──────────────────────────────────────────────────────
// The groups that already exist first: a Market Dynamics card, a Forward
// Outlook trend, one competitor. The AI only groups what is left, and only
// when at least CLUSTER_AI_MIN items are left.
async function cluster(inputs, ctx) {
  const reasons = {};
  const notes = [];
  const lists = [];
  for (const ref of [].concat(inputs.evidence || [])) { const r = resultOf(ref, ctx); if (r && Array.isArray(r.output.items)) lists.push(r.output.items); }
  const items = pickItems(lists, Infinity).items;
  if (!items.length) return finishAi({ groups: [], ungrouped: [] }, reasons, [NO_EVIDENCE]);
  const byKey = new Map();
  for (const it of items) {
    let key = null;
    let name = null;
    let from = null;
    if (it.group && it.group.id) { key = `${it.group.type}:${it.group.id}`; name = it.group.name || (it.group.type === 'card' ? 'Market Dynamics card' : 'Forward Outlook trend'); from = it.group.type; }
    else if (it.module === 'competitor' && it.companies && it.companies[0]) { key = `competitor:${plain(it.companies[0])}`; name = `${it.companies[0]} moves`; from = 'competitor'; }
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { name, from, sources: [] });
    byKey.get(key).sources.push(it.source_id);
  }
  const groups = [...byKey.values()].filter((gr) => gr.sources.length >= 2);
  const used = new Set(groups.flatMap((gr) => gr.sources));
  let left = items.filter((it) => !used.has(it.source_id));
  if (left.length >= CLUSTER_AI_MIN) {
    left = left.slice(0, RUN_LIMITS.max_items_to_ai);
    const n = numbered(left, []);
    const p = await askAi('cluster', { evidence: n.text }, ctx, needsList('groups'), 600);
    for (const raw of p.groups.slice(0, 8)) {
      const name = cut(raw && raw.name, 80);
      const s = sourcesFrom(rawSources(raw), n, reasons);
      const fresh = s.ids.filter((id) => !used.has(id));
      if (fresh.length < s.ids.length) count(reasons, 'an item put in two groups', s.ids.length - fresh.length);
      if (!name || fresh.length < 2) { count(reasons, 'a group with fewer than 2 items (or no name)'); continue; }
      fresh.forEach((id) => used.add(id));
      groups.push({ name, from: 'ai', sources: fresh });
    }
  } else if (left.length) {
    notes.push(`${left.length} items in no existing group (too few to ask the AI)`);
  }
  const ungrouped = items.filter((it) => !used.has(it.source_id)).map((it) => it.source_id);
  return finishAi({ groups, ungrouped }, reasons, notes);
}

// ── DI – 9. identify_patterns ────────────────────────────────────────────
// The AI names the patterns; code works out the dates, how many sources,
// and trend (2 or more sources on different dates) or one-off event.
async function identifyPatterns(inputs, ctx) {
  const reasons = {};
  const notes = [];
  const g = gather(inputs.evidence, ctx);
  if (nothingToWorkOn(g)) return finishAi({ patterns: [] }, reasons, [NO_EVIDENCE], g);
  const n = numbered(g.items, g.findings);
  const p = await askAi('identify_patterns', { topic: inputs.topic || 'the question', evidence: n.text }, ctx, needsList('patterns'), 1000);
  const patterns = [];
  for (const raw of p.patterns.slice(0, 8)) {
    const name = cut(raw && raw.name, 100);
    const pt = makePoint(raw, n, ctx, reasons, { text: raw && raw.description, kind: 'interpretation', extra: { name } });
    if (!pt || !name) { if (pt) count(reasons, 'empty point'); continue; }
    const dates = pt.sources.map((id) => (ctx.sources.get(id) || {}).date).filter(Boolean).sort();
    const days = new Set(dates);
    patterns.push({
      name, description: pt.text, sources: pt.sources, source_count: pt.sources.length,
      first_date: dates[0] || null, last_date: dates[dates.length - 1] || null,
      kind: pt.sources.length >= 2 && days.size >= 2 ? 'trend' : 'one_off',
    });
  }
  patterns.sort((a, b) => (a.kind === b.kind ? b.source_count - a.source_count : a.kind === 'trend' ? -1 : 1));
  return finishAi({ patterns: onlyAboutAsked(patterns.map((x) => ({ ...x, text: x.description })), ctx, reasons, true).map(({ text, ...x }) => x) }, reasons, notes, g);
}

// ── DI – 10 / 11 / 12. gaps, opportunities, risks ────────────────────────
async function identifyGaps(inputs, ctx) {
  const reasons = {};
  const g = gather(inputs.inputs, ctx);
  if (nothingToWorkOn(g)) return finishAi({ findings: [] }, reasons, [NO_EVIDENCE], g);
  const n = numbered(g.items, g.findings);
  const p = await askAi('identify_gaps', { evidence: n.text }, ctx, needsList('gaps'), 800);
  const findings = p.gaps.slice(0, 6).map((x) => makePoint(x, n, ctx, reasons, { text: x && x.text, kind: 'interpretation' })).filter(Boolean)
    .map((f) => ({ ...f, kind: weaker(f.kind, 'interpretation') }));
  return finishAi({ findings: onlyAboutAsked(findings, ctx, reasons, true) }, reasons, [], g);
}

async function discoverOpportunities(inputs, ctx) {
  const reasons = {};
  const g = gather(inputs.inputs, ctx);
  if (nothingToWorkOn(g)) return finishAi({ findings: [] }, reasons, [NO_EVIDENCE], g);
  const n = numbered(g.items, g.findings);
  const p = await askAi('discover_opportunities', { focus: inputs.focus || 'the question', evidence: n.text }, ctx, needsList('opportunities'), 900);
  const findings = p.opportunities.slice(0, 6)
    .map((x) => makePoint(x, n, ctx, reasons, { text: x && x.text, kind: 'hypothesis', extra: { why: cut(x && x.why, 300) } })).filter(Boolean)
    .map((f) => ({ ...f, kind: 'hypothesis' }));
  return finishAi({ findings: onlyAboutAsked(findings, ctx, reasons, true) }, reasons, [], g);
}

const IMPACT_ORDER = ['Critical', 'High', 'Medium', 'Low'];
async function analyseRisks(inputs, ctx) {
  const reasons = {};
  const g = gather(inputs.evidence, ctx);
  if (nothingToWorkOn(g)) return finishAi({ findings: [] }, reasons, [NO_EVIDENCE], g);
  const n = numbered(g.items, g.findings);
  const p = await askAi('analyse_risks', { topic: inputs.topic || 'the question', evidence: n.text }, ctx, needsList('risks'), 1000);
  const findings = p.risks.slice(0, 8).map((x) => {
    const f = makePoint(x, n, ctx, reasons, { text: x && x.risk, kind: 'interpretation', extra: { why_it_matters: cut(x && x.why_it_matters, 300) } });
    if (!f) return null;
    // the level: the highest impact saved on its signals (never the AI's)
    const levels = f.sources.map((id) => String((ctx.sources.get(id) || {}).impact || '')).map((v) => IMPACT_ORDER.find((l) => l.toLowerCase() === v.toLowerCase())).filter(Boolean);
    const level = IMPACT_ORDER.find((l) => levels.includes(l)) || null;
    return { ...f, kind: weaker(f.kind, 'interpretation'), level };
  }).filter(Boolean);
  const rank = (l) => (l ? IMPACT_ORDER.indexOf(l) : IMPACT_ORDER.length);
  findings.sort((a, b) => rank(a.level) - rank(b.level));
  return finishAi({ findings: onlyAboutAsked(findings, ctx, reasons, true) }, reasons, [], g);
}

// ── validate_evidence (code only, no AI) ─────────────────────────────────
// Runs on whatever finished (a job that failed or was blocked is listed as a
// limitation, never hidden). Each point: its sources must be real signals
// of this run; 2 or more sources = supported, 1 = weak; a source dated
// outside the dates asked is flagged; two facts about the same thing with
// different numbers = a conflict. Then: sufficient / partial / insufficient.
async function validateEvidence(inputs, ctx) {
  const supported = [];
  const weak = [];
  const limitations = [];
  const conflicts = [];
  const removedByJobs = {};
  const reasons = {};
  const time = (ctx.understood && ctx.understood.time) || null;
  const signalsSeen = new Set();   // a signal found by two searches counts once
  for (const ref of [].concat(inputs.findings || [])) {
    const id = String(ref).split('.')[0];
    const r = ctx.results[id];
    if (!r || r.status !== 'done' || !r.output) {
      limitations.push(`${id} (${r ? r.capability : 'a job'}) did not finish: ${r ? r.status : 'not run'}${r && r.error ? ` (${cut(r.error, 120)})` : ''}`);
      continue;
    }
    const o = r.output;
    for (const [k, v] of Object.entries((o.removed && o.removed.reasons) || {})) if (r.capability !== 'retrieve_data' && r.capability !== 'structured_search') removedByJobs[k] = (removedByJobs[k] || 0) + v;
    if (Array.isArray(o.items)) {
      // a search given straight to the check: its signals are the points
      if (!o.items.length) continue;
      // (a list answer: each signal stands on its own source)
      const fresh = o.items.map((it) => it.source_id).filter((x) => !signalsSeen.has(x));
      fresh.forEach((x) => signalsSeen.add(x));
      if (fresh.length) supported.push({ task_id: id, text: `${fresh.length} news items for "${o.label || 'the search'}"`, sources: fresh, weight: fresh.length });
      continue;
    }
    const points = findingsOf(r);
    if (!points.length) limitations.push(`${id} (${r.capability}) found nothing${o.note ? `: ${cut(o.note, 160)}` : ''}`);
    for (const pt of points) {
      const real = (pt.sources || []).filter((s) => ctx.sources.has(s));
      if (real.length < (pt.sources || []).length) count(reasons, 'a source that is not a signal of this run', (pt.sources || []).length - real.length);
      if (!real.length) { count(reasons, 'a point with no real source'); continue; }
      // 25 Nov (playground): "Which EU cosmetics rules will affect formulas
      // in 2027?" — the search read the last 12 months (2027 is in the
      // future), but this check used 2027 itself and removed all 9 sources,
      // so the answer said "nothing found". A source now counts when it is
      // inside the dates of a search that found it (the same dates the
      // search used); the question's own dates only for a source no search
      // recorded.
      const until = time && time.to ? readUntil({ date_from: time.from, date_to: time.to }, ctx.understood) : null;
      const inside = (s) => {
        const d = (ctx.sources.get(s) || {}).date;
        if (!d) return true;
        const wins = (ctx.windows && ctx.windows.get(s)) || null;
        if (wins && wins.length) return wins.some((w) => !(w.from && d < w.from) && !(w.until && d > w.until));
        return !(time && time.from && d < time.from) && !(until && d > until);
      };
      if (!real.some(inside)) { count(reasons, 'every source is outside the dates asked'); continue; }
      (real.length >= 2 ? supported : weak).push({ task_id: id, text: cut(pt.text, 200), sources: real });
    }
    for (const h of o.empty_headings || []) limitations.push(`no news found for ${h}`);
    for (const sd of o.empty_sides || []) limitations.push(`no news found for ${sd} (comparison side)`);
    // facts about the same thing with different numbers
    if (r.capability === 'extract_facts') {
      const byAbout = new Map();
      for (const f of o.findings || []) {
        if (!f.about) continue;
        const nums = (f.text.match(/\d+(?:[.,]\d+)*/g) || []).join(',');
        if (!nums) continue;
        if (!byAbout.has(f.about)) byAbout.set(f.about, []);
        byAbout.get(f.about).push({ nums, f });
      }
      // a conflict = two facts saying the SAME thing (the same words apart
      // from the numbers) with different numbers, from different sources.
      // 25 Nov: "Lancôme launched 4 new products: …" and "Lancôme launched 2
      // new products: …" are two launches, not a conflict.
      const words = (t) => new Set(plain(String(t).replace(/\d+(?:[.,]\d+)*/g, ' ')).split(' ').filter((w) => w.length >= 2));
      const alike = (a, b) => { const A = words(a); const B = words(b); const both = [...A].filter((w) => B.has(w)).length; return both / Math.max(1, new Set([...A, ...B]).size) >= 0.6; };
      for (const [about, list] of byAbout) {
        for (let a = 0; a < list.length; a++) {
          for (let b = a + 1; b < list.length; b++) {
            const x = list[a];
            const y = list[b];
            if (x.nums !== y.nums && alike(x.f.text, y.f.text) && x.f.sources.join() !== y.f.sources.join()) {
              conflicts.push({ about, facts: [x, y].map((z) => ({ text: z.f.text, sources: z.f.sources })) });
            }
          }
        }
      }
    }
  }
  // searches of the whole run that found nothing
  for (const [id, r] of Object.entries(ctx.results)) {
    if (['retrieve_data', 'structured_search'].includes(r.capability) && r.status === 'done' && r.output && !r.output.items.length) {
      limitations.push(`the search ${id} "${cut(r.output.label, 80)}" found nothing`);
    }
  }
  // 25 Nov: a list of 9 UAE signals was "partial" (one search = one point);
  // now each signal of a search counts, and "sufficient" needs at least
  // MIN_SUPPORTED supported points
  const nSupported = supported.reduce((a, x) => a + (x.weight || 1), 0);
  const total = nSupported + weak.length;
  const anyMissing = limitations.some((l) => / did not finish/.test(l));
  const status = total === 0 ? 'insufficient'
    : (nSupported >= MIN_SUPPORTED && nSupported >= total / 2 && !anyMissing) ? 'sufficient' : 'partial';
  return { status, counts: { supported: nSupported, weak: weak.length }, supported, weak, limitations: [...new Set(limitations)], conflicts, removed_by_jobs: removedByJobs, removed: { count: Object.values(reasons).reduce((a, b) => a + b, 0), reasons } };
}

// The jobs written so far (filter_data: never planned, the searches filter
// themselves; forecast: not in Layer 1).
const JOBS = {
  retrieve_data: retrieveData, structured_search: structuredSearch,
  extract_facts: extractFacts, summarise, compare, cluster, identify_patterns: identifyPatterns,
  identify_gaps: identifyGaps, discover_opportunities: discoverOpportunities, analyse_risks: analyseRisks,
  validate_evidence: validateEvidence,
};
// runs on whatever finished before it (and lists what did not)
const RUNS_ON_WHAT_FINISHED = ['validate_evidence'];

// ── The runner ───────────────────────────────────────────────────────────
const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`took longer than ${Math.round(ms / 1000)} s`)), ms);
  p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

/**
 * @param {object} checked     what Step 8 returned (status approved, batches)
 * @param {object} workflow    what Step 7 returned (tasks)
 * @param {object} understood  what Step 5 returned (client, companies)
 * @param {object} request     what Step 1 returned (client_id: the logged-in client)
 * @returns { status, results: { T1: { status, capability, output, error, ms, tries } }, counts, notes, ms }
 */
async function runWorkflow(checked, workflow, understood, request, options = {}) {
  const started = Date.now();
  const clientId = request && request.client_id;
  if (!clientId) throw new Error('runWorkflow: no client id from Step 1');
  if (!checked || checked.status !== 'approved') throw new Error('runWorkflow: the plan is not approved by Step 8');
  const tasks = new Map((workflow.tasks || []).map((t) => [t.task_id, t]));
  const results = {};
  const notes = [];
  // AI calls Step 9 may use: what Steps 3–7 left (workflow.ai_budget), minus
  // the one kept for the answer (Step 10)
  const left = options.aiBudget != null ? options.aiBudget
    : Math.max(0, (workflow.ai_budget != null ? workflow.ai_budget : RUN_LIMITS.max_ai_calls_per_question) - ANSWER_AI_CALLS);
  const ctx = { clientId, understood, results, sources: new Map(), windows: new Map(), ai: { budget: left, used: 0 } };
  const timeLimit = options.timeLimitMs || RUN_TIME_LIMIT_MS;

  async function runOne(id) {
    const t = tasks.get(id);
    const r = { status: 'pending', capability: t.capability, output: null, error: null, ms: 0, tries: 0, ai_calls: 0, depends_on: t.depends_on || [] };
    results[id] = r;
    const waiting = (t.depends_on || []).filter((d) => !results[d] || results[d].status !== 'done');
    if (waiting.length && !RUNS_ON_WHAT_FINISHED.includes(t.capability)) {
      r.status = 'blocked';
      r.error = `needs ${waiting.map((d) => `${d} (${results[d] ? results[d].status : 'not run'})`).join(', ')}`;
      return;
    }
    const job = JOBS[t.capability];
    if (!job) { r.status = 'not_built'; r.error = 'this job is not built yet (Step 9 part 2)'; return; }
    if (Date.now() - started > timeLimit) { r.status = 'failed'; r.error = 'the whole run took too long'; return; }
    const cap = getCapability(t.capability);
    const limits = (cap && cap.limits) || { timeout_ms: 20000, retries: 1 };
    const t0 = Date.now();
    const jobCtx = { ...ctx, job: { ai_calls: 0, ai_problems: [], removed_examples: [], replies: [] } };
    for (let attempt = 0; attempt <= (limits.retries || 0); attempt++) {
      r.tries = attempt + 1;
      try {
        r.output = await withTimeout(job(t.inputs || {}, jobCtx), options.jobTimeoutMs || limits.timeout_ms || 20000);
        r.status = 'done';
        r.error = null;
        break;
      } catch (err) {
        r.status = err instanceof AiLimitError ? 'skipped' : 'failed';
        r.error = String(err && err.message ? err.message : err).slice(0, 300);
        // a job that ran out of time is still running: trying it again
        // would only double the load on a slow database. No more AI calls
        // left, a missing prompt or an AI reply that could not be used
        // twice: trying again cannot help (and would cost AI calls).
        if (/^took longer than/.test(r.error) || err instanceof AiLimitError || err.noRetry) break;
      }
    }
    r.ai_calls = jobCtx.job.ai_calls;
    if (jobCtx.job.ai_problems.length) r.ai_problems = jobCtx.job.ai_problems;
    if (jobCtx.job.removed_examples.length) r.removed_examples = jobCtx.job.removed_examples;
    // every AI reply: its length and its end (a cut-off reply shows at its end)
    if (jobCtx.job.replies.length) r.ai_replies = jobCtx.job.replies;
    // the signals of a search: every later job and the answer cite them
    if (r.status === 'done' && r.output && Array.isArray(r.output.items)) {
      // the dates this search really read (a future period reads the last
      // 12 months; "today" meaning "now" reads all dates): the evidence
      // check uses these, never other dates (25 Nov, playground)
      const inp = t.inputs || {};
      const win = { from: inp.date_from || null, until: inp.date_to ? readUntil(inp, ctx.understood) : null };
      await openSignalsOf(r.output.items, ctx, inp, r.output);
      for (const it of r.output.items) {
        ctx.sources.set(it.source_id, it);
        if (!ctx.windows.has(it.source_id)) ctx.windows.set(it.source_id, []);
        ctx.windows.get(it.source_id).push(win);
      }
    }
    r.ms = Date.now() - t0;
  }

  for (const batch of checked.batches || []) {
    await Promise.all(batch.filter((id) => tasks.has(id)).map((id) => runOne(id)));
  }
  // a task Step 8 put in no batch would be a Step 8 bug: never silently skipped
  for (const id of tasks.keys()) {
    if (!results[id]) { results[id] = { status: 'failed', capability: tasks.get(id).capability, error: 'not in any batch from Step 8', output: null, ms: 0, tries: 0 }; }
  }

  const all = Object.values(results);
  const counts = {
    done: all.filter((r) => r.status === 'done').length,
    failed: all.filter((r) => r.status === 'failed').length,
    blocked: all.filter((r) => r.status === 'blocked').length,
    not_built: all.filter((r) => r.status === 'not_built').length,
    skipped: all.filter((r) => r.status === 'skipped').length,
    signals: all.filter((r) => r.status === 'done' && r.output && Array.isArray(r.output.items)).reduce((n, r) => n + r.output.items.length, 0),
  };
  const searches = all.filter((r) => ['retrieve_data', 'structured_search'].includes(r.capability));
  const searchesEmpty = searches.filter((r) => r.status === 'done' && !r.output.items.length).length;
  if (searchesEmpty) notes.push(`${searchesEmpty} of ${searches.length} searches found nothing`);
  if (counts.skipped) notes.push(`${counts.skipped} job(s) not run: the AI calls for this question were used up`);
  const status = counts.failed ? 'failed_jobs' : (counts.blocked || counts.not_built || counts.skipped) ? 'partial' : 'done';
  return {
    status, results, counts, notes, ms: Date.now() - started,
    ai: { used: ctx.ai.used, budget: ctx.ai.budget, kept_for_answer: options.aiBudget != null ? 0 : ANSWER_AI_CALLS },
    // every signal a job may cite, by its source id (for the answer, Step 10)
    sources: Object.fromEntries(ctx.sources),
  };
}

module.exports = {
  runWorkflow, useStore, useAi, usePrompts, applyFilters, toItem, visible, sameCompany, textNamesPlace, numbersOk, pickItems, salvageList, TABLES, plainWords, cutAtWord, squeezedRegex, fuzzyRegex, wordsInTitles, rareWordsOf, namesTogether,
  newestShare, isCommonWord, searchTextOf,
  // shared with Step 10 (generateAnswer.js): the same AI door, prompt reader and reply reader (and the same test fakes)
  callAiText: callAi, readPromptText: readPrompt, fillVars,
  readReplyText: (text) => { const o = strictReply(text); return o !== undefined ? o : readReply(text); },
};
