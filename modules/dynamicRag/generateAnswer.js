/**
 * modules/dynamicRag/generateAnswer.js
 *
 * STEP 10 of the Decision Intelligence chat: the answer the user reads.
 *
 * In plain words (Sneha OK 25 Nov):
 *   1. Code builds the answer from the checked points of Step 9 (no AI):
 *      one part per result (facts, comparison, trends, risks, gaps, ideas,
 *      groups, or the list of news), every point with its source numbers
 *      [1], [2] … and a numbered list of the sources (title, module, date,
 *      link) — only the sources that are really used.
 *   2. Nothing found (evidence "insufficient", or no point at all) -> no AI
 *      call: the answer says plainly that the client's news has nothing on
 *      this, and what was searched. Never a guess.
 *   3. A plain list (only searches, no AI job) -> no AI call: code writes
 *      the list.
 *   4. Otherwise ONE AI call (prompt DI – 13. Write the Answer,
 *      dynamic_rag_answer_v1) writes only the short direct answer at the
 *      top (2 to 5 sentences), from the numbered points, with the source
 *      numbers after every sentence. (A second call only if the first reply
 *      could not be read AND the question still has an AI call left.)
 *   5. Code checks that short answer: every sentence has a source number,
 *      every source number is real, no number (amount, %, year …) that is
 *      not in the points or their sources. If the check fails, code's own
 *      plain short answer is used instead — the failed one is never shown.
 *   6. Every answer ends with how good the evidence is (good / some / not
 *      enough), what was not found or not done, and the sources.
 *   7. The answer is saved in dr_messages (role assistant, the text in
 *      content, everything else in payload) for the chat history (Step 4).
 *   Language: English for now (the news is in English).
 *
 * @returns {
 *   status: 'answered' | 'nothing_found',
 *   answer_text,            the whole answer (markdown) shown to the user
 *   summary, summary_by,    the short direct answer; 'ai' or 'code'
 *   sections: [{ title, kind, points | rows | items, empty_headings? }],
 *   confidence: { level: 'good' | 'some' | 'not_enough', label },
 *   limits: [text],         what was not found / not done (never hidden)
 *   sources: [{ n, source_id, module, module_name, signal_id, title, date, url, countries, companies }],
 *   ai_calls, check: { passed, problems }
 * }
 */

const { ANSWER_PROMPT_ID, ANSWER_TEXT } = require('./chatConfig');
const workflowTools = require('./runWorkflow');

const MODULE_NAMES = { policy: 'Policy and Risk', market: 'Market Dynamics', outlook: 'Forward Outlook', competitor: 'Competitive Radar' };
const SECTION_TITLES = {
  extract_facts: 'Facts', summarise: 'Summary', compare: 'Comparison', cluster: 'Main groups of news',
  identify_patterns: 'Trends', identify_gaps: 'Gaps and unmet needs', discover_opportunities: 'Opportunities (ideas to test)',
  analyse_risks: 'Risks', retrieve_data: 'News found', structured_search: 'News found',
  // K: under an answer the AI wrote, the list is split in these two
  list_used: 'News used in the answer', list_other: 'Other news found',
};
const JOB_WORDS = {
  extract_facts: 'facts', summarise: 'summary', compare: 'comparison', cluster: 'grouping', identify_patterns: 'trends',
  identify_gaps: 'gaps', discover_opportunities: 'opportunities', analyse_risks: 'risks', retrieve_data: 'search',
  structured_search: 'search', validate_evidence: 'evidence check', forecast: 'forecast', filter_data: 'filter',
};
const KIND_WORDS = { interpretation: 'interpretation', hypothesis: 'idea to test' };
const SEARCHES = ['retrieve_data', 'structured_search'];

let saver = null;
/** Tests: a fake save (row) -> void. null = dr_messages. */
function useSaver(fn) { saver = fn; }
async function saveRow(row) {
  if (saver) return saver(row);
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { error } = await supabase.from('dr_messages').insert(row);
  if (error) throw new Error(error.message);
  return null;
}

const cut = (t, n) => { const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// ── 1. Sources: numbered in the order they are first used ────────────────
function sourceBook(run) {
  const all = run.sources || {};
  const list = [];
  const byId = new Map();
  // 26 Nov (dbcheck #28, #33): the same news saved twice (same link, two
  // titles) was listed as two sources. The same link = one source number.
  const byUrl = new Map();
  const urlKey = (u) => String(u || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[/#?]+$/, '');
  const num = (id) => {
    if (!all[id]) return null;                      // never a source that is not a signal of this run
    const key = urlKey(all[id].url);
    // (the other copy is kept on the source as same_link: never hidden)
    if (!byId.has(id) && key && byUrl.has(key)) {
      const n = byUrl.get(key);
      byId.set(id, n);
      const s = list[n - 1];
      if (s.source_id !== id && !s.same_link.includes(id)) s.same_link.push(id);
    }
    if (!byId.has(id)) {
      const it = all[id];
      if (key) byUrl.set(key, list.length + 1);
      byId.set(id, list.length + 1);
      list.push({
        n: list.length + 1, source_id: id, module: it.module, module_name: MODULE_NAMES[it.module] || it.module,
        signal_id: it.signal_id, title: it.title, date: it.date, url: it.url || null,
        // 27 Nov: the one news a click opens in its tab (a Competitive Radar
        // card: the article closest to the question; others: the signal)
        open_id: it.open_id || it.signal_id,
        // 27 Nov (Sneha, P): the card the news sits on, so the screen can
        // link to it like the old "Key Signals Leading to This Intelligence":
        // Forward Outlook -> its active trend, Market Dynamics -> its market
        // card; Policy and Competitive Radar news open as the signal itself
        card: it.group && it.group.id ? { kind: it.group.type === 'trend' ? 'trend' : 'market_card', id: it.group.id, name: it.group.name || null } : null,
        countries: it.countries || [], companies: it.companies || [], same_link: [],
      });
    }
    return byId.get(id);
  };
  const nums = (ids) => [...new Set((ids || []).map(num).filter(Boolean))].sort((a, b) => a - b);
  return { list, nums, item: (n) => all[list[n - 1] && list[n - 1].source_id] };
}
const cites = (ns) => ns.map((n) => `[${n}]`).join('');

// ── 2. The parts of the answer, from the results the evidence check read ──
function resultRefs(run, workflow) {
  const tasks = (workflow && workflow.tasks) || [];
  const check = tasks.find((t) => t.capability === 'validate_evidence');
  let ids = check ? [].concat(check.inputs.findings || []).map((r) => String(r).split('.')[0]) : [];
  if (!ids.length) ids = Object.keys(run.results || {}).filter((id) => run.results[id].capability !== 'validate_evidence');
  // 27 Nov (dbcheck #59 "Compare cosmetics rules in Indonesia and
  // Malaysia", L): the compare job ran, the summary was built from it, but
  // the plan's evidence check listed only the summary, so the side-by-side
  // table was never shown (it depends on the AI planner: sometimes shown,
  // sometimes not). A finished comparison is the main answer to "compare A
  // and B": it is always shown, first, listed or not (never twice). Other
  // jobs are shown only when listed, as before.
  const compares = Object.keys(run.results || {}).filter((id) => run.results[id].capability === 'compare');
  ids = [...compares, ...ids.filter((id) => !compares.includes(id))];
  // the AI results first; the searches only when there is no AI result
  const done = ids.filter((id) => run.results[id] && run.results[id].status === 'done' && run.results[id].output);
  const ai = done.filter((id) => !SEARCHES.includes(run.results[id].capability));
  return ai.length ? ai : done;
}

const LIST_TEXT_CHARS = 300;
const listText = (it) => (it.text ? workflowTools.cutAtWord(String(it.text), LIST_TEXT_CHARS) : null);

function buildSections(run, workflow, book) {
  const sections = [];
  const refs = resultRefs(run, workflow);
  // v79 E (27 Nov, sustainability): a comparison left with one side is not
  // shown when other parts are; it is skipped BEFORE its news get numbers
  // (built and dropped later, the Key Signals began at [4])
  const outOf = (id) => (run.results[id] && run.results[id].output) || {};
  const oneSide = (id) => Array.isArray(outOf(id).rows) && (outOf(id).sides || []).length < 2;
  const hasAny = (id) => ['findings', 'patterns', 'groups', 'items'].some((k) => (outOf(id)[k] || []).length > 0) || (Array.isArray(outOf(id).rows) && !oneSide(id) && outOf(id).rows.length > 0);
  const skipTable = new Set(refs.some(hasAny) ? refs.filter(oneSide) : []);
  for (const id of refs) {
    if (skipTable.has(id)) continue;
    const r = run.results[id];
    const o = r.output;
    const title = SECTION_TITLES[r.capability] || 'Findings';
    if (SEARCHES.includes(r.capability)) {
      const items = (o.items || []).map((it) => ({ title: it.title, module_name: MODULE_NAMES[it.module] || it.module, date: it.date, impact: it.impact || null, text: listText(it), sources: book.nums([it.source_id]) }))
        .filter((x) => x.sources.length);
      if (items.length) sections.push({ title, kind: 'list', from: r.capability, items });
      continue;
    }
    if (Array.isArray(o.findings)) {
      const points = o.findings.map((f) => ({
        text: f.text, kind: f.kind, heading: f.heading || null, level: f.level || null,
        why: f.why || f.why_it_matters || null, sources: book.nums(f.sources),
      })).filter((p) => p.sources.length);
      if (points.length || (o.empty_headings || []).length) sections.push({ title, kind: 'points', points, empty_headings: o.empty_headings || [] });
      continue;
    }
    if (Array.isArray(o.patterns)) {
      const points = o.patterns.map((p) => ({
        text: `${p.name}: ${p.description}`, kind: 'interpretation',
        trend: p.kind === 'trend' ? `trend, ${p.source_count} sources, ${p.first_date} to ${p.last_date}` : `one-off event, ${p.first_date || ''}`.trim(),
        sources: book.nums(p.sources),
      })).filter((p) => p.sources.length);
      if (points.length) sections.push({ title, kind: 'points', points });
      continue;
    }
    if (Array.isArray(o.rows)) {
      const sides = (o.sides || []).map((s) => s.label);
      const rows = o.rows.map((row) => ({ point: row.point, cells: sides.map((s) => { const c = row.cells[s] || { text: '', sources: [] }; return { text: c.text, sources: book.nums(c.sources) }; }) }));
      // the row made by code: how many news items each side's search found
      // (26 Nov: "which competitor is the busiest?" — the AI cannot count)
      if (Array.isArray(o.found) && o.found.length && rows.length) {
        const byLabel = new Map(o.found.map((f) => [f.label, f]));
        rows.push({ point: ANSWER_TEXT.compare_count_point, by_code: true, cells: sides.map((s) => {
          const f = byLabel.get(s);
          if (!f) return { text: '', sources: [] };
          return { text: `${f.count} news ${f.count === 1 ? 'item' : 'items'} found`, sources: book.nums(f.sources || []) };
        }) });
      }
      const differences = (o.differences || []).map((d) => ({ text: d.text, kind: d.kind || 'interpretation', sources: book.nums(d.sources) })).filter((d) => d.sources.length);
      if (rows.length || differences.length) sections.push({ title, kind: 'table', sides, rows, differences, empty_sides: o.empty_sides || [] });
      continue;
    }
    if (Array.isArray(o.groups)) {
      const points = o.groups.map((g) => ({ text: `${g.name} (${g.sources.length} news items)`, kind: 'fact', sources: book.nums(g.sources) })).filter((p) => p.sources.length);
      if (points.length) sections.push({ title, kind: 'points', points });
    }
  }
  // 27 Nov (Sneha, "full view of the EU cosmetics rules", fix 5): two jobs
  // of one kind (two summaries) gave two "Summary" parts with nearly the
  // same points. Parts of points with the same title are one part, and a
  // point whose words are all inside another point's (with its sources
  // inside the other's) is kept once, the longer one.
  {
    const byTitle = new Map();
    const one = [];
    for (const x of sections) {
      if (x.kind !== 'points') { one.push(x); continue; }
      const first = byTitle.get(x.title);
      if (!first) { const c = { ...x, points: [...x.points], empty_headings: [...(x.empty_headings || [])] }; byTitle.set(x.title, c); one.push(c); continue; }
      first.points.push(...x.points);
      first.empty_headings = [...new Set([...first.empty_headings, ...(x.empty_headings || [])])];
    }
    // v79 (Sneha, Indonesia entry, B): two opportunity steps wrote "Build a
    // halal-ready Indonesia product line before entry, with formulas ..." and
    // "Build a halal-ready Indonesia product line aligned with BPJPH
    // requirements before entry": not all words inside, other sources. Two
    // points under the same heading are the same when SAME_POINT_SHARE of the
    // shorter one's words (3+ letters) are in the other and they hold the
    // same numbers (two price cuts of other products never merge): the
    // longer one is kept, with the sources of both.
    const words = (p) => new Set(String(p.text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter((w) => w.length >= 3));
    const numsOf = (p) => (String(p.text || '').match(/\d+(?:[.,]\d+)?/g) || []).sort().join(' ');
    const same = (p, q) => {
      if ((p.heading || '') !== (q.heading || '') || numsOf(p) !== numsOf(q)) return false;
      const a = words(p);
      const b = words(q);
      const small = a.size <= b.size ? a : b;
      const big = small === a ? b : a;
      return small.size > 0 && [...small].filter((w) => big.has(w)).length / small.size >= SAME_POINT_SHARE;
    };
    for (const x of byTitle.values()) {
      const kept = [];
      for (const p of x.points) {
        const k = kept.findIndex((q) => same(p, q));
        if (k < 0) { kept.push(p); continue; }
        const both = [...new Set([...kept[k].sources, ...p.sources])].sort((m, n) => m - n);
        kept[k] = { ...(String(p.text).length > String(kept[k].text).length ? p : kept[k]), sources: both };
      }
      x.points = kept;
      x.empty_headings = x.empty_headings.filter((h) => !kept.some((p) => p.heading === h));
    }
    // v79 (Sneha, sustainability, E): our own side was not compared, the
    // table kept one column ("Competitors": 3 titles picked by date, not by
    // topic) while the summary already said it all. A table with one side
    // is shown only when it is the only part.
    const rest = one.filter((x) => !(x.kind === 'table' && (x.sides || []).length < 2));
    const hasContent = (x) => (x.points || x.rows || x.items || []).length > 0;
    sections.length = 0;
    sections.push(...(rest.some(hasContent) ? rest : one));
  }
  // 25 Nov (Step 10 report): "Forward outlook signals about sustainability"
  // showed the same news three times (three searches = three lists, "60 news
  // items" for 30). All the lists are one list, every signal once.
  // the same news twice in a list (same link = same source number) is listed once
  for (const x of sections) {
    if (x.kind !== 'list') continue;
    const seen1 = new Set();
    x.items = x.items.filter((it) => { const k = it.sources.join(); if (seen1.has(k)) return false; seen1.add(k); return true; });
  }
  const lists = sections.filter((x) => x.kind === 'list');
  if (lists.length > 1) {
    const seen = new Set();
    const items = lists.flatMap((x) => x.items).filter((it) => { const k = it.sources.join(); if (seen.has(k)) return false; seen.add(k); return true; });
    const merged = { title: lists[0].title, kind: 'list', from: lists.some((x) => x.from === 'retrieve_data') ? 'retrieve_data' : lists[0].from, items };
    return [merged, ...sections.filter((x) => x.kind !== 'list')];
  }
  return sections;
}

// 26 Nov (DI tab): the searches found news NAMING the company asked, but no
// point the AI wrote passed the checks, and the user read "nothing found".
// Then that news is shown as a list (code only, no AI): news a search kept
// to a company the data names (never a search by the words only), and news
// whose TITLE holds a rare word of the search (dbcheck "What are
// cosmetotextiles?": found at the top, the AI wrote facts with no source).
function namedLists(run, workflow, book) {
  const items = [];
  const seen = new Set();
  for (const t of (workflow && workflow.tasks) || []) {
    if (!SEARCHES.includes(t.capability)) continue;
    const r = run.results && run.results[t.task_id];
    if (!r || r.status !== 'done' || !r.output) continue;
    const byCompany = ((t.inputs && t.inputs.companies) || []).length > 0 && !/searched by the words only/.test(r.output.note || '');
    const titled = new Set(r.output.titled || []);
    if (!byCompany && !titled.size) continue;
    for (const it of r.output.items || []) {
      if (!byCompany && !titled.has(it.source_id)) continue;
      const sources = book.nums([it.source_id]);
      if (!sources.length || seen.has(it.source_id) || seen.has(sources.join())) continue;
      seen.add(it.source_id);
      seen.add(sources.join());
      items.push({ title: it.title, module_name: MODULE_NAMES[it.module] || it.module, date: it.date, impact: it.impact || null, text: listText(it), sources });
    }
  }
  return items.length ? [{ title: SECTION_TITLES.retrieve_data || 'News found', kind: 'list', from: 'named', items }] : [];
}

// ── 3. Evidence label and what was not found / not done ──────────────────
function evidenceOf(run, workflow) {
  const id = Object.keys(run.results || {}).find((k) => run.results[k].capability === 'validate_evidence');
  const r = id && run.results[id];
  return r && r.status === 'done' ? r.output : null;
}
function confidenceOf(evidence, sections) {
  const any = sections.some((s) => (s.points || s.rows || s.items || []).length);
  const status = evidence ? evidence.status : (any ? 'partial' : 'insufficient');
  const level = status === 'sufficient' ? 'good' : status === 'partial' ? 'some' : 'not_enough';
  return { level, label: ANSWER_TEXT.confidence[level] };
}
function limitsOf(run, evidence) {
  const out = [];
  const plainJob = (cap) => JOB_WORDS[cap] || cap;
  // 27 Nov (Sneha, Indonesia entry, fix 6): two opportunities steps ran, one
  // found ideas, one nothing; the answer showed ideas AND "The opportunities
  // step found nothing to report". A kind of step that found something is
  // not said to have found nothing.
  const hasContent = (o) => Boolean(o) && ['findings', 'patterns', 'rows', 'groups', 'items'].some((k) => Array.isArray(o[k]) && o[k].length > 0);
  const foundSome = new Set(Object.values(run.results || {}).filter((r) => r.status === 'done' && hasContent(r.output)).map((r) => r.capability));
  for (const l of (evidence && evidence.limitations) || []) {
    let m = l.match(/^the search T\d+ "(.*)" found nothing$/);
    if (m) { out.push(`No news found for "${m[1]}"`); continue; }
    m = l.match(/^T\d+ \((\w+)\) did not finish: (\w+)/);
    if (m) { out.push(`The ${plainJob(m[1])} step did not finish (${m[2].replace('_', ' ')})`); continue; }
    m = l.match(/^T\d+ \((\w+)\) found nothing/);
    if (m && /nothing the AI wrote passed the checks/.test(l)) { out.push(`The ${plainJob(m[1])} step is left out: what the AI wrote did not pass the checks`); continue; }
    if (m && foundSome.has(m[1])) continue;
    if (m) { out.push(`The ${plainJob(m[1])} step found nothing to report`); continue; }
    m = l.match(/^no news found for (.+?)( \(comparison side\))?$/);
    if (m) { out.push(`No news found for ${m[1].replace(/^\w+: /, '')}${m[2] ? ' (one side of the comparison)' : ''}`); continue; }
    out.push(l);
  }
  for (const r of Object.values(run.results || {})) {
    if (r.status === 'skipped') out.push(`The ${plainJob(r.capability)} step was not run (the AI calls for this question were used up)`);
    if (r.status === 'not_built') out.push(`The ${plainJob(r.capability)} step is not available yet`);
  }
  if (evidence && (evidence.conflicts || []).length) out.push(ANSWER_TEXT.conflicts);
  for (const r of Object.values(run.results || {})) {
    if (r.capability === 'compare' && r.status === 'done' && r.output && r.output.made_by === 'code') out.push(ANSWER_TEXT.compare_by_code);
    if (r.capability === 'compare' && r.status === 'done' && r.output && r.output.own_not_compared) out.push(ANSWER_TEXT.own_not_compared.split('{name}').join(r.output.own_not_compared));   // every {name} (27 Nov: the second stayed)
  }
  return [...new Set(out)];
}

// ── 4. The numbered points given to the AI (and code's own short answer) ──
function pointsForAi(sections) {
  const lines = [];
  const kindOf = (k) => (k === 'hypothesis' ? 'idea' : k || 'fact');
  for (const s of sections) {
    if (s.kind === 'points') for (const p of s.points) lines.push({ kind: kindOf(p.kind), text: `${s.title}: ${p.heading ? `${p.heading}: ` : ''}${p.text}${p.level ? ` (risk level ${p.level})` : ''}${p.why ? ` (${p.why})` : ''}${p.trend ? ` (${p.trend})` : ''}`, sources: p.sources });
    if (s.kind === 'table') {
      for (const row of s.rows) {
        const used = row.cells.filter((c) => c.text);
        if (used.length) lines.push({ kind: 'fact', text: `${s.title}, ${row.point}: ${row.cells.map((c, k) => `${s.sides[k]}: ${c.text || 'no news'}`).join(' | ')}`, sources: [...new Set(used.flatMap((c) => c.sources))].sort((a, b) => a - b) });
      }
      for (const d of s.differences) lines.push({ kind: kindOf(d.kind), text: `${s.title}, difference: ${d.text}`, sources: d.sources });
    }
    // 26 Nov (question bank, "shiseido new director"): the short answer saw
    // only the titles and wrote "the name of the new director is not
    // specified"; the text said "Ryoko Nagata". Each listed news item now
    // gives its text too (the start, LIST_TEXT_CHARS).
    if (s.kind === 'list') for (const it of s.items) lines.push({ kind: 'fact', text: `${it.title} (${it.module_name}, ${it.date || 'no date'})${it.text ? `: ${it.text}` : ''}`, sources: it.sources });
  }
  return lines.slice(0, 30).map((l, k) => ({ ...l, code: `P${k + 1}` }));
}
// code's own short answer: one plain sentence from the first point of each
// part (at most 3). 25 Nov (Step 10 report): it used to copy the point with
// its labels ("The news suggests: Ban on …: … (trend, 3 sources, …)") and a
// comparison row as "Saudi Arabia: … | United Arab Emirates: …".
// "2026-11-23" -> "23 Nov 2026"
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(d || ''); };
// 26 Nov: every search found nothing and its dates are after the newest
// news in the data -> say so (the dates, not a broken chat)
function datesGap(run, workflow) {
  const gaps = ((workflow && workflow.tasks) || []).filter((t) => SEARCHES.includes(t.capability)).map((t) => {
    const r = run.results && run.results[t.task_id];
    return r && r.status === 'done' && r.output && !r.output.items.length && r.output.newest_in_data
      ? { from: t.inputs.date_from, to: t.inputs.date_to || new Date().toISOString().slice(0, 10), newest: r.output.newest_in_data } : null;
  });
  if (!gaps.length || gaps.some((g) => !g)) return null;
  return { from: gaps.map((g) => g.from).sort()[0], to: gaps.map((g) => g.to).sort().pop(), newest: gaps.map((g) => g.newest).sort().pop() };
}
// "More targeted actives" -> "more targeted actives"; "AI ...", "Skims
// Beauty ...", "Shiseido ..." stay as they are
function smallFirstLetter(text) {
  const t = String(text || '');
  const first = (t.match(/^[A-Za-z]+/) || [''])[0];
  const asWord = first.length > 1 && first === first.charAt(0) + first.slice(1).toLowerCase();
  return asWord && workflowTools.isCommonWord(first) ? first.charAt(0).toLowerCase() + t.slice(1) : t;
}
// Said already: a sentence written before rests on at least half of this
// point's sources AND shares at least SAID_BEFORE_WORDS of its main words
// (the same news told twice in other words: "AI is set to speed product
// development ... [1][2][3][4]" and "AI is being used to ... launch products
// faster [1][2][3][5][15]"); or it shares SAID_BEFORE_SHARE of its main words.
const SAID_BEFORE_SHARE = 0.6;
const SAID_BEFORE_WORDS = 0.3;
function saidBefore(text, sources, said) {
  const words = (x) => new Set(workflowTools.plainWords(x));
  const mine = words(text);
  if (!mine.size) return false;
  const src = new Set(sources || []);
  return said.some((t) => {
    const theirs = words(t.text);
    let n = 0;
    for (const w of mine) if (theirs.has(w)) n += 1;
    const share = n / mine.size;
    const sameNews = src.size > 0 && [...src].filter((k) => t.sources.includes(k)).length * 2 >= src.size;
    return share >= SAID_BEFORE_SHARE || (sameNews && share >= SAID_BEFORE_WORDS);
  });
}
function codeSummary(sections, nothing, foundNews = false, named = false) {
  // 26 Nov (DI tab): "what is operation sindhoora" said "The searches below
  // found nothing" but the searches had found news, none of which answered
  // (the facts step kept nothing). Each case now says what really happened.
  if (nothing) return foundNews ? ANSWER_TEXT.nothing_answers : ANSWER_TEXT.nothing_found;
  const lists = sections.filter((s) => s.kind === 'list');
  if (lists.length === sections.length) {
    const n = lists.reduce((a, s) => a + s.items.length, 0);
    // 26 Nov (DI tab): "Here are the 1 news items" -> "Here is the 1 news item"
    if (n === 1) return named ? ANSWER_TEXT.named_list_intro_one : ANSWER_TEXT.list_intro_one;
    return (named ? ANSWER_TEXT.named_list_intro : ANSWER_TEXT.list_intro).replace('{n}', String(n));
  }
  // v88 (Sneha): no "The news suggests that ..." in the answer: it is written
  // about the topic itself (the part below still marks it an interpretation)
  const lead = { fact: '', interpretation: '', hypothesis: 'One idea to test: ' };
  const sentence = (text, ns) => `${String(text).trim().replace(/[.;:,]+$/, '')} ${cites(ns)}.`;
  const out = [];
  const said = [];
  for (const s of sections) {
    if (out.length >= 3) break;
    if (s.kind === 'points' && s.points.length) {
      // 27 Nov (DI tab, N2): the first point of Summary and of Trends said
      // the same thing twice; a point whose main words were mostly said
      // already gives its place to the next point of its part
      const textOf = (p) => (p.trend ? p.text.replace(/^[^:]{1,120}: /, '') : p.text);   // a trend "Name: description" -> the description
      const p = s.points.find((x) => !saidBefore(textOf(x), x.sources, said));
      if (!p) continue;
      let t = textOf(p);
      // 27 Nov (DI tab, N): "the news suggests that aI ...", "that skims
      // Beauty", "that shiseido": the first letter is made small only when
      // the first word is a common English word written as a word ("More",
      // "Skincare"), never a short form ("AI") or a name ("Shiseido")
      if (lead[p.kind] && p.kind === 'interpretation') t = smallFirstLetter(t);
      said.push({ text: t, sources: p.sources || [] });
      out.push(sentence(`${lead[p.kind] || ''}${t}`, p.sources));
    }
    if (s.kind === 'table') {
      const own = s.rows.filter((r) => !r.by_code);
      const row = own.find((r) => r.cells.filter((c) => c.text).length >= 2) || own.find((r) => r.cells.some((c) => c.text));
      if (row) {
        const parts = row.cells.map((c, k) => (c.text ? `${s.sides[k]}: ${c.text.replace(/[.;]+$/, '')}` : `${s.sides[k]}: ${ANSWER_TEXT.no_news_cell}`));
        out.push(sentence(`On ${row.point}, ${parts.join('; ')}`, [...new Set(row.cells.flatMap((c) => c.sources))].sort((a, b) => a - b)));
      } else if (s.differences.length) {
        out.push(sentence(String(s.differences[0].text).replace(/^\p{Ll}/u, (c) => c.toUpperCase()), s.differences[0].sources));
      }
    }
  }
  return out.join(' ');
}

// ── 5. Checking the AI's short answer ────────────────────────────────────
// every group of source numbers written once, in order: "[2][1][2]" -> "[1][2]"
const MAX_CITES = 6;
const tidyCites = (t) => t.replace(/(?:\[\d+\]\s*)+/g, (m) => `${cites([...new Set((m.match(/\d+/g) || []).map(Number))].sort((a, b) => a - b).slice(0, MAX_CITES))} `).replace(/\s+([.!?,;])/g, '$1').trim();
// 25 Nov (second Step 10 report): the AI mostly writes good sentences but
// WITHOUT source numbers (every AI answer failed the check). So code finds
// the sources itself: a sentence with no source number gets the sources of
// the points it is about (the points that share at least 2 of its words);
// a sentence that no point supports ("The company should be prepared to
// adapt") is taken out, never shown. A sentence with a number that is not
// in its sources, or a source number that does not exist, is taken out too.
// When nothing is left, code's own short answer is used.
// the words of a text (grammar words out, one form per word): shared with
// Step 9, which checks the sources of a point the same way (26 Nov)
const { plainWords } = workflowTools;
function pointsFor(sentence, points) {
  const sw = [...new Set(plainWords(sentence))];
  if (!sw.length) return [];
  return points.map((p) => {
    const pw = new Set(plainWords(p.text));
    const shared = sw.filter((w) => pw.has(w)).length;
    return { p, shared, score: shared / sw.length };
  }).filter((x) => x.shared >= 2 && x.score >= 0.25).sort((x, y) => y.shared - x.shared)
    // 25 Nov (playground): "Estée Lauder acquired Forest Essentials for $160
    // million" also got the two $210 million lawsuit items, which share only
    // "Estée Lauder" and "million". Only the points close to the best match
    // are its sources (at least 60% of the best one's shared words).
    .filter((x, k, all) => x.shared >= all[0].shared * 0.6)
    .slice(0, 3).map((x) => x.p);
}
function numbersIn(sentence, ns, book, points, question) {
  const bare = sentence.replace(/\[\d+\]/g, ' ');
  const nums = bare.match(/\d+(?:[.,]\d+)*%?/g) || [];
  const hay = [question, ...points.filter((p) => p.sources.some((n) => ns.includes(n))).map((p) => p.text),
    ...ns.filter((n) => book.item(n)).map((n) => { const it = book.item(n); return `${it.title} ${it.text} ${it.date}`; })]
    .join(' ').replace(/(\d),(\d)/g, '$1$2');
  // 25 Nov (third Step 10 report): "Lancôme launched 8 new products" — the
  // AI added 4 + 4 itself. In the answer EVERY number (also a small count)
  // must be in the sentence's sources or points.
  return nums.filter((x) => {
    const v = x.replace(/%$/, '').replace(/,/g, '');
    return !new RegExp(`(?<![\\d.])${v.replace(/\./g, '\\.')}(?![\\d])`).test(hay);
  });
}
// 26 Nov (question bank, "sugar cosmtics india funding amount"): the AI
// wrote "Lumière Beauty Group plans to raise Rs 100-105 crore" — the news
// says "the company" (Sugar Cosmetics). A sentence naming the client's own
// company is taken out when the question is not about us (no we / our /
// us / my, no client name) and none of its sources names the client.
const ABOUT_US = /\b(we|our|ours|ourselves|my)\b/i;
function ownNameIn(text, ownName) {
  if (!ownName) return false;
  const flat = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const t = ` ${flat(text)} `;
  const name = flat(ownName);
  if (name && t.includes(` ${name} `)) return true;
  // a word of the name that is not English ("Lumière") names it too
  if (workflowTools.rareWordsOf(ownName, {}, null).filter((w) => !w.includes(' ')).some((w) => t.includes(` ${w} `))) return true;
  // 27 Nov (fix 4): "lumiere" was read as an English word by its ending
  // ("-ere"), so "Lumière business risks" did not name us. A word of the name
  // past the most used English words (4+ letters) names it too.
  return name.split(' ').filter((w) => w.length >= 4 && !workflowTools.isCommonWord(w)).some((w) => t.includes(` ${w} `));
}
const questionAboutUs = (question, ownName) => ABOUT_US.test(String(question || '')) || /(^|[^A-Za-z])us([^A-Za-z]|$)/.test(String(question || '')) || ownNameIn(question, ownName);

const LIMIT_START_WORDS = 5;
// v88 (Sneha: "in every answer it says the news says, the news shows ... it
// should be normal"): the answer talks about the topic, never about the
// news. A sentence that only says the answer rests on few news is taken out
// (the evidence line below says it); "based on limited news" inside a
// sentence, "According to the news," and "The news shows that ..." at its
// start are taken out of it (small grammar sets).
const ABOUT_NEWS_ONLY = /^(?:this|the)\s+(?:answer|information|summary)\s+(?:is|rests)\s+(?:only\s+)?(?:based\s+)?on\s+(?:limited|few|a few)\s+news\b/i;
const NEWS_LEAD = /^(?:(?:according to|based on|from|in)\s+(?:the\s+)?(?:limited\s+)?(?:news|news items?|data),?\s+|(?:the|this|these)\s+news(?:\s+items?)?\s+(?:also\s+)?(?:shows?|says?|suggests?|indicates?|reports?|reveals?|states?|confirms?|highlights?|mentions?)\s+that\s+)/i;
const LIMITED_NEWS = /,?\s*(?:and\s+)?based on (?:limited|few|a few) news(?:\s+items?)?(?=[\s.,;\[]|$)/gi;
const SAME_POINT_SHARE = 0.7;
// v84 (Sneha, "list the tariff updates"): the user's OWN words ask for a
// list (not the goal the AI guessed): every news found is a Key Signal
const LIST_ASKED = /^\s*(?:please\s+|can you\s+|could you\s+)?(?:list|show(?:\s+me)?\s+(?:all|a list|the list)|give(?:\s+me)?\s+(?:all|a list|the list))\b/i;
// v84 (Sneha, tariffs: "... but this is not a cosmetics tariff update [4]"):
// a sentence that says it is not about the topic is not part of the answer
const NOT_ON_TOPIC = /\b(?:this|that|which|it)\s+(?:is|was)\s+not\s+(?:(?:a|an)\s+[\w\s-]{0,40}?\b(?:update|news|item|topic)\b|(?:related|relevant)\s+to\b|about\s+(?:the|this)\s+(?:question|topic)\b)/i;
const SUMMARY_MAX_CHARS = 1200;
const CODE_LIST_TEXT_MAX = 5;   // a list answered by code: up to this many news show their own summary
const BACK_WORDS = /^["']?(other|others|it|its|this|that|these|those|they|their|also|however|but|still|yet|instead|meanwhile|both)\b/i;
// 27 Nov (YSL "price changes in the UK", fix 1): the answer began "The news
// ALSO points to ...": a word that adds to something said before, a few
// words in. Leans back too (small grammar set).
const ADDED_WORDS = /^["']?(\S+\s+){1,3}(also|too|additionally|furthermore|further|again)\b/i;
function checkSummary(text, book, points, question, ownName = null, limits = []) {
  const usAsked = questionAboutUs(question, ownName);
  const problems = [];
  // v79 (Sneha, EU full view, C): a long answer was cut in the middle ("…").
  // It is cut after the last whole sentence within SUMMARY_MAX_CHARS.
  let t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (t.length > SUMMARY_MAX_CHARS) {
    const head = t.slice(0, SUMMARY_MAX_CHARS);
    const ends = [...head.matchAll(/[.!?](?:\s*\[[^\]]{1,12}\])*(?=\s|$)/g)];
    const last = ends.length ? ends[ends.length - 1] : null;
    t = last ? head.slice(0, last.index + last[0].length) : cut(t, SUMMARY_MAX_CHARS);
  }
  if (!t) return { ok: false, problems: ['empty answer'] };
  // the AI may name the points ([P1], [P2, P3]) or write [1, 3]: a point
  // number stands for that point's sources; [1, 3] = [1][3]
  t = t.replace(/\[((?:P?\d+)(?:\s*,\s*P?\d+)+)\]/gi, (m, list) => list.split(',').map((x) => `[${x.trim()}]`).join(''));
  t = t.replace(/\[P(\d+)\]/gi, (m, k) => { const p = points[Number(k) - 1]; return p ? cites(p.sources) : m; });
  // 27 Nov (fix 1): point codes written in the text ("based on P2:") are taken out
  t = workflowTools.withoutCodes(t, new Set(points.map((p, k) => p.code || `P${k + 1}`)));
  t = tidyCites(t);
  // "Sentence. [2]" -> "Sentence [2]." so each sentence keeps its numbers
  t = t.replace(/([.!?])\s*((?:\[\d+\]\s*)+)/g, (m, end, nums) => ` ${nums.trim()}${end} `).replace(/\s+/g, ' ').trim();
  // a sentence ends at . ! ? after a small letter, a number or a source
  // number, and the next one starts with a capital (25 Nov: "Renergie
  // H.P.N. 300 Peptide Cream" was cut into two sentences)
  // 25 Nov (playground): a sentence ending in a word in capitals ("… in the
  // GCC. The regulations …") was not split, so its first half was never
  // checked. A word of 2+ capitals ends a sentence too; one capital after a
  // dot ("H.P.N.", "U.S.") still does not.
  // 26 Nov (dbcheck #32): "Dr. Groot" was cut into two sentences. A dot the
  // NEWS itself writes inside a name ("Dr. Groot" in its sources) never ends
  // a sentence (the news decides, no list of short words).
  const newsText = [...new Set(points.flatMap((p) => p.sources))].map((k) => { const it = book.item(k); return it ? `${it.title} ${it.text || ''}` : ''; }).join(' ').toLowerCase().replace(/\s+/g, ' ');
  const KEEP = '\u2024';   // a one-dot leader: never a sentence end, put back below
  t = t.replace(/(\S+)\.\s+(\S+)/g, (m, a, b) => (newsText.includes(`${a}. ${b}`.toLowerCase()) ? `${a}${KEEP} ${b}` : m));
  const sentences = t.split(/(?<=(?:[a-z0-9%)\]]|[a-z]{2}\.|(?:^|[\s(])[A-Z]{2,})[.!?])\s+(?=["'A-Z])/).filter((x) => x.trim()).map((x) => x.split(KEEP).join('.'));
  const kept = [];
  let firstOut = false;
  for (const [index, raw] of sentences.entries()) {
    if (index === 1 && !kept.length) firstOut = true;
    let sentence = raw.trim();
    if (ABOUT_NEWS_ONLY.test(sentence)) { problems.push(`taken out (says only that the news is limited): ${cut(sentence, 120)}`); continue; }
    sentence = sentence.replace(LIMITED_NEWS, '').replace(/^,\s*/, '');
    if (NEWS_LEAD.test(sentence)) sentence = sentence.replace(NEWS_LEAD, '').replace(/^\p{Ll}/u, (c) => c.toUpperCase());
    // 27 Nov (Sneha, Indonesia entry, fix 2): the AI copied a line of what
    // was not found into the answer, cut and with sources that are not its
    // own ("No news found for "Indonesia cosmetics market attractiveness
    // ... dist" [1][2][3]"). A sentence that starts like a line of that list
    // (its first LIMIT_START_WORDS words) is taken out: the list is shown
    // under the answer anyway.
    const startOf = (x) => String(x).toLowerCase().replace(/\[\d+\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').slice(0, LIMIT_START_WORDS).join(' ');
    if ((limits || []).some((l) => startOf(l).split(' ').length >= LIMIT_START_WORDS && startOf(sentence) === startOf(l))) {
      problems.push(`taken out (copies a line of what was not found): ${cut(sentence, 120)}`);
      continue;
    }
    if (NOT_ON_TOPIC.test(sentence)) { problems.push(`taken out (says it is not about the topic): ${cut(sentence, 120)}`); continue; }
    let own = [...sentence.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    const unknown = own.filter((n) => !book.item(n));
    if (unknown.length) {
      // v85 (Sneha, dbcheck #57 "what is operation soundarya"): the AI wrote
      // the NUMBER OF A FACT it was shown as a source number ("... soaps,
      // and oils [1][5][8]": facts 5 and 8, one news [1]), and the whole
      // sentence was taken out. A number that is not a source but is a
      // fact's number stands for that fact's sources; any other wrong number
      // is left out. The sentence is taken out only when no right source is
      // left (as before).
      const valid = own.filter((n) => book.item(n));
      // v87 (dbcheck #57 again: "... safety standards [2][3]", only fact
      // numbers, no right one): with no right source, a fact's number still
      // stands for its sources when the sentence is about that fact (its
      // words, as for a sentence without numbers)
      const named = [...new Set(own.filter((n) => !book.item(n)).map((n) => points[n - 1]).filter(Boolean))];
      const about = valid.length ? named : pointsFor(sentence, named);
      const fixed = sentence.replace(/\[(\d+)\]/g, (m, k) => {
        const n = Number(k);
        if (book.item(n)) return m;
        const p = points[n - 1];
        return p && about.includes(p) ? cites(p.sources) : '';
      });
      const left = [...fixed.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      if (!left.length) { problems.push(`taken out (source numbers that do not exist: ${[...new Set(unknown)].join(', ')}): ${cut(sentence, 120)}`); continue; }
      problems.push(`source numbers that do not exist: ${[...new Set(unknown)].join(', ')} (a fact's number read as its sources, others left out): ${cut(sentence, 120)}`);
      sentence = tidyCites(fixed);
      own = left;
    }
    let ns = own;
    if (!ns.length) {
      const found = pointsFor(sentence, points);
      if (!found.length) { problems.push(`taken out (no point supports it): ${cut(sentence, 120)}`); continue; }
      ns = [...new Set(found.flatMap((p) => p.sources))].sort((a, b) => a - b);
      // at most 6 source numbers after a sentence (the best points' first;
      // every source is still in the parts and the list below)
      ns = [...new Set(found.flatMap((p) => p.sources))].slice(0, MAX_CITES).sort((a, b) => a - b);
      sentence = `${sentence.replace(/[.!?]+$/, '')} ${cites(ns)}.`;
    }
    const bad = numbersIn(sentence, ns, book, points, question);
    if (bad.length) { problems.push(`taken out (the number ${bad.join(', ')} is not in its sources): ${cut(sentence, 120)}`); continue; }
    if (ownName && !usAsked && ownNameIn(sentence, ownName) && !ns.some((k) => { const it = book.item(k); return it && ownNameIn(`${it.title} ${it.text || ''}`, ownName); })) {
      problems.push(`taken out (names ${ownName}, but the question is not about us and its news does not name it): ${cut(sentence, 120)}`);
      continue;
    }
    kept.push(sentence);
  }
  if (kept.length > 5) problems.push(`${kept.length} sentences: the first 5 kept`);
  const finalText = tidyCites(kept.slice(0, 5).join(' '));
  if (sentences.length === 1 && !kept.length) firstOut = true;
  // 27 Nov (dbcheck #49 on Hy4, halal deadline): the FIRST sentence (the
  // direct answer) was taken out, and the answer began "Other points say
  // ...". When the sentence that is now first points back to the one taken
  // out (it starts with a word like "Other", "It", "This", "However": a
  // small grammar set, BACK_WORDS), the AI answer is not used: code's answer
  // (the first point of each part) is, as when the whole check fails. A
  // first sentence taken out with the rest standing on its own ("The GCC
  // updated ...") still gives the AI answer without it.
  const leansBack = firstOut && kept.length > 0 && (BACK_WORDS.test(kept[0]) || ADDED_WORDS.test(kept[0]));
  if (leansBack) problems.push('the first sentence (the direct answer) was taken out and the next one leans on it, so the AI answer is not used');
  return { ok: kept.length > 0 && !leansBack, problems, text: finalText };
}

// ── 6. The whole answer as text (markdown) ───────────────────────────────
// 26 Nov (DI tab): sources are shown as the signal itself (title — tab,
// date), never as an outside web link; the screen opens the signal in its
// tab. withSources = false gives the answer without the Sources block (the
// screen draws its own clickable list from answer_details.sources).
function renderAnswer(summary, sections, confidence, limits, sources, withSources = true) {
  const L = [summary, ''];
  const kindTag = (k) => (KIND_WORDS[k] ? ` _(${KIND_WORDS[k]})_` : '');
  for (const s of sections) {
    L.push(`### ${s.title}`);
    if (s.kind === 'list') for (const it of s.items) L.push(`- ${it.title} — ${it.module_name}, ${it.date || 'no date'}${it.impact ? `, ${it.impact} impact` : ''} ${cites(it.sources)}`);
    if (s.kind === 'points') {
      const byHeading = new Map();
      for (const p of s.points) { const h = p.heading || ''; if (!byHeading.has(h)) byHeading.set(h, []); byHeading.get(h).push(p); }
      for (const [h, ps] of byHeading) {
        if (h) L.push(`**${h}**`);
        for (const p of ps) L.push(`- ${p.level ? `[${p.level}] ` : ''}${p.text}${p.why ? ` — ${p.why}` : ''}${p.trend ? ` (${p.trend})` : ''}${kindTag(p.kind)} ${cites(p.sources)}`);
      }
      for (const h of s.empty_headings || []) L.push(`**${h}**`, `- ${ANSWER_TEXT.no_news_for_heading}`);
    }
    if (s.kind === 'table') {
      L.push(`| | ${s.sides.join(' | ')} |`, `|---|${s.sides.map(() => '---').join('|')}|`);
      for (const row of s.rows) L.push(`| ${row.point} | ${row.cells.map((c) => (c.text ? `${c.text.replace(/\|/g, '/')} ${cites(c.sources)}` : ANSWER_TEXT.no_news_cell)).join(' | ')} |`);
      for (const d of s.differences) L.push(`- ${d.text}${kindTag(d.kind)} ${cites(d.sources)}`);
    }
    L.push('');
  }
  L.push(`**${ANSWER_TEXT.evidence_title}:** ${confidence.label}`);
  if (limits.length) { L.push('', `**${ANSWER_TEXT.limits_title}:**`); for (const l of limits) L.push(`- ${l}`); }
  if (sources.length && withSources) {
    L.push('', `**${ANSWER_TEXT.sources_title}:**`);
    // "[1] FORWARD OUTLOOK · Red Pantz ... — 2026-09-29" (the tab first, like the old cards)
    for (const s of sources) L.push(`[${s.n}] ${String(s.module_name || '').toUpperCase()} · ${s.title} — ${s.date || 'no date'}`);
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── The step ─────────────────────────────────────────────────────────────
// 26 Nov (question bank): a search kept to the client's own company finds
// nothing (the data is news about the market); the AI read that limit as a
// fact ("Lumière has no news items, so it may be missing opportunities").
// It stays in the list the user sees, but is not given to the AI.
function aiLimits(limits, run, workflow, ownName) {
  if (!ownName) return limits;
  const ownQueries = ((workflow && workflow.tasks) || []).filter((t) => {
    if (!SEARCHES.includes(t.capability)) return false;
    const cs = (t.inputs && t.inputs.companies) || [];
    const r = run.results && run.results[t.task_id];
    return cs.length > 0 && cs.every((n) => workflowTools.sameCompany(ownName, n)) && r && r.output && !(r.output.items || []).length;
  }).map((t) => t.inputs.query).filter(Boolean);
  return limits.filter((l) => !ownQueries.some((q) => l.includes(`"${q}"`)) && !l.includes(`${ownName} (one side of the comparison)`));
}

// 27 Nov (DI tab, K, "Give me compliance requirement in singapore"): the
// list under the answer held every Singapore news found, the answer's own
// sources and unrelated ones (Adampak, Singtel, SGX) mixed. Closeness cannot
// part them (the Sudan IV news the answer uses scored 0.26, Adampak 0.29).
// Under an answer the AI wrote, the list is split: the news the answer cites
// first, then the other news found. Nothing is hidden. A list with all or
// none of its news cited stays one list.
function splitUsedList(sections, summary) {
  const cited = new Set([...String(summary || '').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  if (!cited.size) return sections;
  return sections.flatMap((s) => {
    if (s.kind !== 'list') return [s];
    const used = s.items.filter((it) => it.sources.some((n) => cited.has(n)));
    const other = s.items.filter((it) => !it.sources.some((n) => cited.has(n)));
    if (!used.length || !other.length) return [s];
    return [{ ...s, title: SECTION_TITLES.list_used, items: used }, { ...s, title: SECTION_TITLES.list_other, items: other }];
  });
}
async function generateAnswer(run, workflow, understood, request, options = {}) {
  const book = sourceBook(run);
  let sections = buildSections(run, workflow, book);
  const hasContent = (x) => (x.points || x.rows || x.items || []).length > 0;
  const named = !sections.some(hasContent) ? namedLists(run, workflow, book) : [];
  if (named.length) sections = named;
  const evidence = evidenceOf(run, workflow);
  // the named news is real but no point was checked: "some evidence"
  const confidence = named.length ? { level: 'some', label: ANSWER_TEXT.confidence.some } : confidenceOf(evidence, sections);
  // 27 Nov (Sneha, fix 4): "No news found for "Lumière business risks
  // Indonesia"" was shown in 4 answers: the data is news about the market,
  // a search for the client's own name finds nothing, and the user read it
  // as a failure. Such a line is not shown (kept in check.hidden_limits).
  const ownNameA = understood && understood.client && understood.client.company_name;
  const allLimits = limitsOf(run, evidence);
  const ownSearch = (l) => { const m = String(l).match(/^No news found for "(.*)"/); return Boolean(m && ownNameA && ownNameIn(m[1], ownNameA)); };
  const limits = allLimits.filter((l) => !ownSearch(l));
  const points = pointsForAi(sections);
  const nothing = confidence.level === 'not_enough' || !points.length;
  // a list of the newest / highest-impact news (exact read) is answered by
  // code alone; a list found by meaning for a topic ("what did our
  // competitors launch") gets the short AI answer on top (25 Nov: the plain
  // list mixed launches with lawsuits and the user had to read all 20)
  const onlyLists = named.length > 0 || (sections.length > 0 && sections.every((s) => s.kind === 'list' && s.from !== 'retrieve_data'));
  const question = (understood && (understood.question_typed || understood.question_text)) || (request && request.original_query) || '';
  const check = { passed: null, problems: [] };
  if (allLimits.length !== limits.length) check.hidden_limits = allLimits.filter(ownSearch);
  let aiCalls = 0;
  const foundNews = Object.keys((run && run.sources) || {}).length > 0;
  let summary = codeSummary(sections, nothing, foundNews, named.length > 0);
  const gap = nothing ? datesGap(run, workflow) : null;
  if (gap) summary = ANSWER_TEXT.nothing_in_dates.replace('{from}', dayText(gap.from)).replace('{to}', dayText(gap.to)).replace('{newest}', dayText(gap.newest));
  let summaryBy = 'code';

  // the AI writes only the short answer, when there is something to say
  // and the points are not a plain list
  const callsLeft = options.aiCalls != null ? options.aiCalls
    : run.ai ? Math.min(2, Math.max(0, run.ai.budget - run.ai.used) + (run.ai.kept_for_answer || 0)) : 1;
  if (!nothing && !onlyLists && callsLeft > 0) {
    const template = await workflowTools.readPromptText(ANSWER_PROMPT_ID);
    if (!template) {
      check.problems.push(`the prompt ${ANSWER_PROMPT_ID} is missing or switched off in the prompts table`);
    } else {
      const u = understood || {};
      const c = u.client || {};
      const vars = {
        client: c.company_name ? `${c.company_name}${c.industry ? ` (${c.industry} industry)` : ''}` : 'the client',
        question, today: new Date().toISOString().slice(0, 10),
        points: points.map((p) => `[${p.code}] (${p.kind}) ${cut(p.text, 400)} ${cites(p.sources)}`).join('\n'),
        confidence: { good: 'good evidence', some: 'some evidence', not_enough: 'not enough evidence' }[confidence.level],
        limits: aiLimits(limits, run, workflow, c.company_name).join('. ') || 'nothing',
      };
      const messages = [{ role: 'user', content: workflowTools.fillVars(template, vars) }];
      for (let k = 0; k < callsLeft && k < 2; k++) {
        aiCalls += 1;
        let reply;
        try {
          reply = await workflowTools.callAiText(messages, { temperature: k === 0 ? 0 : 0.3, max_tokens: 500, timeout: 40000, maxRetries: 2 });
        } catch (err) {
          check.problems.push(`AI call failed: ${cut(err.message, 150)}`);
          break;
        }
        const parsed = workflowTools.readReplyText(reply);
        const text = parsed && typeof parsed.answer === 'string' ? parsed.answer : null;
        if (!text) { check.problems.push(`reply not readable: ${cut(reply, 200)}`); continue; }   // asked again only if a call is left
        const res = checkSummary(text, book, points, question, understood && understood.client && understood.client.company_name, limits);
        check.problems.push(...res.problems);
        if (res.problems.length) check.ai_text = cut(text, 600);
        if (res.ok) { summary = res.text; summaryBy = 'ai'; check.passed = true; } else { check.passed = false; }
        break;   // a readable answer that fails the check is not asked again: code's answer is used
      }
    }
  }
  if (summaryBy === 'ai') sections = splitUsedList(sections, summary);
  // the sources really used, in their order
  const usedNums = new Set([...summary.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  for (const s of sections) for (const x of [...(s.points || []), ...(s.items || []), ...(s.differences || []), ...(s.rows || []).flatMap((r) => r.cells)]) (x.sources || []).forEach((n) => usedNums.add(n));
  const sources = book.list.filter((s) => usedNums.has(s.n));
  // 27 Nov (Sneha, Shiseido "loyalty points offer", fix 2): the screen showed
  // the same news three times: "News used in the answer", "Other news found"
  // and the Key Signals list (all 20; the answer used 2). Under an answer the
  // AI wrote, the screen's Key Signals are the news the answer cites (and
  // the news of its other parts); the rest of the list is other_sources (the
  // screen shows it as one closed line), and the body has no list. An
  // answer by code (a list asked for: "latest policy news in the UK") keeps
  // its list as before. The saved answer text keeps everything (nothing
  // hidden). Not by the goal the AI guessed (v74: "Shiseido loyalty points
  // offer" was guessed a list question and kept all 20).
  const listOnScreen = summaryBy !== 'ai';
  const screenNums = new Set([...summary.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  for (const s of sections) {
    if (s.kind === 'list' && !listOnScreen) continue;
    for (const x of [...(s.points || []), ...(s.items || []), ...(s.differences || []), ...(s.rows || []).flatMap((r) => r.cells)]) (x.sources || []).forEach((n) => screenNums.add(n));
  }
  const listAsked = LIST_ASKED.test(String(question || ''));
  const keySources = listOnScreen || listAsked ? [...sources] : sources.filter((x) => screenNums.has(x.n));
  const otherSources = listOnScreen || listAsked ? [] : sources.filter((x) => !screenNums.has(x.n));
  // a list asked for by the user: newest first
  if (listAsked && !listOnScreen) keySources.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || a.n - b.n);
  // v76 (Sneha): an answer by code ("latest policy news in the UK") showed
  // its 19 news twice, as "News found" and as the Key Signals rows. The
  // Key Signals rows hold every one of them (clickable), so the screen
  // never shows a list section; the saved answer text keeps it.
  const screenSections = sections.filter((x) => x.kind !== 'list');

  // v81 (Sneha, "list recent news about loreal", 3): the Key Signals read
  // [1]…[8], [13], [18]: numbers were given to all news found, the screen
  // shows the ones used. The news are numbered again: the Key Signals
  // [1]…[k] with no gap, the other news after them; every [n] follows.
  const order = [...keySources, ...otherSources];
  const newN = new Map(order.map((x, k) => [x.n, k + 1]));
  const re = (n) => newN.get(n) || n;
  const reText = (t) => String(t).replace(/\[(\d+)\]/g, (m, n) => (newN.has(Number(n)) ? `[${re(Number(n))}]` : m));
  const reNums = (ns) => (ns || []).map(re).sort((a, b) => a - b);
  summary = reText(summary);
  for (const sec of sections) {
    for (const x of [...(sec.points || []), ...(sec.items || []), ...(sec.differences || [])]) x.sources = reNums(x.sources);
    for (const row of sec.rows || []) for (const c of row.cells) c.sources = reNums(c.sources);
  }
  for (const x of order) x.n = re(x.n);
  sources.sort((a, b) => a.n - b.n);
  keySources.sort((a, b) => a.n - b.n);
  otherSources.sort((a, b) => a.n - b.n);
  if (listAsked) check.list_asked = true;
  // v81 (Sneha, "any news on kanufresh?", 2): an answer by code said "Here
  // is the 1 news item ..." and nothing else (its list is the Key Signals
  // rows, titles only). A list of up to CODE_LIST_TEXT_MAX news shows each
  // news' own short summary, word for word from the news (no AI).
  let screenSummary = summary;
  if (summaryBy !== 'ai' && !nothing) {
    const items = sections.filter((x) => x.kind === 'list').flatMap((x) => x.items);
    if (items.length && items.length <= CODE_LIST_TEXT_MAX && items.some((it) => it.text)) {
      screenSummary = [summary, ...items.map((it) => `**${it.title}** (${it.date || 'no date'})${it.text ? `: ${String(it.text).trim()}` : ''} ${cites(it.sources)}`)].join('\n\n');
    }
  }
  const status = nothing ? 'nothing_found' : 'answered';
  const answerText = nothing
    ? renderAnswer(summary, [], confidence, limits, [])
    : renderAnswer(summary, sections, confidence, limits, sources);
  // the answer for the screen: no Sources block, and every source number a
  // link the screen opens as that signal ("[2]" -> "[[2]](#source-2)")
  const body = (nothing ? answerText : renderAnswer(screenSummary, screenSections, confidence, limits, keySources, false))
    .replace(/\[(\d+)\](?!\()/g, (m, n) => (keySources.some((x) => x.n === Number(n)) ? `[[${n}]](#source-${n})` : m));
  const out = {
    status, answer_text: answerText, body, summary, summary_by: summaryBy,
    sections: nothing ? [] : sections, confidence, limits, sources: nothing ? [] : keySources,
    other_sources: nothing ? [] : otherSources,
    ai_calls: aiCalls, check,
  };
  if (options.save !== false && request && request.conversation_id) out.saved = await saveAnswer(request, status, answerText, out);
  return out;
}

// Every reply of the chat (an answer, a reject, a question back, a refused
// plan) is saved as the assistant message of the question. A save that
// fails never breaks the reply (recorded).
async function saveAnswer(request, status, content, payload) {
  try {
    await saveRow({
      request_id: request.request_id, conversation_id: request.conversation_id,
      client_id: request.client_id, user_id: request.user_id,
      role: 'assistant', content, payload: { status, ...(payload && typeof payload === 'object' ? payload : {}) },
    });
    return true;
  } catch (err) {
    console.log(`[DynamicRAG] saving the answer failed: ${err.message}`);
    return false;
  }
}

module.exports = { generateAnswer, saveAnswer, useSaver, checkSummary, sourceBook, codeSummary };
