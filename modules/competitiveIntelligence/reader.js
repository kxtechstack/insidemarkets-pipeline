/**
 * modules/competitiveIntelligence/reader.js
 *
 * STEP 2 of the daily news run: the AI READS one article and code CHECKS the answer.
 *
 *   - one article per AI call (tested: more accurate than many at once)
 *   - the AI sees all 39 signals with their definitions and picks ONE by number
 *   - the prompt text lives in public.prompts (id: ci_change_reader_v1), never in code
 *
 * Code then checks the AI's answer. If a check fails, the AI gets ONE more try
 * with the problem explained. Still wrong -> the article is dropped (with the reason logged).
 *   1. answer is valid JSON
 *   2. article is about THIS competitor and is a real action (not opinion / stock price / history)
 *   3. signal number exists, and the client has ticked that signal
 *   4. the "key facts" are really written in the article (no made-up facts)
 *   5. every number in the title / summary is really in the article
 *   6. a date: the event date, or the article date. Never "today" by default.
 */

const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../llmClient');
const { CI_MODULE_ID, LIMITS, PROMPTS } = require('./constants');
const { norm, clean } = require('./webTools');
// a title is never cut in the middle of a word: cut back to the last whole word
const cutTitle = (t, n = 160) => { const x = clean(t, 2000); return x.length <= n ? x : x.slice(0, n).replace(/\s+\S*$/, '').replace(/[\s,;:(\-–]+$/, ''); };
// is a short AI text English? (non-Latin script, or several little words of other languages = not English)
const OTHER_LANG_WORDS = /\b(el|los|las|con|y|para|del|sobre|una|com|não|em|les|des|et|une|pour|avec|sur|dans|de|du|aux|der|die|das|und|mit|für|zum|von|il|che|per|della|dan|yang|untuk|dengan|của|và|cho|lancia|lanza|resmikan|kehadirannya)\b/gi;
function aiTextEnglish(text) {
  const t = String(text || '');
  if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f]/.test(t)) return false;
  return (t.match(OTHER_LANG_WORDS) || []).length < 2;
}
const SUNSET_ANY = /discontinu|withdraw|phase[ds]? out|no longer (be )?(sold|available)|descatalog|dejar[aá] de (vender|fabricar)|retirad|deja de venderse|arr[eê]t|ne sera plus|fin de (la )?(commercialisation|production)|eingestellt|abgek[uü]ndigt|nicht mehr (erh[aä]ltlich|verf[uü]gbar)|fuori produzione|non sar[aà] pi[uù]|descontinuad|deixar[aá] de|販売終了|生産終了|終売|廃番|販売を終了|단종|판매 ?종료|停产|停售|下架|ng[uừ]ng (s[aả]n xu[aấ]t|b[aá]n|kinh doanh)|dihentikan/i;
// cut a long quote at the last whole word (never "to develop, bu")
const cutWords = (f, n) => { const t = clean(f, 5000); return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '').replace(/[\s,;:(]+$/, ''); };
const { parseLooseDate, brandMentions, isDateNotice, isMarketChatter } = require('./collector');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = () => supabase.schema('admin');

const IMPORTANCE = ['Critical', 'High', 'Medium', 'Low'];

// ---------------------------------------------------------------------
// Prompt (cached 5 minutes, so an edit in the database is used soon)
// ---------------------------------------------------------------------
let promptCache = { text: null, at: 0 };
async function getReaderPrompt() {
  if (promptCache.text && Date.now() - promptCache.at < 5 * 60 * 1000) return promptCache.text;
  const { data, error } = await supabase.from('prompts').select('prompt_template')
    .eq('id', PROMPTS.CHANGE_READER).eq('is_active', true).maybeSingle();
  if (error || !data || !data.prompt_template) {
    throw new Error(`Prompt '${PROMPTS.CHANGE_READER}' not found or not active in public.prompts (run sql/ci_004_reader_prompt.sql)`);
  }
  promptCache = { text: data.prompt_template, at: Date.now() };
  return data.prompt_template;
}

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));

// ---------------------------------------------------------------------
// The 39 signals, and which ones this client ticked
// ---------------------------------------------------------------------
/**
 * @returns {{all: Array<{n, id, name, definition, submodule_id, category, enabled}>, enabledCount, text}}
 */
async function loadSignals(clientId) {
  const [{ data: subs, error: e1 }, { data: sigs, error: e2 }, { data: ticked, error: e3 }] = await Promise.all([
    admin().from('submodules').select('id, submodule_name').eq('module_id', CI_MODULE_ID),
    admin().from('signals').select('id, signal_name, signal_definition, submodule_id').eq('module_id', CI_MODULE_ID),
    admin().from('client_signals').select('signal_id').eq('client_id', clientId).eq('is_enabled', true),
  ]);
  if (e1 || e2 || e3) throw new Error(`could not load CI signals: ${(e1 || e2 || e3).message}`);
  const subName = new Map((subs || []).map((s) => [s.id, s.submodule_name]));
  const tickedSet = new Set((ticked || []).map((t) => t.signal_id));
  const all = (sigs || [])
    .map((s) => ({
      id: s.id,
      name: s.signal_name,
      definition: s.signal_definition || '',
      submodule_id: s.submodule_id,
      category: subName.get(s.submodule_id) || '',
      enabled: tickedSet.has(s.id),
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    .map((s, i) => ({ ...s, n: i + 1 }));
  // 'Others' always last, so the AI checks every other signal first
  const others = all.find((s) => /^others$/i.test(s.name));
  if (others) {
    all.splice(all.indexOf(others), 1);
    all.push(others);
    all.forEach((s, i) => { s.n = i + 1; });
  }
  const text = all.map((s) => `${s.n}. ${s.name} [type: ${s.category}] - ${s.definition}`).join('\n');
  return { all, enabledCount: all.filter((s) => s.enabled).length, text };
}

// ---------------------------------------------------------------------
// Checks on the AI answer
// ---------------------------------------------------------------------
function parseJson(raw) {
  const s = String(raw || '').replace(/```(json)?/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

const squash = (s) => norm(s).replace(/[‘’“”"'`]/g, '').replace(/[^a-z0-9%.]+/g, ' ').trim();

/** Is this short quote really in the article? (exact, after removing case / accents / punctuation) */
function quoteInText(quote, normText) {
  const q = squash(quote);
  if (q.length < 8) return false;
  if (normText.includes(q)) return true;
  // long quotes: allow small differences, 85% of 5-word pieces must be there
  const w = q.split(' ');
  if (w.length < 10) return false;
  let hit = 0; let total = 0;
  for (let i = 0; i + 5 <= w.length; i += 5) { total++; if (normText.includes(w.slice(i, i + 5).join(' '))) hit++; }
  return total > 0 && hit / total >= 0.85;
}

// numbers with 2+ digits (prices, %, money, counts). '50ml' -> '50', '$1,250' -> '1250', '2.5bn' -> '2.5'
function numbersIn(s) {
  return [...String(s || '').matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => m[0].replace(/,/g, '').replace(/\.0+$/, ''))
    .filter((n) => n.replace('.', '').length >= 2);
}

/** Problems with the answer (empty list = good) */
const brandWordSet = (ctx) => new Set([ctx.comp.name, ctx.comp.search_name, ...(ctx.comp.aliases || [])].filter(Boolean).flatMap((n) => squash(n).split(' ')).filter((w) => w.length >= 4));
const looksEnglish = (t) => {
  const words = String(t).split(/\s+/).length || 1;
  return ((String(t).match(/\b(the|and|of|to|in|for|with|is|has|its)\b/gi) || []).length / words) > 0.08;
};

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Is this date really WRITTEN in the page text (e.g. "Oct. 22, 2026", "22 October 2026", "2026-10-22")? */
function dateWritten(text, iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const ab = MONTH_NAMES[m - 1].slice(0, 3);
  const t = String(text).toLowerCase();
  const re = [
    `${ab}[a-z]*\\.?\\s+(\\d{1,2}(st|nd|rd|th)?,?\\s+)?${y}`,
    `\\d{1,2}(st|nd|rd|th)?\\s+${ab}[a-z]*\\.?,?\\s+${y}`,
    `${y}[-/.]0?${m}[-/.]\\d{1,2}`,
    `\\d{1,2}[-/.]0?${m}[-/.]${y}`,
    `0?${m}[-/.]\\d{1,2}[-/.]${y}`,
  ];
  return re.some((r) => new RegExp(r).test(t));
}

function checkAnswer(ans, ctx) {
  const problems = [];
  if (!ans) return { problems: ['The answer was not valid JSON.'], fatal: false };
  if (ans.about_competitor === false) return { drop: `not about ${ctx.comp.name}: ${clean(ans.drop_reason, 150)}` };
  if (ans.real_action === false) {
    // the AI sometimes drops a real item with a reason about its own quotes / title / signal. That is not a real reason.
    // a headline that names the competitor and contains an action word is strong evidence: "no_announcement" is then probably wrong
    const headlineAction = /\b(announces?|launch(es|ed)?|enters? into|signs?|signed|acquires?|acquired|opens?|inaugurates?|appoints?|names?|wins?|won|reports?|secures?|completes?|files?|sues?|sued|settles?|raises?|cuts?|reaches|unveils?|introduces?|partners?|agreement)\b/i.test(ctx.itemTitle || '') && brandMentions(ctx.itemTitle || '', ctx.terms) > 0;
    const machinery = /\b(quotes?|signals?|titles?|match(es)?|direct(ly)?|plain words|states?|statements?|results?|not an action)\b/i.test(String(ans.drop_reason || ''))
      || (headlineAction && /no.?announcement/i.test(String(ans.drop_reason || '')));
    if (machinery && ctx.attempt === 1) {
      return { problems: ['You set real_action to false because of the quotes, the title or the signal. That is not a reason to drop an article. If the article reports something the competitor did or announced (results, a deal, a lawsuit, a launch, an opening...), set real_action to true, choose the best signal, and copy sentences that describe it. Use real_action false only for stock price news, opinion, history, job adverts, rumours, passing mentions or articles with no announcement.'] };
    }
    if (machinery && ctx.attempt === 2) return { rescue: true, drop: `not a real action: ${clean(ans.drop_reason, 150)}` };
    return { drop: `not a real action: ${clean(ans.drop_reason, 150)}` };
  }
  if (ans.about_competitor !== true || ans.real_action !== true) problems.push('"about_competitor" and "real_action" must be true or false.');

  const n = Number(ans.signal_number);
  let signal = ctx.signals.all.find((s) => s.n === n);
  // the AI sometimes picks a wrong number (off by one) but writes the right name: trust the name
  const byName = ans.signal_name ? ctx.signals.all.find((s) => squash(s.name) === squash(ans.signal_name)) : null;
  if (byName && (!signal || byName.n !== signal.n)) signal = byName;
  if (!signal) problems.push(`"signal_number" must be one number from 1 to ${ctx.signals.all.length}.`);

  const title = cutTitle(ans.title, 160);
  const summary = clean(ans.summary, 500);
  if (title.length < 10) problems.push('"title" is missing or too short.');
  // a title that is only the name (or the name plus one word) says nothing
  else if (title.split(/\s+/).length < (String(ctx.comp.name).split(/\s+/).length + 2)) problems.push('"title" must say what happened, not only the competitor name.');
  if (summary.length < 20) problems.push('"summary" is missing or too short.');
  // the dashboard is in English: title and summary must be English, whatever the article's language
  if (!aiTextEnglish(title) || !aiTextEnglish(summary)) problems.push('Write "title" and "summary" in ENGLISH (translate them), even when the article is in another language. Only key_facts stay in the article\'s language.');
  // "discontinues / withdraws" must be in the article itself (any language), never the AI's own idea
  if (/\b(discontinu\w*|withdr[ae]w\w*|stops? selling|phases? out)\b/i.test(`${title} ${summary}`) && !SUNSET_ANY.test(ctx.text || '')) {
    problems.push('Your title or summary says the product is discontinued or withdrawn, but the article does not say that. Describe only what the article says.');
  }

  if (isDateNotice(title)) return { drop: 'only gives the date of a results release or call - not news' };
  if (isMarketChatter(title)) return { drop: 'share-market talk (stock, analysts) - not an action by the company' };

  const facts = (Array.isArray(ans.key_facts) ? ans.key_facts : []).map((f) => cutWords(f, 300)).filter(Boolean);
  const factsFound = facts.filter((f) => quoteInText(f, ctx.normText));
  if (!factsFound.length) problems.push('"key_facts" must be copied word for word from the article. None of them were found in the article.');

  // the quotes must talk about what the title says (stops page menus / side lists being used as proof)
  if (ctx.attempt === 1 && ctx.isEnglish && factsFound.length && title) {
    const tw = [...new Set(squash(title).match(/[a-z]{5,}/g) || [])].filter((w) => !brandWordSet(ctx).has(w));
    const qt = squash(factsFound.join(' '));
    if (tw.length >= 2 && !tw.some((w) => qt.includes(w.slice(0, Math.max(4, w.length - 2))))) {
      problems.push('Your quotes do not talk about what your "title" says. The first quote must directly state the action in the title. If no quote does, set real_action to false.');
    }
  }

  // numbers: every number in title / summary must be in the article (years: the event year is fine too)
  const eventYear = String(new Date(ctx.publishedDate).getUTCFullYear());
  const textNumbers = new Set(numbersIn(ctx.text));
  const missing = [...new Set(numbersIn(`${title} ${summary}`))].filter((x) => !textNumbers.has(x) && x !== eventYear);
  if (missing.length) problems.push(`These numbers are not in the article: ${missing.join(', ')}. Use only numbers written in the article.`);

  // title and summary must not contain made-up words: most of their longer words must be in the article
  // (only checked for English articles - for other languages we cannot compare words)
  if (ctx.isEnglish) {
    for (const [label, str] of [['title', title], ['summary', summary]]) {
      const words = [...new Set(squash(str).match(/[a-z]{5,}/g) || [])].filter((w) => !brandWordSet(ctx).has(w));
      const absent = words.filter((w) => !ctx.normText.includes(w.slice(0, Math.max(4, w.length - 2))));
      if (words.length >= 4 && absent.length / words.length > 0.3) {
        problems.push(`Your "${label}" uses words that are not in the article (${absent.slice(0, 6).join(', ')}). Use only names and facts written in the article.`);
      }
    }
  }

  // the title must name the competitor (the chat finds changes by name)
  if (title && brandMentions(title, ctx.terms) === 0) problems.push(`"title" must start with the competitor name "${ctx.comp.name}".`);

  // the quotes must really show the action the signal claims (stops "discontinued" / "launched" being invented)
  // English article: the quotes must prove the signal. Other languages: the quotes are not English,
  // so the English title + summary are checked instead (they are written from the article)
  if (signal && (factsFound.length || !ctx.isEnglish)) {
    const proof = ctx.proofAll ? `${factsFound.join(' ')} ${title} ${summary}` : (ctx.isEnglish ? factsFound.join(' ') : `${title} ${summary}`);
    const must = [
      [/sunset/i, /discontinu|withdr[ae]w\w*\s+(\S+\s+){0,3}(products?|ranges?|lines?|shades?|items?|from (sale|the market|market|shelves))|pulled from (shelves|sale)|phase[ds]? out|no longer (be )?(sold|available|produced|made)|end(s|ed)? (the )?(sale|production)|stop(s|ped)? (selling|production|making)|retir/i, 'that a product is stopped or withdrawn'],
      [/new product launch|feature release/i, /launch|introduc|unveil|release|debut|rolls? out|now available|available (from|in|at|starting|now)|goes? on sale|new /i, 'that a product is launched'],
    ];
    must.push(
      [/\bAI\b|automation/i, /\bAI\b|artificial intelligence|automat|machine learning|robot|algorithm/i, 'AI or automation being used'],
      [/customer wins|customer win/i, /customer|client|contract|order|purchase|supply|signed|selected|awarded|\bwon\b|\blost\b|deal|agreement/i, 'a named customer ordering, signing or leaving'],
      [/partnership|alliance|collaborat/i, /partnership|collaborat|alliance|joint venture|teams? up|agreement|signed|licen[cs]|co-creat|deal|acquir|invest/i, 'a real deal or agreement between companies'],
      [/patents?\b|R&D/i, /patent|develop|invent|R&D|research|prototype|filed|unveil|launch|introduc|breakthrough|innovat/i, 'that something was developed, patented or researched'],
      [/lawsuit|dispute/i, /lawsuit|court|sue[sd]?\b|suing|damages|dispute|claim|ruling|judge|litigation|legal action|complaint|tribunal/i, 'a legal action'],
      [/award|certification/i, /award|won\b|wins?\b|recogni[sz]|certif|ranked|named|honou?r|prize|accredit/i, 'an award or certification'],
      // "Results & Publications" is only for the company's own numbers or reports (not a fine, a record, a project)
      [/rebrand/i, /rebrand|new (name|logo|identity|brand identity|visual identity)|renam|brand refresh|new look for the brand|redesign(s|ed)? (its|the) (logo|brand|packaging)/i, 'a new name, logo or brand identity'],
      [/advertis|campaign|marketing|sponsor|influencer|social/i, /advert|\bads?\b|campaign|marketing|sponsor|commercial|influencer|social media|ambassador|face of|\bmuses?\b|pop-?up|activation|\bfilm\b|billboard|promotion|promo\b/i, 'an advertising or marketing campaign'],
      [/restructuring|reorgani/i, /restructur|reorgani|spin[- ]?off|split (into|off)|layoffs?|consolidat|cost[- ]cutting|divest|new (unit|division|structure)/i, 'that the company changes how it is organised'],
      [/messaging shift|positioning|thought leadership/i, /messag|tagline|slogan|positioning|repositio|brand (story|platform|purpose|voice)|campaign|manifesto|thought leadership|white ?paper|report|study|survey|research/i, 'a new message, position or published point of view'],
      [/geographic|market entry|new market|expansion|new segment|vertical/i, /\bopen(s|ed|ing)?\b|\benter(s|ed|ing)?\b(?! into)|expan|\b(launch|debut|arriv)\w*\s+(in|into|across|throughout)\b|new (store|market|countr|city|region|office|plant|site|segment|category)|first .{0,30}(store|boutique|office|plant|shop|market)/i, 'entering a new place, market or segment'],
      [/free trial|freemium/i, /free trial|\btrial\b|freemium|free (plan|tier|version)/i, 'a free trial or free plan'],
      [/hiring surges|layoffs/i, /layoffs?|lay(s|ing)? off|job cuts?|cut(s|ting)? [\d,]+ (jobs|roles|staff)|hiring (spree|surge|drive)|recruit(ing|ment) drive|hir(e|es|ed|ing) [\d,]+|[\d,]+ (new )?(jobs|roles|positions)|workforce/i, 'many jobs being added or cut (not one person hired)'],
      [/results|publications/i, /results|revenue|net sales|\bsales\b|earnings|profit|net income|\bloss\b|quarter|\bQ[1-4]\b|fiscal|full[- ]year|guidance|outlook|forecast|backlog|EBITDA|per share|\bEPS\b|margin|annual report|sustainability report|impact report|investor presentation|financial (results|statements|report)/i, 'financial results or a report the company published'],
    );
    let movedByRule = false;   // a code rule chose the signal from the headline -> the headline is part of the proof
    if (/customer wins|customer win/i.test(signal.name) && /attorney general|regulator|regulatory|commission|commissioner|governor|settlement|settles|\bcourt\b|\bfines?\b|\bSCC\b|oversight/i.test(proof)) {
      const fb0 = ctx.signals.all.find((x) => /^company updates$/i.test(x.name));
      if (ctx.attempt >= 2 && fb0) signal = fb0;
      else problems.push('The signal "Major customer wins or losses" is only for a business customer. Regulators, governors, courts and settlements are not customers. Choose a legal or regulatory signal, or Company Updates.');
    }
    // non-English article said to stop a product: the ORIGINAL text must say so (the English summary is the AI's own words
    // and it can turn "launches" into "discontinues"). Words for "stopped / no longer sold" in common languages:
    if (/sunset/i.test(signal.name) && !ctx.isEnglish && !SUNSET_ANY.test(ctx.text || '')) {
      const fbS = ctx.signals.all.find((x) => /^new product launch/i.test(x.name)) || ctx.signals.all.find((x) => /^company updates$/i.test(x.name));
      if (ctx.attempt >= 2 && fbS) signal = fbS;
      else problems.push(`The article does not say that a product is stopped (no word like discontinued / descatalogado / arrêté / 販売終了 / 단종 / 停产). If it is a launch, choose "New product launches".`);
    }
    // a product that is BROUGHT BACK (relaunch, comeback, re-release) is a launch, not a sunset - even if the article
    // mentions that it was discontinued years ago. Works in every language for English articles; others keep the rule above.
    if (/sunset/i.test(signal.name)
      && /\bbr(ing|ings|ought) back\b|\bc(a|o)me back\b|\bcomeback\b|\bre-?releas\w*|\bre-?launch\w*|\breturns?\b|\breturning\b|\bre-?issu\w*|\brevival\b|\brevive[sd]?\b|\bback in (stock|stores|store)\b|\bis back\b|\bare back\b/i.test(`${title} ${summary} ${proof}`)
      && !/\b(no longer|will (be )?(stop|discontinu|end)|being (discontinued|phased out)|phas(e|es|ing) out)\b/i.test(`${title} ${proof}`)) {
      const fbL = ctx.signals.all.find((x) => x.enabled && /^new product launch/i.test(x.name)) || ctx.signals.all.find((x) => /^company updates$/i.test(x.name));
      if (fbL) signal = fbL;
    }
    // general bucket, but the headline clearly names the type -> that type (only types ticked for the client)
    if (isCatchAll(signal.name)) {
      const pickType = (catRe, nameRe) => ctx.signals.all.find((x) => x.enabled && catRe.test(x.category) && (!nameRe || nameRe.test(x.name)))
        || ctx.signals.all.find((x) => x.enabled && catRe.test(x.category) && !isCatchAll(x.name));
      const rules = [
        [/\b(wins?|won|awarded|receives?|named)\b.{0,60}\bawards?\b|\bawards? 20\d\d\b|\bbest of the best\b|\bcertifi(ed|cation)\b/i, /customer wins|reputation/i, /award|certif/i],
        [/\b(lawsuits?|sued|sues|suing|settlements?|court|fined|fines?|class action|litigation)\b/i, /regulatory|legal|compliance/i, /lawsuit|dispute|regulatory action/i],
        [/\b(loyalty|reward(s)? (program|programme|points)|double points|\d+x points|points with purchase|gift[s]?[- ]with[- ]purchase|\d{1,2}% (off|savings)|discounts?)\b/i, /pricing|promotion/i, /limited|promotion|loyalty|price/i],
      ];
      for (const [titleRe, catRe, nameRe] of rules) {
        if (!titleRe.test(title)) continue;
        const t = pickType(catRe, nameRe);
        if (t) { signal = t; movedByRule = true; }
        break;
      }
    }
    // general / partnership item whose headline is a campaign, ambassador, muse or pop-up -> marketing
    if ((isCatchAll(signal.name) || /partnership|alliance|tie-?up/i.test(`${signal.name} ${signal.category}`))
      && /\b(campaigns?|ambassadors?|face of|muses?|pop-?ups?|activations?|to promote|spokes(person|model|woman|man)|brand (film|mission film)|commercials?)\b/i.test(title)) {
      const mkC = ctx.signals.all.find((x) => x.enabled && /campaign|advertis|marketing/i.test(`${x.name} ${x.category}`));
      if (mkC) { signal = mkC; movedByRule = true; }
    }
    // "M&A" when a fund / investor only buys SHARES of the company -> not a deal by the company
    if (/acquisition|merger|m&a|funding|investment/i.test(`${signal.name} ${signal.category}`)
      && /\b(shares?|stocks?|investors?|portfolio|hedge fund|fund manager|equity research|holding(s)? in)\b/i.test(`${title} ${summary} ${proof}`)
      && !/\b(acquir\w*|merg\w*|takeover|buy(s|ing)? out|stake in (a|an|the)\b|invest\w* \S*\s*(million|billion|bn|m)\b)/i.test(`${summary} ${proof}`)) {
      problems.push('This is about investors buying or selling SHARES of the company, not about the company buying, selling or investing in something. Set real_action to false with drop_reason "share-market talk".');
    }
    // the summary must describe the action, not the article ("but there is no mention of a launch")
    if (/\b(no mention of|not mentioned|does not mention|doesn't mention|the article (does not|doesn't))\b/i.test(summary)) {
      problems.push('Your "summary" talks about what the article does not say. Write only what the company did.');
    }
    // a title that says what did NOT happen is not news
    if (/\b(not mentioned|no (new )?product|does not|did not|do not|is not a|are not)\b/i.test(title)) {
      problems.push('Your "title" says what did not happen. Write what the company DID, or set real_action to false if the article has no action by the company.');
    }
    // a "launch" that is really an advert, campaign, ambassador or event (no new product named) -> marketing
    if (/product launch|feature launch/i.test(signal.name)
      && /\b(campaigns?|ambassadors?|face of|night ?club|pop-?ups?|activations?|events?|festive campaign|film|short film|commercial)\b/i.test(title)
      && !/\b(new|launch\w*|introduc\w*|unveil\w*|debut\w*)\s+(\S+\s+){0,3}(fragrances?|perfumes?|scents?|serums?|creams?|collections?|ranges?|lines?|products?|shades?|lipsticks?|foundations?|palettes?|formulas?|kits?|sets?|models?|versions?|features?|apps?|services?)\b/i.test(`${title} ${summary}`)) {
      const mkL = ctx.signals.all.find((x) => x.enabled && /campaign|advertis|marketing/i.test(`${x.name} ${x.category}`));
      if (mkL) { signal = mkL; movedByRule = true; }
    }
    // an advert / campaign / sampling in a country is marketing, not entering that market (unless a store, office or plant opens)
    if (/geographic|market entry|new market|expansion/i.test(`${signal.name} ${signal.category}`)
      && /\b(campaign|advert\w*|ads?|sampling|promotion|influencer|activation|pop-?up)\b/i.test(`${title} ${summary} ${proof}`)
      && !/\b(store|boutique|office|plant|factory|warehouse|subsidiar\w*|branch|distribut\w*|e-?commerce|website|retailer)\b/i.test(`${summary} ${proof}`)) {
      const mk = ctx.signals.all.find((x) => x.enabled && /campaign|advertis|marketing/i.test(`${x.name} ${x.category}`));
      if (mk) { signal = mk; movedByRule = true; }
    }
    for (const [nameRe, wordRe, what] of must) {
      if (nameRe.test(signal.name) && !wordRe.test(movedByRule ? `${proof} ${title} ${summary}` : proof)) {
        const fb = ctx.signals.all.find((x) => /^company updates$/i.test(x.name));
        if (ctx.attempt >= 2 && fb && signal !== fb) { signal = fb; continue; }
        problems.push(`The signal "${signal.name}" needs a quote that says ${what} in plain words. None of your quotes say it. If the article does not say it, choose a better signal (for example Company Updates) or set real_action to false.`);
      }
    }
  }

  if (problems.length) return { problems };
  return { ok: true, signal, title, summary, facts: factsFound };
}

/** Event date: the AI's date if it is real and close to the article date, else the article date */
function pickEventDate(aiDate, publishedDate) {
  const pub = new Date(publishedDate);
  const ev = parseLooseDate(aiDate);
  if (!ev) return { date: pub.toISOString().slice(0, 10), from: 'article' };
  const evMs = new Date(ev).getTime();
  if (evMs > pub.getTime() + 2 * 864e5) return { date: pub.toISOString().slice(0, 10), from: 'article (event date was after the article)' };
  if (evMs < pub.getTime() - LIMITS.MAX_EVENT_AGE_DAYS * 864e5) return { old: true, date: ev.slice(0, 10) };
  return { date: ev.slice(0, 10), from: 'event' };
}

// ---------------------------------------------------------------------
// Main: read one article
// ---------------------------------------------------------------------
/**
 * @param item  collected article {url, title, text, publishedDate, section}
 * @param ctx   {client, comp, otherCompetitors, signals, terms}
 * @returns {{outcome: 'keep'|'dropped'|'failed', reason?, change?, ai?}}
 */
async function readArticle(item, ctx) {
  const tpl = await getReaderPrompt();
  const text = item.text.slice(0, LIMITS.ARTICLE_CHARS_FOR_AI);
  const vars = {
    today: new Date().toISOString().slice(0, 10),
    client_industry: ctx.client.industry || 'not given',
    client_country: ctx.client.country || 'not given',
    competitor: ctx.comp.name,
    competitor_other_names: [ctx.comp.search_name, ...(ctx.comp.aliases || []), ctx.comp.parent_group ? `part of ${ctx.comp.parent_group}` : null]
      .filter(Boolean).join(', ') || 'none',
    other_competitors: ctx.otherCompetitors.join(', ') || 'none',
    signals: ctx.signals.text,
    signal_count: ctx.signals.all.length,
    source_kind: { news: 'a news article', own_site: "a page on the competitor's own website", press: "the competitor's own press release", blog: "a post on the competitor's own blog" }[item.section] || item.section,
    article_title: item.title || '(no title)',
    article_url: item.url,
    article_date: item.publishedDate.slice(0, 10),
    article_text: text,
  };
  const messages = [{ role: 'user', content: fill(tpl, vars) }];
  const checkCtx = { ...ctx, text, normText: squash(text), publishedDate: item.publishedDate, isEnglish: looksEnglish(text), itemTitle: item.title };

  let ans = null;
  let verdict = null;
  let tries = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    tries = attempt;
    let raw;
    try {
      raw = await callLLM(messages, { temperature: 0, max_tokens: 700, timeout: 90000 });
    } catch (e) {
      return { outcome: 'failed', reason: `AI call failed: ${clean(e.message, 150)}` };
    }
    ans = parseJson(raw);
    // 3rd try: the news decision is already made, the AI only has to fill in the fields
    if (attempt === 3 && ans) { ans.real_action = true; ans.about_competitor = true; }
    verdict = checkAnswer(ans, { ...checkCtx, attempt });
    // optional: the stage-view script passes ctx.trace = [] to see every AI answer and what the code said about it
    if (Array.isArray(ctx.trace)) {
      ctx.trace.push({
        attempt,
        raw_answer: clean(raw, 4000),
        code_said: verdict.ok ? 'OK - answer passed all checks'
          : verdict.rescue ? `AI dropped it with a weak reason (${verdict.drop}) - asking again`
          : verdict.drop ? `DROP - ${verdict.drop}`
          : `PROBLEMS - ${(verdict.problems || []).join(' | ')}`,
      });
    }
    if (verdict.ok || (verdict.drop && !verdict.rescue)) break;
    if (attempt === 1) {
      messages.push({ role: 'assistant', content: clean(raw, 3000) });
      messages.push({ role: 'user', content: `Your answer has problems:\n- ${verdict.problems.join('\n- ')}\nIf the article really reports a launch, deal or other action, keep real_action true and choose the correct signal. Fix the problems and answer again with the JSON only.` });
    } else if (attempt === 2 && verdict.rescue) {
      messages.push({ role: 'assistant', content: clean(raw, 3000) });
      messages.push({ role: 'user', content: `Do not decide whether this is news. That is already decided: it IS a real action by ${ctx.comp.name}. Answer again with real_action true and ALL fields filled: the best signal (use Company Updates if nothing fits better), a title that starts with "${ctx.comp.name}", a summary, 1 to 3 quotes copied word for word from the article that describe what happened, event_date and importance. JSON only.` });
    } else {
      break;
    }
  }

  const aiInfo = ans ? {
    tries,
    text_chars: item.text.length,
    signal_number: ans.signal_number, importance: ans.importance, event_date: ans.event_date,
    about_competitor: ans.about_competitor, real_action: ans.real_action, also_involves: ans.also_involves,
  } : null;
  if (verdict.drop) return { outcome: 'dropped', reason: verdict.drop, ai: aiInfo };
  if (!verdict.ok) return { outcome: 'dropped', reason: `AI answer failed checks: ${verdict.problems.join(' ')}`.slice(0, 400), ai: aiInfo };

  const { title, summary, facts } = verdict;
  let { signal } = verdict;
  // a catch-all type ("Company Updates" / "Others") is often chosen when the AI did not look carefully.
  // Ask ONE more time with ONLY the real types; the code then checks the quotes really prove the new type.
  if (isCatchAll(signal.name)) {
    const better = await recheckCatchAll({ title, summary, facts, itemTitle: item.title }, ctx, ans, checkCtx);
    if (better) {
      if (aiInfo) aiInfo.relabelled = `${signal.name} -> ${better.name}`;
      signal = better;
    }
  }
  if (!signal.enabled) return { outcome: 'dropped', reason: `signal not ticked for this client: ${signal.name}`, ai: aiInfo };

  // own website / press site search: the date we have is often only the day we read the page,
  // so the event date must be a real date AND really written in the page text
  if ((item.section === 'own_site' || item.via === 'exa_site_search')
    && (!parseLooseDate(ans.event_date) || !dateWritten(text, parseLooseDate(ans.event_date)))) {
    return { outcome: 'dropped', reason: 'own-website page with no real date written on it (the date we have is only when we read it)', ai: aiInfo };
  }

  // results: the news is the day they were announced, not the end of the period they cover
  if (/result|earnings/i.test(signal.name)) ans.event_date = null;

  const ev = pickEventDate(ans.event_date, item.publishedDate);
  if (ev.old) return { outcome: 'dropped', reason: `old event (${ev.date}) - history, not news`, ai: aiInfo };

  let importance = IMPORTANCE.includes(ans.importance) ? ans.importance : 'Medium';
  if (/^others$/i.test(signal.name)) importance = 'Low';

  return {
    outcome: 'keep',
    ai: aiInfo,
    change: {
      signal,
      title,
      summary,
      importance,
      event_date: ev.date,
      event_date_from: ev.from,
      country: clean(ans.country, 80) || null,
      key_facts: facts,
      also_involves: Array.isArray(ans.also_involves) ? ans.also_involves.map((x) => clean(x, 80)).filter(Boolean) : [],
    },
  };
}

// ---------------------------------------------------------------------
// SECOND LOOK for catch-all types. Works for every client / industry: only the client's own signal list is used.
// ---------------------------------------------------------------------
const isCatchAll = (name) => /^(company updates|others?|general updates?)$/i.test(String(name || '').trim());
async function recheckCatchAll(read, ctx, ans, checkCtx) {
  const options = ctx.signals.all.filter((s) => !isCatchAll(s.name));
  if (!options.length) return null;
  const list = options.map((s) => `${s.n}. ${s.name} [type: ${s.category}] - ${s.definition}`).join('\n');
  const prompt = `A news item about the company ${ctx.comp.name}:\n`
    + `Headline: ${read.itemTitle || read.title}\nWhat happened: ${read.title}. ${read.summary}\n`
    + `Quotes from the article:\n- ${(read.facts || []).join('\n- ')}\n\n`
    + `It was put in the general bucket "Company Updates". Look again carefully. Which ONE of these types describes WHAT THE COMPANY DID?\n${list}\n\n`
    + 'Think about the action itself: opening a store, office, plant or website in a new country or city is an expansion; '
    + 'a new or changed product, version, range, collection or formula is a product launch; a deal with another company is a partnership; '
    + 'numbers about sales, profit or targets are results; an advert, campaign or event is marketing.\n'
    + 'Answer with the number only, for example: 12. Answer 0 only if NONE of the types fits.';
  let raw;
  try {
    raw = await callLLM([{ role: 'user', content: prompt }], { temperature: 0, max_tokens: 20, timeout: 30000 });
  } catch (e) {
    console.log(`[CI relabel] ${ctx.comp.name}: AI call failed - stays general`);
    return null; // AI down: keep the general type
  }
  const n = Number((String(raw || '').match(/\d+/) || [])[0]);
  const pick = options.find((s) => s.n === n);
  const tag = `[CI relabel] ${ctx.comp.name} | "${clean(read.title, 70)}"`;
  if (!pick) { console.log(`${tag}: AI answered "${clean(raw, 30)}" - stays general`); return null; }
  if (!pick.enabled) { console.log(`${tag}: AI picked "${pick.name}", not ticked for this client - stays general`); return null; }
  // the same proof rules as the first read. The proof is the quotes PLUS the checked title and summary
  // (the quotes were picked for the first type, so they often lack the word, e.g. "a serum used frozen" for a launch)
  const again = checkAnswer({ ...ans, signal_number: pick.n, signal_name: pick.name }, { ...checkCtx, attempt: 2, proofAll: true });
  // the checks may move it to a better type (e.g. a "launch" that is only a campaign -> marketing): keep that, unless it is general again
  const final = again.ok && again.signal && !isCatchAll(again.signal.name) && again.signal.enabled !== false ? again.signal : null;
  console.log(`${tag}: ${final ? `-> ${final.name}${final.n !== pick.n ? ` (AI said "${pick.name}")` : ''}` : `AI picked "${pick.name}" but the text does not prove it - stays general`}`);
  return final;
}

module.exports = { recheckCatchAll, dateWritten, loadSignals, readArticle, checkAnswer, quoteInText, numbersIn, pickEventDate, getReaderPrompt };