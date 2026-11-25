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
  const num = (id) => {
    if (!all[id]) return null;                      // never a source that is not a signal of this run
    if (!byId.has(id)) {
      const it = all[id];
      byId.set(id, list.length + 1);
      list.push({
        n: list.length + 1, source_id: id, module: it.module, module_name: MODULE_NAMES[it.module] || it.module,
        signal_id: it.signal_id, title: it.title, date: it.date, url: it.url || null,
        countries: it.countries || [], companies: it.companies || [],
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
  // the AI results first; the searches only when there is no AI result
  const done = ids.filter((id) => run.results[id] && run.results[id].status === 'done' && run.results[id].output);
  const ai = done.filter((id) => !SEARCHES.includes(run.results[id].capability));
  return ai.length ? ai : done;
}

function buildSections(run, workflow, book) {
  const sections = [];
  for (const id of resultRefs(run, workflow)) {
    const r = run.results[id];
    const o = r.output;
    const title = SECTION_TITLES[r.capability] || 'Findings';
    if (SEARCHES.includes(r.capability)) {
      const items = (o.items || []).map((it) => ({ title: it.title, module_name: MODULE_NAMES[it.module] || it.module, date: it.date, impact: it.impact || null, sources: book.nums([it.source_id]) }))
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
      const differences = (o.differences || []).map((d) => ({ text: d.text, kind: d.kind || 'interpretation', sources: book.nums(d.sources) })).filter((d) => d.sources.length);
      if (rows.length || differences.length) sections.push({ title, kind: 'table', sides, rows, differences, empty_sides: o.empty_sides || [] });
      continue;
    }
    if (Array.isArray(o.groups)) {
      const points = o.groups.map((g) => ({ text: `${g.name} (${g.sources.length} news items)`, kind: 'fact', sources: book.nums(g.sources) })).filter((p) => p.sources.length);
      if (points.length) sections.push({ title, kind: 'points', points });
    }
  }
  // 25 Nov (Step 10 report): "Forward outlook signals about sustainability"
  // showed the same news three times (three searches = three lists, "60 news
  // items" for 30). All the lists are one list, every signal once.
  const lists = sections.filter((x) => x.kind === 'list');
  if (lists.length > 1) {
    const seen = new Set();
    const items = lists.flatMap((x) => x.items).filter((it) => { const k = it.sources.join(); if (seen.has(k)) return false; seen.add(k); return true; });
    const merged = { title: lists[0].title, kind: 'list', from: lists.some((x) => x.from === 'retrieve_data') ? 'retrieve_data' : lists[0].from, items };
    return [merged, ...sections.filter((x) => x.kind !== 'list')];
  }
  return sections;
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
  for (const l of (evidence && evidence.limitations) || []) {
    let m = l.match(/^the search T\d+ "(.*)" found nothing$/);
    if (m) { out.push(`No news found for "${m[1]}"`); continue; }
    m = l.match(/^T\d+ \((\w+)\) did not finish: (\w+)/);
    if (m) { out.push(`The ${plainJob(m[1])} step did not finish (${m[2].replace('_', ' ')})`); continue; }
    m = l.match(/^T\d+ \((\w+)\) found nothing/);
    if (m && /nothing the AI wrote passed the checks/.test(l)) { out.push(`The ${plainJob(m[1])} step is left out: what the AI wrote did not pass the checks`); continue; }
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
    if (s.kind === 'list') for (const it of s.items) lines.push({ kind: 'fact', text: `${it.title} (${it.module_name}, ${it.date || 'no date'})`, sources: it.sources });
  }
  return lines.slice(0, 30).map((l, k) => ({ ...l, code: `P${k + 1}` }));
}
// code's own short answer: one plain sentence from the first point of each
// part (at most 3). 25 Nov (Step 10 report): it used to copy the point with
// its labels ("The news suggests: Ban on …: … (trend, 3 sources, …)") and a
// comparison row as "Saudi Arabia: … | United Arab Emirates: …".
function codeSummary(sections, nothing) {
  if (nothing) return ANSWER_TEXT.nothing_found;
  const lists = sections.filter((s) => s.kind === 'list');
  if (lists.length === sections.length) {
    const n = lists.reduce((a, s) => a + s.items.length, 0);
    return ANSWER_TEXT.list_intro.replace('{n}', String(n));
  }
  const lead = { fact: '', interpretation: 'The news suggests that ', hypothesis: 'One idea to test: ' };
  const sentence = (text, ns) => `${String(text).trim().replace(/[.;:,]+$/, '')} ${cites(ns)}.`;
  const out = [];
  for (const s of sections) {
    if (out.length >= 3) break;
    if (s.kind === 'points' && s.points.length) {
      const p = s.points[0];
      // a trend "Name: description" -> the description
      let t = p.trend ? p.text.replace(/^[^:]{1,120}: /, '') : p.text;
      if (lead[p.kind] && p.kind === 'interpretation') t = t.charAt(0).toLowerCase() + t.slice(1);
      out.push(sentence(`${lead[p.kind] || ''}${t}`, p.sources));
    }
    if (s.kind === 'table') {
      const row = s.rows.find((r) => r.cells.filter((c) => c.text).length >= 2) || s.rows.find((r) => r.cells.some((c) => c.text));
      if (row) {
        const parts = row.cells.map((c, k) => (c.text ? `${s.sides[k]}: ${c.text.replace(/[.;]+$/, '')}` : `${s.sides[k]}: ${ANSWER_TEXT.no_news_cell}`));
        out.push(sentence(`On ${row.point}, ${parts.join('; ')}`, [...new Set(row.cells.flatMap((c) => c.sources))].sort((a, b) => a - b)));
      } else if (s.differences.length) {
        out.push(sentence(`The news suggests that ${s.differences[0].text.charAt(0).toLowerCase()}${s.differences[0].text.slice(1)}`, s.differences[0].sources));
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
// (small fixed set of grammar words, not a topic list)
const GRAMMAR_WORDS = new Set(['with', 'that', 'this', 'from', 'have', 'been', 'also', 'into', 'their', 'they', 'these', 'those', 'which',
  'while', 'will', 'would', 'could', 'should', 'there', 'about', 'more', 'most', 'some', 'such', 'than', 'then', 'them', 'were', 'what',
  'when', 'where', 'other', 'over', 'very', 'based', 'news', 'limited', 'suggests', 'suggest', 'including', 'both', 'each', 'many', 'being']);
// one form for a word and its endings ("launched" / "launches" -> "launch",
// "acquired" / "acquires" -> "acquir", "companies" -> "company")
const stem = (w) => { const x = stemEnd(w); return x.length > 4 ? x.replace(/e$/, '') : x; };
const stemEnd = (w) => {
  if (w.length > 5 && /ies$/.test(w)) return w.replace(/ies$/, 'y');
  if (w.length > 5 && /(?:ss|x|z|ch|sh)es$/.test(w)) return w.replace(/es$/, '');
  if (w.length > 5 && /ing$/.test(w)) return w.replace(/ing$/, '');
  if (w.length > 5 && /ed$/.test(w)) return w.replace(/ed$/, '');
  if (w.length > 5 && /[^aeiou]es$/.test(w) && !/[^aeiou]ses$/.test(w)) return w.replace(/s$/, '');
  if (/[^s]s$/.test(w)) return w.replace(/s$/, '');
  return w;
};
const plainWords = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w.length >= 4 && !GRAMMAR_WORDS.has(w)).map(stem);
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
function checkSummary(text, book, points, question) {
  const problems = [];
  let t = cut(text, 1200);
  if (!t) return { ok: false, problems: ['empty answer'] };
  // the AI may name the points ([P1], [P2, P3]) or write [1, 3]: a point
  // number stands for that point's sources; [1, 3] = [1][3]
  t = t.replace(/\[((?:P?\d+)(?:\s*,\s*P?\d+)+)\]/gi, (m, list) => list.split(',').map((x) => `[${x.trim()}]`).join(''));
  t = t.replace(/\[P(\d+)\]/gi, (m, k) => { const p = points[Number(k) - 1]; return p ? cites(p.sources) : m; });
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
  const sentences = t.split(/(?<=(?:[a-z0-9%)\]]|[a-z]{2}\.|(?:^|[\s(])[A-Z]{2,})[.!?])\s+(?=["'A-Z])/).filter((x) => x.trim());
  const kept = [];
  for (const raw of sentences) {
    let sentence = raw.trim();
    const own = [...sentence.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    const unknown = own.filter((n) => !book.item(n));
    if (unknown.length) { problems.push(`taken out (source numbers that do not exist: ${[...new Set(unknown)].join(', ')}): ${cut(sentence, 120)}`); continue; }
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
    kept.push(sentence);
  }
  if (kept.length > 5) problems.push(`${kept.length} sentences: the first 5 kept`);
  const finalText = tidyCites(kept.slice(0, 5).join(' '));
  return { ok: kept.length > 0, problems, text: finalText };
}

// ── 6. The whole answer as text (markdown) ───────────────────────────────
function renderAnswer(summary, sections, confidence, limits, sources) {
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
  if (sources.length) {
    L.push('', `**${ANSWER_TEXT.sources_title}:**`);
    for (const s of sources) L.push(`[${s.n}] ${s.title} — ${s.module_name}, ${s.date || 'no date'}${s.url ? ` — ${s.url}` : ''}`);
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── The step ─────────────────────────────────────────────────────────────
async function generateAnswer(run, workflow, understood, request, options = {}) {
  const book = sourceBook(run);
  const sections = buildSections(run, workflow, book);
  const evidence = evidenceOf(run, workflow);
  const confidence = confidenceOf(evidence, sections);
  const limits = limitsOf(run, evidence);
  const points = pointsForAi(sections);
  const nothing = confidence.level === 'not_enough' || !points.length;
  // a list of the newest / highest-impact news (exact read) is answered by
  // code alone; a list found by meaning for a topic ("what did our
  // competitors launch") gets the short AI answer on top (25 Nov: the plain
  // list mixed launches with lawsuits and the user had to read all 20)
  const onlyLists = sections.length > 0 && sections.every((s) => s.kind === 'list' && s.from !== 'retrieve_data');
  const question = (understood && (understood.question_typed || understood.question_text)) || (request && request.original_query) || '';
  const check = { passed: null, problems: [] };
  let aiCalls = 0;
  let summary = codeSummary(sections, nothing);
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
        limits: limits.length ? limits.join('. ') : 'nothing',
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
        const res = checkSummary(text, book, points, question);
        check.problems.push(...res.problems);
        if (res.problems.length) check.ai_text = cut(text, 600);
        if (res.ok) { summary = res.text; summaryBy = 'ai'; check.passed = true; } else { check.passed = false; }
        break;   // a readable answer that fails the check is not asked again: code's answer is used
      }
    }
  }
  // the sources really used, in their order
  const usedNums = new Set([...summary.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  for (const s of sections) for (const x of [...(s.points || []), ...(s.items || []), ...(s.differences || []), ...(s.rows || []).flatMap((r) => r.cells)]) (x.sources || []).forEach((n) => usedNums.add(n));
  const sources = book.list.filter((s) => usedNums.has(s.n));

  const status = nothing ? 'nothing_found' : 'answered';
  const answerText = nothing
    ? renderAnswer(summary, [], confidence, limits, [])
    : renderAnswer(summary, sections, confidence, limits, sources);
  const out = {
    status, answer_text: answerText, summary, summary_by: summaryBy,
    sections: nothing ? [] : sections, confidence, limits, sources: nothing ? [] : sources,
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
