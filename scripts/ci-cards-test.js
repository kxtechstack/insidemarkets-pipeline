/**
 * scripts/ci-cards-test.js - write the CARDS and see them like the "Competitor activity" section.
 *
 *   node scripts/ci-cards-test.js --client 19174b66-5ad9-44fa-8071-b30a90c15ea2
 *       -> writes cards that are new or got a new signal, then shows ALL live cards
 *   node scripts/ci-cards-test.js --client <uuid> --rewrite
 *       -> writes EVERY card again (use once after ci_006_cards.sql, for cards saved before)
 *   node scripts/ci-cards-test.js --client <uuid> --show-only
 *       -> only shows, writes nothing
 *
 * Report: ci-test-output/cards.html
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { writeDueCards } = require('../modules/competitiveIntelligence/cardWriter');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const clientId = flag('--client') || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KIND = { news: 'News', press: 'Press release', blog: 'Blog', own_site: 'Own website', product: 'Product page' };

(async () => {
  if (args.includes('--rewrite')) {
    await supabase.from('competitor_changes').update({ card_written_at: null }).eq('client_id', clientId).eq('status', 'verified');
    console.log('All live cards marked to be written again.');
  }
  if (!args.includes('--show-only')) {
    // join cards that are the same event (same check as after a real run)
    const { joinSplitCards, dedupeCardSignals, refreshCardCounts } = require('../modules/competitiveIntelligence/changeStore');
    // copies inside a card (same news on several sites): keep the company's own source, else the newest
    const { data: live } = await supabase.from('competitor_changes').select('id, signal_title')
      .eq('client_id', clientId).eq('status', 'verified').eq('is_duplicate', false);
    let copyCards = 0;
    for (const c of live || []) {
      const n = await dedupeCardSignals(c.id);
      if (n) { await refreshCardCounts(c.id); copyCards++; }
    }
    console.log(`Copies check: ${copyCards} card(s) changed`);
    const { data: comps } = await supabase.schema('admin').from('competitors').select('id, name').eq('client_id', clientId).eq('is_active', true);
    for (const comp of comps || []) {
      const j = await joinSplitCards(clientId, comp);
      j.notes.forEach((n) => console.log(`  joined: ${n}`));
    }
    const r = await writeDueCards(clientId, { limit: 200 });
    console.log(`Cards written: ${r.written}, failed: ${r.failed}`);
    r.notes.slice(0, 10).forEach((n) => console.log(`  - ${n}`));
  }

  const { data: cards } = await supabase.from('competitor_changes_live')
    .select('id, organization, category, signal_name, signal_title, summary, business_impact, importance, signal_count, last_signal_at, event_date, card_written_at')
    .eq('client_id', clientId).order('last_signal_at', { ascending: false });
  const { data: sigs } = await supabase.from('competitor_signals_live')
    .select('change_id, signal_title, summary, category, signal_name, event_date, url, source_domain, source_kind, key_facts')
    .eq('client_id', clientId).order('event_date', { ascending: false });
  const byCard = {};
  (sigs || []).forEach((s) => { (byCard[s.change_id] = byCard[s.change_id] || []).push(s); });

  // group like the screen: one block per change type
  const groups = {};
  (cards || []).forEach((c) => { (groups[c.category] = groups[c.category] || []).push(c); });
  const H = [`<h1>Competitor activity <span class="muted">(${(cards || []).length} cards)</span></h1>`];
  for (const [cat, list] of Object.entries(groups)) {
    H.push(`<h2>${esc(cat)} <span class="muted">${list.length} items</span></h2>`);
    for (const c of list) {
      const s = byCard[c.id] || [];
      H.push(`<details class="card"><summary><span class="chip">${esc(c.organization)}</span> <b>${esc(c.signal_title)}</b>
<span class="right">${esc(c.last_signal_at || c.event_date)} <span class="badge">${s.length} signal${s.length === 1 ? '' : 's'}</span> <span class="imp ${esc(c.importance)}">${esc(c.importance)}</span></span>
<div class="muted">${esc(c.signal_name)}${c.card_written_at ? '' : ' - <span class="warn">card text not written yet</span>'}</div></summary>
<div class="drawer"><p>${esc(c.summary)}</p>
<h4>Business impact</h4>${Array.isArray(c.business_impact) && c.business_impact.length ? `<ul>${c.business_impact.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '<p class="warn">not written yet</p>'}
<h4>Signals (${s.length})</h4>${s.map((x) => `<div class="sig"><span class="tag">${esc(KIND[x.source_kind] || x.source_kind)}</span> <b>${esc(x.signal_title)}</b> <span class="right">${esc(x.event_date)}</span>
<div>${esc(x.summary || '')}</div><div class="muted">${esc(x.category)} &rarr; ${esc(x.signal_name)} | <a href="${esc(x.url)}" target="_blank">${esc(x.source_domain || x.url)}</a></div>
${Array.isArray(x.key_facts) && x.key_facts.length ? `<div class="muted">${x.key_facts.map(esc).join(' | ')}</div>` : ''}</div>`).join('')}</div></details>`);
    }
  }
  const out = path.join(process.cwd(), 'ci-test-output');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'cards.html'), `<!doctype html><meta charset="utf-8"><title>CI cards</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#222;max-width:1100px}h2{color:#2a3fd1;border-bottom:1px solid #ddd;padding-bottom:4px}.muted{color:#777;font-size:12px}.warn{color:#b00}
.card{border-bottom:1px solid #eee;padding:8px 0}.card summary{cursor:pointer}.chip{border:1px solid #9ab;border-radius:4px;padding:1px 6px;font-size:12px;background:#eef3ff}
.right{float:right;font-size:12px;color:#555}.badge{border:1px solid #e0b000;border-radius:4px;padding:1px 6px;background:#fff8dd}.imp{border-radius:4px;padding:1px 6px;margin-left:4px}
.imp.Critical{background:#fdd}.imp.High{background:#ffe4cc}.imp.Medium{background:#eef}.imp.Low{background:#eee}.drawer{background:#fafbff;border:1px solid #dde;padding:10px;margin-top:6px}
.sig{border:1px solid #e3e6ef;border-radius:6px;padding:6px;margin:6px 0;background:#fff}.tag{background:#e7f6ee;border-radius:4px;padding:1px 6px;font-size:12px}</style>
${H.join('\n')}`);
  console.log('Report: ci-test-output/cards.html');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });