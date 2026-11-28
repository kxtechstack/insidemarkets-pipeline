/**
 * modules/customSources/readPdf.js
 *
 * Reads the real text inside a PDF with PDF.js (Mozilla, the reader inside
 * Firefox). Free, exact (no reading of pictures, so no "Al" for "AI"), and
 * the file never leaves our server.
 *
 * In:  the PDF bytes
 * Out: { needsPictureReading, parts, pageCount, pageChars, notes }
 *   needsPictureReading = true when half the pages or more have no real text
 *   (a scanned PDF). readText.js then sends the file to Unstructured instead.
 *
 * How the text is rebuilt, page by page:
 *   1. Every piece of text has a place (x, y) and a letter size.
 *      Pieces at the same height form one line, left to right.
 *   2. A wide gap inside a line splits it into cells: that line is a table row
 *      ("Amazon | 23.0 | 23.9% | 25.2%"). Rows next to each other form a table.
 *   3. Text clearly bigger than the normal text of the page is a heading.
 *      So is a short line that is all bold and does not end like a sentence
 *      (reports like a 10-K print headings bold, at the normal size).
 *   4. Normal lines close together, with the same letter size, join into a
 *      paragraph. A line starting with a bullet starts a list item.
 *   5. Sideways text (a chart axis label) is kept as its own line.
 *   6. Removed, and written in the notes:
 *      - a line on most pages, at the top or bottom of the page (running
 *        header or footer, page number allowed at its start or end)
 *      - a page number alone on the first or last line of a page
 *      - a line of single spaced letters ("B E A U T Y"), which is decoration
 */

const {
  PDF_MAX_PAGES, PDF_CELL_GAP, PDF_HEADING_SIZE, PDF_BOLD_HEADING_MAX_CHARS, PDF_PARAGRAPH_GAP, HEADING_MAX_CHARS,
  SCANNED_PAGE_MIN_CHARS, SCANNED_SHARE_FOR_OCR,
  REPEATED_LINE_MAX_CHARS, REPEATED_LINE_MIN_PAGES, REPEATED_LINE_PAGE_SHARE,
} = require('./customSourceConfig');
const { cleanText, stripBullet, repeatKey, short } = require('./textTools');
const { SourceError } = require('./sourceError');

let pdfjs = null;
const loadPdfjs = async () => {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
};

const letterCount = (text) => (String(text).match(/\p{L}/gu) || []).length;

// ── 1. The text pieces of every page ───────────────────────────────────
async function readPages(bytes) {
  const { getDocument } = await loadPdfjs();
  let doc;
  try {
    doc = await getDocument({
      data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, verbosity: 0, useSystemFonts: false,
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') {
      throw new SourceError('READ_FAILED', 'This PDF is locked with a password, so it cannot be read.');
    }
    throw e; // not a PDF we can open: readText.js tries Unstructured
  }
  try {
    if (doc.numPages > PDF_MAX_PAGES) {
      throw new SourceError('TOO_BIG', `This PDF has ${doc.numPages} pages. The limit is ${PDF_MAX_PAGES}.`);
    }
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // Font names tell which text is bold ("TimesNewRoman-Bold"). They are
      // known only after the page's fonts are loaded.
      const boldFont = {};
      try {
        await page.getOperatorList();
        for (const it of content.items) {
          if (it.fontName in boldFont) continue;
          let name = '';
          try { const font = page.commonObjs.get(it.fontName); name = (font && font.name) || ''; } catch (e) { name = ''; }
          boldFont[it.fontName] = /bold|black|heavy|semibold|demibold/i.test(name);
        }
      } catch (e) { /* no font names: no bold headings on this page */ }
      const items = [];
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        const [a, b, c, d, x, y] = it.transform;
        const rotated = Math.abs(b) > 0.01 || Math.abs(c) > 0.01;
        items.push({
          text: it.str, x, y, size: rotated ? Math.hypot(a, b) : Math.abs(d) || Math.abs(a),
          width: it.width || 0, rotated, bold: Boolean(boldFont[it.fontName]),
        });
      }
      pages.push({ page: n, items: withoutDoubles(items) });
      page.cleanup();
    }
    return { pageCount: doc.numPages, pages };
  } finally {
    await doc.destroy();
  }
}

// Some PDFs draw the same text twice at the same spot (a bold or shadow
// effect), sometimes once as one long piece and once in short pieces.
// The copy is dropped, or the line would read "Source:Source:".
// A piece is a copy when another piece on the same line covers the same
// space and already has its text.
function withoutDoubles(items) {
  const longestFirst = items.map((item, i) => ({ ...item, i })).sort((p, q) => q.text.length - p.text.length);
  const kept = [];
  for (const item of longestFirst) {
    const text = item.text.trim();
    const copy = kept.some((k) => k.rotated === item.rotated
      && Math.abs(k.y - item.y) < 1.5
      && item.x >= k.x - 1.5 && item.x + item.width <= k.x + k.width + 1.5
      && k.text.includes(text));
    if (!copy) kept.push(item);
  }
  return kept.sort((p, q) => p.i - q.i).map(({ i, ...item }) => item);
}

// ── 2. Lines of one page ────────────────────────────────────────────────
/**
 * @param {Array} items  [{ text, x, y, size, width, rotated }]
 * @returns [{ text, size, y, cells, rotated }] top to bottom
 */
function linesOfPage(items) {
  const flat = items.filter((i) => !i.rotated).sort((p, q) => q.y - p.y || p.x - q.x);
  const groups = [];
  for (const item of flat) {
    const group = groups[groups.length - 1];
    const tolerance = Math.max(1.5, 0.45 * Math.min(item.size, group ? group.size : item.size));
    if (group && Math.abs(group.y - item.y) <= tolerance) {
      group.items.push(item);
      group.size = Math.max(group.size, item.size);
    } else {
      groups.push({ y: item.y, size: item.size, items: [item] });
    }
  }

  const lines = groups.map((group) => {
    const parts = group.items.sort((p, q) => p.x - q.x);
    let text = '';
    let end = null;
    let cells = 1;
    for (const item of parts) {
      if (end !== null) {
        const gap = item.x - end;
        const lastCell = text.split(' | ').pop().trim();
        // "+" or "-" right before a number is its sign: "+10%", "-0.57"
        const sign = /^[+\-\u2212\u2013]$/.test(lastCell) && /^\d/.test(item.text.trim());
        // A cell that is only one other symbol ("•" far left of its text) is a bullet, not a cell
        const symbolCell = !sign && /^[\p{S}\p{Po}\p{Pd}]$/u.test(lastCell);
        if (sign) { /* joined with no space */ }
        else if (gap > PDF_CELL_GAP * item.size && !symbolCell) { text += ' | '; cells += 1; }
        else if (gap > 0.15 * item.size && !/\s$/.test(text) && !/^\s/.test(item.text)) text += ' ';
      }
      text += item.text;
      end = item.x + item.width;
    }
    // The letter size of the line = the size of most of its letters
    const bySize = {};
    for (const item of parts) bySize[item.size] = (bySize[item.size] || 0) + letterCount(item.text) + 1;
    const size = Number(Object.entries(bySize).sort((p, q) => q[1] - p[1])[0][0]);
    // The line is bold when every piece with letters in it is bold
    const withLetters = parts.filter((item) => letterCount(item.text) > 0);
    const bold = withLetters.length > 0 && withLetters.every((item) => item.bold);
    return { text: cleanText(text), size, y: group.y, cells, rotated: false, bold };
  }).filter((line) => line.text);

  // Sideways text: each piece is its own line, at the end of the page
  for (const item of items.filter((i) => i.rotated).sort((p, q) => p.x - q.x)) {
    const text = cleanText(item.text);
    if (text) lines.push({ text, size: item.size, y: -Infinity, cells: 1, rotated: true });
  }
  return lines;
}

// "B E A U T Y", "s U K S e l": mostly single letters with spaces = decoration
function isSpacedLetters(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  return tokens.length >= 4 && tokens.filter((t) => t.length === 1).length / tokens.length >= 0.7;
}

// ── 3. Lines -> parts ───────────────────────────────────────────────────
/**
 * @param {Array} pages [{ page, lines }]
 * @param {number} pageCount
 * @returns { parts, pageChars, notes }
 */
function partsFromLines(pages, pageCount) {
  const notes = [];

  // The normal letter size = the size used by most letters. Each page with
  // enough text has its own (slides differ from page to page); a page with
  // little text uses the size of the whole file.
  const sizeOf = (lines) => {
    const bySize = {};
    for (const line of lines) {
      const key = Math.round(line.size * 2) / 2;
      bySize[key] = (bySize[key] || 0) + line.text.length;
    }
    const top = Object.entries(bySize).sort((p, q) => q[1] - p[1])[0];
    return top ? Number(top[0]) : 10;
  };
  const fileBodySize = sizeOf(pages.flatMap((p) => p.lines));
  const PAGE_OWN_SIZE_MIN_CHARS = 300;

  // How a line is compared across pages. A row ("Confidential | © 2026 ... | 7")
  // is compared by its cells in any order, without cells that are only a page
  // number, so "© ... | Confidential" on page 1 matches the others.
  const lineKey = (line) => {
    if (line.cells < 2) return repeatKey(line.text);
    const cells = line.text.split(' | ').map((c) => c.trim()).filter((c) => c && !/^\d{1,4}$/.test(c));
    return repeatKey(cells.sort().join(' | '));
  };

  // Running headers and footers: a short line on most pages, at the top or
  // bottom of the page (the first 2 or last 3 lines). A line in the middle of
  // a page is never one, even when it repeats.
  const edgeLines = (lines) => {
    const flat = lines.filter((l) => !l.rotated);
    return new Set([...flat.slice(0, 2), ...flat.slice(-3)]);
  };
  const edgesByPage = new Map(pages.map(({ page, lines }) => [page, edgeLines(lines)]));
  const removedRepeats = new Map();
  if (pageCount >= REPEATED_LINE_MIN_PAGES) {
    const pagesByKey = new Map();
    for (const { page, lines } of pages) {
      for (const line of lines) {
        if (!edgesByPage.get(page).has(line) || line.text.length > REPEATED_LINE_MAX_CHARS) continue;
        const key = lineKey(line);
        if (key === null) continue;
        if (!pagesByKey.has(key)) pagesByKey.set(key, new Set());
        pagesByKey.get(key).add(page);
      }
    }
    const needed = Math.max(REPEATED_LINE_MIN_PAGES, Math.ceil(pageCount * REPEATED_LINE_PAGE_SHARE));
    for (const [key, set] of pagesByKey) if (set.size >= needed) removedRepeats.set(key, null);
  }

  let repeatCount = 0;
  let pageNumberCount = 0;
  let spacedCount = 0;
  const parts = [];
  const pageChars = {};

  for (const { page, lines } of pages) {
    const flatLines = lines.filter((l) => !l.rotated);
    const charsOnPage = flatLines.reduce((t, l) => t + l.text.length, 0);
    const bodySize = charsOnPage >= PAGE_OWN_SIZE_MIN_CHARS ? sizeOf(flatLines) : fileBodySize;
    const first = flatLines[0];
    const last = flatLines[flatLines.length - 1];
    let current = null; // the part being built: { type, size, lastY, text }

    const finish = () => {
      if (!current) return;
      const text = current.type === 'table' ? cleanText(current.text, { keepLines: true }) : cleanText(current.text);
      // A long sentence with a full stop is text, even when it is printed big
      if (current.type === 'title' && /[.!?]["”’)]?$/.test(text) && text.split(/\s+/).length >= 8) current.type = 'text';
      if (text) {
        parts.push({ type: current.type, page, sheet: null, text });
        pageChars[page] = (pageChars[page] || 0) + text.length;
      }
      current = null;
    };

    for (const line of lines) {
      const key = lineKey(line);
      if (key !== null && removedRepeats.has(key) && edgesByPage.get(page).has(line)) {
        repeatCount += 1;
        if (removedRepeats.get(key) === null) removedRepeats.set(key, line.text);
        continue;
      }
      if ((line === first || line === last) && /^\d{1,4}$/.test(line.text)) { pageNumberCount += 1; continue; }
      if (isSpacedLetters(line.text)) { spacedCount += 1; continue; }

      // What kind of line
      let type = 'text';
      let text = line.text;
      if (line.rotated) type = 'label';
      else if (line.cells >= 2) type = 'table';
      else if (line.size >= bodySize * PDF_HEADING_SIZE && letterCount(text) >= 3 && text.length <= HEADING_MAX_CHARS) type = 'title';
      else if (line.bold && line.size >= bodySize * 0.95 && letterCount(text) >= 3 && text.length <= PDF_BOLD_HEADING_MAX_CHARS
        && !/[.:;,]$/.test(text)) type = 'title'; // a short bold line on its own: a heading in a report like a 10-K
      else {
        const bullet = stripBullet(text);
        if (bullet.isBullet) { type = 'list-start'; text = bullet.text; }
      }

      const gap = current && current.lastY !== null && line.y !== -Infinity ? current.lastY - line.y : Infinity;
      const sameSize = current && Math.abs(current.size - line.size) <= 0.15 * Math.max(current.size, line.size);
      const close = sameSize && gap <= PDF_PARAGRAPH_GAP * line.size;

      if (type === 'table' && current && current.type === 'table' && gap <= 3 * line.size) {
        current.text += `\n${text}`;
      } else if (type === 'title' && current && current.type === 'title' && close) {
        current.text += ` ${text}`;
      } else if (type === 'text' && current && (current.type === 'text' || current.type === 'list') && close) {
        // the same paragraph (or the next line of a list item)
        current.text += current.text.endsWith('-') && /^\p{Ll}/u.test(text) ? text : ` ${text}`;
      } else {
        finish();
        current = {
          type: type === 'list-start' ? 'list' : type === 'label' ? 'text' : type,
          size: line.size,
          lastY: null,
          text,
        };
      }
      current.lastY = line.y === -Infinity ? null : line.y;
    }
    finish();
  }

  if (repeatCount) {
    const examples = [...removedRepeats.values()].filter(Boolean).slice(0, 2).map((t) => `"${short(t)}"`);
    notes.push(`Removed ${repeatCount} repeated lines found on most pages (running headers or footers), for example: ${examples.join(', ')}.`);
  }
  if (pageNumberCount) notes.push(`Removed ${pageNumberCount} page numbers.`);
  if (spacedCount) notes.push(`Removed ${spacedCount} lines of single spaced letters (decoration).`);
  return { parts, pageChars, notes };
}

/**
 * @param {Buffer} bytes
 * @param {object} [deps] { readPages } (the tests pass fake pages)
 */
async function readPdf(bytes, deps = {}) {
  const { pageCount, pages } = await (deps.readPages || readPages)(bytes);
  const withLines = pages.map((p) => ({ page: p.page, lines: linesOfPage(p.items) }));

  // A scanned PDF: most pages have (almost) no real text
  const textPerPage = withLines.map((p) => p.lines.reduce((t, l) => t + l.text.length, 0));
  const pictures = textPerPage.filter((chars) => chars < SCANNED_PAGE_MIN_CHARS).length;
  if (pageCount === 0 || pictures / pageCount >= SCANNED_SHARE_FOR_OCR) {
    return { needsPictureReading: true, pictures, pageCount };
  }

  const { parts, pageChars, notes } = partsFromLines(withLines, pageCount);
  return { needsPictureReading: false, parts, pageCount, pageChars, notes };
}

module.exports = { readPdf, linesOfPage, partsFromLines, isSpacedLetters, withoutDoubles };
