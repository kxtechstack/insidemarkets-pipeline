/**
 * modules/customSources/readText.js
 *
 * Step 3 of reading a custom source: turn the bytes into text parts.
 *
 * In:  the job (receiveSource.js) and what fetchSource.js got
 * Out: {
 *   title,        // file: the source name. website: the page title.
 *   reader,       // who read it: unstructured / readability / firecrawl / text
 *   parts: [ { type, page, sheet, text } ],
 *                 // type: title / text / list / table
 *                 // page: page number (files), null for websites and typed text
 *                 // sheet: sheet name (Excel), else null
 *   pageCount,    // highest page number seen (0 when there are no pages)
 *   pageChars,    // { pageNumber: characters on that page } for the checks in step 4
 *   charCount,    // all characters together
 *   publishedAt,  // date of a web article when the page says it, else null
 *   notes: [],    // what was removed or changed, in plain words (shown in the logs)
 * }
 *
 * How each kind is read:
 *   pdf     -> readPdf.js reads the PDF's own text with PDF.js (exact, free,
 *              the file stays on our server). Only a scanned PDF (most pages
 *              are pictures) goes to Unstructured.io, which reads the pictures.
 *   other files (Word, Excel, PowerPoint), or a PDF that PDF.js cannot open
 *           -> Unstructured.io. Every part comes with a label (Title, NarrativeText,
 *              Table, Header, Footer ...) and a page number. We drop the labels
 *              that are never content (DROP_PART_TYPES) and keep the rest.
 *              No guessing rules and no word lists.
 *   website -> Mozilla Readability (the code behind Firefox reader view) takes
 *              only the main article, not menus, ads or footers. If the site
 *              blocked us, or the article is too short, Firecrawl loads the page
 *              and Readability reads that instead.
 *   text    -> as typed, split at blank lines.
 *
 * Every part is cleaned the same way: odd letters made normal (the "fi"
 * ligature becomes "fi"), invisible control characters removed, extra spaces
 * removed. Words are never removed.
 */

const cheerio = require('cheerio');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const {
  UNSTRUCTURED_STRATEGY, UNSTRUCTURED_SCAN_STRATEGY, UNSTRUCTURED_TIMEOUT_MS, DROP_PART_TYPES,
  REPEATED_LINE_MAX_CHARS, REPEATED_LINE_MIN_PAGES, REPEATED_LINE_PAGE_SHARE,
  WEBSITE_MIN_CHARS, FIRECRAWL_TIMEOUT_MS,
} = require('./customSourceConfig');
const { SourceError } = require('./sourceError');
const { cleanText, stripBullet, repeatKey, short } = require('./textTools');
const { readPdf } = require('./readPdf');

// ── Cleaning ───────────────────────────────────────────────────────────
// (cleanText, stripBullet, repeatKey live in textTools.js)

// A table written as HTML -> one line per row, cells split by " | "
function tableRows(html) {
  const $ = cheerio.load(String(html));
  const rows = [];
  $('tr').each((i, tr) => {
    const cells = $(tr).find('th, td').map((j, cell) => cleanText($(cell).text())).get();
    if (cells.some(Boolean)) rows.push(cells.join(' | '));
  });
  return rows.join('\n');
}

const sumChars = (parts) => parts.reduce((total, p) => total + p.text.length, 0);

function pageCharsOf(parts) {
  const pages = {};
  for (const p of parts) if (p.page) pages[p.page] = (pages[p.page] || 0) + p.text.length;
  return pages;
}

/**
 * A short line found on most pages is a running header or footer.
 * Returns the parts without those lines, and a note saying what was removed.
 */
function removeRepeatedLines(parts, pageCount) {
  if (pageCount < REPEATED_LINE_MIN_PAGES) return { parts, note: null };
  const pagesByLine = new Map();
  for (const p of parts) {
    if (p.type === 'table' || !p.page || p.text.length > REPEATED_LINE_MAX_CHARS) continue;
    const key = repeatKey(p.text);
    if (key === null) continue;
    if (!pagesByLine.has(key)) pagesByLine.set(key, new Set());
    pagesByLine.get(key).add(p.page);
  }
  const needed = Math.max(REPEATED_LINE_MIN_PAGES, Math.ceil(pageCount * REPEATED_LINE_PAGE_SHARE));
  const repeated = new Set([...pagesByLine].filter(([, pages]) => pages.size >= needed).map(([key]) => key));
  if (repeated.size === 0) return { parts, note: null };

  const kept = [];
  let removed = 0;
  const examples = [];
  for (const p of parts) {
    const key = repeatKey(p.text);
    if (p.type !== 'table' && key !== null && repeated.has(key)) {
      removed += 1;
      if (examples.length < 3 && !examples.includes(p.text)) examples.push(p.text);
    } else {
      kept.push(p);
    }
  }
  const note = `Removed ${removed} repeated lines found on most pages (running headers or footers), for example: ${examples.map((e) => `"${short(e)}"`).join(', ')}.`;
  return { parts: kept, note };
}

// ── Files: Unstructured.io ──────────────────────────────────────────────

let sharedUnstructured = null;
function defaultPartition() {
  if (!process.env.UNSTRUCTURED_API_KEY) {
    throw new SourceError('SERVICE_PROBLEM', 'The file reader (Unstructured.io) is not set up: UNSTRUCTURED_API_KEY is missing.');
  }
  if (!sharedUnstructured) {
    const { UnstructuredClient } = require('unstructured-client');
    sharedUnstructured = new UnstructuredClient({
      security: { apiKeyAuth: process.env.UNSTRUCTURED_API_KEY },
      ...(process.env.UNSTRUCTURED_API_URL ? { serverURL: process.env.UNSTRUCTURED_API_URL } : {}),
      timeoutMs: UNSTRUCTURED_TIMEOUT_MS,
    });
  }
  return async (bytes, fileName, strategy = UNSTRUCTURED_STRATEGY) => sharedUnstructured.general.partition({
    partitionParameters: {
      files: { content: bytes, fileName },
      strategy,
      pdfInferTableStructure: true,
    },
  });
}

const TYPE_OF = { Title: 'title', ListItem: 'list', Table: 'table' };

// The status number inside an Unstructured error, if any
function statusOf(error) {
  return Number(error && (error.statusCode || error.status || (error.rawResponse && error.rawResponse.status))) || 0;
}

async function readFile(job, fetched, deps) {
  const notesBefore = [];
  let strategy;

  // A PDF: read its own text first
  if (fetched.fileType === 'pdf') {
    let pdf = null;
    try {
      pdf = await (deps.readPdf || readPdf)(fetched.bytes, deps);
    } catch (e) {
      if (e instanceof SourceError) throw e;
      notesBefore.push(`The PDF text could not be read directly (${short(e.message, 120)}), so it was read by Unstructured.io.`);
    }
    if (pdf && !pdf.needsPictureReading) {
      return {
        title: job.sourceName,
        reader: 'pdf-text',
        parts: pdf.parts,
        pageCount: pdf.pageCount,
        pageChars: pdf.pageChars,
        charCount: sumChars(pdf.parts),
        publishedAt: null,
        notes: pdf.notes,
      };
    }
    if (pdf) {
      notesBefore.push(`${pdf.pictures} of ${pdf.pageCount} pages have no real text (a scanned PDF), so the pages were read as pictures.`);
      strategy = UNSTRUCTURED_SCAN_STRATEGY;
    }
  }

  const partition = deps.partition || defaultPartition();
  let result;
  try {
    result = await partition(fetched.bytes, fetched.fileName, strategy);
  } catch (e) {
    if (e instanceof SourceError) throw e;
    const status = statusOf(e);
    if (status === 401 || status === 402 || status === 403 || status === 429 || status >= 500 || /timed? ?out|credit|quota/i.test(e.message)) {
      throw new SourceError('SERVICE_PROBLEM', `The file reader (Unstructured.io) had a problem${status ? ` (status ${status})` : ''}: ${short(e.message, 200)}`);
    }
    throw new SourceError('READ_FAILED', `The file could not be read. It may be broken or locked with a password. (${short(e.message, 200)})`);
  }

  const elements = Array.isArray(result) ? result : ((result && result.elements) || []);
  const dropped = {};
  const parts = [];
  for (const el of elements) {
    const label = el.type || 'Text';
    if (DROP_PART_TYPES.includes(label)) {
      dropped[label] = (dropped[label] || 0) + 1;
      continue;
    }
    const meta = el.metadata || {};
    let type = TYPE_OF[label] || 'text';
    let text = type === 'table' && meta.text_as_html
      ? (tableRows(meta.text_as_html) || cleanText(el.text))
      : cleanText(el.text);
    if (type !== 'table' && type !== 'title') {
      const bullet = stripBullet(text);
      if (bullet.isBullet) { text = bullet.text; type = 'list'; }
    }
    if (!text) continue;
    parts.push({
      type,
      page: Number.isInteger(meta.page_number) && meta.page_number > 0 ? meta.page_number : null,
      sheet: meta.page_name ? cleanText(meta.page_name) : null,
      text,
    });
  }

  const notes = [...notesBefore];
  const droppedList = Object.entries(dropped).map(([label, count]) => `${count} ${label}`);
  if (droppedList.length) notes.push(`Left out parts marked as not content: ${droppedList.join(', ')}.`);

  const pageCount = parts.reduce((max, p) => Math.max(max, p.page || 0), 0);
  const { parts: kept, note } = removeRepeatedLines(parts, pageCount);
  if (note) notes.push(note);

  return {
    title: job.sourceName,
    reader: 'unstructured',
    parts: kept,
    pageCount,
    pageChars: pageCharsOf(kept),
    charCount: sumChars(kept),
    publishedAt: null,
    notes,
  };
}

// ── Websites: Readability, Firecrawl when needed ────────────────────────

// The page's letters, using the character set the page says it uses
function decodeHtml(bytes, contentType = '') {
  const fromHeader = String(contentType).match(/charset=["']?([\w-]+)/i);
  const fromPage = bytes.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i);
  const label = (fromHeader && fromHeader[1]) || (fromPage && fromPage[1]) || 'utf-8';
  try {
    return new TextDecoder(label.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// The article HTML from Readability -> parts, in page order
const BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, table, pre, blockquote, dt, dd, figcaption';
function partsFromArticleHtml(html, fullText) {
  const $ = cheerio.load(String(html));
  const parts = [];
  $(BLOCKS).each((i, el) => {
    const node = $(el);
    // Skip a block inside another block (a paragraph inside a list item or a
    // table cell): the outer block already has its text.
    if (node.parents(BLOCKS).length > 0) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'table') {
      const rows = tableRows($.html(node));
      if (rows) parts.push({ type: 'table', page: null, sheet: null, text: rows });
      return;
    }
    const text = cleanText(node.text());
    if (!text) return;
    const type = /^h[1-6]$/.test(tag) ? 'title' : tag === 'li' ? 'list' : 'text';
    parts.push({ type, page: null, sheet: null, text });
  });

  // Some articles keep text in plain boxes without paragraph tags. If the
  // blocks above hold much less than the whole article, use the whole text.
  const whole = cleanText(fullText, { keepLines: true });
  if (sumChars(parts) < whole.replace(/\n/g, ' ').length * 0.6) {
    return whole.split('\n').map((line) => cleanText(line)).filter(Boolean)
      .map((text) => ({ type: 'text', page: null, sheet: null, text }));
  }
  return parts;
}

// Reads a page with Readability. Scripts in the page are never run.
function readArticle(html, url) {
  const dom = new JSDOM(html, { url: url || 'https://example.invalid/', virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    const pageTitle = cleanText(document.title);
    const article = new Readability(document).parse();
    if (!article) return { title: pageTitle, parts: [], publishedAt: null };
    return {
      title: cleanText(article.title) || pageTitle,
      parts: partsFromArticleHtml(article.content || '', article.textContent || ''),
      publishedAt: article.publishedTime || null,
    };
  } finally {
    dom.window.close();
  }
}

// Firecrawl loads the page from its own servers and gives back the HTML
async function defaultFirecrawl(url, attempt = 1) {
  if (!process.env.FIRECRAWL_API_KEY) return { ok: false, error: 'FIRECRAWL_API_KEY missing' };
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
      body: JSON.stringify({ url, formats: ['rawHtml'], timeout: 30000 }),
      signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 15000 * attempt));
      return defaultFirecrawl(url, attempt + 1);
    }
    if (!res.ok || !data.success) return { ok: false, error: short(String(data.error || `status ${res.status}`), 150) };
    return { ok: true, html: (data.data && data.data.rawHtml) || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function readWebsite(job, fetched, deps) {
  const notes = [];
  let first = null;

  if (!fetched.blocked) {
    first = readArticle(decodeHtml(fetched.bytes, fetched.contentType), fetched.finalUrl);
    if (sumChars(first.parts) >= WEBSITE_MIN_CHARS) return websiteResult(job, first, 'readability', notes);
  }

  // Blocked, or too little text: try Firecrawl
  const why = fetched.blocked
    ? `the site blocked our reader (status ${fetched.blocked.status})`
    : `the page gave only ${first ? sumChars(first.parts) : 0} characters of article text`;
  const firecrawl = deps.firecrawl || defaultFirecrawl;
  const fc = await firecrawl(fetched.finalUrl || job.url);
  if (fc.ok && fc.html) {
    const second = readArticle(fc.html, fetched.finalUrl || job.url);
    if (sumChars(second.parts) >= WEBSITE_MIN_CHARS || sumChars(second.parts) > sumChars((first && first.parts) || [])) {
      notes.push(`Read with Firecrawl because ${why}.`);
      return websiteResult(job, second, 'firecrawl', notes);
    }
  } else {
    notes.push(`Firecrawl did not help (${fc.error || 'no page'}).`);
  }

  // Firecrawl did not do better: keep our own read if it has any text
  if (first && sumChars(first.parts) > 0) {
    notes.push(`Only a little text was found on this page (${sumChars(first.parts)} characters). It may need a login or be built by JavaScript.`);
    return websiteResult(job, first, 'readability', notes);
  }
  if (fetched.blocked) {
    throw new SourceError('BLOCKED_BY_SITE', `The site blocked our reader (status ${fetched.blocked.status}) and Firecrawl could not read it either. ${notes.join(' ')}`.trim());
  }
  throw new SourceError('NO_TEXT', `No article text was found on this page. It may need a login or be built by JavaScript. ${notes.join(' ')}`.trim());
}

function websiteResult(job, read, reader, notes) {
  return {
    title: read.title || job.sourceName,
    reader,
    parts: read.parts,
    pageCount: 0,
    pageChars: {},
    charCount: sumChars(read.parts),
    publishedAt: read.publishedAt,
    notes,
  };
}

// ── Typed text, or a plain text file ────────────────────────────────────

function readPlainText(job, fetched) {
  const blocks = String(fetched.text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const parts = [];
  for (const block of blocks) {
    const heading = block.trim().match(/^#{1,6}\s+(.+)$/);
    if (heading && !block.trim().includes('\n')) {
      parts.push({ type: 'title', page: null, sheet: null, text: cleanText(heading[1]) });
      continue;
    }
    const lines = block.split('\n').map((line) => cleanText(line)).filter(Boolean);
    const bullets = lines.map(stripBullet);
    if (lines.length > 0 && bullets.every((b) => b.isBullet)) {
      bullets.forEach((b) => parts.push({ type: 'list', page: null, sheet: null, text: b.text }));
      continue;
    }
    const text = cleanText(block);
    if (text) parts.push({ type: 'text', page: null, sheet: null, text });
  }
  return {
    title: job.sourceName,
    reader: 'text',
    parts,
    pageCount: 0,
    pageChars: {},
    charCount: sumChars(parts),
    publishedAt: null,
    notes: [],
  };
}

/**
 * @param {object} job      from receiveSource.js
 * @param {object} fetched  from fetchSource.js
 * @param {object} [deps]   { partition, firecrawl } (the tests pass fake ones)
 */
async function readText(job, fetched, deps = {}) {
  if (fetched.kind === 'file') return readFile(job, fetched, deps);
  if (fetched.kind === 'website') return readWebsite(job, fetched, deps);
  if (fetched.kind === 'text') return readPlainText(job, fetched);
  throw new Error(`readText: unknown kind "${fetched.kind}"`);
}

module.exports = { readText, cleanText, stripBullet, tableRows, removeRepeatedLines, repeatKey, decodeHtml, readArticle };
