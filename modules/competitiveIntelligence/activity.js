/**
 * modules/competitiveIntelligence/activity.js
 *
 * "Who is moving where" - worked out HERE in the backend at the END of every run, then SAVED,
 * so the screen only reads ready rows (fast, no counting on the screen or in a database view).
 *
 * What it counts: live signals (news items) of live cards, per competitor + change type (the card's category).
 * Date of a signal = event date, else article date.
 *
 *   today (India date) = Nov 6
 *   this window   = same day last month .. today          -> Oct 6 .. Nov 6
 *   before window = same day 2 months ago .. day before   -> Sep 6 .. Oct 5
 *
 * Saved in 2 tables (sql/ci_016_who_is_where_tables.sql):
 *   competitor_activity_live        one row per competitor + type (+ one 'All' row per competitor)
 *       count_30d       signals in this window            -> number in the block
 *       prev_count_30d  signals in the before window
 *       change_30d, trend ('up' | 'down' | 'same')
 *       count_total     all signals up to today
 *       badge_level     colour of the block, compared with this client's busiest block (highest count_30d):
 *                         0 -> 'none', up to 1/3 -> 'low' (green), up to 2/3 -> 'medium' (orange), above -> 'high' (red)
 *   competitor_activity_type_totals one row per type (the Total column)
 *       total_30d, total_prev_30d, trend, sort_order (biggest total first, then A-Z)
 *   competitor_strategic_shifts     the top section: top 3 types (no General Updates), see shifts.js
 *
 * Works for every client. Nothing is hardcoded.
 */
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PAGE = 1000;

/** today's date in India, 'YYYY-MM-DD' */
const indiaToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

/** same day N months earlier; a day that does not exist moves to the month's last day (Mar 31 -> Feb 28) */
function monthsBack(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 - n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
const dayBefore = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);

/** read every row (Supabase gives max 1000 per call) */
async function readAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

const trendOf = (now, before) => (now > before ? 'up' : now < before ? 'down' : 'same');
function badgeOf(n, top) {
  if (!n || !top) return 'none';
  if (n * 3 <= top) return 'low';
  if (n * 3 <= top * 2) return 'medium';
  return 'high';
}

/**
 * Work out and save "who is moving where" for one client.
 * @param {string} clientId
 * @param {{day?: string}} opts  day = 'YYYY-MM-DD' to work out another day (tests); default India today
 * @returns {{day, window, compared_with, cells, types}}
 */
async function refreshActivity(clientId, opts = {}) {
  const day = opts.day || indiaToday();
  const from = monthsBack(day, 1);
  const prevFrom = monthsBack(day, 2);
  const prevTo = dayBefore(from);

  // 1. active competitors of this client (names for the table)
  const { data: comps, error: cErr } = await supabase.schema('admin').from('competitors')
    .select('id, name').eq('client_id', clientId).eq('is_active', true);
  if (cErr) throw new Error(cErr.message);
  const compName = new Map((comps || []).map((c) => [c.id, c.name]));

  // 2. live cards -> their type (category)
  const cards = await readAll(() => supabase.from('competitor_changes_live')
    .select('id, competitor_id, category, signal_name, signal_title, summary, importance, last_signal_at, event_date')
    .eq('client_id', clientId).order('id'));
  const typeOf = new Map(cards.map((c) => [c.id, c.category || 'General Updates']));

  // 3. live signals -> count per competitor + type
  const sigs = await readAll(() => supabase.from('competitor_signals_live')
    .select('id, change_id, competitor_id, event_date, published_date').eq('client_id', clientId).order('id'));

  const cells = new Map();            // 'competitor|type' -> counts
  const bump = (compId, type, d) => {
    const k = `${compId}|${type}`;
    if (!cells.has(k)) cells.set(k, { competitor_id: compId, category: type, c30: 0, p30: 0, tot: 0 });
    const x = cells.get(k);
    x.tot += 1;
    if (d >= from && d <= day) x.c30 += 1;
    else if (d >= prevFrom && d <= prevTo) x.p30 += 1;
  };
  for (const s of sigs) {
    const d = String(s.event_date || s.published_date || '').slice(0, 10);
    if (!d || d > day) continue;                                  // no date, or a date after today
    if (!compName.has(s.competitor_id) || !typeOf.has(s.change_id)) continue;
    bump(s.competitor_id, typeOf.get(s.change_id), d);
  }

  // 4. 'All' row per competitor + the busiest block (for the colours)
  const typeCells = [...cells.values()];
  const top = typeCells.reduce((m, x) => Math.max(m, x.c30), 0);
  const allRows = new Map();
  for (const x of typeCells) {
    if (!allRows.has(x.competitor_id)) allRows.set(x.competitor_id, { competitor_id: x.competitor_id, category: 'All', c30: 0, p30: 0, tot: 0 });
    const a = allRows.get(x.competitor_id);
    a.c30 += x.c30; a.p30 += x.p30; a.tot += x.tot;
  }

  const stamp = new Date().toISOString();
  const cellRows = [...typeCells, ...allRows.values()].map((x) => ({
    client_id: clientId,
    competitor_id: x.competitor_id,
    competitor: compName.get(x.competitor_id),
    category: x.category,
    day,
    window_from: from,
    count_30d: x.c30,
    prev_from: prevFrom,
    prev_to: prevTo,
    prev_count_30d: x.p30,
    change_30d: x.c30 - x.p30,
    trend: trendOf(x.c30, x.p30),
    count_total: x.tot,
    badge_level: x.category === 'All' ? null : badgeOf(x.c30, top),
    updated_at: stamp,
  }));

  // 5. Total column: one row per type
  const byType = new Map();
  for (const x of typeCells) {
    if (!byType.has(x.category)) byType.set(x.category, { category: x.category, t30: 0, p30: 0 });
    const t = byType.get(x.category);
    t.t30 += x.c30; t.p30 += x.p30;
  }
  const typeRows = [...byType.values()]
    .sort((a, b) => (b.t30 - a.t30) || a.category.localeCompare(b.category))
    .map((t, i) => ({
      client_id: clientId,
      category: t.category,
      day,
      total_30d: t.t30,
      total_prev_30d: t.p30,
      trend: trendOf(t.t30, t.p30),
      sort_order: i + 1,
      updated_at: stamp,
    }));

  // 6. save: write the new rows, then remove this client's rows that were not written now (old ones)
  if (cellRows.length) {
    const { error } = await supabase.from('competitor_activity_live').upsert(cellRows, { onConflict: 'client_id,competitor_id,category' });
    if (error) throw new Error(`competitor_activity_live: ${error.message}`);
  }
  if (typeRows.length) {
    const { error } = await supabase.from('competitor_activity_type_totals').upsert(typeRows, { onConflict: 'client_id,category' });
    if (error) throw new Error(`competitor_activity_type_totals: ${error.message}`);
  }
  await supabase.from('competitor_activity_live').delete().eq('client_id', clientId).lt('updated_at', stamp);
  await supabase.from('competitor_activity_type_totals').delete().eq('client_id', clientId).lt('updated_at', stamp);

  // 7. STRATEGIC SHIFTS (top section): the top 3 types without General Updates, written by the AI.
  //    Saved apart: if this fails, the counts above are still saved.
  let shifts = null;
  try { shifts = await require('./shifts').refreshShifts(clientId, { day, from, typeRows, compName }); } catch (e) { console.log(`[CI shifts] ${clientId}: ${e.message} (run sql/ci_017_strategic_shifts.sql)`); }

  return {
    day,
    shifts,
    window: { from, to: day },
    compared_with: { from: prevFrom, to: prevTo },
    cells: cellRows.length,
    types: typeRows.length,
  };
}

/** same as refreshActivity, but never throws (used at the end of runs) */
async function refreshActivitySafe(clientId, opts) {
  try {
    const r = await refreshActivity(clientId, opts);
    console.log(`[CI activity] ${clientId}: ${r.cells} blocks, ${r.types} types (${r.window.from}..${r.window.to} vs ${r.compared_with.from}..${r.compared_with.to})`);
    return r;
  } catch (e) {
    console.log(`[CI activity] ${clientId}: FAILED ${e.message} (run sql/ci_016_who_is_where_tables.sql)`);
    return { error: e.message };
  }
}

module.exports = { refreshActivity, refreshActivitySafe, monthsBack, indiaToday };