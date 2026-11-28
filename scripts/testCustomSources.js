/**
 * scripts/testCustomSources.js
 *
 * Code tests for reading custom sources (modules/customSources/).
 * No internet and no database: every test uses fake data or a small
 * test server on this computer.
 * Each step adds its own section when it is built.
 *
 * Run:  node scripts/testCustomSources.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { receiveSource } = require('../modules/customSources/receiveSource');
const { fetchSource, isPublicAddress, checkLink, detectFileType, fileNameFor } = require('../modules/customSources/fetchSource');
const { readText, cleanText, stripBullet, tableRows, removeRepeatedLines } = require('../modules/customSources/readText');
const { checkText, junkShare } = require('../modules/customSources/checkText');
const { cutPieces, sentencesOf, countWords } = require('../modules/customSources/cutPieces');
const { saveSource } = require('../modules/customSources/saveSource');
const { reportRun } = require('../modules/customSources/reportRun');
const { runSource } = require('../modules/customSources/runSource');
const { searchCustomSources } = require('../modules/customSources/searchCustomSources');
const { readPdf, linesOfPage, partsFromLines, isSpacedLetters, withoutDoubles } = require('../modules/customSources/readPdf');
const { SourceError } = require('../modules/customSources/sourceError');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

// The job must fail with this SourceError code
async function expectCode(name, job, code) {
  try {
    await job();
    check(name, false, 'no error was raised');
  } catch (e) {
    check(name, e instanceof SourceError && e.code === code, `error was: ${e.code || ''} ${e.message}`);
  }
}

// ── A fake database: just enough of the Supabase client for these tests ──
// tables = { 'admin.custom_data_sources': [rows], 'admin.clients': [rows] }
// failOn = a table name that answers with a database error
function fakeDb(tables, failOn = null) {
  return {
    schema(schemaName) {
      return {
        from(tableName) {
          const fullName = `${schemaName}.${tableName}`;
          const filters = [];
          const query = {
            select() { return query; },
            eq(column, value) { filters.push([column, value]); return query; },
            async maybeSingle() {
              if (failOn === fullName) return { data: null, error: { message: 'connection lost' } };
              const rows = (tables[fullName] || []).filter((r) => filters.every(([c, v]) => r[c] === v));
              return { data: rows[0] || null, error: null };
            },
          };
          return query;
        },
      };
    },
  };
}

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_CLIENT = '22222222-2222-4222-8222-222222222222';
const id = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

function source(n, fields) {
  return {
    id: id(n), client_id: CLIENT, source_name: `Source ${n}`, source_type: 'website',
    url_or_path: null, storage_path: null, text_content: null, ...fields,
  };
}

async function testReceiveSource() {
  console.log('\nStep 1: receiveSource.js');

  const rows = [
    source(1, { source_type: 'website', url_or_path: 'https://example.com/report' }),
    source(2, { source_type: 'pdf', storage_path: `${CLIENT}/1787056410922.pdf` }),
    source(3, { source_type: 'pdf', url_or_path: 'https://example.com/a.pdf' }),
    source(4, { source_type: 'pdf', storage_path: `${CLIENT}/1.pdf`, url_or_path: 'https://example.com/b.pdf' }),
    source(5, { source_type: 'text', text_content: '  Our plan for 2027 is to grow in Australia.  ' }),
    source(6, { source_type: 'website', url_or_path: null }),
    source(7, { source_type: 'website', url_or_path: 'ftp://example.com/x' }),
    source(8, { source_type: 'pdf' }),
    source(9, { source_type: 'text', text_content: '   ' }),
    source(10, { source_type: 'text', text_content: 'x'.repeat(1000001) }),
    source(11, { source_type: 'video', url_or_path: 'https://example.com' }),
    source(12, { source_type: 'file', url_or_path: 'https://example.com/c.docx' }),
    source(13, { source_type: 'website', url_or_path: 'https://example.com', client_id: OTHER_CLIENT }),
    source(14, { source_type: ' Website ', url_or_path: ' https://example.com/x ', source_name: '   ' }),
    source(15, { source_type: 'pdf', url_or_path: 'javascript:alert(1)' }),
  ];
  const db = fakeDb({ 'admin.custom_data_sources': rows, 'admin.clients': [{ id: CLIENT }] });
  const run = (n) => receiveSource(id(n), { db });

  const web = await run(1);
  check('website: kind is website', web.kind === 'website');
  check('website: link kept', web.url === 'https://example.com/report');
  check('website: client comes from the row', web.clientId === CLIENT);
  check('website: name kept', web.sourceName === 'Source 1');

  const upload = await run(2);
  check('pdf upload: kind is file', upload.kind === 'file');
  check('pdf upload: storage path kept, no link', upload.storagePath === `${CLIENT}/1787056410922.pdf` && upload.url === null);

  const pdfLink = await run(3);
  check('pdf link: kind is file, link kept, no storage path', pdfLink.kind === 'file' && pdfLink.url === 'https://example.com/a.pdf' && pdfLink.storagePath === null);

  const both = await run(4);
  check('pdf with upload and link: the upload wins', both.storagePath === `${CLIENT}/1.pdf` && both.url === null);

  const text = await run(5);
  check('text: kind is text, spaces trimmed', text.kind === 'text' && text.text === 'Our plan for 2027 is to grow in Australia.');

  const fileType = await run(12);
  check('"file" type is read like pdf', fileType.kind === 'file' && fileType.url === 'https://example.com/c.docx');

  const messy = await run(14);
  check('type with spaces and capitals still works', messy.kind === 'website' && messy.url === 'https://example.com/x');
  check('empty name gets "Untitled source"', messy.sourceName === 'Untitled source');

  await expectCode('website with no link stops', () => run(6), 'MISSING_INPUT');
  await expectCode('website with ftp link stops', () => run(7), 'BAD_LINK');
  await expectCode('pdf with no file and no link stops', () => run(8), 'MISSING_INPUT');
  await expectCode('text with only spaces stops', () => run(9), 'MISSING_INPUT');
  await expectCode('text over the limit stops', () => run(10), 'TEXT_TOO_LONG');
  await expectCode('unknown type stops', () => run(11), 'UNKNOWN_TYPE');
  await expectCode('source of a missing client stops', () => run(13), 'CLIENT_NOT_FOUND');
  await expectCode('javascript: link stops', () => run(15), 'BAD_LINK');
  await expectCode('bad id stops', () => receiveSource('abc', { db }), 'BAD_SOURCE_ID');
  await expectCode('empty id stops', () => receiveSource(undefined, { db }), 'BAD_SOURCE_ID');
  await expectCode('missing source stops', () => receiveSource(id(99), { db }), 'SOURCE_NOT_FOUND');
  try { await run(11); } catch (e) {
    check('a problem after the row is read says which client and source', e.source && e.source.clientId === CLIENT && e.source.sourceId === id(11));
  }

  // A database error is not a SourceError: it must not look like "not found"
  try {
    await receiveSource(id(1), { db: fakeDb({}, 'admin.custom_data_sources') });
    check('database error is reported', false, 'no error was raised');
  } catch (e) {
    check('database error is reported as a database error', !(e instanceof SourceError) && e.message.includes('connection lost'), e.message);
  }
}


// ── Step 2: fetchSource.js ──────────────────────────────────────────────

const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');
const HTML_PAGE = '<!DOCTYPE html><html><head><title>Report</title></head><body><p>Our 2027 plan.</p></body></html>';

// A small web server on this computer, only for the tests
function startTestServer() {
  const routes = {
    '/pdf': (req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(PDF_BYTES); },
    '/html': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML_PAGE); },
    '/text': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Plain notes about the market.'); },
    '/png': (req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])); },
    '/empty': (req, res) => { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(); },
    '/redirect': (req, res) => { res.writeHead(302, { Location: '/pdf' }); res.end(); },
    '/loop': (req, res) => { res.writeHead(302, { Location: '/loop' }); res.end(); },
    '/redirect-internal': (req, res) => { res.writeHead(302, { Location: `http://10.0.0.5:${req.socket.localPort}/pdf` }); res.end(); },
    '/redirect-ftp': (req, res) => { res.writeHead(302, { Location: 'ftp://example.com/file.pdf' }); res.end(); },
    '/big': (req, res) => { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': 5000 }); res.end(Buffer.alloc(5000, 65)); },
    '/big-no-size': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); for (let i = 0; i < 10; i += 1) res.write(Buffer.alloc(500, 65)); res.end(); },
    '/gzip': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }); res.end(zlib.gzipSync(HTML_PAGE)); },
    '/gzip-bomb': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' }); res.end(zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024, 65))); },
    '/slow': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('start'); /* never ends */ },
    '/401': (req, res) => { res.writeHead(401); res.end('login'); },
    '/403': (req, res) => { res.writeHead(403); res.end('no robots'); },
    '/404': (req, res) => { res.writeHead(404); res.end('missing'); },
    '/500': (req, res) => { res.writeHead(500); res.end('broken'); },
  };
  const server = http.createServer((req, res) => (routes[req.url] || routes['/404'])(req, res));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// A fake storage bucket
function fakeStorage(files) {
  return {
    storage: {
      from(bucket) {
        return {
          async download(filePath) {
            if (bucket !== 'custom-source-files') return { data: null, error: { message: 'Bucket not found' } };
            if (!(filePath in files)) return { data: null, error: { message: 'Object not found' } };
            const bytes = files[filePath];
            return { data: { type: 'application/pdf', arrayBuffer: async () => bytes }, error: null };
          },
        };
      },
    },
  };
}

async function testFetchSource() {
  console.log('\nStep 2: fetchSource.js');

  // Addresses
  const publicOnes = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '152.228.233.227', '2606:4700:4700::1111', '::ffff:8.8.8.8'];
  const privateOnes = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]', 'qdrant'];
  check('public addresses are allowed', publicOnes.every(isPublicAddress), publicOnes.filter((a) => !isPublicAddress(a)).join(', '));
  check('private and internal addresses are refused', privateOnes.every((a) => !isPublicAddress(a)), privateOnes.filter(isPublicAddress).join(', '));

  // Links (default rules, nothing is opened)
  const defaultRules = { isAllowedAddress: isPublicAddress, allowedPorts: [80, 443] };
  const linkCode = (url) => { try { checkLink(new URL(url), defaultRules); return 'OK'; } catch (e) { return e.code; } };
  check('https link to a normal site passes', linkCode('https://example.com/report.pdf') === 'OK');
  check('ftp link is refused', linkCode('ftp://example.com/a.pdf') === 'BAD_LINK');
  check('file: link is refused', linkCode('file:///etc/passwd') === 'BAD_LINK');
  check('link with user:password is refused', linkCode('https://user:pw@example.com/') === 'BAD_LINK');
  check('link to port 6333 (Qdrant) is refused', linkCode('http://example.com:6333/collections') === 'BLOCKED_PORT');
  check('link to our server ip with port 6333 is refused', linkCode('http://152.228.233.227:6333/collections') === 'BLOCKED_PORT');
  check('link to 127.0.0.1 is refused', linkCode('http://127.0.0.1/') === 'BLOCKED_ADDRESS');
  check('link to 127.0.0.1 written as a number is refused', linkCode('http://2130706433/') === 'BLOCKED_ADDRESS');
  check('link to [::1] is refused', linkCode('http://[::1]/') === 'BLOCKED_ADDRESS');
  check('link to the cloud metadata address is refused', linkCode('http://169.254.169.254/latest/meta-data') === 'BLOCKED_ADDRESS');
  check('link to 10.x is refused', linkCode('https://10.0.0.5/') === 'BLOCKED_ADDRESS');

  // File type from the first bytes
  const zipWith = (folder) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`....${folder}document.xml....`)]);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);
  check('pdf found by its first bytes', detectFileType(PDF_BYTES, 'application/octet-stream') === 'pdf');
  check('pdf with junk before the start is still pdf', detectFileType(Buffer.concat([Buffer.from('junk\n'), PDF_BYTES])) === 'pdf');
  check('word file found', detectFileType(zipWith('word/')) === 'docx');
  check('excel file found', detectFileType(zipWith('xl/')) === 'xlsx');
  check('powerpoint file found', detectFileType(zipWith('ppt/')) === 'pptx');
  check('other zip is not supported', detectFileType(zipWith('stuff/')) === 'unknown');
  check('old excel found by its name', detectFileType(ole, '', 'sales.xls') === 'xls');
  check('web page found by its start', detectFileType(Buffer.from(HTML_PAGE), 'application/octet-stream') === 'html');
  check('web page found by what the site says', detectFileType(Buffer.from('<div>hi</div>'), 'text/html') === 'html');
  check('plain text found', detectFileType(Buffer.from('notes'), 'text/plain') === 'text');
  check('image is not supported', detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), 'image/png') === 'unknown');

  // File names for the reader
  check('file name: cleaned, right ending', fileNameFor('/files/Q3%20Report.PDF?x=1', 'pdf') === 'Q3 Report.pdf');
  check('file name: empty gets "document"', fileNameFor('', 'pdf') === 'document.pdf');
  check('file name: ending follows the real type', fileNameFor('/download.php', 'docx') === 'download.docx');

  // Default rules really block local addresses, also when found by name
  const code = async (job, deps) => { try { await fetchSource(job, deps); return 'OK'; } catch (e) { return e.code || e.message; } };
  check('"localhost" link is refused at connect time', (await code({ kind: 'website', url: 'http://localhost/' })) === 'BLOCKED_ADDRESS');
  const qdrantCode = await code({ kind: 'website', url: 'http://qdrant/collections' });
  check('"qdrant" link is never opened', ['BLOCKED_ADDRESS', 'LINK_NOT_FOUND'].includes(qdrantCode), qdrantCode);
  check('"qdrant:6333" link is refused by port', (await code({ kind: 'website', url: 'http://qdrant:6333/collections' })) === 'BLOCKED_PORT');

  // Real downloads from the test server
  const server = await startTestServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  // The test server is on this computer, so the tests allow only it
  const local = { isAllowedAddress: (a) => a === '127.0.0.1', allowedPorts: [port], maxBytes: 1000, timeoutMs: 1500 };
  const web = (p) => ({ kind: 'website', url: base + p });
  const file = (p) => ({ kind: 'file', url: base + p });

  try {
    check('our own server is refused with normal rules', (await code(web('/pdf'), { allowedPorts: [port] })) === 'BLOCKED_ADDRESS');

    const pdf = await fetchSource(file('/pdf'), local);
    check('pdf link: kind file, type pdf, name pdf.pdf', pdf.kind === 'file' && pdf.fileType === 'pdf' && pdf.fileName === 'pdf.pdf', JSON.stringify({ k: pdf.kind, t: pdf.fileType, n: pdf.fileName }));
    check('pdf link: bytes kept', pdf.bytes.equals(PDF_BYTES));

    const webPdf = await fetchSource(web('/pdf'), local);
    check('website link that is really a pdf goes to the file reader', webPdf.kind === 'file' && webPdf.fileType === 'pdf');

    const page = await fetchSource(web('/html'), local);
    check('website link gives a web page', page.kind === 'website' && page.fileType === 'html' && page.bytes.toString().includes('Our 2027 plan'));

    check('file link that opens a web page is refused', (await code(file('/html'), local)) === 'NOT_A_FILE');

    const txt = await fetchSource(file('/text'), local);
    check('plain text link gives text', txt.kind === 'text' && txt.text === 'Plain notes about the market.');

    const moved = await fetchSource(file('/redirect'), local);
    check('redirect is followed', moved.fileType === 'pdf' && moved.finalUrl === `${base}/pdf`, moved.finalUrl);

    check('endless redirects stop', (await code(file('/loop'), local)) === 'TOO_MANY_REDIRECTS');
    check('redirect to an internal address is refused', (await code(file('/redirect-internal'), local)) === 'BLOCKED_ADDRESS');
    check('redirect to ftp is refused', (await code(file('/redirect-ftp'), local)) === 'BAD_LINK');
    check('too big (size given) stops', (await code(file('/big'), local)) === 'TOO_BIG');
    check('too big (no size given) stops', (await code(file('/big-no-size'), local)) === 'TOO_BIG');

    const zipped = await fetchSource(web('/gzip'), local);
    check('compressed page is unzipped', zipped.fileType === 'html' && zipped.bytes.toString() === HTML_PAGE);
    check('compressed bomb stops at the size limit', (await code(web('/gzip-bomb'), local)) === 'TOO_BIG');

    check('slow site stops at the time limit', (await code(web('/slow'), { ...local, timeoutMs: 400 })) === 'TIMEOUT');

    const blocked = await fetchSource(web('/403'), local);
    check('website that blocks robots: marked blocked for Firecrawl', blocked.blocked && blocked.blocked.status === 403 && blocked.bytes === null);
    check('file that is blocked stops', (await code(file('/403'), local)) === 'BLOCKED_BY_SITE');
    check('login page stops', (await code(web('/401'), local)) === 'LOGIN_NEEDED');
    check('missing page stops', (await code(web('/404'), local)) === 'LINK_NOT_FOUND');
    check('server error stops', (await code(web('/500'), local)) === 'HTTP_ERROR');
    check('empty reply stops', (await code(file('/empty'), local)) === 'EMPTY_DOWNLOAD');
    check('image stops as not supported', (await code(file('/png'), local)) === 'UNSUPPORTED_CONTENT');
  } finally {
    server.close();
  }

  // Uploaded files
  const storage = fakeStorage({
    [`${CLIENT}/1787056410922.pdf`]: PDF_BYTES,
    [`${CLIENT}/big.pdf`]: Buffer.concat([PDF_BYTES, Buffer.alloc(2000, 65)]),
    [`${OTHER_CLIENT}/theirs.pdf`]: PDF_BYTES,
  });
  const uploaded = (p) => ({ kind: 'file', clientId: CLIENT, storagePath: p });
  const up = await fetchSource(uploaded(`${CLIENT}/1787056410922.pdf`), { db: storage });
  check('uploaded pdf is downloaded', up.kind === 'file' && up.fileType === 'pdf' && up.fileName === '1787056410922.pdf');
  check('file of another client is refused', (await code(uploaded(`${OTHER_CLIENT}/theirs.pdf`), { db: storage })) === 'WRONG_FOLDER');
  check('path with ".." is refused', (await code(uploaded(`${CLIENT}/../${OTHER_CLIENT}/theirs.pdf`), { db: storage })) === 'WRONG_FOLDER');
  check('missing uploaded file says so', (await code(uploaded(`${CLIENT}/gone.pdf`), { db: storage })) === 'FILE_NOT_FOUND');
  check('uploaded file over the limit stops', (await code(uploaded(`${CLIENT}/big.pdf`), { db: storage, maxBytes: 1000 })) === 'TOO_BIG');

  // Typed text
  const typed = await fetchSource({ kind: 'text', text: 'Our plan.' });
  check('typed text passes through', typed.kind === 'text' && typed.text === 'Our plan.' && typed.bytes === null);
}

// ── Step 3: readText.js ─────────────────────────────────────────────────

// The sentence the OLD code broke (it deleted "in the US by" and "and it is set to")
const OLD_BUG_SENTENCE = 'The company plans to cut its prices in the US by 10% and it is set to open 5 new stores.';

// What Unstructured sends back for a 4-page PDF (fake, no real call)
function fakeElements() {
  const els = [];
  for (let page = 1; page <= 4; page += 1) {
    els.push({ type: 'Header', text: 'Australian Cosmetics Report 2026', metadata: { page_number: page } });
    els.push({ type: 'UncategorizedText', text: 'Confidential, Nielsen 2026', metadata: { page_number: page } });
    els.push({ type: 'PageNumber', text: String(page), metadata: { page_number: page } });
  }
  els.push({ type: 'Title', text: 'Market overview', metadata: { page_number: 1 } });
  els.push({ type: 'NarrativeText', text: OLD_BUG_SENTENCE, metadata: { page_number: 1 } });
  els.push({ type: 'NarrativeText', text: 'The ﬁnance team saw growth\nin skincare,  mostly in   Sydney.', metadata: { page_number: 2 } });
  els.push({ type: 'ListItem', text: 'Sun care up 12%', metadata: { page_number: 2 } });
  els.push({ type: 'Table', text: 'Brand Share A 10% B 20%', metadata: { page_number: 3, text_as_html: '<table><tr><th>Brand</th><th>Share</th></tr><tr><td>A</td><td>10%</td></tr><tr><td>B</td><td>20%</td></tr></table>' } });
  els.push({ type: 'Image', text: 'chart', metadata: { page_number: 3 } });
  els.push({ type: 'NarrativeText', text: '   ', metadata: { page_number: 3 } });
  els.push({ type: 'NarrativeText', text: 'Outlook for 2027 is positive.', metadata: { page_number: 4 } });
  els.push({ type: 'Footer', text: 'www.example.com', metadata: { page_number: 4 } });
  return els;
}

// A normal news page: menu, article, side box, footer
function newsPage(articleParagraphs) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Beauty market news | Example News</title>
  <meta property="article:published_time" content="2026-10-02T09:00:00Z">
  <script>globalThis.PAGE_SCRIPT_RAN = true;</script></head>
  <body>
    <nav><ul><li><a href="/">Home</a></li><li><a href="/world">World</a></li><li><a href="/login">Sign in to your account</a></li></ul></nav>
    <header><div>Subscribe now for full access</div></header>
    <main><article>
      <h1>Skincare sales rise in Australia</h1>
      ${articleParagraphs.map((p) => `<p>${p}</p>`).join('\n')}
      <h2>Shares by brand</h2>
      <table><tr><th>Brand</th><th>Share</th></tr><tr><td>Alpha</td><td>31%</td></tr></table>
    </article></main>
    <aside><p>Most read: celebrity gossip of the week</p></aside>
    <footer><p>Copyright 2026 Example News. All rights reserved. Privacy policy. Terms.</p></footer>
  </body></html>`;
}
const ARTICLE = [
  'Skincare sales in Australia grew by 8% in the third quarter of 2026, led by sun care and serums, according to the latest retail figures released this week.',
  'Retailers in Sydney and Melbourne said demand for mineral sunscreen was strongest among shoppers aged 25 to 34, with online orders up sharply compared with last year.',
  'Analysts expect the trend to continue into 2027 as brands launch new products with local ingredients and refill packs that cut plastic waste in stores.',
  OLD_BUG_SENTENCE,
];

async function testReadText() {
  console.log('\nStep 3: readText.js');
  const job = { sourceName: 'Australian Cosmetics PDF', url: 'https://news.example.com/a' };

  // Cleaning
  check('cleaning keeps every small word (the old bug)', cleanText(OLD_BUG_SENTENCE) === OLD_BUG_SENTENCE);
  check('cleaning fixes the "fi" ligature', cleanText('ﬁnance') === 'finance');
  check('cleaning removes extra spaces and invisible characters', cleanText('  a   b​\tc \u0007') === 'a b c');
  check('table html becomes rows', tableRows('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td> 2 </td></tr></table>') === 'A | B\n1 | 2');

  // Files (fake Unstructured)
  let sentName = null;
  const partition = async (bytes, fileName) => { sentName = fileName; return fakeElements(); };
  const file = await readText(job, { kind: 'file', bytes: Buffer.from('%PDF'), fileName: 'report.pdf' }, { partition });
  const texts = file.parts.map((p) => p.text);
  check('file: reader is unstructured, file name sent', file.reader === 'unstructured' && sentName === 'report.pdf');
  check('file: title is the source name', file.title === 'Australian Cosmetics PDF');
  check('file: header, footer, page number and image parts are left out',
    !texts.some((t) => ['Australian Cosmetics Report 2026', 'www.example.com', 'chart', '1', '2'].includes(t)), texts.join(' / '));
  check('file: a running line on every page (not labelled) is removed', !texts.includes('Confidential, Nielsen 2026'));
  check('file: the removal is written in the notes', file.notes.some((n) => n.includes('Confidential, Nielsen 2026')), file.notes.join(' '));
  check('file: the left-out labels are written in the notes', file.notes.some((n) => n.includes('4 Header') && n.includes('1 Footer')), file.notes.join(' '));
  check('file: the old-bug sentence is kept whole', texts.includes(OLD_BUG_SENTENCE));
  check('file: broken lines joined, ligature fixed', texts.includes('The finance team saw growth in skincare, mostly in Sydney.'), texts.join(' / '));
  check('file: page numbers kept', file.parts.find((p) => p.text.startsWith('Outlook')).page === 4);
  check('file: title and list labels kept', file.parts[0].type === 'title' && file.parts.some((p) => p.type === 'list' && p.text === 'Sun care up 12%'));
  check('file: table kept as rows', file.parts.some((p) => p.type === 'table' && p.text === 'Brand | Share\nA | 10%\nB | 20%'));
  check('file: empty parts dropped', !texts.includes(''));
  check('file: page count and characters per page', file.pageCount === 4 && file.pageChars[1] > 0 && file.pageChars[4] > 0, JSON.stringify(file.pageChars));

  // Bullets (found in the first real PDF: the bullet font came out as "¢")
  check('bullet "¢ " is removed', stripBullet('¢ Audit all labels.').text === 'Audit all labels.' && stripBullet('¢ Audit all labels.').isBullet);
  check('bullets "• ▪ * · ► –" are removed', ['• A', '▪ A', '* A', '· A', '► A', '– A'].every((t) => stripBullet(t).text === 'A'), ['• A', '▪ A', '* A', '· A', '► A', '– A'].map((t) => stripBullet(t).text).join(','));
  check('money is not a bullet ("$ 5", "£ 20")', !stripBullet('$ 5 off all serums').isBullet && !stripBullet('£ 20 price cap').isBullet);
  check('normal text is not a bullet', !stripBullet('Audit all labels.').isBullet && !stripBullet('"Quoted" text').isBullet && !stripBullet('(a) first point').isBullet);
  const bulletFile = await readText(job, { kind: 'file', bytes: Buffer.from('x'), fileName: 'a.pdf' }, {
    partition: async () => [
      { type: 'ListItem', text: '¢ Audit all labels against the new rules.', metadata: { page_number: 3 } },
      { type: 'NarrativeText', text: '• Train regional teams before the deadlines.', metadata: { page_number: 3 } },
    ],
  });
  check('file: bullet symbol removed from list items', bulletFile.parts[0].text === 'Audit all labels against the new rules.' && bulletFile.parts[0].type === 'list');
  check('file: a text part starting with a bullet becomes a list item', bulletFile.parts[1].type === 'list' && bulletFile.parts[1].text === 'Train regional teams before the deadlines.');
  const bulletPieces = cutPieces(job, { title: 'T', parts: bulletFile.parts });
  check('pieces: list shows "- Audit ..." (no "- ¢")', bulletPieces.pieces[0].text === '- Audit all labels against the new rules.\n- Train regional teams before the deadlines.', JSON.stringify(bulletPieces.pieces[0].text));
  const typedList = await readText({ sourceName: 'N' }, { kind: 'text', text: 'Actions:\n\n• Audit labels\n• Train teams' });
  check('text: bullet lines become list items', typedList.parts.length === 3 && typedList.parts[1].type === 'list' && typedList.parts[2].text === 'Train teams', JSON.stringify(typedList.parts));

  // A footer that ends with the page number (found in the NIQ PDF)
  const footerParts = [];
  for (let page = 1; page <= 6; page += 1) {
    footerParts.push(textPart(`Real content of page ${page} about beauty sales.`, page));
    footerParts.push(textPart(`Confidential and prop rietary \u00a9 202 6 Nielsen Con sumer LL C. All Rights Reserved. ${page}`, page));
    footerParts.push(textPart('+14%', page));
  }
  const footerResult = removeRepeatedLines(footerParts.map((p) => ({ ...p, text: cleanText(p.text) })), 6);
  const footerLeft = footerResult.parts.map((p) => p.text);
  check('footer with page number at the end is removed on every page', !footerLeft.some((t) => t.includes('All Rights Reserved')), footerLeft.join(' / '));
  check('page content stays (it has page numbers too, but differs)', footerLeft.filter((t) => t.startsWith('Real content of page')).length === 6);
  check('short number lines like "+14%" are never removed as a footer', footerLeft.filter((t) => t === '+14%').length === 6);

  // A 2-page file: too few pages to call anything "repeated"
  const twoPages = await readText(job, { kind: 'file', bytes: Buffer.from('x'), fileName: 'a.pdf' }, {
    partition: async () => [
      { type: 'NarrativeText', text: 'Same line', metadata: { page_number: 1 } },
      { type: 'NarrativeText', text: 'Same line', metadata: { page_number: 2 } },
    ],
  });
  check('file: short files keep lines that appear twice', twoPages.parts.length === 2);

  // Excel sheet names
  const sheet = await readText(job, { kind: 'file', bytes: Buffer.from('x'), fileName: 'a.xlsx' }, {
    partition: async () => [{ type: 'Table', text: 'x', metadata: { page_number: 1, page_name: 'Q3 Sales', text_as_html: '<table><tr><td>A</td><td>1</td></tr></table>' } }],
  });
  check('file: Excel sheet name kept', sheet.parts[0].sheet === 'Q3 Sales' && sheet.parts[0].text === 'A | 1');

  // Unstructured problems
  const code = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return e.code || e.message; } };
  const failWith = (statusCode, message) => async () => { const e = new Error(message); e.statusCode = statusCode; throw e; };
  check('file: broken or locked file says so', (await code(() => readText(job, { kind: 'file', bytes: Buffer.from('x'), fileName: 'a.pdf' }, { partition: failWith(422, 'File is encrypted') }))) === 'READ_FAILED');
  check('file: wrong key or no credits is a service problem', (await code(() => readText(job, { kind: 'file', bytes: Buffer.from('x'), fileName: 'a.pdf' }, { partition: failWith(401, 'API key is invalid') }))) === 'SERVICE_PROBLEM');
  const savedKey = process.env.UNSTRUCTURED_API_KEY;
  delete process.env.UNSTRUCTURED_API_KEY;
  check('file: missing key is a service problem', (await code(() => readText(job, { kind: 'file', bytes: Buffer.from('x'), fileName: 'a.pdf' }))) === 'SERVICE_PROBLEM');
  if (savedKey !== undefined) process.env.UNSTRUCTURED_API_KEY = savedKey;

  // Websites (Readability)
  let firecrawlCalls = 0;
  const noFirecrawl = async () => { firecrawlCalls += 1; return { ok: false, error: 'should not be called' }; };
  const page = await readText(job, { kind: 'website', bytes: Buffer.from(newsPage(ARTICLE)), contentType: 'text/html', finalUrl: 'https://news.example.com/a' }, { firecrawl: noFirecrawl });
  const pageText = page.parts.map((p) => p.text).join(' / ');
  check('website: read by readability, no Firecrawl call', page.reader === 'readability' && firecrawlCalls === 0, `${page.reader} ${firecrawlCalls}`);
  check('website: article paragraphs kept', ARTICLE.every((p) => pageText.includes(p)), pageText);
  check('website: menu, sign-in, side box and footer left out', !/Sign in to your account|Subscribe now|Most read|All rights reserved/.test(pageText), pageText);
  check('website: headings become titles', page.parts.some((p) => p.type === 'title' && p.text === 'Shares by brand'));
  check('website: table kept as rows', page.parts.some((p) => p.type === 'table' && p.text === 'Brand | Share\nAlpha | 31%'));
  check('website: page title kept', /Skincare sales rise in Australia|Beauty market news/.test(page.title), page.title);
  check('website: article date kept', String(page.publishedAt || '').startsWith('2026-10-02'), String(page.publishedAt));
  check('website: scripts in the page never run', globalThis.PAGE_SCRIPT_RAN !== true);

  // Letters in an older character set (windows-1252: e with accent = byte 0xE9)
  const latin = Buffer.concat([
    Buffer.from(newsPage(ARTICLE).replace('<meta charset="utf-8">', '').replace('Skincare sales rise in Australia', 'Lumi_re results')),
  ]);
  latin[latin.indexOf('Lumi_re')+4] = 0xe9;
  const latinPage = await readText(job, { kind: 'website', bytes: latin, contentType: 'text/html; charset=windows-1252', finalUrl: 'https://news.example.com/b' }, { firecrawl: noFirecrawl });
  check('website: older character set read right', latinPage.parts.map((p) => p.text).join(' ').includes('Lumiére results') || latinPage.title.includes('Lumiére'), latinPage.title);

  // Blocked site -> Firecrawl
  let askedFor = null;
  const goodFirecrawl = async (url) => { askedFor = url; return { ok: true, html: newsPage(ARTICLE) }; };
  const viaFc = await readText(job, { kind: 'website', bytes: null, blocked: { status: 403 }, finalUrl: 'https://news.example.com/c' }, { firecrawl: goodFirecrawl });
  check('website blocked: Firecrawl used, note says why', viaFc.reader === 'firecrawl' && askedFor === 'https://news.example.com/c' && viaFc.notes.some((n) => n.includes('403')), viaFc.notes.join(' '));
  check('website blocked: article read from the Firecrawl page', viaFc.parts.some((p) => p.text === ARTICLE[0]));

  // Too little text (robot check page) -> Firecrawl
  const robotPage = '<html><head><title>Just a moment</title></head><body><p>Checking your browser.</p></body></html>';
  const thin = await readText(job, { kind: 'website', bytes: Buffer.from(robotPage), contentType: 'text/html', finalUrl: 'https://news.example.com/d' }, { firecrawl: goodFirecrawl });
  check('website with too little text: Firecrawl used', thin.reader === 'firecrawl' && thin.parts.some((p) => p.text === ARTICLE[1]));

  // Firecrawl also fails
  const badFirecrawl = async () => ({ ok: false, error: 'no credits' });
  check('website blocked and Firecrawl fails: clear message', (await code(() => readText(job, { kind: 'website', bytes: null, blocked: { status: 403 }, finalUrl: 'https://x.example.com' }, { firecrawl: badFirecrawl }))) === 'BLOCKED_BY_SITE');
  const emptyPage = '<html><head><title>App</title></head><body><div id="root"></div></body></html>';
  check('website with no text and Firecrawl fails: clear message', (await code(() => readText(job, { kind: 'website', bytes: Buffer.from(emptyPage), contentType: 'text/html', finalUrl: 'https://x.example.com' }, { firecrawl: badFirecrawl }))) === 'NO_TEXT');
  const keptThin = await readText(job, { kind: 'website', bytes: Buffer.from(robotPage), contentType: 'text/html', finalUrl: 'https://x.example.com' }, { firecrawl: badFirecrawl });
  check('website with a little text and Firecrawl fails: little text kept, with a note', keptThin.charCount > 0 && keptThin.notes.some((n) => n.includes('Only a little text')), keptThin.notes.join(' '));

  // Typed text
  const typed = await readText({ sourceName: 'Notes' }, { kind: 'text', text: '# Plan 2027\n\nWe will grow in Sydney.\nAnd in Perth.\n\n\n  \n\nBudget is fixed.' });
  check('text: heading and paragraphs', typed.reader === 'text' && typed.parts.length === 3 && typed.parts[0].type === 'title' && typed.parts[0].text === 'Plan 2027', JSON.stringify(typed.parts));
  check('text: lines in one paragraph joined', typed.parts[1].text === 'We will grow in Sydney. And in Perth.');
  check('text: no page numbers', typed.parts.every((p) => p.page === null) && typed.pageCount === 0);
}

// ── Step 4: checkText.js ────────────────────────────────────────────────

// A fake readText.js result: one part per page, with the given text per page
function readOf(pageTexts, extra = {}) {
  const parts = [];
  const pageChars = {};
  pageTexts.forEach((text, i) => {
    if (!text) return;
    parts.push({ type: 'text', page: i + 1, sheet: null, text });
    pageChars[i + 1] = text.length;
  });
  return { reader: 'unstructured', parts, pageCount: pageTexts.length, pageChars, notes: [], ...extra };
}
const PAGE = 'Skincare sales in Australia grew by 8% in the third quarter of 2026, led by sun care and serums, according to the latest retail figures. ';
const pdf = { kind: 'file', fileType: 'pdf' };

function testCheckText() {
  console.log('\nStep 4: checkText.js');

  const good = checkText(pdf, readOf([PAGE, PAGE, PAGE], { notes: ['Left out parts marked as not content: 3 Header.'] }));
  check('good pdf: ok, no problems', good.status === 'ok' && good.problems.length === 0, good.message);
  check('good pdf: summary counts', good.summary.pages === 3 && good.summary.parts === 3 && good.summary.chars > 300);
  check('good pdf: notes from the reader are kept in the message', good.message.includes('3 Header'), good.message);
  check('good pdf: message starts with what was read', good.message.startsWith('Read 3 pages,'), good.message);

  const nothing = checkText(pdf, readOf(['', '', '']));
  check('pdf with no text: failed, says scanned', nothing.status === 'failed' && nothing.problems[0].code === 'NO_TEXT' && /scanned/.test(nothing.message), nothing.message);
  check('website with no text: failed', checkText({ kind: 'website', fileType: 'html' }, { reader: 'readability', parts: [], pageCount: 0, pageChars: {}, notes: [] }).status === 'failed');

  const scanned = checkText(pdf, readOf(['Page title', 'A', 'B', 'C', 'Logo']));
  check('pdf with very little text per page: warning "looks scanned"', scanned.status === 'warning' && scanned.problems.some((p) => p.code === 'LOOKS_SCANNED'), scanned.message);
  check('very little text overall: warning', scanned.problems.some((p) => p.code === 'LITTLE_TEXT'));

  const tenPages = [PAGE, '', PAGE, PAGE, PAGE, PAGE, PAGE, PAGE, PAGE, PAGE];
  const oneEmpty = checkText(pdf, readOf(tenPages));
  check('one empty page in ten: still ok, listed in the notes', oneEmpty.status === 'ok' && oneEmpty.notes.includes('Pages with no text: 2.'), oneEmpty.message);

  const manyEmpty = checkText(pdf, readOf([PAGE, '', '', PAGE, '', PAGE, PAGE, PAGE, PAGE, PAGE]));
  check('three empty pages in ten: warning with the page numbers', manyEmpty.status === 'warning' && manyEmpty.problems.some((p) => p.code === 'EMPTY_PAGES' && p.message.includes('2, 3, 5')), manyEmpty.message);

  const broken = checkText(pdf, readOf([' �� abc '.repeat(30)]));
  check('broken font (many unreadable characters): failed', broken.status === 'failed' && broken.problems.some((p) => p.code === 'BROKEN_TEXT'), broken.message);

  const someOdd = checkText(pdf, readOf([PAGE + '�'.repeat(12)]));
  check('a few unreadable characters: warning', someOdd.status === 'warning' && someOdd.problems.some((p) => p.code === 'ODD_CHARACTERS'), someOdd.message);

  check('normal text in other languages and symbols is not junk',
    junkShare('Crème brûlée, 日本の化粧品, ₹500, 10% — “quoted” • bullet') === 0);

  const typed = checkText({ kind: 'text', fileType: 'text' }, { reader: 'text', parts: [{ type: 'text', page: null, sheet: null, text: 'Focus on Sydney.' }], pageCount: 0, pageChars: {}, notes: [] });
  check('short typed note: ok (no "little text" warning)', typed.status === 'ok', typed.message);

  const shortPage = checkText({ kind: 'website', fileType: 'html' }, { reader: 'readability', parts: [{ type: 'text', page: null, sheet: null, text: 'Short page.' }], pageCount: 0, pageChars: {}, notes: [] });
  check('short web page: warning', shortPage.status === 'warning' && shortPage.problems[0].code === 'LITTLE_TEXT');

  const deck = checkText({ kind: 'file', fileType: 'pptx' }, readOf(['Q3 plan', 'Growth', 'Risks', 'Next steps'].map((t) => `${t}: ${PAGE}`)));
  check('slides are not called scanned', !deck.problems.some((p) => p.code === 'LOOKS_SCANNED'));
}

// ── Step 5: cutPieces.js ────────────────────────────────────────────────

// A sentence of about 18 words with its own number, so we can follow it
const sentence = (n) => `Sentence ${n} says that sales in region ${n} grew by ${n % 40}% over the last quarter of the year.`;
const paragraph = (from, count) => Array.from({ length: count }, (_, i) => sentence(from + i)).join(' ');
const textPart = (text, page = 1, extra = {}) => ({ type: 'text', page, sheet: null, text, ...extra });

// Every word of the text must be in the pieces, in order.
// A piece may start with the end of the piece before (the repeated sentence).
function coversAllWords(pieces, allText) {
  const words = allText.split(/\s+/).filter(Boolean);
  let at = 0;
  for (const piece of pieces) {
    const own = piece.text.split(/\s+/).filter(Boolean);
    let overlap = 0;
    for (let k = Math.min(own.length, 60, at); k > 0; k -= 1) {
      if (own.slice(0, k).join(' ') === words.slice(at - k, at).join(' ')) { overlap = k; break; }
    }
    const rest = own.slice(overlap);
    if (rest.join(' ') !== words.slice(at, at + rest.length).join(' ')) return `piece ${piece.pieceNo} does not continue the text`;
    at += rest.length;
  }
  return at === words.length ? true : `only ${at} of ${words.length} words are in the pieces`;
}

function testCutPieces() {
  console.log('\nStep 5: cutPieces.js');
  const job = { sourceName: 'Australian Cosmetics PDF' };

  // Sentences
  check('sentences: "Dr." and "e.g." do not cut a sentence', JSON.stringify(sentencesOf('Sales grew 8.5% in Q3. Dr. Lee said e.g. serums led. Prices fell!'))
    === JSON.stringify(['Sales grew 8.5% in Q3.', 'Dr. Lee said e.g. serums led.', 'Prices fell!']), JSON.stringify(sentencesOf('Sales grew 8.5% in Q3. Dr. Lee said e.g. serums led. Prices fell!')));
  check('sentences: the old-bug sentence stays whole', sentencesOf(OLD_BUG_SENTENCE).length === 1);

  // A long text: 120 sentences in 6 paragraphs over 3 pages
  const parts = [];
  for (let p = 0; p < 6; p += 1) parts.push(textPart(paragraph(p * 20 + 1, 20), Math.floor(p / 2) + 1));
  const long = cutPieces(job, { title: 'Australian Cosmetics PDF', parts });
  const all = parts.map((p) => p.text).join(' ');
  check('long text: cut into several pieces', long.pieces.length >= 10, `${long.pieces.length} pieces`);
  check('long text: no piece over the maximum', long.pieces.every((p) => p.wordCount <= 200), long.pieces.map((p) => p.wordCount).join(','));
  check('long text: pieces are a useful size', long.pieces.slice(0, -1).every((p) => p.wordCount >= 120), long.pieces.map((p) => p.wordCount).join(','));
  check('long text: every piece ends at a sentence end', long.pieces.every((p) => /[.!?]$/.test(p.text)));
  check('long text: every piece starts at a sentence start', long.pieces.every((p) => /^Sentence \d+ says/.test(p.text)));
  const covered = coversAllWords(long.pieces, all);
  check('long text: no words lost, all in order', covered === true, covered);
  const lastOfFirst = sentencesOf(long.pieces[0].text).pop();
  check('long text: next piece starts with the last sentence of the piece before', long.pieces[1].text.startsWith(lastOfFirst), lastOfFirst);
  check('long text: piece numbers 1, 2, 3 ...', long.pieces.every((p, i) => p.pieceNo === i + 1));
  check('long text: pages from and to', long.pieces[0].pageFrom === 1 && long.pieces[long.pieces.length - 1].pageTo === 3);
  check('long text: a piece over a page break has both pages', long.pieces.some((p) => p.pageFrom === 1 && p.pageTo === 2));
  check('long text: note says how many pieces', long.notes[0].startsWith(`Cut into ${long.pieces.length} pieces`));

  // Headings
  const sections = cutPieces(job, { title: 'Report', parts: [
    { type: 'title', page: 1, sheet: null, text: 'Chapter 2' },
    { type: 'title', page: 1, sheet: null, text: 'Market overview' },
    textPart(paragraph(1, 12), 1),
    { type: 'title', page: 2, sheet: null, text: 'Risks' },
    textPart(paragraph(100, 3), 2),
    { type: 'title', page: 2, sheet: null, text: 'A very long line marked as a title by the reader '.repeat(6) },
  ] });
  const risk = sections.pieces.find((p) => p.heading === 'Risks');
  check('headings: two headings in a row are kept together', sections.pieces[0].heading === 'Chapter 2 › Market overview');
  check('headings: a new heading starts a new piece', risk && risk.text.startsWith('Sentence 100 says'), risk && risk.text.slice(0, 40));
  check('headings: no piece mixes two sections', !sections.pieces.some((p) => p.heading === 'Chapter 2 › Market overview' && p.text.includes('Sentence 100 says')));
  check('headings: a very long "title" is kept as text', sections.pieces.some((p) => p.text.includes('A very long line marked as a title')));
  check('headings: search text has the title and the heading', risk.searchText.startsWith('Report › Risks: Sentence 100'), risk.searchText.slice(0, 50));
  check('headings: the stored text has no title added', !risk.text.includes('Report'));

  // A tiny last piece of a section joins the piece before
  const tiny = cutPieces(job, { title: 'T', parts: [textPart(paragraph(1, 9)), textPart('Short end.')] });
  check('tiny end piece joins the piece before', tiny.pieces.length === 1 && tiny.pieces[0].text.endsWith('Short end.'), tiny.pieces.map((p) => p.wordCount).join(','));
  const tinyOther = cutPieces(job, { title: 'T', parts: [textPart(paragraph(1, 9)), { type: 'title', page: 1, sheet: null, text: 'Next' }, textPart('Short end.')] });
  check('a crumb under another heading joins the piece before, with its heading as a line', tinyOther.pieces.length === 1 && tinyOther.pieces[0].text.endsWith('\nNext\nShort end.'), JSON.stringify(tinyOther.pieces.map((p) => p.text.slice(-30))));
  const smallOther = cutPieces(job, { title: 'T', parts: [textPart(paragraph(1, 9)), { type: 'title', page: 1, sheet: null, text: 'Next' }, textPart(paragraph(50, 1))] });
  check('a small section (not a crumb) under another heading stays its own piece', smallOther.pieces.length === 2 && smallOther.pieces[1].heading === 'Next', smallOther.pieces.map((p) => `${p.heading}:${p.wordCount}`).join(','));

  // A tiny last piece that starts with the repeated sentence: no double sentence after joining
  const edge = cutPieces(job, { title: 'T', parts: [textPart(paragraph(1, 9) + ' ' + sentence(10)), textPart('Short end.')] });
  const edgeText = edge.pieces.map((p) => p.text).join(' ');
  check('joining never repeats a sentence twice in one piece', edge.pieces.every((p) => (p.text.match(/Sentence 10 says/g) || []).length <= 1), edgeText.slice(-200));
  const edgeCovered = coversAllWords(edge.pieces, paragraph(1, 9) + ' ' + sentence(10) + ' Short end.');
  check('joining loses no words', edgeCovered === true, edgeCovered);

  // One giant sentence with no full stop
  const giant = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
  const big = cutPieces(job, { title: 'T', parts: [textPart(giant)] });
  check('giant sentence: cut, no piece over the maximum', big.pieces.length >= 3 && big.pieces.every((p) => p.wordCount <= 200), big.pieces.map((p) => p.wordCount).join(','));
  check('giant sentence: no words lost', coversAllWords(big.pieces, giant) === true);

  // Tables
  const rows = ['Brand | Share | Change'].concat(Array.from({ length: 60 }, (_, i) => `Brand ${i} | ${i}% | up ${i % 7} points`));
  const table = cutPieces(job, { title: 'T', parts: [textPart(paragraph(1, 3)), { type: 'table', page: 3, sheet: null, text: rows.join('\n') }, textPart(paragraph(50, 3))] });
  const tablePieces = table.pieces.filter((p) => p.text.startsWith('Brand | Share | Change'));
  check('big table: cut into several pieces', tablePieces.length >= 2, `${tablePieces.length}`);
  check('big table: header row in every table piece', tablePieces.every((p) => p.text.split('\n')[0] === 'Brand | Share | Change'));
  check('big table: no piece over the maximum', table.pieces.every((p) => p.wordCount <= 200));
  const seenRows = tablePieces.flatMap((p) => p.text.split('\n').slice(1));
  check('big table: every row is there once', seenRows.length === 60 && new Set(seenRows).size === 60, `${seenRows.length}`);
  check('big table: text before and after is not mixed into the table', !tablePieces.some((p) => p.text.includes('Sentence')));
  check('big table: page number kept', tablePieces.every((p) => p.pageFrom === 3));

  // Lists and sheets
  const list = cutPieces(job, { title: 'T', parts: [textPart('Top products:'), { type: 'list', page: 1, sheet: null, text: 'Sun care up 12%' }, { type: 'list', page: 1, sheet: null, text: 'Serums up 9%' }] });
  check('lists: one item per line with "- "', list.pieces[0].text === 'Top products:\n- Sun care up 12%\n- Serums up 9%', JSON.stringify(list.pieces[0].text));
  const sheets = cutPieces(job, { title: 'Sales', parts: [textPart('North did well.', 1, { sheet: 'Q3' }), textPart('South did well.', 2, { sheet: 'Q4' })] });
  check('sheets: a new sheet starts a new piece', sheets.pieces.length === 2 && sheets.pieces[1].sheet === 'Q4');
  check('sheets: search text has the sheet name', sheets.pieces[1].searchText === 'Sales › Q4: South did well.');

  check('nothing to cut gives no pieces', cutPieces(job, { title: 'T', parts: [] }).pieces.length === 0);
  check('word count helper', countWords('  a b\nc ') === 3 && countWords('') === 0);
}

// ── Steps 6 and 7: saveSource.js, reportRun.js, runSource.js ────────────

// An in-memory database: just enough of the Supabase client for these steps.
// failOn = { 'insert:custom_source_pieces': 'message' } makes that call fail.
function memoryDb(tables = {}, failOn = {}, files = {}) {
  const data = { 'admin.custom_data_sources': [], 'admin.clients': [], 'public.custom_source_documents': [], 'public.custom_source_pieces': [], 'public.custom_source_run_log': [], ...tables };
  const table = (schemaName, name) => {
    const full = `${schemaName}.${name}`;
    if (!data[full]) data[full] = [];
    const filters = [];
    let action = 'select';
    let payload = null;
    const matches = (row) => filters.every(([op, c, v]) => (op === 'eq' ? row[c] === v : op === 'in' ? v.includes(row[c]) : row[c] !== v));
    const run = () => {
      const fail = failOn[`${action}:${name}`];
      if (fail) return { data: null, error: { message: fail } };
      if (action === 'insert') {
        data[full].push(...(Array.isArray(payload) ? payload : [payload]).map((r) => ({ ...r })));
        return { data: null, error: null };
      }
      if (action === 'update') {
        data[full].filter(matches).forEach((r) => Object.assign(r, payload));
        return { data: null, error: null };
      }
      if (action === 'delete') {
        const gone = data[full].filter(matches);
        data[full] = data[full].filter((r) => !matches(r));
        if (full === 'public.custom_source_documents') { // on delete cascade
          const ids = new Set(gone.map((d) => d.id));
          data['public.custom_source_pieces'] = data['public.custom_source_pieces'].filter((p) => !ids.has(p.document_id));
        }
        return { data: null, error: null };
      }
      return { data: data[full].filter(matches), error: null };
    };
    const q = {
      select() { return q; },
      insert(rows) { action = 'insert'; payload = rows; return q; },
      update(values) { action = 'update'; payload = values; return q; },
      delete() { action = 'delete'; return q; },
      eq(c, v) { filters.push(['eq', c, v]); return q; },
      neq(c, v) { filters.push(['neq', c, v]); return q; },
      in(c, v) { filters.push(['in', c, v]); return q; },
      async maybeSingle() { const r = run(); return { data: r.data ? r.data[0] || null : null, error: r.error }; },
      then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
    };
    return q;
  };
  return {
    data,
    schema(schemaName) { return { from: (name) => table(schemaName, name) }; },
    from(name) { return table('public', name); },
    storage: fakeStorage(files).storage,
  };
}

// An in-memory Qdrant
function memoryQdrant(failUpsert = false) {
  const collections = {};
  const matchesFilter = (point, filter = {}) => {
    const is = (cond) => point.payload[cond.key] === cond.match.value;
    return (filter.must || []).every(is) && !(filter.must_not || []).some(is);
  };
  return {
    collections,
    async getCollections() { return { collections: Object.keys(collections).map((name) => ({ name })) }; },
    async createCollection(name, options) { collections[name] = { options, points: new Map() }; },
    async createPayloadIndex() {},
    async upsert(name, { points }) {
      if (failUpsert) throw new Error('Qdrant is down');
      points.forEach((p) => collections[name].points.set(p.id, p));
    },
    async delete(name, { filter }) {
      for (const [id, p] of collections[name].points) if (matchesFilter(p, filter)) collections[name].points.delete(id);
    },
    async search(name, { vector, limit, score_threshold: minScore, filter }) {
      if (!collections[name]) throw new Error(`Collection ${name} not found`);
      this.lastFilter = filter;
      const cosine = (a, b) => a.reduce((t, x, i) => t + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b) || 1);
      const fits = (p) => (filter.must || []).every((c) => (c.match.any ? c.match.any.includes(p.payload[c.key]) : p.payload[c.key] === c.match.value));
      return [...collections[name].points.values()].filter(fits)
        .map((p) => ({ id: p.id, score: cosine(vector, p.vector), payload: p.payload }))
        .filter((h) => h.score >= minScore).sort((a, b) => b.score - a.score).slice(0, limit);
    },
    points(name = 'custom_source_pieces') { return [...collections[name].points.values()]; },
  };
}

// A fake search model: a vector of the right size, and a list of what it was asked
function fakeEmbed(size = 384) {
  const asked = [];
  const embed = async (text) => { asked.push(text); return Array.from({ length: size }, (_, i) => (i === 0 ? text.length : 0)); };
  return { embed, asked };
}

function savedInput(sourceId, clientId, sentences = 30) {
  const job = { sourceId, clientId, sourceName: 'Plan 2027', sourceType: 'text', kind: 'text', url: null };
  const read = { title: 'Plan 2027', reader: 'text', parts: [{ type: 'title', page: null, sheet: null, text: 'Growth' }, textPart(paragraph(1, sentences), null)], pageCount: 0, pageChars: {}, notes: [] };
  const check = checkText({ kind: 'text', fileType: 'text' }, read);
  const cut = cutPieces(job, read);
  return { job, read, check, cut };
}

async function testSaveAndRun() {
  console.log('\nSteps 6 and 7: saveSource.js, reportRun.js, runSource.js');
  const SRC = id(1);
  const OTHER_SRC = id(2);
  const db = memoryDb();
  const qdrant = memoryQdrant();
  const model = fakeEmbed();
  const deps = { db, qdrant, embed: model.embed };
  const docs = () => db.data['public.custom_source_documents'];
  const pieceRows = () => db.data['public.custom_source_pieces'];

  // First save
  const input = savedInput(SRC, CLIENT);
  const first = await saveSource(input, deps);
  check('save: collection made with 384-size vectors', qdrant.collections.custom_source_pieces && qdrant.collections.custom_source_pieces.options.vectors.size === 384);
  check('save: one document row with the check result', docs().length === 1 && docs()[0].check_status === 'ok' && docs()[0].client_id === CLIENT && docs()[0].piece_count === input.cut.pieces.length);
  check('save: one piece row per piece', pieceRows().length === input.cut.pieces.length && pieceRows().every((r) => r.document_id === first.documentId && r.client_id === CLIENT));
  check('save: one vector per piece', qdrant.points().length === input.cut.pieces.length);
  check('save: every vector has client, source, document and text', qdrant.points().every((p) => p.payload.client_id === CLIENT && p.payload.source_id === SRC && p.payload.document_id === first.documentId && p.payload.text));
  check('save: vector id = piece row id (easy to link)', qdrant.points().every((p) => pieceRows().some((r) => r.id === p.id)));
  check('save: the search model read the search text (title + heading)', model.asked.every((t) => t.startsWith('Plan 2027 › Growth: ')), model.asked[0]);

  // Another source of the same client: must never be touched
  await saveSource(savedInput(OTHER_SRC, CLIENT, 5), deps);
  const otherPoints = () => qdrant.points().filter((p) => p.payload.source_id === OTHER_SRC).length;
  const otherBefore = otherPoints();

  // Second run of the same source: the old version is removed after the new one is saved
  const second = await saveSource(savedInput(SRC, CLIENT, 12), deps);
  const srcDocs = docs().filter((d) => d.source_id === SRC);
  check('re-run: only the new document is left', srcDocs.length === 1 && srcDocs[0].id === second.documentId);
  check('re-run: old piece rows are gone', !pieceRows().some((r) => r.document_id === first.documentId));
  check('re-run: old vectors are gone, new ones are there', !qdrant.points().some((p) => p.payload.document_id === first.documentId) && qdrant.points().some((p) => p.payload.document_id === second.documentId));
  check('re-run: the other source is untouched', otherPoints() === otherBefore && otherBefore > 0);

  // Third run fails while sending the vectors: the old version stays
  const code = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return e.message; } };
  const brokenQdrant = memoryQdrant();
  Object.assign(brokenQdrant.collections, qdrant.collections);
  brokenQdrant.upsert = async () => { throw new Error('Qdrant is down'); };
  const failMsg = await code(() => saveSource(savedInput(SRC, CLIENT, 20), { ...deps, qdrant: brokenQdrant }));
  check('failed save: the error comes back', failMsg.includes('Qdrant is down'), failMsg);
  check('failed save: the half-written new document is removed', docs().filter((d) => d.source_id === SRC).length === 1 && docs().some((d) => d.id === second.documentId));
  check('failed save: the old pieces and vectors are still there', pieceRows().some((r) => r.document_id === second.documentId) && qdrant.points().some((p) => p.payload.document_id === second.documentId));

  // The search model fails: nothing is written
  const countBefore = docs().length;
  await code(() => saveSource(savedInput(SRC, CLIENT), { ...deps, embed: async () => { throw new Error('model missing'); } }));
  check('model fails: nothing new is written', docs().length === countBefore);
  const sizeMsg = await code(() => saveSource(savedInput(SRC, CLIENT), { ...deps, embed: fakeEmbed(768).embed }));
  check('wrong vector size: stops with a clear message', /size 768, expected 384/.test(sizeMsg) && docs().length === countBefore, sizeMsg);

  // The browser-key problem gets a hint
  const rlsMsg = await code(() => saveSource(savedInput(id(3), CLIENT), { db: memoryDb({}, { 'insert:custom_source_documents': 'new row violates row-level security policy' }), qdrant: memoryQdrant(), embed: model.embed }));
  check('row security error: says the backend key must be the service key', /service key/.test(rlsMsg), rlsMsg);

  // Reporting
  const rdb = memoryDb({ 'admin.custom_data_sources': [source(1, { last_run_status: null, last_article_id: 'old-doc' })] });
  await reportRun({ sourceId: id(1), clientId: CLIENT, sourceName: 'Source 1', status: 'warning', message: 'Read 3 pages. Pages with no text: 2.', documentId: 'new-doc' }, { db: rdb });
  const row = rdb.data['admin.custom_data_sources'][0];
  const log = rdb.data['public.custom_source_run_log'];
  check('report warning: source row says success (the text was saved)', row.last_run_status === 'success' && row.last_article_id === 'new-doc' && row.last_run_at);
  check('report warning: log row says warning with the message', log.length === 1 && log[0].status === 'warning' && log[0].error_message.includes('Pages with no text') && log[0].content_id === 'new-doc');
  await reportRun({ sourceId: id(1), clientId: CLIENT, sourceName: 'Source 1', status: 'failed', message: 'x'.repeat(5000), documentId: null }, { db: rdb });
  check('report failed: source row says failed, keeps the last good document', row.last_run_status === 'failed' && row.last_article_id === 'new-doc');
  check('report failed: long message is shortened', log[1].status === 'failed' && log[1].error_message.length === 3000 && log[1].content_id === null);
  await reportRun({ sourceId: id(1), clientId: CLIENT, status: 'ok', message: 'Fine', documentId: 'd2' }, { db: rdb });
  check('report ok: log says success', log[2].status === 'success');

  // Whole runs (no internet: a text source, and a "PDF" with a fake reader)
  const clients = [{ id: CLIENT }];
  const runDb = memoryDb({
    'admin.clients': clients,
    'admin.custom_data_sources': [
      source(10, { source_type: 'text', source_name: 'Plan notes', text_content: paragraph(1, 25) }),
      source(11, { source_type: 'video', url_or_path: 'https://example.com' }),
      source(12, { source_type: 'pdf', storage_path: `${CLIENT}/scan.pdf` }),
      source(13, { source_type: 'pdf', storage_path: `${CLIENT}/good.pdf` }),
    ],
  }, {}, { [`${CLIENT}/scan.pdf`]: PDF_BYTES, [`${CLIENT}/good.pdf`]: PDF_BYTES });
  const runQdrant = memoryQdrant();
  const runDeps = {
    db: runDb, qdrant: runQdrant, embed: fakeEmbed().embed,
    partition: async (bytes, fileName) => (fileName === 'scan.pdf'
      ? [{ type: 'Image', text: '', metadata: { page_number: 1 } }, { type: 'Image', text: '', metadata: { page_number: 2 } }]
      : fakeElements()),
  };
  const logOf = (n) => runDb.data['public.custom_source_run_log'].filter((l) => l.source_id === id(n));
  const rowOf = (n) => runDb.data['admin.custom_data_sources'].find((r) => r.id === id(n));

  const ok = await runSource(id(10), runDeps);
  check('run text source: ok, pieces saved', ok.status === 'ok' && ok.pieceCount > 0 && runQdrant.points().some((p) => p.payload.source_id === id(10)), ok.message);
  check('run text source: tick in the admin console, log row written', rowOf(10).last_run_status === 'success' && logOf(10)[0].status === 'success');
  check('run text source: message has what was read, the pieces and the time', /^Read \d+ characters/.test(ok.message) && /Cut into \d+ pieces/.test(ok.message) && /\(\d+(\.\d)? s\)$/.test(ok.message), ok.message);

  const pdfRun = await runSource(id(13), runDeps);
  check('run uploaded pdf (little text per page): warning, still saved with page numbers', pdfRun.status === 'warning' && /per page/.test(pdfRun.message) && runQdrant.points().some((p) => p.payload.source_id === id(13) && p.payload.page_from >= 1), pdfRun.message);
  check('run uploaded pdf: the left-out headers are in the log message', /Left out parts marked as not content/.test(logOf(13)[0].error_message));

  const scan = await runSource(id(12), runDeps);
  check('run scanned pdf: failed, nothing saved, message says scanned', scan.status === 'failed' && !runQdrant.points().some((p) => p.payload.source_id === id(12)) && /scanned/.test(logOf(12)[0].error_message), scan.message);
  check('run scanned pdf: Retry in the admin console', rowOf(12).last_run_status === 'failed');

  const bad = await runSource(id(11), runDeps);
  check('run unknown type: failed, log row written under its client with the plain message', bad.status === 'failed' && logOf(11).length === 1 && logOf(11)[0].client_id === CLIENT && /Unknown source type "video"/.test(logOf(11)[0].error_message));
  check('run unknown type: Retry in the admin console', rowOf(11).last_run_status === 'failed');

  const missing = await runSource(id(98), runDeps);
  check('run missing source: failed, no log row (no client to log under)', missing.status === 'failed' && logOf(98).length === 0);

  const crash = await runSource(id(10), { ...runDeps, embed: async () => { throw new Error('model file missing'); } });
  check('run with a crash: failed, "Something went wrong" with the reason', crash.status === 'failed' && /Something went wrong.*model file missing/.test(crash.message));
  check('run with a crash: the last good version is still there', runQdrant.points().some((p) => p.payload.source_id === id(10)) && rowOf(10).last_run_status === 'failed');

  // The same source twice at the same time
  let release;
  const slowDeps = { ...runDeps, embed: async (t) => { await new Promise((r) => { release = r; }); return fakeEmbed().embed(t); } };
  const firstRun = runSource(id(10), slowDeps);
  await new Promise((r) => setTimeout(r, 20));
  const secondRun = await runSource(id(10), runDeps);
  check('same source twice: the second run is skipped', secondRun.status === 'skipped');
  const finishSlow = async () => { while (release) { const r = release; release = null; r(); await new Promise((x) => setTimeout(x, 5)); } };
  await finishSlow();
  await firstRun;
}

// ── Search: searchCustomSources.js ──────────────────────────────────────

// A tiny "meaning" model for tests: one number per topic word
const TOPICS = ['tiktok', 'price', 'skin', 'amazon'];
const topicEmbed = async (text) => {
  const lower = text.toLowerCase();
  const v = Array.from({ length: 384 }, () => 0);
  TOPICS.forEach((word, i) => { if (lower.includes(word)) v[i] = 1; });
  v[383] = 0.01; // never all zero
  return v;
};

async function testSearch() {
  console.log('\nSearch: searchCustomSources.js');
  const qdrant = memoryQdrant();
  const db = memoryDb();
  const save = async (sourceId, clientId, name, texts) => {
    const job = { sourceId, clientId, sourceName: name, sourceType: 'pdf', kind: 'file', url: null };
    const read = { title: name, reader: 'unstructured', parts: texts.map((t, i) => textPart(t, i + 1)), pageCount: texts.length, pageChars: {}, notes: [] };
    const check = { status: 'ok', summary: { chars: 100 }, message: 'ok' };
    await saveSource({ job, read, check, cut: cutPieces(job, read) }, { db, qdrant, embed: topicEmbed });
  };
  await save(id(1), CLIENT, 'NIQ Beauty', ['TikTok Shop sales grew fast.', 'Skin care leads growth.', 'Prices rose in 2025.']);
  await save(id(2), OTHER_CLIENT, 'Other client report', ['TikTok Shop is huge for us.']);

  const sdeps = { db, qdrant, embed: topicEmbed };
  const hits = await searchCustomSources({ question: 'How big is TikTok?', clientId: CLIENT }, sdeps);
  check('search: best piece first, with source and page', hits[0] && hits[0].sourceName === 'NIQ Beauty' && hits[0].pageFrom === 1 && /TikTok/.test(hits[0].text), JSON.stringify(hits[0]));
  check('search: never shows another client\'s pieces', hits.every((h) => h.sourceName !== 'Other client report'));
  check('search: always filters by client', JSON.stringify(qdrant.lastFilter.must[0]) === JSON.stringify({ key: 'client_id', match: { value: CLIENT } }));
  check('search: only live documents are searched', qdrant.lastFilter.must[1].key === 'document_id' && qdrant.lastFilter.must[1].match.any.length === 1);
  const onlySource = await searchCustomSources({ question: 'TikTok', clientId: CLIENT, sourceIds: [id(9)] }, sdeps);
  check('search: can be limited to some sources', onlySource.length === 0);
  const code = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return e.message; } };
  check('search: empty question stops', /empty/.test(await code(() => searchCustomSources({ question: ' ', clientId: CLIENT }, sdeps))));
  check('search: missing client stops', /clientId/.test(await code(() => searchCustomSources({ question: 'x', clientId: '' }, sdeps))));
  const none = await searchCustomSources({ question: 'TikTok', clientId: CLIENT }, { db, qdrant: { search: async () => { throw new Error('Collection custom_source_pieces not found'); } }, embed: topicEmbed });
  check('search: no collection yet gives no results (not a crash)', Array.isArray(none) && none.length === 0);

  // A source deleted in the admin console: its rows are gone, its vectors are still in Qdrant
  const docsBefore = db.data['public.custom_source_documents'].length;
  db.data['public.custom_source_documents'] = db.data['public.custom_source_documents'].filter((d) => d.source_id !== id(1));
  const afterDelete = await searchCustomSources({ question: 'TikTok', clientId: CLIENT }, sdeps);
  check('search: a deleted source never shows up (its vectors are ignored)', afterDelete.length === 0 && qdrant.points().some((p) => p.payload.source_id === id(1)), `${docsBefore} docs before, ${afterDelete.length} hits`);

  // The same file added twice as two sources: the text is shown once
  await save(id(4), CLIENT, 'Copy A', ['TikTok Shop is growing in Asia.']);
  await save(id(5), CLIENT, 'Copy B', ['TikTok Shop is growing in Asia.']);
  const twice = await searchCustomSources({ question: 'TikTok', clientId: CLIENT }, sdeps);
  check('search: the same text from two sources is shown once', twice.filter((h) => h.text === 'TikTok Shop is growing in Asia.').length === 1, twice.map((h) => h.sourceName).join(','));
}

// ── PDFs: readPdf.js (our own reading of the PDF text) ──────────────────

// A text piece on a page: x, y, letter size, width
const at = (text, x, y, size = 10, extra = {}) => ({ text, x, y, size, width: text.length * size * 0.5, rotated: false, bold: false, ...extra });

async function testReadPdf() {
  console.log('\nPDFs: readPdf.js');

  // Lines
  const lines = linesOfPage([
    at('Amazon', 80, 600), at('23.0', 200, 600), at('23.9%', 300, 600.5),
    at('Our sales grew', 80, 580), at('in 2025.', 152, 580),
    at('Number of visible SKUs', 20, 300, 12, { rotated: true }),
  ]);
  check('pdf lines: pieces at the same height make one line', lines[0].text === 'Amazon | 23.0 | 23.9%' && lines[0].cells === 3, JSON.stringify(lines[0]));
  check('pdf lines: a small gap is a space, not a cell', lines[1].text === 'Our sales grew in 2025.' && lines[1].cells === 1, JSON.stringify(lines[1]));
  check('pdf lines: sideways text is kept as its own line', lines[2].text === 'Number of visible SKUs' && lines[2].rotated);
  const boldLine = linesOfPage([at('Liquidity and Capital Resources', 80, 500, 10, { bold: true })])[0];
  check('pdf lines: an all-bold line is marked bold', boldLine.bold === true);

  // Text drawn twice
  const doubled = withoutDoubles([
    at('Source:', 23, 46.9), at('NielsenIQ', 53, 46.9),
    { ...at('Source: NielsenIQ Omnisales, RMS', 23, 46.9), width: 180 },
    at('MAT Nov 2025', 211, 46.9), at('MAT Nov 2025', 211, 46.9),
  ]);
  check('pdf: text drawn twice at the same spot is kept once', doubled.map((i) => i.text).join(' / ') === 'Source: NielsenIQ Omnisales, RMS / MAT Nov 2025', doubled.map((i) => i.text).join(' / '));
  check('pdf: the same word at another spot is kept', withoutDoubles([at('Sales', 10, 100), at('Sales', 300, 100)]).length === 2);

  check('spaced letters "B E A U T Y" are decoration', isSpacedLetters('B E A U T Y') && isSpacedLetters('s U K S e l b i'));
  check('normal text is not spaced letters', !isSpacedLetters('A B testing is a way to compare') && !isSpacedLetters('Q3 2025 sales'));

  // Lines -> parts, over 4 pages with a footer and page numbers
  const CITY = ['Sydney', 'Perth', 'Brisbane', 'Darwin'];
  const pageLines = (n) => linesOfPage([
    at(n === 1 ? 'Market overview' : `Market in ${CITY[n - 1]}`, 80, 750, 18),
    at(`Sales of skincare in ${CITY[n - 1]} grew by 8% in the third quarter, led by sun care and`, 80, 720),
    at(`serums. Retailers in ${CITY[n - 1]} said demand was strong in all age-`, 80, 708),
    at('groups and channels.', 80, 696),
    at(n === 1 ? 'Liquidity and Capital Resources' : `Cash in ${CITY[n - 1]}`, 80, 670, 10, { bold: true }),
    at(`Our cash in ${CITY[n - 1]} was $48.0 billion at the end of the year.`, 80, 655),
    at(n === 1 ? 'Region' : `Region in ${CITY[n - 1]}`, 80, 620), at('Share', 300, 620),
    at('EU', 80, 608), at('31%', 300, 608),
    at(n === 1 ? '• Audit all labels.' : `• Audit labels in ${CITY[n - 1]}.`, 80, 580),
    at(n === 1 ? '• Train regional teams.' : `• Train teams in ${CITY[n - 1]}.`, 80, 568),
    at('Confidential and proprietary, Example Co. All Rights Reserved.', 300, 30, 7), at(String(n), 560, 30, 7),
    at(String(n), 300, 15, 9),
  ]);
  const pages4 = [1, 2, 3, 4].map((n) => ({ page: n, lines: pageLines(n) }));
  const built = partsFromLines(pages4, 4);
  const p1 = built.parts.filter((p) => p.page === 1);
  check('pdf parts: big text is a heading', p1[0].type === 'title' && p1[0].text === 'Market overview');
  check('pdf parts: lines join into one paragraph, a word broken with "-" is joined', p1[1].type === 'text' && p1[1].text === 'Sales of skincare in Sydney grew by 8% in the third quarter, led by sun care and serums. Retailers in Sydney said demand was strong in all age-groups and channels.', p1[1].text);
  check('pdf parts: a short bold line is a heading', p1[2].type === 'title' && p1[2].text === 'Liquidity and Capital Resources');
  check('pdf parts: rows next to each other form one table', p1.some((p) => p.type === 'table' && p.text === 'Region | Share\nEU | 31%'), JSON.stringify(p1));
  check('pdf parts: bullet lines are list items without the bullet', p1.filter((p) => p.type === 'list').map((p) => p.text).join('/') === 'Audit all labels./Train regional teams.');
  check('pdf parts: footer with page number removed on every page', !built.parts.some((p) => p.text.includes('All Rights Reserved')));
  check('pdf parts: page numbers removed', !built.parts.some((p) => /^\d+$/.test(p.text)) && built.notes.some((n) => n.includes('page numbers')), built.notes.join(' '));
  check('pdf parts: the notes say what was removed', built.notes.some((n) => n.includes('Removed 4 repeated lines')), built.notes.join(' '));
  check('pdf parts: a sentence end on every page is not a footer ("groups and channels." stays)', built.parts.filter((p) => p.text.includes('groups and channels.')).length === 4);
  check('pdf parts: page numbers kept on the parts', built.parts.every((p) => p.page >= 1 && p.page <= 4));
  check('pdf parts: characters counted per page', built.pageChars[1] > 100 && built.pageChars[4] > 100);

  // A long sentence printed big is text, not a heading
  const big = partsFromLines([{ page: 1, lines: linesOfPage([at('Beauty is entering 2026 with resilience and a new level of complexity.', 80, 700, 16), at('Body text that is long enough to set the normal size of this page for sure.', 80, 600, 10)]) }], 1);
  check('pdf parts: a big full sentence is text', big.parts[0].type === 'text', JSON.stringify(big.parts[0]));

  // A scanned PDF: most pages have no real text
  const scanned = await readPdf(Buffer.from('x'), { readPages: async () => ({ pageCount: 3, pages: [{ page: 1, items: [] }, { page: 2, items: [at('Logo', 10, 10)] }, { page: 3, items: [] }] }) });
  check('pdf: a scanned PDF asks for reading the pictures', scanned.needsPictureReading === true && scanned.pictures === 3);

  // readText: the PDF route, the scanned route, the fallback
  const job = { sourceName: 'Test PDF' };
  let usedStrategy = 'not called';
  const partition = async (bytes, fileName, strategy) => { usedStrategy = strategy; return [{ type: 'NarrativeText', text: 'Read from pictures.', metadata: { page_number: 1 } }]; };
  const viaScan = await readText(job, { kind: 'file', fileType: 'pdf', bytes: Buffer.from('x'), fileName: 'a.pdf' }, { partition, readPdf: async () => ({ needsPictureReading: true, pictures: 3, pageCount: 3 }) });
  check('scanned PDF: read by Unstructured as pictures (hi_res), with a note', viaScan.reader === 'unstructured' && usedStrategy === 'hi_res' && viaScan.notes[0].includes('3 of 3 pages have no real text'), `${usedStrategy} ${viaScan.notes.join(' ')}`);
  const viaFallback = await readText(job, { kind: 'file', fileType: 'pdf', bytes: Buffer.from('x'), fileName: 'a.pdf' }, { partition, readPdf: async () => { throw new Error('Invalid PDF structure'); } });
  check('broken PDF: Unstructured tries instead, with a note', viaFallback.reader === 'unstructured' && viaFallback.notes[0].includes('could not be read directly'), viaFallback.notes.join(' '));
  const locked = await (async () => { try { await readText(job, { kind: 'file', fileType: 'pdf', bytes: Buffer.from('x'), fileName: 'a.pdf' }, { partition, readPdf: async () => { throw new SourceError('READ_FAILED', 'locked'); } }); return 'OK'; } catch (e) { return e.code; } })();
  check('locked PDF: stops with the message (no Unstructured call)', locked === 'READ_FAILED');

  // A real PDF file (scripts/fixtures/regulatory-compliance-test.pdf)
  const fixture = path.join(__dirname, 'fixtures', 'regulatory-compliance-test.pdf');
  if (!fs.existsSync(fixture)) {
    check('real PDF fixture is there (scripts/fixtures/regulatory-compliance-test.pdf)', false);
    return;
  }
  const real = await readText(job, { kind: 'file', fileType: 'pdf', bytes: fs.readFileSync(fixture), fileName: 'regulatory-compliance-test.pdf' }, { partition: async () => { throw new Error('Unstructured must not be called'); } });
  const realTexts = real.parts.map((p) => p.text);
  check('real PDF: read with PDF.js, 3 pages, no Unstructured call', real.reader === 'pdf-text' && real.pageCount === 3, `${real.reader} ${real.pageCount}`);
  check('real PDF: headings found', real.parts.filter((p) => p.type === 'title').map((p) => p.text).includes('Section 2: Ingredient Restrictions'));
  check('real PDF: the table is exact', realTexts.includes('Region | Change | Deadline\nEU | New allergen labels | Mar 2027\nUK | Preservative limits | Jun 2027\nAPAC | Import testing | Sep 2027'), realTexts.join(' // '));
  check('real PDF: bullets are clean list items (no "¢")', real.parts.filter((p) => p.type === 'list').map((p) => p.text).join('/') === 'Audit all labels against the new rules./Update supplier contracts with testing clauses./Train regional teams before the deadlines.');
  check('real PDF: paragraph lines joined, every word kept', realTexts.some((t) => t.startsWith('This is a sample report used to test the Voice of Market PDF viewer. It has three pages with headings, text and a small table.')));
  const realPieces = cutPieces(job, real);
  check('real PDF: cut into 3 pieces, the table stays with its section', realPieces.pieces.length === 3 && realPieces.pieces[1].text.includes('Region | Change | Deadline') && realPieces.pieces[1].heading === 'Section 2: Ingredient Restrictions', realPieces.pieces.map((p) => `${p.heading}:${p.wordCount}`).join(' / '));
}

async function main() {
  await testReceiveSource();
  await testFetchSource();
  await testReadText();
  testCheckText();
  testCutPieces();
  await testSaveAndRun();
  await testSearch();
  await testReadPdf();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Test run crashed:', e);
  process.exitCode = 1;
});
