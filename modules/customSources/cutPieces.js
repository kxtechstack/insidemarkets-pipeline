/**
 * modules/customSources/cutPieces.js
 *
 * Step 5 of reading a custom source: cut the text into pieces for search.
 *
 * In:  the job (for the source name) and what readText.js read
 * Out: {
 *   pieces: [ {
 *     pieceNo,        // 1, 2, 3 ... in reading order
 *     heading,        // the section the piece is in ("Market overview"), or null
 *     sheet,          // Excel sheet name, or null
 *     pageFrom, pageTo,
 *     text,           // the piece, as-is (what we show and what the AI reads later)
 *     wordCount,
 *     searchText,     // title + sheet + heading + text: what the search model reads
 *   } ],
 *   notes: [],
 * }
 *
 * Rules:
 *   1. A heading starts a new piece, so a piece never mixes two sections.
 *      But when the piece so far is tiny (under PIECE_MIN_WORDS, like a chart
 *      label on a slide), the heading stays inside the piece as a line, so we
 *      never get pieces of one or two words. At the top of a new page (a new
 *      slide) a heading starts a new piece unless the piece is under half that. Two headings in a row are kept
 *      together ("Chapter 2 › Market overview"), at most 2 levels.
 *      A new Excel sheet starts a new piece too.
 *   2. A piece is about PIECE_TARGET_WORDS long and never over PIECE_MAX_WORDS.
 *   3. Never cut inside a sentence. Only one giant sentence with no full stop
 *      (longer than a whole piece) is cut by words.
 *   4. The last sentence of a piece is repeated at the start of the next one.
 *   5. A big table gets its own pieces, cut by rows, and the header row is
 *      repeated in every piece, so "10%" always stays next to "Share".
 *      A small table (under PIECE_MIN_WORDS) stays inside the text around it.
 *   6. A tiny last piece of a section is joined to the piece before it, if it fits.
 *      A crumb (under 10 words, like a lone chart number) joins the piece
 *      before it on the same page, whatever kind.
 *   7. No words are lost: every word of the text is in at least one piece.
 */

const {
  PIECE_TARGET_WORDS, PIECE_MAX_WORDS, PIECE_MIN_WORDS, OVERLAP_MAX_WORDS, HEADING_MAX_CHARS,
} = require('./customSourceConfig');

// A piece this small is a crumb (a lone chart number, an axis label)
const CRUMB_WORDS = 10;

const countWords = (text) => (String(text).trim() ? String(text).trim().split(/\s+/).length : 0);

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/**
 * Sentences of a paragraph. Very short bits (1 or 2 words, like "Dr." or
 * "No. 5") are joined to the next sentence, so a cut never lands inside them.
 */
function sentencesOf(text) {
  const raw = [...segmenter.segment(String(text))].map((s) => s.segment.trim()).filter(Boolean);
  const sentences = [];
  let carry = '';
  for (const s of raw) {
    const joined = carry ? `${carry} ${s}` : s;
    if (countWords(joined) <= 2 && s !== raw[raw.length - 1]) {
      carry = joined;
      continue;
    }
    sentences.push(joined);
    carry = '';
  }
  if (carry) sentences.push(carry);
  return sentences;
}

// One giant sentence -> bits of PIECE_TARGET_WORDS words
function splitByWords(sentence) {
  const words = sentence.split(/\s+/);
  const bits = [];
  for (let i = 0; i < words.length; i += PIECE_TARGET_WORDS) bits.push(words.slice(i, i + PIECE_TARGET_WORDS).join(' '));
  return bits;
}

/**
 * @param {object} job   from receiveSource.js (sourceName)
 * @param {object} read  from readText.js (title, parts)
 */
function cutPieces(job, read) {
  const title = read.title || job.sourceName;
  const pieces = [];
  const notes = [];

  let heading = null;
  let lastPartWasHeading = false;
  let current = null; // { units: [], words, heading, sheet, pages: [], isTable }
  let carry = null;   // the sentence to repeat at the start of the next piece

  const start = (sheet, isTable = false) => {
    current = { units: [], words: 0, heading, sheet, pages: [], isTable };
  };

  const add = (unit) => {
    current.units.push(unit);
    current.words += unit.words;
    if (unit.page) current.pages.push(unit.page);
  };

  // Closes the current piece. withOverlap: the next piece starts with its last sentence.
  const close = ({ withOverlap = false } = {}) => {
    if (!current || current.units.every((u) => u.isOverlap || u.isRepeatedHeader)) {
      current = null;
      carry = null;
      return;
    }
    let text = '';
    current.units.forEach((u, i) => {
      if (i === 0) text = u.text;
      else text += (u.newBlock ? '\n' : ' ') + u.text;
    });
    pieces.push({
      heading: current.heading,
      sheet: current.sheet,
      pageFrom: current.pages.length ? Math.min(...current.pages) : null,
      pageTo: current.pages.length ? Math.max(...current.pages) : null,
      text,
      wordCount: countWords(text),
      isTable: current.isTable,
      overlapText: current.units[0].isOverlap ? current.units[0].text : null,
    });
    const last = current.units[current.units.length - 1];
    carry = withOverlap && last.isSentence && !last.isOverlap && last.words <= OVERLAP_MAX_WORDS
      ? { ...last, isOverlap: true, newBlock: false }
      : null;
    current = null;
  };

  // Adds one sentence (or list item) of normal text
  const addSentence = (unit) => {
    if (current && (current.isTable || current.sheet !== unit.sheet)) close();
    if (!current) {
      start(unit.sheet);
      if (carry && carry.sheet === unit.sheet) add({ ...carry, newBlock: false });
      carry = null;
    }
    // Would go over the maximum: close first (the next piece repeats the last sentence)
    if (current.words > 0 && current.words + unit.words > PIECE_MAX_WORDS) {
      close({ withOverlap: true });
      start(unit.sheet);
      if (carry && carry.words + unit.words <= PIECE_MAX_WORDS) add(carry);
      carry = null;
      add({ ...unit, newBlock: current.units.length > 0 ? unit.newBlock : false });
    } else {
      add(current.units.length === 0 ? { ...unit, newBlock: false } : unit);
    }
    if (current.words >= PIECE_TARGET_WORDS) close({ withOverlap: true });
  };

  for (const part of read.parts || []) {
    const sheet = part.sheet || null;

    // A heading
    if (part.type === 'title' && part.text.length <= HEADING_MAX_CHARS) {
      const levels = heading ? heading.split(' › ').length : 0;
      // A heading at the top of a new page (a new slide) starts a new piece,
      // unless the piece so far is really tiny.
      const newPage = current && part.page && current.pages.length > 0 && part.page > Math.max(...current.pages);
      const tinyLimit = newPage ? PIECE_MIN_WORDS / 2 : PIECE_MIN_WORDS;
      if (current && current.words > 0 && current.words < tinyLimit) {
        // The piece so far is tiny: keep the heading inside it as a line.
        // Pieces after this one get the new heading.
        addSentence({ text: part.text, words: countWords(part.text), page: part.page, sheet, newBlock: true, isSentence: false });
        heading = part.text;
        lastPartWasHeading = false;
      } else if (!current && lastPartWasHeading && levels >= 2) {
        // Already 2 headings in a row: this one is the first line of the piece
        addSentence({ text: part.text, words: countWords(part.text), page: part.page, sheet, newBlock: false, isSentence: false });
        lastPartWasHeading = false;
      } else {
        close();
        // Two headings in a row ("Chapter 2", "Market overview") are kept together
        heading = lastPartWasHeading && heading ? `${heading} › ${part.text}` : part.text;
        lastPartWasHeading = true;
      }
      continue;
    }
    lastPartWasHeading = false;

    // A small table: stays in the text around it, one row per line
    if (part.type === 'table' && countWords(part.text) < PIECE_MIN_WORDS) {
      part.text.split('\n').filter(Boolean).forEach((row) => {
        addSentence({ text: row, words: countWords(row), page: part.page, sheet, newBlock: true, isSentence: false });
      });
      continue;
    }

    // A big table: its own pieces, header row repeated
    if (part.type === 'table') {
      close();
      const rows = part.text.split('\n').filter(Boolean);
      const header = rows[0];
      const headerWords = countWords(header);
      start(sheet, true);
      add({ text: header, words: headerWords, page: part.page, newBlock: false });
      for (const row of rows.slice(1)) {
        const words = countWords(row);
        if (current.words + words > PIECE_MAX_WORDS && current.units.length > 1) {
          close();
          start(sheet, true);
          add({ text: header, words: headerWords, page: part.page, newBlock: false, isRepeatedHeader: true });
        }
        add({ text: row, words, page: part.page, newBlock: true });
      }
      close();
      continue;
    }

    // Normal text or a list item
    const prefix = part.type === 'list' ? '- ' : '';
    const sentences = part.type === 'list' ? [part.text] : sentencesOf(part.text);
    sentences.forEach((sentence, i) => {
      const bits = countWords(sentence) > PIECE_MAX_WORDS ? splitByWords(sentence) : [sentence];
      bits.forEach((bit, j) => {
        const text = i === 0 && j === 0 ? prefix + bit : bit;
        addSentence({
          text,
          words: countWords(text),
          page: part.page,
          sheet,
          newBlock: i === 0 && j === 0,
          isSentence: bits.length === 1,
        });
      });
    });
  }
  close();

  // A tiny last piece of a section joins the piece before it (same section, fits)
  const merged = [];
  for (const piece of pieces) {
    const before = merged[merged.length - 1];
    const tinySameSection = !piece.isTable && !before?.isTable && piece.wordCount < PIECE_MIN_WORDS
      && before?.heading === piece.heading && before?.sheet === piece.sheet;
    // A crumb (a few words, like a lone chart number) joins the piece before it on the same page, whatever kind
    const crumb = piece.wordCount < CRUMB_WORDS && before && before.sheet === piece.sheet
      && (before.pageTo === piece.pageFrom || (before.pageTo === null && piece.pageFrom === null));
    if (before && (tinySameSection || crumb) && before.wordCount + piece.wordCount <= PIECE_MAX_WORDS) {
      // The tiny piece may start with the repeated last sentence of the piece before: drop that copy
      const raw = piece.overlapText ? piece.text.slice(piece.overlapText.length) : piece.text;
      let rest = raw.trim();
      let newLine = raw.startsWith('\n') || rest.startsWith('- ');
      // A crumb from another section brings its heading along as a line, so it is not lost
      if (piece.heading && piece.heading !== before.heading) {
        rest = `${piece.heading.split(' › ').pop()}\n${rest}`;
        newLine = true;
      }
      if (rest) before.text += (newLine ? '\n' : ' ') + rest;
      before.wordCount = countWords(before.text);
      before.pageFrom = [before.pageFrom, piece.pageFrom].filter((p) => p !== null).reduce((a, b) => Math.min(a, b), Infinity);
      before.pageTo = [before.pageTo, piece.pageTo].filter((p) => p !== null).reduce((a, b) => Math.max(a, b), -Infinity);
      if (!Number.isFinite(before.pageFrom)) before.pageFrom = null;
      if (!Number.isFinite(before.pageTo)) before.pageTo = null;
      continue;
    }
    merged.push({ ...piece });
  }

  const finished = merged.map((piece, i) => {
    const path = [title, piece.sheet, piece.heading].filter(Boolean).join(' › ');
    return {
      pieceNo: i + 1,
      heading: piece.heading,
      sheet: piece.sheet,
      pageFrom: piece.pageFrom,
      pageTo: piece.pageTo,
      text: piece.text,
      wordCount: piece.wordCount,
      searchText: `${path}: ${piece.text}`,
    };
  });

  if (finished.length) {
    const average = Math.round(finished.reduce((t, p) => t + p.wordCount, 0) / finished.length);
    notes.push(`Cut into ${finished.length} pieces (about ${average} words each).`);
  }
  return { pieces: finished, notes };
}

module.exports = { cutPieces, sentencesOf, countWords };
