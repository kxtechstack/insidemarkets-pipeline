/**
 * modules/competitiveIntelligence/cardWriter.js   (v2 - permanent fix)
 *
 * Writes the CARD text from ALL its supporting signals:
 *   - title            the event, not one article
 *   - summary          all signals combined
 *   - business_impact  1-3 bullets: what it means for the client
 *
 * WHY v2: v1 asked the AI to write a "fact" in its own words and then checked that the words were in
 * the source. A small AI always rewords a little, so the check kept failing and one bad part threw
 * away the whole card.  v2 works like this instead:
 *   1. The AI never writes a fact. It picks a FACT NUMBER from a list; CODE copies the exact text.
 *      (The facts in the list were already checked against the article by reader.js.)
 *   2. One bad part never kills the card:
 *        - bad title           -> title built from the real source title
 *        - bad summary sentence-> only that sentence is removed (none left -> summary from the sources)
 *        - bad impact item     -> only that item is dropped (none left -> standard "what to check" line)
 *   3. The card is ALWAYS complete. Only a real AI outage (server down) skips a card - tried again next run.
 *
 * When: after a run, for every card that is new or got a new signal (card_written_at is null).
 * After writing, the chat copy (Qdrant) is refreshed with the new text.
 */

const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../llmClient');
const { clean, norm } = require('./webTools');
// a title is never cut in the middle of a word: cut back to the last whole word
const cutTitle = (t, n = 160) => { const x = clean(t, 2000); return x.length <= n ? x : x.slice(0, n).replace(/\s+\S*$/, '').replace(/[\s,;:(\-–]+$/, ''); };
const store = require('./changeStore');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PROMPT_ID = 'ci_card_writer_v1';   // same id as before: the text in public.prompts is replaced (latest: sql/ci_010_card_prompt_v4.sql)
const MAX_SIGNALS_TO_AI = 12;
const MAX_FACTS = 16;

const KIND = { news: 'News article', press: 'Press release', blog: 'Company blog', own_site: 'Company website', product: 'Product / pricing page' };

let promptCache = { text: null, at: 0 };
async function getPrompt() {
  if (promptCache.text && Date.now() - promptCache.at < 5 * 60 * 1000) return promptCache.text;
  const { data } = await supabase.from('prompts').select('prompt_template').eq('id', PROMPT_ID).eq('is_active', true).maybeSingle();
  if (!data || !data.prompt_template) throw new Error(`Prompt '${PROMPT_ID}' not found or not active (run sql/ci_007_card_prompt_v2.sql)`);
  if (!/\{\{facts\}\}/.test(data.prompt_template)) throw new Error(`Prompt '${PROMPT_ID}' is still the OLD version (no {{facts}}). Run sql/ci_007_card_prompt_v2.sql`);
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

/** the client's own profile: text for the AI + a numbered list of the client's areas (products, sectors, markets) */
async function clientProfile(clientId) {
  const { data } = await supabase.schema('admin').from('client_icp').select('context_json').eq('client_id', clientId).maybeSingle();
  const x = (data && data.context_json) || {};
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map((s) => clean(s, 80)) : (typeof v === 'string' && v ? v.split(/[,;]/).map((s) => clean(s, 80)).filter(Boolean) : []));
  const areas = [...new Set([...arr(x.focus_products_services), ...arr(x.core_sectors), ...arr(x.geographic_focus)])].slice(0, 20);
  const lines = [];
  if (arr(x.focus_products_services).length) lines.push(`- Sells / focuses on: ${arr(x.focus_products_services).join(', ')}`);
  if (arr(x.core_sectors).length) lines.push(`- Core sectors: ${arr(x.core_sectors).join(', ')}`);
  if (arr(x.geographic_focus).length) lines.push(`- Markets: ${arr(x.geographic_focus).join(', ')}`);
  if (arr(x.sectors_to_avoid).length) lines.push(`- Not a focus: ${arr(x.sectors_to_avoid).join(', ')}`);
  return { text: lines.length ? lines.join('\n') : '- (no profile given)', areas, geo: arr(x.geographic_focus) };
}

// ---------------------------------------------------------------------
// Standard "what to check" line (states no fact about the client, so it cannot be wrong)
// ---------------------------------------------------------------------
const FALLBACK = [
  [/pricing|promotion/i, (c) => `What to check: compare your own prices with ${c}'s change.`],
  [/product|feature|launch/i, (c) => `What to check: how ${c}'s new offer compares with your own products.`],
  [/geographic|expansion|market entry/i, (c) => `What to check: whether ${c}'s move adds competition in your markets.`],
  [/m&a|funding|investment|acquisition|merger/i, (c) => `What to check: ${c} gains money or capacity - expect it to compete harder.`],
  [/partnership|alliance/i, (c) => `What to check: whether this partner of ${c} is also a partner or customer of yours.`],
  [/brand|positioning|thought leadership/i, (c) => `What to check: whether ${c}'s message targets the same customers as yours.`],
  [/leadership &|org changes|executive|appoint|new leader/i, (c) => `What to check: whether ${c}'s new leaders may change its direction.`],
  [/regulatory|legal|compliance|lawsuit/i, (c) => `What to check: whether the same rule or claim against ${c} could apply to you.`],
  [/customer|reputation|award/i, (c) => `What to check: whether this changes how customers see ${c} against you.`],
  [/marketing|campaign|brand/i, (c) => `What to check: whether ${c}'s message targets the same customers as yours.`],
  [/technology|ai\b|digital/i, (c) => `What to check: whether ${c}'s new capability is one your customers ask for.`],
];
function fallbackImpact(card) {
  const hit = FALLBACK.find(([re]) => re.test(`${card.category} ${card.signal_name}`));
  const fn = hit ? hit[1] : (c) => `What to check: what this move by ${c} means for your own plans.`;
  return [fn(card.organization)];
}

// ---------------------------------------------------------------------
// Small checkers (used per sentence / per item - never to throw a whole card away)
// ---------------------------------------------------------------------
// The dangerous invention is a WRONG ACTION ("acquires" when the source says "signs"). Normal wording is fine.
const ACTION = /\b(discontinu\w*|withdr[ae]w\w*|acquir\w*|buys?|bought|merg\w*|takeover|launch\w*|unveil\w*|sues?|sued|lawsuit|fined?|bans?|banned|recall\w*|cuts?|raises?|hikes?|lowers?|closes?|closed|shuts?|exits?|enters?|entered|signs?|signed|wins?|won|loses?|lost|hires?|hired|appoints?|appointed|resigns?|resigned|fires?|fired|layoffs?|partners?|partnered|invests?|invested|sells?|sold|divests?|ipo|bankrupt\w*)\b/gi;
function inventedActions(text, signalsText) {
  const sig = norm(signalsText);
  const found = [...new Set((norm(text).match(ACTION) || []).map((w) => w.toLowerCase()))];
  return found.filter((w) => !sig.includes(w.slice(0, Math.max(3, w.length - 3))));
}
const numbersOf = (s) => (String(s || '').match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,/g, ''));
const unknownNumbers = (text, allowed) => [...new Set(numbersOf(text))].filter((n) => n.length > 1 && !allowed.has(n));

const META = /\b(was|were|been) (reported|announced|published|confirmed) (on|by|in|through)\b|according to (the )?(article|signals?|press release|news)|\b(the|this) (article|signals?|press release|information|news) (does|do|did|is|was|provides?|confirms?|mentions?)\b|\bno (specific |further |more )?(details|date|information|figures|numbers)\b|\bthis event (occurred|happened|took place)\b|\bnot (specified|mentioned|provided|disclosed) in\b|\bthis information\b/i;
const EMPTY = /\bshould monitor\b|\bmonitor\b|keep an eye|stay informed|may (impact|affect) the [a-z ]{0,30}market|could be a positive sign|potential(ly)? impact/i;
const VAGUE = /\b(assess|evaluate|review)\w* (its|your|their) (own )?[a-z ]{0,25}(strateg\w*|approach|plans?)\b|\bexplore (this|the) (opportunity|option)\b|\bstay(ing)? competitive\b|\bconsider (adjusting|reviewing|exploring|developing)\b|\breview (your |its |their )?(product )?offerings?\b|\b(adjust|review|reassess)\w* (your|its|their) [a-z ]{0,20}strateg|\bfocus on your own\b|\bremain competitive\b|review (its |their |the |your )?(pricing |sales |business )?strateg(y|ies)|analy[sz]e (the )?(implications|market|landscape)|assess (the |its )?(implications|landscape|impact)|adjust (its |their )?strateg|consider (expanding|exploring|the implications)|\baccordingly\b|update (its|their) market analysis|reassess (the|its) [a-z ]*strategy/i;
// "may harm SolarGrid's reputation" - the sources never say that about the client
function claimsAboutClient(why, clientName) {
  if (!clientName) return false;
  const first = norm(clientName).split(/\s+/)[0];
  const w = norm(why);
  // a stated fact about the client is not allowed; a possible effect ("may", "could") is what we ask for
  return w.includes(first) && /\b(reputation|quality|sales|revenue|customers?|products?|systems? sold|profits?|brand|trust)\b/.test(w)
    && !/\b(may|might|could|can|risk|chance|likely)\b/.test(w);
}
// "NextEra Energy expands its presence in the US market" - about the competitor, not about the client
const CLIENT_SIDE = /\b(demand|buyers?|customers?|market for|opportunit\w*|room|gap|prices?|pricing|compet\w*|rival|client|you|your|supplier|partner)\b/i;
function onlyDescribesCompetitor(why, competitor) {
  const first = norm(competitor).split(/\s+/)[0];
  const w = norm(why).replace(/^(this|it) (shows|indicates|demonstrates|reflects|highlights|means|suggests) (that )?/, '');
  return w.startsWith(first) && !CLIENT_SIDE.test(w);
}
// "why" that is just the fact again ("Revenue of $1.09B beats by $284.29M.")
function repeatsFact(why, fact) {
  const w = norm(why).match(/[a-z0-9$.%]{3,}/g) || [];
  const f = new Set(norm(fact).match(/[a-z0-9$.%]{3,}/g) || []);
  return w.length > 0 && w.filter((x) => f.has(x)).length / w.length >= 0.7;
}
// an opportunity for the CLIENT names something the client can win
// every bullet must name HOW the client is touched (generic "benefits the sector", "growth opportunities for the client" is dropped)
// short market names in a client profile -> the words an article uses for them
const MARKET_WORDS = {
  us: /\bUS\b|\bU\.S\.|United States|\bAmerica\b|\bAmerican\b/, usa: /\bUSA\b|\bUS\b|\bU\.S\.|United States|\bAmerica/,
  uk: /\bUK\b|\bU\.K\.|United Kingdom|Britain|British|England|London/, gb: /\bUK\b|United Kingdom|Britain|British/,
  in: /\bIndia\b|\bIndian\b/, uae: /\bUAE\b|Emirates|Dubai|Abu Dhabi/, eu: /\bEU\b|Europe|European/,
};
function marketInText(area, text) {
  const k = norm(area).trim();
  const re = MARKET_WORDS[k] || new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(text);
}
const SETBACK = /\b(discontinu\w*|withdraw\w*|exits?|exited|sunset\w*|decreas\w*|declin\w*|down \d|cuts?|cutting|lower(ed|s)?|downgrad\w*|fell|falls?|dropp?\w*|miss(ed|es|ing)|lawsuit|sued|sues|defects?|losses|net loss|layoffs?|recall\w*|fined?|penalt\w*|settle\w*|degrad\w*|complaint|recalls?|replacements?)\b/i;
// a donation or community project does not change competition (it is a "low" item at most)
const COMMUNITY = /\b(donat\w*|charit\w*|communit\w*|volunteer\w*|scholarship\w*|emergency preparedness|residents|nonprofits?|non-profits?|awareness|mental health|well-?being)\b/i;
const MORE_COMPETITION = /\b(increas\w*|more|greater|stronger|higher|intensif\w*)\b[^.]{0,30}\bcompetition\b|\bcompetition\b[^.]{0,20}\b(increas\w*|grow\w*|intensif\w*)/i;
const CLIENT_LINK = /\b(demand|buyers?|market for|gap|room|prices?|pricing|compet\w*|rival|threat|pressure|market share|share of|win|wins|lose|loses|losing|switch\w*|supplier\w*|supply|contracts?|bids?|tenders?|costs?|margins?|orders?)\b/i;
// how the client is touched (wider than CLIENT_LINK: attention, shelf space, channels, partners, product plans too)
const IMPACT_LINK = /\b(demand|buyers?|shoppers?|customers?|consumers?|attention|notice|visib\w*|shelf|shelves|space|channels?|retailers?|stores?|partners?|distributors?|market for|gap|room|prices?|pricing|discount\w*|compet\w*|rival|threat|pressure|market share|share of|win|wins|lose|loses|losing|switch\w*|supplier\w*|supply|contracts?|bids?|tenders?|costs?|margins?|orders?|launch\w*|range|portfolio|offer\w*|you|your|client)\b/i;
// words that fit ANY card - a point made only of these is a template, not about this card
const GENERIC = new Set(('products product market markets customers customer buyers buyer shoppers brand brands company companies competition competitor competitors '
  + 'rival rivals launch launches launched launching offer offers offering offerings sales growth global consumer consumers attention clearly closest better '
  + 'their which these those about could would should other unique benefits benefit highlight similar develop increase increased business industry sector '
  + 'premium luxury quality value strategy pricing prices price event events new range ranges items while because there where people').split(' '));
function specificWords(text, skip) {
  return new Set((norm(text).match(/[a-z]{5,}/g) || []).filter((w) => !GENERIC.has(w) && !skip.has(w)));
}
// country / region names (any client): a point that is only about a market the client is not in is not useful
const COUNTRIES = ('Japan|China|Korea|South Korea|India|Indonesia|Thailand|Vietnam|Malaysia|Singapore|Philippines|Taiwan|Hong Kong|Australia|New Zealand|'
  + 'Brazil|Mexico|Argentina|Chile|Colombia|Peru|Canada|United States|USA|US|UK|United Kingdom|Britain|Ireland|France|Germany|Italy|Spain|Portugal|'
  + 'Netherlands|Belgium|Switzerland|Austria|Poland|Sweden|Norway|Denmark|Finland|Russia|Turkey|Saudi Arabia|UAE|Dubai|Qatar|Egypt|Nigeria|South Africa|Kenya|Pakistan|Bangladesh|Sri Lanka|Croatia|Zagreb|Toronto|Paris|London|Tokyo|Shanghai|São Paulo|Sao Paulo').split('|');
const EFFECT = { risk: 'Risk', threat: 'Risk', opportunity: 'Opportunity', low: 'Low direct impact' };

// a quote cut in the middle of a word ("to develop, bu") -> cut back to the last whole word
function wholeWords(text, max = 220) {
  const t = clean(text, 2000);
  if (t.length < 300 && t.length <= max) return t;                // not cut
  return `${t.slice(0, max).replace(/\s+\S*$/, '').replace(/[\s,;:(]+$/, '')}…`;
}
// German / Korean quotes are left out when an English one exists (the card is in English)
const EN_WORDS = /\b(the|and|of|to|for|with|has|have|is|was|are|its|an|on|by|at|from|that|this|will|which|new|launches|launched|says|after|its)\b/gi;
// common little words of other languages (Spanish, Portuguese, French, Italian, German, Indonesian, Vietnamese)
const OTHER_WORDS = /\b(el|los|las|con|y|para|del|sobre|una|um|uma|com|não|nao|em|les|des|et|une|pour|avec|sur|dans|de|du|au|aux|à|en|son|sa|ses|nouveaux|nouvelles|notamment|der|die|das|und|mit|für|fur|zum|von|nach|il|che|per|della|dan|yang|untuk|dengan|của|và|cho|những)\b/gi;
function isEnglish(text) {
  const t = String(text || '');
  if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f]/.test(t)) return false; // Japanese, Chinese, Korean, Cyrillic, Arabic, Thai
  const other = (t.match(OTHER_WORDS) || []).length;
  const en = (t.match(EN_WORDS) || []).length;
  // brand names often carry a French word ("La Vie Est Belle"), so one or two foreign words alone are not enough
  return !(other >= 3 && other > en) && !(other >= 2 && en === 0 && t.split(/\s+/).length >= 8);
}

const splitSentences = (s) => String(s || '').split(/(?<=[.!?])\s+/).map((x) => clean(x, 500)).filter(Boolean);

// a source title worth showing as a card title (not "Newsroom", "ICYMI: ... this month", "Press releases")
const usefulSourceTitle = (t) => t.length >= 25 && !/newsroom|news releases?|press releases?|icymi|developments around|round-?up|this week in|this month/i.test(t);
const cleanSourceTitle = (t) => cutTitle(String(t || '').replace(/\s+[|\-–·]\s+[^|\-–·]{2,60}$/, ''), 160);
const withCompetitor = (title, competitor) => (norm(title).includes(norm(competitor).split(' ')[0]) ? title : `${competitor}: ${title}`);

function fallbackTitle(ctx) {
  const titles = ctx.signals.map((s) => cleanSourceTitle(s.signal_title || s.title)).filter(Boolean);
  // an English source title, else the first sentence of an English source summary (cut to 14 words)
  const firstSentence = ctx.signals.map((x) => splitSentences(x.summary)[0]).find((x) => x && isEnglish(x));
  const fromSummary = firstSentence ? firstSentence.split(/\s+/).slice(0, 14).join(' ').replace(/[,.;:]$/, '') : null;
  const pick = titles.find((t) => usefulSourceTitle(t) && isEnglish(t)) || fromSummary || titles.find(usefulSourceTitle) || titles[0]
    || clean(ctx.card && ctx.card.signal_title, 160) || `${ctx.competitor} update`;
  return withCompetitor(pick, ctx.competitor);
}
function fallbackSummary(ctx) {
  // first sentence of each source summary (the reader already checked these against the article)
  const parts = [];
  for (const s of ctx.signals) {
    const first = splitSentences(s.summary)[0];
    if (first && !parts.some((p) => norm(p) === norm(first))) parts.push(first);
    if (parts.length >= 3) break;
  }
  return clean(parts.join(' ') || (ctx.card && ctx.card.summary) || '', 1200);
}

/**
 * Build the final card text from the AI answer. NEVER throws away the whole card.
 * @param ans  parsed AI answer (or null if the AI gave no valid JSON)
 * @param ctx  { signals, signalsText, facts: string[], competitor, clientName, areas, card }
 * @returns {{title, summary, impact: string[], impactCount, repairs: string[], itemProblems: string[]}}
 */
function composeCard(ans, ctx, rawSnippet) {
  const repairs = [];
  const itemProblems = [];
  const allowed = new Set(numbersOf(ctx.signalsText));
  const a = ans || {};
  if (!ans) repairs.push(`AI gave no valid JSON - everything built from the sources (answer started: "${clean(rawSnippet, 120)}")`);

  // ---- title: bad -> built from the real source title
  let title = cutTitle(a.title, 160);
  const titleBad = !title || title.split(/\s+/).length < 3
    || inventedActions(title, ctx.signalsText).length || unknownNumbers(title, allowed).length
    || (title.split(/\s+/).length >= 6 && !isEnglish(title));   // the card is in English
  if (titleBad) { title = fallbackTitle(ctx); if (ans) repairs.push('title from the source'); }
  title = withCompetitor(title, ctx.competitor);

  // ---- summary: only the bad SENTENCES are removed
  const sentences = splitSentences(a.summary);
  const keep = sentences.filter((s) => !inventedActions(s, ctx.signalsText).length
    && !unknownNumbers(s, allowed).length
    && !META.test(s)
    && isEnglish(s)
    && !(ctx.clientName && norm(s).includes(norm(ctx.clientName))));
  let summary = clean(keep.join(' '), 1200);
  if (summary.length < 40) {
    summary = fallbackSummary(ctx);
    if (ans) repairs.push('summary from the sources');
  } else if (keep.length < sentences.length) {
    repairs.push(`removed ${sentences.length - keep.length} summary sentence(s)`);
  }

  // ---- business impact: 3-4 points "what this means for the client" + "what the client can do".
  // Each point is tied to a FACT number (checked source text). Only bad POINTS are dropped, never the card.
  // v4 prompt: business_impact is an object with one point per ANGLE (buyers / price / channels / products);
  // older prompts: a list. Both are turned into one list here.
  const ANGLES = ['buyers', 'price', 'channels', 'products', 'markets'];
  const bi = a.business_impact;
  const rawItems = Array.isArray(bi) ? bi
    : (bi && typeof bi === 'object' ? ANGLES.map((k) => {
      const v = bi[k];
      if (v && typeof v === 'object') return { ...v, angle: k };
      // the small model sometimes writes the angle as a plain sentence instead of an object
      if (typeof v === 'string' && v.split(/\s+/).length >= 6) return { point: v, effect: 'risk', area_number: 0, angle: k };
      return null;
    }) : []);
  const items = rawItems.filter((x) => x && typeof x === 'object' && /[a-z]{3,}.*[a-z]{3,}/i.test(String(x.point || x.impact || x.why || ''))).slice(0, 5);
  const impact = [];
  const factUse = new Map();
  const wordsOf = (t) => new Set((norm(t).match(/[a-z]{4,}/g) || []));
  const tooAlike = (x, y) => { const A = wordsOf(x); const B = wordsOf(y); const n = [...A].filter((w) => B.has(w)).length; return n / Math.max(1, Math.min(A.size, B.size)) >= 0.6; };
  items.forEach((it, i) => {
    const tag = `Impact ${i + 1}:`;
    let effect = EFFECT[String(it.effect || '').toLowerCase().trim()];
    const area = Number(it.area_number) === 0 ? 'General' : ctx.areas[Number(it.area_number) - 1];
    const fact = ctx.facts[Number(it.fact_number) - 1] || '';   // optional: the point itself must name something from the card
    // ONE sentence: what may change for the client + what to do ("..., so ..."). Older prompts: "point"+"action" or "why".
    const lowFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);
    const joined = it.impact && it.action ? `${clean(it.impact, 300).replace(/[.\s]+$/, '')}, so ${lowFirst(clean(it.action, 250))}` : '';
    const why = clean(it.point || joined || it.impact || it.why, 400);
    const problems = [];
    if (!effect) problems.push('"effect" must be one word: risk, opportunity or low');
    if (!area) problems.push('"area_number" must be a number from the AREAS list (0 = general)');
    if (!why || why.split(/\s+/).length > 50) problems.push('"point" must be one sentence of at most 40 words');
    else if (EMPTY.test(why)) problems.push('"point" is an empty phrase - say in plain words what changes for the client (never "monitor")');
    else if (VAGUE.test(why)) problems.push('"point" is vague - say what changes for the client');
    else if (unknownNumbers(why, allowed).length) problems.push(`"point" has numbers that are not in the sources: ${unknownNumbers(why, allowed).join(', ')}`);
    if (!problems.length && fact && (factUse.get(Number(it.fact_number)) || 0) >= 2) problems.push('this fact_number is already used twice - use another fact');
    if (!problems.length && claimsAboutClient(why, ctx.clientName)) problems.push(`"point" states something about ${ctx.clientName} (its reputation, quality, sales or customers) as a fact. Say what MAY happen ("may", "could")`);
    if (!problems.length && onlyDescribesCompetitor(why, ctx.competitor)) problems.push(`"point" only describes ${ctx.competitor}. Say what it means for the client`);
    if (!problems.length && repeatsFact(why, fact)) problems.push('"point" only repeats the fact. Say what it MEANS for the client');
    if (!problems.length && !IMPACT_LINK.test(why)) problems.push('"point" must say how the client is touched: its buyers, attention, prices, shelf space, partners, channels, markets, costs or product plans');
    const namedMarket = (ctx.geo || []).find((g) => g !== area && new RegExp(`\\b${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(why) && !marketInText(g, ctx.signalsText));
    if (!problems.length && namedMarket) problems.push(`"point" names ${namedMarket}, but the sources do not mention it`);
    if (!problems.length && (ctx.geo || []).includes(area) && !marketInText(area, ctx.signalsText)) problems.push(`the sources do not mention ${area}. Use area 0 or the area the event is really about`);
    if (!problems.length && COMMUNITY.test(fact) && effect !== 'Low direct impact') effect = 'Low direct impact';
    // a point about a country the client does not sell in is low impact for the client
    const country = COUNTRIES.find((c) => new RegExp(`(^|[^A-Za-z])${c}([^A-Za-z]|$)`).test(why));   // case-sensitive: "US" is not "us"
    if (!problems.length && country && (ctx.geo || []).length && !(ctx.geo || []).some((g) => marketInText(g, country) || marketInText(country, g) || new RegExp(`\\b${country}\\b`, 'i').test(g))) {
      problems.push(`"point" is about ${country}, which is not one of the client's markets - say what it means for the client's OWN markets, or leave it out`);
    }
    if (!problems.length && (SETBACK.test(fact) || SETBACK.test(why)) && MORE_COMPETITION.test(why)) problems.push(`the fact is a setback for ${ctx.competitor}; a setback does not mean more competition for the client. Say what the client can win from it`);
    if (!problems.length) {
      const skip = new Set(norm(`${ctx.clientName || ''} ${ctx.competitor} ${(ctx.areas || []).join(' ')}`).match(/[a-z]{5,}/g) || []);
      const cardWords = specificWords(ctx.signalsText, skip);
      if (![...specificWords(why, skip)].some((w) => cardWords.has(w) || [...cardWords].some((c) => c.startsWith(w.slice(0, 6)))))
        problems.push('"point" is general and could fit any card - name what from THIS card changes things for the client (the product, partner, place, channel or number)');
    }
    if (!problems.length && impact.some((x) => tooAlike(x.why, why))) problems.push('"point" says the same as another point - give a DIFFERENT angle (buyers, price, channels/partners, product plans, markets) or fewer points');
    if (problems.length) { itemProblems.push(`${tag} ${problems.join('; ')}.`); return; }
    if (fact) factUse.set(Number(it.fact_number), (factUse.get(Number(it.fact_number)) || 0) + 1);
    // the small model sometimes mixes up the direction: the sentence decides
    if (effect === 'Risk' && (/\b(reduc\w*|less|lower|weaker|fewer|weaken\w*)\b[^.]{0,30}\bcompet\w*/i.test(why) || /\bsell into\b|\blarger market\b|\bnew market for\b|\bgap\b/i.test(why))) effect = 'Opportunity';
    else if (effect === 'Opportunity' && /\b(competition|compete|competitors?|threat|lose|loss|pressure|decline|harm|damage|risk|less attention|notice .{0,20}less)\b/i.test(why)) effect = 'Risk';
    // a competitor's PRICE change: a cut = price pressure on the client (Risk), a rise = room for the client (Opportunity)
    if (/pric/i.test(`${(ctx.card && ctx.card.category) || ''} ${(ctx.card && ctx.card.signal_name) || ''}`)) {
      const priceText = `${why} ${(ctx.card && ctx.card.signal_title) || ''}`;
      if (/\b(reduc\w*|lower\w*|cut\w*|drop\w*|discount\w*|cheaper|decreas\w*)\b/i.test(priceText)) effect = 'Risk';
      else if (/\b(rais\w*|increas\w*|hike\w*|higher|more expensive)\b[^.]{0,20}\bpric/i.test(priceText)) effect = 'Opportunity';
    }
    impact.push({ effect, area, fact, why });
  });
  const real = impact.filter((x) => x.effect !== 'Low direct impact');
  const chosen = (real.length ? real : impact.slice(0, 1)).slice(0, 4);
  const sentence = (t) => { const x = t.replace(/\s+$/, ''); return /[.!?]$/.test(x) ? x : `${x}.`; };
  const bullets = chosen.map((x) => `${x.effect}${x.area !== 'General' ? ` for ${x.area}` : ''}: ${sentence(x.why)}`);
  if (!bullets.length) {
    repairs.push(items.length
      ? `business impact = standard line (dropped: ${itemProblems.join(' ')})`
      : 'business impact = standard line (the AI gave no impact items)');
  }

  return { title, summary, impact: bullets, impactCount: bullets.length, repairs, itemProblems };
}

/** numbered FACTS list: the reader's checked key facts; a signal with none gives its first summary sentences */
function buildFacts(signals) {
  const facts = [];
  signals.forEach((s, i) => {
    let own = (Array.isArray(s.key_facts) ? s.key_facts : []).filter(isEnglish).map((f) => wholeWords(f, 220));
    if (!own.length) own = splitSentences(s.summary).slice(0, 2);   // no English quote -> the English summary
    for (const f of own) {
      if (f && facts.length < MAX_FACTS && !facts.some((x) => norm(x.text) === norm(f))) facts.push({ text: f, signal: i + 1 });
    }
  });
  return facts;
}

/**
 * Write one card again from all its signals.
 * @returns {{ok, reason?, title?, repairs?}}
 */
async function writeCard(changeId) {
  const { data: card } = await supabase.from('competitor_changes').select('*').eq('id', changeId).maybeSingle();
  if (!card) return { ok: false, reason: 'card not found' };
  const { data: ev } = await supabase.from('competitor_change_evidence')
    .select('signal_title, title, summary, source_kind, source_domain, event_date, published_date, key_facts')
    .eq('change_id', changeId).eq('is_copy', false).order('event_date', { ascending: false }); // newest move first
  const { data: client } = await supabase.schema('admin').from('clients')
    .select('company_name, industry, location').eq('id', card.client_id).maybeSingle();

  const signals = (ev || []).slice(0, MAX_SIGNALS_TO_AI);
  const factObjs = buildFacts(signals);
  const sigLines = signals.map((s, i) => `${i + 1}. [${KIND[s.source_kind] || s.source_kind}, ${s.source_domain || ''}, ${s.event_date || s.published_date || ''}] ${clean(s.signal_title || s.title, 200)}\n   ${clean(s.summary || '', 600)}`);
  const factLines = factObjs.map((f, i) => `${i + 1}. (source ${f.signal}) ${f.text}`);
  // only real source text counts (never the card's own older AI text - it could carry an old mistake)
  const signalsText = `${sigLines.join('\n')}\n${factLines.join('\n')}`;

  const profile = await clientProfile(card.client_id);
  const vars = {
    client_name: (client && client.company_name) || 'the client',
    client_industry: (client && client.industry) || 'not given',
    client_country: (client && client.location) || card.country || 'not given',
    client_profile: profile.text,
    areas: profile.areas.length ? profile.areas.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(no areas given - use 0)',
    competitor: card.organization,
    category: card.category,
    signal_name: card.signal_name,
    signal_count: signals.length,
    signals: sigLines.join('\n'),
    facts: factLines.join('\n') || '(no facts - use only the sources above)',
  };
  const ctx = {
    signals, signalsText, facts: factObjs.map((f) => f.text), competitor: card.organization,
    clientName: client && client.company_name, areas: profile.areas, geo: profile.geo || [], card,
  };

  const messages = [{ role: 'user', content: fill(await getPrompt(), vars) }];
  let composed = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw;
    try {
      raw = await callLLM(messages, { temperature: 0, max_tokens: 1100, timeout: 90000, model: process.env.CI_CARD_MODEL || null });
    } catch (e) {
      // a real outage: leave the card as it is, it is tried again next run
      return { ok: false, reason: `AI call failed: ${clean(e.message, 150)}` };
    }
    const ans = parseJson(raw);
    const now = composeCard(ans, ctx, raw);
    // keep the better of the two answers (more usable points)
    if (!composed || now.impactCount >= composed.impactCount) composed = now;
    // one more try when the AI gave fewer than 3 usable points
    if (attempt === 1 && (!ans || composed.impactCount < 3)) {
      messages.push({ role: 'assistant', content: clean(raw, 3000) });
      messages.push({ role: 'user', content: ans
        ? `${now.itemProblems.length ? `Some points cannot be used:\n- ${now.itemProblems.join('\n- ')}\n` : ''}Fill at least 3 of the 4 business_impact angles (buyers, price, channels, products), each naming something from THIS card. Answer again with the full JSON only (title, summary and 3 to 4 business_impact points). Pick fact_number from the FACTS list.`
        : 'Your answer was not valid JSON. Answer again with the JSON only.' });
      continue;
    }
    break;
  }

  const impact = composed.impact.length ? composed.impact : fallbackImpact(card);
  const chatText = store.buildChatText({ name: card.organization }, {
    title: composed.title, summary: composed.summary, event_date: card.event_date, importance: card.importance,
    signal: { category: card.category, name: card.signal_name },
  });
  const { error } = await supabase.from('competitor_changes').update({
    signal_title: composed.title,
    summary: composed.summary,
    business_impact: impact,
    chat_text: chatText,
    card_written_at: new Date().toISOString(),
  }).eq('id', changeId);
  if (error) return { ok: false, reason: `could not save the card: ${error.message}` };
  await store.syncChangeToQdrant(changeId); // chat copy gets the combined text
  return { ok: true, title: composed.title, repairs: composed.repairs };
}

/** every card of a client (or one competitor) that is new or got a new signal */
async function writeDueCards(clientId, { competitorId, limit = 50 } = {}) {
  let q = supabase.from('competitor_changes').select('id')
    .eq('client_id', clientId).is('card_written_at', null).in('status', ['pending', 'verified']).eq('is_duplicate', false)
    .order('event_date', { ascending: false }).limit(limit);
  if (competitorId) q = q.eq('competitor_id', competitorId);
  const { data } = await q;
  const out = { written: 0, repaired: 0, failed: 0, notes: [] };
  for (const r of data || []) {
    const w = await writeCard(r.id).catch((e) => ({ ok: false, reason: e.message }));
    if (w.ok) {
      out.written++;
      if (w.repairs && w.repairs.length) { out.repaired++; out.notes.push(`${w.title}: ${w.repairs.join(', ')}`); }
    } else { out.failed++; out.notes.push(w.reason); }
  }
  if ((data || []).length) console.log(`[CI cards] ${clientId}: written ${out.written} (${out.repaired} needed a code repair), failed ${out.failed}`);
  return out;
}

module.exports = { writeCard, writeDueCards, composeCard, buildFacts };