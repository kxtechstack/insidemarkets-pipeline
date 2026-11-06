/**
 * scripts/ci-news-test.js - try the daily news run from the terminal (TEST database).
 *
 *   node scripts/ci-news-test.js "Shiseido"              -> TEST ONLY: reads 30 days, saves NOTHING, writes a report
 *   node scripts/ci-news-test.js all                     -> same, every competitor of the client
 *   node scripts/ci-news-test.js "Shiseido" --save       -> really saves (changes + chat database + logs)
 *
 *   --days 7                     look back 7 days instead of 30
 *   --sections press,news        only these sections (press, own_site, news)
 *   --client <uuid>              another client (default: Lumière)
 *
 * Report: ci-test-output/news-report.html (open in the browser) + news-report.json
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { runNewsForClient } = require('../modules/competitiveIntelligence/newsRun');
const { nameKey } = require('../modules/competitiveIntelligence/webTools');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const save = args.includes('--save');
const clientId = flag('--client') || 'b61b4d3b-caeb-457b-9971-636c83688ee4'; // Lumière
const days = flag('--days') ? Number(flag('--days')) : (save ? undefined : 30);
const sections = flag('--sections') ? flag('--sections').split(',').map((s) => s.trim()) : undefined;
const valueFlags = new Set(['--client', '--days', '--sections']);
const target = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]))[0];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function html(result) {
  const rows = [];
  if (result.skipped || result.error) rows.push(`<h2 class="warn">Run did not start</h2><p class="warn">${esc(result.skipped || result.error)}</p>`);
  if (!(result.competitors || []).length && !result.skipped && !result.error) rows.push('<p class="warn">No competitors were checked.</p>');
  for (const c of result.competitors || []) {
    if (c.skipped || c.error) { rows.push(`<h2>${esc(c.competitor)}</h2><p class="warn">${esc(c.skipped || c.error)}</p>`); continue; }
    rows.push(`<h2>${esc(c.competitor)}</h2>`);
    for (const [sec, r] of Object.entries(c.sections)) {
      if (r.skipped) { rows.push(`<h3>${sec}</h3><p class="muted">${esc(r.skipped)}</p>`); continue; }
      rows.push(`<h3>${sec} <span class="muted">since ${r.since} - ${esc(JSON.stringify(r.counts))}</span></h3>`);
      if (r.notes.length) rows.push(`<p class="muted">${r.notes.map(esc).join('<br>')}</p>`);
      if (r.error) rows.push(`<p class="warn">${esc(r.error)}</p>`);
      rows.push('<table><tr><th>Result</th><th>Article</th><th>What the AI saved / why dropped</th></tr>');
      const order = { 'would save': 0, saved: 0, merged: 1, failed: 2, dropped: 3 };
      for (const it of [...r.items].sort((a, b) => (order[a.outcome] ?? 9) - (order[b.outcome] ?? 9))) {
        const ch = it.change;
        const right = ch
          ? `<b>${esc(ch.title)}</b><br>${esc(ch.summary)}<br><span class="tag">${esc(ch.type)} &rarr; ${esc(ch.signal)}</span> <span class="tag">${esc(ch.importance)}</span> <span class="tag">event ${esc(ch.event_date)} (${esc(ch.event_date_from)})</span>${it.merged_by ? ` <span class="tag">joined: ${esc(it.merged_by)}</span>` : ''}${it.in_chat === false ? ' <span class="tag warn">not in chat yet</span>' : ''}<br><span class="muted">proof: ${ch.key_facts.map((f) => `"${esc(f)}"`).join(' | ')}</span>`
          : `${esc(it.reason)} <span class="muted">(${esc(it.step)})</span>`;
        rows.push(`<tr class="${esc(it.outcome.replace(' ', '-'))}"><td>${esc(it.outcome)}</td><td><a href="${esc(it.url)}" target="_blank">${esc(it.title || it.url)}</a><br><span class="muted">${esc((it.date || '').slice(0, 10))} - ${esc(new URL(it.url).hostname)}${it.mentions != null ? ` - named ${it.mentions}x` : ''}</span></td><td>${right}</td></tr>`);
      }
      rows.push('</table>');
    }
  }
  return `<!doctype html><meta charset="utf-8"><title>CI news report</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%;margin-bottom:18px}td,th{border:1px solid #ddd;padding:6px;vertical-align:top;text-align:left}
th{background:#f3f3f3}.muted{color:#777;font-size:12px}.warn{color:#b00}.tag{display:inline-block;background:#eef;padding:1px 6px;border-radius:8px;font-size:12px;margin-top:3px}
tr.would-save td:first-child,tr.saved td:first-child{background:#dff5df}tr.merged td:first-child{background:#e3ecff}tr.dropped td:first-child{background:#f3f3f3}tr.failed td:first-child{background:#fde2e2}</style>
<h1>CI news report - ${esc(result.client || '')} ${save ? '(SAVED)' : '(test only - nothing saved)'}</h1>
<p class="muted">${new Date().toISOString()}</p>${rows.join('\n')}`;
}

(async () => {
  let competitorId;
  if (target && target !== 'all') {
    const { data } = await supabase.schema('admin').from('competitors').select('id, name, name_key').eq('client_id', clientId).eq('is_active', true);
    const hit = (data || []).find((c) => c.name_key === nameKey(target));
    if (!hit) { console.log(`"${target}" not found. Competitors: ${(data || []).map((c) => c.name).join(', ')}`); process.exit(1); }
    competitorId = hit.id;
  } else if (!target) {
    console.log('Say which competitor: node scripts/ci-news-test.js "Shiseido"   (or: all)');
    process.exit(1);
  }

  console.log(`${save ? 'SAVING' : 'TEST ONLY (nothing saved)'} - ${target} - ${days ? `${days} days` : 'since last run'}${sections ? ` - ${sections.join(',')}` : ''}\n`);
  const result = await runNewsForClient(clientId, { competitorId, days, sections, dryRun: !save, triggeredBy: 'manual' });

  const out = path.join(process.cwd(), 'ci-test-output');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'news-report.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(out, 'news-report.html'), html(result));

  if (result.skipped || result.error) console.log('\nRUN SKIPPED. REASON: ' + (result.skipped || result.error));
  console.log('Full result:', JSON.stringify(result).slice(0, 600));
  for (const c of result.competitors || []) {
    if (c.skipped || c.error) { console.log(`${c.competitor}: ${c.skipped || c.error}`); continue; }
    for (const [sec, r] of Object.entries(c.sections)) {
      console.log(`${c.competitor} / ${sec}: ${r.skipped || JSON.stringify(r.counts)}`);
    }
  }
  console.log('\nReport: ci-test-output/news-report.html');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });