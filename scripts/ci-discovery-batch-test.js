/**
 * scripts/ci-discovery-batch-test.js
 *
 * Tests ONLY the link finding (shop website, company site, press page, product pages)
 * for many clients / industries at once. Uses the SAME code as the real discovery
 * (findSources in modules/competitiveIntelligence/discovery.js) but saves NOTHING to the database.
 *
 *   node scripts/ci-discovery-batch-test.js                     -> all clients in ci-discovery-testset.json
 *   node scripts/ci-discovery-batch-test.js --only Cosmetics    -> one client (matches client name or industry)
 *   node scripts/ci-discovery-batch-test.js --with-company      -> use the company website from the test file (like the admin typed it)
 *   node scripts/ci-discovery-batch-test.js --no-products       -> skip product pages (faster, no Firecrawl)
 *   node scripts/ci-discovery-batch-test.js --parallel 3        -> competitors checked at the same time (default 2)
 *
 * Output (in ./ci-test-output/):
 *   discovery-report.html  - open in a browser: every link is clickable, green = matches what we expected
 *   discovery-report.csv   - same, for Excel / Sheets (has an empty "Correct? (you)" column)
 *   discovery-raw.json     - everything, for debugging
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { findSources } = require('../modules/competitiveIntelligence/discovery');
const { countryProfileFor, rootDomain, makeCounter } = require('../modules/competitiveIntelligence/webTools');
const { LIMITS } = require('../modules/competitiveIntelligence/constants');

const args = process.argv.slice(2);
const argVal = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const only = argVal('--only', null);
const skipProducts = args.includes('--no-products');
const withCompany = args.includes('--with-company');
const parallel = Math.max(1, Number(argVal('--parallel', 2)) || 2);
const setFile = argVal('--set', path.join(__dirname, 'ci-discovery-testset.json'));
const outDir = path.join(process.cwd(), 'ci-test-output');

for (const k of ['EXA_API_KEY']) if (!process.env[k]) { console.error(`${k} missing in .env`); process.exit(1); }
if (!skipProducts && !process.env.FIRECRAWL_API_KEY) console.log('Note: FIRECRAWL_API_KEY missing - blocked product pages will be skipped.');

// -------------------------------------------------------------
const verdict = (host, expected) => {
  if (!host) return 'MISSING';
  if (!expected || !expected.length) return 'CHECK';
  return expected.includes(rootDomain(host)) ? 'OK' : 'WRONG';
};

async function runOne(client, c) {
  const profile = countryProfileFor(client.location);
  const counter = makeCounter();
  const started = Date.now();
  try {
    const r = await findSources(
      { name: c.name, search_name: c.search_name || c.name, shop_domain: null, company_domain: (withCompany && c.company_domain) || null },
      profile,
      { counter, budget: { firecrawl: LIMITS.MAX_FIRECRAWL_PER_RUN }, skipProducts },
    );
    return {
      client: client.client, industry: client.industry, location: client.location, country: profile.key,
      competitor: c.name,
      shop: r.shopHost, shop_verdict: verdict(r.shopHost, c.expect_shop), expect_shop: c.expect_shop || [],
      shop_candidates: r.shopCandidates.map((x) => `${x.host} (${x.total})`),
      company_given: !!(withCompany && c.company_domain),
      company_guessed: !!r.companyGuessed,
      company: r.companyHost, company_verdict: verdict(r.companyHost, c.expect_company), expect_company: c.expect_company || [],
      company_candidates: (r.companyCandidates || []).map((x) => `${x.host} (${x.score})`),
      press: r.press ? r.press.url : null, press_dates: r.press ? r.press.dates : 0, press_via: r.press ? r.press.via : null,
      press_how: r.press ? (r.press.mode === 'site_search' ? 'site search (no list page)' : r.press.found_via) : null,
      products: r.products.good.map((p) => ({ url: p.url, name: p.name, currency: p.currency, variants: p.variants, via: p.via })),
      products_checked: r.products.good.length + r.products.rejected.length,
      products_rejected: r.products.rejected.slice(0, 5),
      status: r.status, notes: r.notes,
      exa: counter.exa, firecrawl: counter.firecrawl, seconds: Math.round((Date.now() - started) / 1000),
    };
  } catch (e) {
    return {
      client: client.client, industry: client.industry, location: client.location, competitor: c.name,
      status: 'failed', error: e.message, shop_verdict: 'MISSING', company_verdict: 'MISSING',
      products: [], notes: [], exa: counter.exa, firecrawl: counter.firecrawl,
    };
  }
}

// run a list of jobs, N at a time
async function pool(jobs, n) {
  const out = new Array(jobs.length);
  let next = 0;
  let done = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
      done++;
      const r = out[i];
      console.log(`[${String(done).padStart(2)}/${jobs.length}] ${r.client.padEnd(42)} ${r.competitor.padEnd(18)} shop ${String(r.shop_verdict).padEnd(7)} company ${String(r.company_verdict).padEnd(7)} press ${r.press ? 'yes' : 'no '} products ${r.products.length}  (${r.seconds || 0}s)`);
    }
  }));
  return out;
}

// -------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const link = (u, label) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(label || u)}</a>` : '<span class="none">-</span>');
const badge = (v) => `<span class="b ${esc(v)}">${esc(v)}</span>`;

function htmlReport(rows) {
  const clients = [...new Set(rows.map((r) => r.client))];
  const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
  const sum = (list) => {
    const n = list.length;
    const shopOk = list.filter((r) => r.shop_verdict === 'OK').length;
    const compOk = list.filter((r) => r.company_verdict === 'OK').length;
    const press = list.filter((r) => r.press).length;
    const prod = list.filter((r) => r.products.length).length;
    return { n, shopOk, compOk, press, prod };
  };
  const all = sum(rows);
  const summaryRows = clients.map((cl) => {
    const list = rows.filter((r) => r.client === cl);
    const s = sum(list);
    return `<tr><td>${esc(cl)}<div class="sub">${esc(list[0].location)}</div></td><td>${s.n}</td>
      <td>${s.shopOk}/${s.n} <span class="sub">${pct(s.shopOk, s.n)}%</span></td>
      <td>${s.compOk}/${s.n} <span class="sub">${pct(s.compOk, s.n)}%</span></td>
      <td>${s.press}/${s.n}</td><td>${s.prod}/${s.n}</td></tr>`;
  }).join('');

  const detail = clients.map((cl) => {
    const list = rows.filter((r) => r.client === cl);
    return `<h2>${esc(cl)} <span class="sub">${esc(list[0].industry)} · ${esc(list[0].location)} · country "${esc(list[0].country || '')}"</span></h2>
    <div class="scroll"><table class="d"><thead><tr>
      <th>Competitor</th><th>Shop website</th><th>Company site</th><th>Press page</th><th>Product pages (trusted price)</th><th>Notes</th>
    </tr></thead><tbody>${list.map((r) => `<tr>
      <td><b>${esc(r.competitor)}</b><div class="sub">${esc(r.status)} · exa ${r.exa} · fc ${r.firecrawl}${r.seconds ? ' · ' + r.seconds + 's' : ''}</div>${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}</td>
      <td>${badge(r.shop_verdict)} ${link(r.shop ? 'https://' + r.shop : null, r.shop)}
        <div class="sub">expected: ${esc((r.expect_shop || []).join(', ') || '-')}</div>
        <details><summary>other options</summary>${esc((r.shop_candidates || []).join(' · ') || '-')}</details></td>
      <td>${badge(r.company_verdict)} ${link(r.company ? 'https://' + r.company : null, r.company)}${r.company_given ? ' <span class="sub">(given)</span>' : ''}${r.company_guessed ? ' <span class="sub">(guessed - admin must confirm)</span>' : ''}
        <div class="sub">expected: ${esc((r.expect_company || []).join(', ') || '-')}</div>
        <details><summary>other options</summary>${esc((r.company_candidates || []).join(' · ') || '-')}</details></td>
      <td>${r.press ? link(r.press) + `<div class="sub">${esc(r.press_how || '')} · ${r.press_dates} dated items · read ${esc(r.press_via)}</div>` : badge('MISSING')}</td>
      <td>${r.products.length ? '<ol>' + r.products.map((p) => `<li>${link(p.url, p.name || p.url)} <span class="sub">${esc(p.currency)} · ${p.variants} size(s) · ${esc(p.via)}</span></li>`).join('') + '</ol>' : badge('MISSING')}
        <div class="sub">${r.products_checked || 0} pages checked</div>
        ${r.products_rejected && r.products_rejected.length ? `<details><summary>rejected</summary>${r.products_rejected.map((x) => `${link(x.url)} - ${esc(x.reason)}`).join('<br>')}</details>` : ''}</td>
      <td class="notes">${(r.notes || []).map(esc).join('<br>')}</td>
    </tr>`).join('')}</tbody></table></div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CI Discovery Test</title><style>
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6b6b70;--line:#e3e3e8;--ok:#1f7a3d;--okbg:#e3f4e8;--bad:#a8261b;--badbg:#fbe5e2;--chk:#8a5a00;--chkbg:#fdf1d6}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--mut:#9a9aa3;--line:#2c2c31;--ok:#7fd69a;--okbg:#173322;--bad:#ff9d93;--badbg:#3a1a17;--chk:#f2c66b;--chkbg:#352a12}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:1500px;margin:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px}.sub{color:var(--mut);font-size:12px;font-weight:400}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
th{font-size:12px;color:var(--mut);font-weight:600}.scroll{overflow-x:auto}table.d td{min-width:150px}td.notes{min-width:220px;font-size:12px}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--mut);word-break:break-all}
.b{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;margin-right:4px}
.b.OK{color:var(--ok);background:var(--okbg)}.b.WRONG,.b.MISSING{color:var(--bad);background:var(--badbg)}.b.CHECK{color:var(--chk);background:var(--chkbg)}
.none{color:var(--mut)}.err{color:var(--bad);font-size:12px}ol{margin:0;padding-left:18px}details{font-size:12px;color:var(--mut)}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.k{border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:140px}.k b{font-size:20px;display:block}
</style></head><body>
<h1>Competitive Radar · link finding test</h1>
<div class="sub">${new Date().toLocaleString('en-GB')} · ${rows.length} competitors · ${clients.length} test clients · company website ${withCompany ? 'GIVEN by admin' : 'found automatically'} · products ${skipProducts ? 'skipped' : 'checked'} · nothing saved to the database</div>
<div class="kpis">
<div class="k"><b>${all.shopOk}/${all.n}</b>shop website correct</div>
<div class="k"><b>${all.compOk}/${all.n}</b>company site correct</div>
<div class="k"><b>${all.press}/${all.n}</b>press page found</div>
<div class="k"><b>${all.prod}/${all.n}</b>have price pages</div>
<div class="k"><b>${rows.reduce((a, r) => a + (r.exa || 0), 0)} / ${rows.reduce((a, r) => a + (r.firecrawl || 0), 0)}</b>Exa / Firecrawl calls</div>
</div>
<div class="sub">OK = matches what we expected · WRONG = different site (could still be fine, open it) · CHECK = no expectation, look by eye · MISSING = not found</div>
<div class="scroll"><table><thead><tr><th>Client</th><th>Competitors</th><th>Shop correct</th><th>Company correct</th><th>Press found</th><th>Price pages</th></tr></thead><tbody>${summaryRows}</tbody></table></div>
${detail}
</body></html>`;
}

function csvReport(rows) {
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const head = ['Client', 'Location', 'Competitor', 'Shop found', 'Shop check', 'Shop expected', 'Company found', 'Company check', 'Company expected',
    'Press page', 'Product 1', 'Product 2', 'Product 3', 'Product 4', 'Product 5', 'Status', 'Notes', 'Correct? (you)', 'Your comment'];
  const lines = rows.map((r) => [r.client, r.location, r.competitor, r.shop, r.shop_verdict, (r.expect_shop || []).join(' | '),
    r.company, r.company_verdict, (r.expect_company || []).join(' | '), r.press,
    ...[0, 1, 2, 3, 4].map((i) => (r.products[i] ? r.products[i].url : '')), r.status, (r.notes || []).join(' '), '', ''].map(q).join(','));
  return [head.map(q).join(','), ...lines].join('\n');
}

// -------------------------------------------------------------
(async () => {
  const set = JSON.parse(fs.readFileSync(setFile, 'utf8'));
  const clients = set.clients.filter((c) => !only || `${c.client} ${c.industry}`.toLowerCase().includes(only.toLowerCase()));
  if (!clients.length) { console.log(`No client matches "${only}"`); return; }
  const jobs = [];
  for (const cl of clients) for (const c of cl.competitors) jobs.push(() => runOne(cl, c));
  console.log(`Testing ${jobs.length} competitors across ${clients.length} clients, ${parallel} at a time, company website ${withCompany ? 'GIVEN' : 'auto'}${skipProducts ? ', products skipped' : ''}...\n`);

  const rows = await pool(jobs, parallel);

  fs.mkdirSync(outDir, { recursive: true });
  const tag = withCompany ? '-with-company' : '';   // two runs = two reports, easy to compare
  fs.writeFileSync(path.join(outDir, `discovery-raw${tag}.json`), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(outDir, `discovery-report${tag}.csv`), csvReport(rows));
  fs.writeFileSync(path.join(outDir, `discovery-report${tag}.html`), htmlReport(rows));

  const n = rows.length;
  const c = (k, v) => rows.filter((r) => r[k] === v).length;
  console.log(`\nShop correct ${c('shop_verdict', 'OK')}/${n} · Company correct ${c('company_verdict', 'OK')}/${n} · Press found ${rows.filter((r) => r.press).length}/${n} · Price pages ${rows.filter((r) => r.products.length).length}/${n}`);
  console.log(`Exa calls ${rows.reduce((a, r) => a + (r.exa || 0), 0)} · Firecrawl calls ${rows.reduce((a, r) => a + (r.firecrawl || 0), 0)}`);
  console.log(`\nReport: ${path.join(outDir, `discovery-report${tag}.html`)}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });