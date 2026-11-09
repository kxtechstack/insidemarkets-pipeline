/**
 * modules/competitiveIntelligence/shifts.js
 *
 * "STRATEGIC SHIFTS" - the top section of the Competitive Intelligence Overview tab.
 * Worked out by the BACKEND at the end of every run (called from activity.js) and SAVED; the screen only reads it.
 *
 *   1. Take the change types (categories) of the "Who is moving where" table, last 30 days.
 *   2. Leave out the general types (General Updates / Others / Company Updates).
 *   3. The 3 types with the most signals (same order as the table) = the 3 shifts.
 *   4. For each shift: ALL signals of that type in the last 30 days, from ALL competitors.
 *      The AI writes ONE title, ONE summary and the business impact for all of them together.
 *   5. Saved in public.competitor_strategic_shifts (sql/ci_017_strategic_shifts.sql), one row per rank (1, 2, 3).
 *
 * The AI is called only when the signals of a shift changed since the last run (signal_hash), to save cost.
 * Prompt: public.prompts id 'ci_shift_writer_v1' (editable later in the admin console).
 * Works for every client. Nothing is hardcoded.
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../llmClient');
const { clean, norm } = require('./webTools');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PROMPT_ID = 'ci_shift_writer_v1';
const TOP_N = Math.max(1, Number(process.env.CI_SHIFTS_TOP) || 3);
const MAX_SIGNALS_TO_AI = 25;
const GENERAL_TYPE = /^(general( updates?)?|others?|company updates?)$/i;
const RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const VAGUE = /\b(monitor|keep an eye|stay competitive|review (its|their|the) strategy|explore (this|the) opportunit|stay ahead|closely watch)\b/i;

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
function parseJson(raw) {
  const s = String(raw || '').replace(/```(json)?/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}
const numbersOf = (t) => (String(t || '').match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', '.'));
const sentences = (t) => String(t || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

async function getPrompt() {
  const { data } = await supabase.from('prompts').select('prompt_template').eq('id', PROMPT_ID).eq('is_active', true).maybeSingle();
  if (!data || !data.prompt_template) throw new Error(`Prompt '${PROMPT_ID}' not found or not active (run sql/ci_017_strategic_shifts.sql)`);
  return data.prompt_template;
}

/** read every row (Supabase gives max 1000 per call) */
async function readAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

/**
 * Write the AI text for one shift and check it. Never throws: a failed AI call gives a text built from the signals.
 */
async function writeShift(shift, client, profileText) {
  const sigs = shift.signals.slice(0, MAX_SIGNALS_TO_AI);
  const lines = sigs.map((s, i) => `${i + 1}. [${s.competitor}, ${s.sub_category}, ${s.date}] ${clean(s.title, 200)}\n   ${clean(s.summary, 400)}`);
  const signalsText = lines.join('\n');
  const vars = {
    client_name: client.name,
    client_industry: client.industry,
    client_country: client.country,
    client_profile: profileText,
    category: shift.category,
    window_from: shift.window_from,
    window_to: shift.window_to,
    competitors: shift.competitors.map((c) => `${c.competitor} (${c.signal_count})`).join(', '),
    signal_count: shift.signal_count,
    signals: signalsText,
  };
  let ans = null;
  try {
    const raw = await callLLM([{ role: 'user', content: fill(await getPrompt(), vars) }],
      { temperature: 0, max_tokens: 900, timeout: 90000, model: process.env.CI_CARD_MODEL || null });
    ans = parseJson(raw);
  } catch (e) {
    console.log(`[CI shifts] ${shift.category}: AI failed (${clean(e.message, 120)}) - text built from the signals`);
  }
  const a = ans || {};
  const allowed = new Set(numbersOf(signalsText));
  const okText = (t) => t && numbersOf(t).every((n) => allowed.has(n)) && !new RegExp(`\\b${norm(client.name).split(' ')[0]}\\b`, 'i').test(norm(t));

  // title
  let title = clean(a.title, 160);
  if (!okText(title) || title.split(/\s+/).length < 3) {
    title = `${shift.category}: ${shift.competitors.map((c) => c.competitor).slice(0, 4).join(', ')} - ${shift.signal_count} moves in 30 days`;
  }
  // summary: only good sentences; every competitor must be in it
  // a sentence about a tracked competitor that is NOT in this shift is wrong -> removed
  const inShift = new Set(shift.competitors.map((c) => norm(c.competitor).split(' ')[0]));
  const others = (shift.allCompetitors || []).map((n) => norm(n).split(' ')[0]).filter((w) => !inShift.has(w));
  let summary = sentences(a.summary).filter((s) => okText(s) && !/\b(the signals|according to|was reported)\b/i.test(s)
    && !others.some((w) => norm(s).includes(w))).join(' ');
  for (const c of shift.competitors) {
    const first = norm(c.competitor).split(' ')[0];
    if (!norm(summary).includes(first)) {
      const one = shift.signals.find((s) => s.competitor_id === c.competitor_id);
      if (one) {
        const t = clean(one.title, 160).replace(/[.]$/, '');
        summary = `${summary} ${norm(t).startsWith(first) ? t : `${c.competitor}: ${t}`}.`.trim();
      }
    }
  }
  // the first sentence must be the overall picture (the list shows it). If it is about ONE competitor only,
  // an overall sentence built from the facts is put in front.
  const firstS = sentences(summary)[0] || '';
  const namesIn = shift.competitors.filter((c) => norm(firstS).includes(norm(c.competitor).split(' ')[0])).length;
  if (shift.competitors.length > 1 && namesIn <= 1 && !/\b(competitors|rivals|players|brands|companies|several|multiple)\b/i.test(firstS)) {
    const names = shift.competitors.map((c) => c.competitor);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    summary = `${list} made ${shift.signal_count} moves in ${shift.category} in the last 30 days. ${summary}`;
  }
  summary = clean(summary, 1600);
  // business impact: one full sentence each, no vague advice
  let impact = (Array.isArray(a.business_impact) ? a.business_impact : [])
    .map((x) => clean(typeof x === 'string' ? x : (x && (x.point || x.text)) || '', 400))
    .filter((x) => x.split(/\s+/).length >= 8 && okText(x.split(client.name).join('')) && !VAGUE.test(x))
    .slice(0, 4);
  if (!impact.length) impact = [`What to check: how ${shift.competitors.map((c) => c.competitor).join(', ')}'s ${shift.category.toLowerCase()} compare with your own plans.`];
  return { title, summary, business_impact: impact, ai_ok: !!ans };
}

/**
 * Work out and save the strategic shifts of one client.
 * @param {string} clientId
 * @param {{day: string, from: string, typeRows: Array<{category, total_30d, sort_order}>, compName: Map}} ctx  from activity.js
 */
async function refreshShifts(clientId, ctx) {
  const { day, from, typeRows, compName } = ctx;
  const top = typeRows
    .filter((t) => t.total_30d > 0 && !GENERAL_TYPE.test(String(t.category || '').trim()))
    .sort((a, b) => a.sort_order - b.sort_order)
    .slice(0, TOP_N);

  if (!top.length) {
    await supabase.from('competitor_strategic_shifts').delete().eq('client_id', clientId);
    return [];
  }

  // all live signals of these types in the last 30 days
  const cats = top.map((t) => t.category);
  const cards = await readAll(() => supabase.from('competitor_changes_live')
    .select('id, category, importance').eq('client_id', clientId).in('category', cats).order('id'));
  const cardOf = new Map(cards.map((c) => [c.id, c]));
  const sigs = (await readAll(() => supabase.from('competitor_signals_live')
    .select('id, change_id, competitor_id, organization, signal_name, signal_title, summary, key_facts, event_date, published_date, url, source_domain, source_kind')
    .eq('client_id', clientId).order('id')))
    .filter((s) => cardOf.has(s.change_id) && compName.has(s.competitor_id))
    .map((s) => ({ ...s, date: String(s.event_date || s.published_date || '').slice(0, 10) }))
    .filter((s) => s.date && s.date >= from && s.date <= day);

  // client
  const { data: cl } = await supabase.schema('admin').from('clients').select('company_name, industry, location').eq('id', clientId).maybeSingle();
  const client = { name: (cl && cl.company_name) || 'the client', industry: (cl && cl.industry) || 'not given', country: (cl && cl.location) || 'not given' };
  let profileText = '- (no profile given)';
  try { profileText = (await require('./cardWriter').clientProfile(clientId)).text; } catch (e) { /* profile is optional */ }

  // what is saved now (to skip the AI when nothing changed)
  const { data: old } = await supabase.from('competitor_strategic_shifts').select('rank, category, signal_hash, title, summary, business_impact, written_at').eq('client_id', clientId);
  const oldByCat = new Map((old || []).map((o) => [o.category, o]));

  const stamp = new Date().toISOString();
  const rows = [];
  for (let i = 0; i < top.length; i++) {
    const cat = top[i].category;
    const list = sigs.filter((s) => cardOf.get(s.change_id).category === cat)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!list.length) continue;
    const comps = new Map();
    for (const s of list) {
      if (!comps.has(s.competitor_id)) comps.set(s.competitor_id, { competitor_id: s.competitor_id, competitor: compName.get(s.competitor_id), signal_count: 0 });
      comps.get(s.competitor_id).signal_count += 1;
    }
    const competitors = [...comps.values()].sort((a, b) => b.signal_count - a.signal_count);
    const importance = [...new Set(list.map((s) => cardOf.get(s.change_id).importance))]
      .sort((a, b) => (RANK[String(b || '').toLowerCase()] || 0) - (RANK[String(a || '').toLowerCase()] || 0))[0] || 'Medium';
    const shift = {
      category: cat,
      window_from: from,
      window_to: day,
      competitors,
      allCompetitors: [...compName.values()],
      signal_count: list.length,
      signals: list.map((s) => ({
        id: s.id, change_id: s.change_id, competitor_id: s.competitor_id, competitor: compName.get(s.competitor_id),
        sub_category: s.signal_name, title: s.signal_title, summary: s.summary, date: s.date,
        url: s.url, source_domain: s.source_domain, source_kind: s.source_kind,
        key_facts: Array.isArray(s.key_facts) ? s.key_facts : [],
      })),
    };
    const hash = crypto.createHash('sha1').update(list.map((s) => s.id).sort().join(',')).digest('hex');
    const prev = oldByCat.get(cat);
    let text;
    if (prev && prev.signal_hash === hash && prev.title) {
      text = { title: prev.title, summary: prev.summary, business_impact: prev.business_impact, written_at: prev.written_at };
    } else {
      text = { ...(await writeShift(shift, client, profileText)), written_at: stamp };
      console.log(`[CI shifts] ${clientId} #${i + 1} ${cat}: written (${list.length} signals, ${competitors.length} competitors)`);
    }
    rows.push({
      client_id: clientId,
      rank: i + 1,
      category: cat,
      title: text.title,
      summary: text.summary,
      business_impact: text.business_impact,
      importance,
      competitors,
      signal_count: list.length,
      card_count: new Set(list.map((s) => s.change_id)).size,
      latest_date: list[0].date,
      window_from: from,
      window_to: day,
      signals: shift.signals,
      signal_hash: hash,
      written_at: text.written_at,
      updated_at: stamp,
    });
  }

  if (rows.length) {
    const { error } = await supabase.from('competitor_strategic_shifts').upsert(rows, { onConflict: 'client_id,rank' });
    if (error) throw new Error(error.message);
  }
  await supabase.from('competitor_strategic_shifts').delete().eq('client_id', clientId).lt('updated_at', stamp);
  return rows.map((r) => ({ rank: r.rank, category: r.category, signals: r.signal_count, title: r.title }));
}

module.exports = { refreshShifts };