/**
 * scripts/ci-page-watch-test.js - SEE EVERY STAGE of the page watch (product / pricing pages).
 *
 *   node scripts/ci-page-watch-test.js "First Solar" --client 19174b66-5ad9-44fa-8071-b30a90c15ea2
 *       -> every watched page of the competitor, compared with the LAST STORED copy. Saves nothing.
 *
 *   node scripts/ci-page-watch-test.js "First Solar" --client <uuid> --url https://www.firstsolar.com/en/Modules/Series-7
 *       -> only this page (it does not have to be added as a source)
 *
 *   --against-archive 20250601   compare with the copy of the page in the Internet Archive (web.archive.org)
 *                                from that date instead of our stored copy. Good for testing: a real old version
 *                                of the page -> a real difference -> you see what the AI says. Saves nothing.
 *
 *   --keep-text old.txt   write today's clean page text to old.txt
 *   --old-file old.txt    compare with old.txt instead (edit it first, e.g. change a price -> a test change)
 *
 *   --save    the real daily step for this competitor (stores copies, saves real changes, writes the log)
 *
 * Report: ci-test-output/page-watch.html
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { nameKey, fetchDirect } = require('../modules/competitiveIntelligence/webTools');
const collector = require('../modules/competitiveIntelligence/collector');
const reader = require('../modules/competitiveIntelligence/reader');
const pw = require('../modules/competitiveIntelligence/pageWatch');
const { loadClient } = require('../modules/competitiveIntelligence/newsRun');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const clientId = flag('--client') || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const oneUrl = flag('--url');
const archiveDate = flag('--against-archive');
const keepText = flag('--keep-text');   // write today's clean text to this file
const oldFile = flag('--old-file');     // use this text file as the OLD copy of the page
const save = args.includes('--save');
const valueFlags = new Set(['--client', '--url', '--against-archive', '--keep-text', '--old-file']);
const target = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]))[0];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = () => supabase.schema('admin');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function archiveCopy(url) {
  // the Internet Archive says 429 ("too many requests") when asked quickly: wait and try again (3 times)
  let r;
  for (let i = 1; i <= 4; i++) {
    r = await fetchDirect(`https://web.archive.org/web/${archiveDate}id_/${url}`);
    if (r.status !== 429) break;
    if (i < 4) { console.log(`  archive busy (429) - waiting ${20 * i} seconds...`); await new Promise((ok) => setTimeout(ok, 20000 * i)); }
  }
  if (!r.ok) return { error: r.status === 429 ? 'the Internet Archive is busy (429, too many requests). Try again in a few minutes.' : `archive has no copy (status ${r.status})` };
  const t = pw.pageText(r.text);
  const m = String(r.finalUrl || '').match(/\/web\/(\d{8})/);
  return { lines: t.lines, seen_at: m ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}` : archiveDate };
}

async function storedCopy(sourceId, url) {
  let q = supabase.from('competitor_page_snapshots').select('text, seen_at, fetch_method').order('seen_at', { ascending: false }).limit(1);
  q = sourceId ? q.eq('source_id', sourceId) : q.eq('url', url);
  const { data } = await q.maybeSingle();
  return data ? { lines: String(data.text).split('\n').filter(Boolean), seen_at: data.seen_at, fetch_method: data.fetch_method } : null;
}

const list = (lines, cls) => (lines && lines.length ? `<pre class="${cls}">${esc(lines.join('\n'))}</pre>` : '<p class="muted">(none)</p>');

(async () => {
  if (!target) { console.log('Say which competitor: node scripts/ci-page-watch-test.js "First Solar" --client <uuid>'); process.exit(1); }
  const { data: comps } = await admin().from('competitors').select('*').eq('client_id', clientId).eq('is_active', true);
  const comp = (comps || []).find((c) => c.name_key === nameKey(target));
  if (!comp) { console.log(`"${target}" not found. Competitors: ${(comps || []).map((c) => c.name).join(', ')}`); process.exit(1); }

  if (save) {
    const r = await pw.runPagesForCompetitor(comp.id, { force: true, triggeredBy: 'manual' });
    console.log(JSON.stringify({ counts: r.counts, skipped: r.skipped, pages: (r.pages || []).map((p) => ({ url: p.url, outcome: p.outcome, reason: p.reason, titles: (p.changes || []).map((c) => c.title) })) }, null, 2));
    process.exit(0);
  }

  const client = await loadClient(clientId);
  const signals = await reader.loadSignals(clientId);
  const ctx = { client, comp, signals, terms: collector.brandTerms(comp) };
  let pages;
  if (oneUrl) pages = [{ id: null, url: oneUrl, product_name: null }];
  else {
    const { data } = await admin().from('competitor_sources').select('id, url, product_name, check_frequency, last_checked_at, status')
      .eq('competitor_id', comp.id).eq('source_type', 'product').eq('status', 'active');
    pages = data || [];
  }
  console.log(`\nPAGE WATCH TEST - ${comp.name} - ${pages.length} page(s) - compared with ${oldFile ? `the file ${oldFile}` : archiveDate ? `the archive copy of ${archiveDate}` : 'our last stored copy'} - nothing saved\n`);

  const H = [`<h1>${esc(comp.name)} - page watch, stage by stage <span class="muted">(${pages.length} pages, compared with ${oldFile ? `the file ${esc(oldFile)}` : archiveDate ? `the Internet Archive copy near ${esc(archiveDate)}` : 'our last stored copy'}, test only - nothing saved)</span></h1>`];
  if (!pages.length) H.push('<p class="warn">No active product / pricing pages for this competitor. Add one with POST /competitive-radar/sources {source_type:"auto", url} or use --url.</p>');

  for (const p of pages) {
    H.push(`<h2>${esc(p.product_name || p.url)}</h2><p class="muted"><a href="${esc(p.url)}" target="_blank">${esc(p.url)}</a></p>`);
    // 1. FETCH + 2. CLEAN
    const now = await pw.readPage(p.url, { firecrawl: 1 }, { exa: 0, firecrawl: 0 });
    if (!now.ok) {
      H.push(`<h3>Stage 1 - FETCH</h3><p class="drop">BLOCKED / EMPTY - ${esc(now.error)} (via ${esc(now.via)}). Never compared, so it can never look like "everything was removed".</p>`);
      console.log(`  ${p.url}: blocked - ${now.error}`);
      continue;
    }
    H.push(`<h3>Stage 1 - FETCH</h3><p>Opened via <b>${esc(now.via)}</b>. Page title: ${esc(now.title)}</p>`);
    if (keepText) { fs.writeFileSync(keepText, now.lines.join('\n')); console.log(`  clean text written to ${keepText}`); }
    H.push(`<h3>Stage 2 - CLEAN: ${now.lines.length} lines, ${now.chars} characters kept</h3><p class="muted">Menus, header, footer, cookie text and scripts removed. "Product data:" lines come from the page code (name, price, currency).</p><details><summary>See the clean text</summary>${list(now.lines, 'plain')}</details>`);

    // 3. COMPARE
    const old = oldFile ? { lines: fs.readFileSync(oldFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean), seen_at: `file ${oldFile}` }
      : archiveDate ? await archiveCopy(p.url) : await pw.lastSnapshot(p.id, p.url, now.via);
    if (old && old.error) {
      H.push(`<h3>Stage 3 - COMPARE</h3><p class="warn">${esc(old.error)}</p>`);
      continue;
    }
    const refetch = () => pw.readPage(p.url, { firecrawl: now.via === 'firecrawl' ? 1 : 0 }, { exa: 0, firecrawl: 0 });
    const r = await pw.comparePage(ctx, { url: p.url, name: p.product_name, refetch }, old, now);
    const fp = (lines) => pw.fingerprint(lines).slice(0, 10);
    H.push(`<h3>Stage 3 - COMPARE</h3><p>${old ? `Old copy from <b>${esc(String(old.seen_at).slice(0, 10))}</b> (${old.lines.length} lines, fingerprint ${fp(old.lines)}) vs now (fingerprint ${fp(now.lines)})` : 'No old copy yet'}</p>`);
    if (r.diff) {
      H.push(`<p>${r.diff.removed_total} lines removed, ${r.diff.added_total} lines added (${Math.round(r.diff.changed_share * 100)}% of the page). The AI sees only these lines${r.diff.removed_total > r.diff.removed.length || r.diff.added_total > r.diff.added.length ? ' (first part only - very long)' : ''}:</p>`);
      H.push(`<div class="two"><div><b>Removed</b>${list(r.diff.removed, 'rem')}</div><div><b>Added</b>${list(r.diff.added, 'add')}</div></div>`);
    }

    // 4. AI + 5. CHECK
    if (r.trace && r.trace.length) {
      H.push(`<h3>Stage 4 - AI and Stage 5 - CODE CHECKS (${r.trace.length} ${r.trace.length === 1 ? 'try' : 'tries'})</h3>`);
      H.push(r.trace.map((t) => `<details><summary>Try ${t.attempt}: ${esc(t.code_said)}</summary><pre>${esc(t.raw_answer)}</pre></details>`).join(''));
    }

    // 6. RESULT
    let res;
    if (r.outcome === 'keep') {
      res = `<b class="ok">WOULD SAVE ${r.changes.length} CHANGE(S)</b>` + r.changes.map((c) => `<div class="card"><b>${esc(c.title)}</b><br>${esc(c.summary)}<br><span class="tag">${esc(c.signal.category)} &rarr; ${esc(c.signal.name)}</span> <span class="tag">${esc(c.importance)}</span> <span class="tag">seen ${esc(c.event_date)}</span><br><span class="muted">${c.key_facts.map(esc).join('<br>')}</span></div>`).join('')
        + (r.notes && r.notes.length ? `<p class="muted">Not kept: ${esc(r.notes.join(' | '))}</p>` : '');
    } else {
      res = `<b class="${r.outcome === 'same' || r.outcome === 'baseline' ? 'muted' : 'drop'}">${esc(r.outcome.toUpperCase())}</b> - ${esc(r.reason)}`;
    }
    H.push(`<h3>Stage 6 - RESULT</h3><p>${res}</p>`);
    console.log(`  ${p.product_name || p.url}: ${r.outcome === 'keep' ? `${r.changes.length} CHANGE(S) - ${r.changes.map((c) => c.title).join(' / ')}` : `${r.outcome} - ${r.reason}`}`);
  }

  const out = path.join(process.cwd(), 'ci-test-output');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'page-watch.html'), `<!doctype html><meta charset="utf-8"><title>CI page watch - ${esc(comp.name)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#222;max-width:1300px}h2{background:#223;color:#fff;padding:6px 10px}h3{border-bottom:2px solid #ccd;padding-bottom:3px}
.muted{color:#777;font-size:12px}.warn{color:#b00}pre{white-space:pre-wrap;padding:8px;font-size:12px;max-height:420px;overflow:auto;background:#f7f7f9}
pre.rem{background:#fdecec}pre.add{background:#e9f8e9}.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.tag{display:inline-block;background:#eef;padding:1px 6px;border-radius:8px;font-size:12px}
.card{background:#f6fff6;border:1px solid #cfe8cf;padding:6px;margin-top:6px}.ok{color:#080}.drop{color:#b00}summary{cursor:pointer}</style>
${H.join('\n')}`);
  console.log('\nReport: ci-test-output/page-watch.html');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });