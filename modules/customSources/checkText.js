/**
 * modules/customSources/checkText.js
 *
 * Step 4 of reading a custom source: is the text good enough to save?
 * Runs BEFORE anything is saved. Code only, no AI.
 *
 * In:  what fetchSource.js got (for the file type) and what readText.js read
 * Out: {
 *   status,     // ok / warning / failed
 *   problems,   // [ { code, level, message } ]  level: warning / failed
 *   notes,      // the notes from readText.js, plus the notes from these checks
 *   summary,    // { reader, pages, chars, parts, emptyPages }
 *   message,    // one plain text for the admin console logs
 * }
 *
 * The checks:
 *   NO_TEXT        no text at all                                     -> failed
 *   BROKEN_TEXT    20% or more unreadable characters (broken font)    -> failed
 *   ODD_CHARACTERS 5% or more unreadable characters                   -> warning
 *   LITTLE_TEXT    a file or page with very little text               -> warning
 *   LOOKS_SCANNED  a PDF with very little text per page               -> warning
 *   EMPTY_PAGES    many pages with no text                            -> warning
 *                  (a few empty pages, like a picture cover, are only a note)
 *
 * Nothing is dropped here. A warning still saves the text, and the reason
 * shows in the logs. Only "failed" stops the run.
 */

const {
  CHECK_MIN_CHARS, SCANNED_CHARS_PER_PAGE, EMPTY_PAGE_SHARE_WARN, JUNK_SHARE_WARN, JUNK_SHARE_FAIL,
} = require('./customSourceConfig');

// Characters a reader cannot show: the "?" box, private symbols from broken
// fonts, and anything that is not a letter, number, mark, punctuation,
// symbol or space.
const JUNK = /[�-]|[^\p{L}\p{N}\p{M}\p{P}\p{S}\p{Z}\s]/gu;

function junkShare(text) {
  if (!text) return 0;
  const junk = (text.match(JUNK) || []).length;
  return junk / [...text].length;
}

const percent = (share) => `${Math.round(share * 100)}%`;

// "4, 7, 9" (at most 20 numbers, then "and N more")
function pageList(pages) {
  const shown = pages.slice(0, 20).join(', ');
  return pages.length > 20 ? `${shown} and ${pages.length - 20} more` : shown;
}

/**
 * @param {object} fetched  from fetchSource.js (only fileType and kind are used)
 * @param {object} read     from readText.js
 */
function checkText(fetched, read) {
  const problems = [];
  const notes = [...(read.notes || [])];
  const parts = read.parts || [];
  const allText = parts.map((p) => p.text).join('\n');
  const chars = allText.length;
  const isPdf = fetched.fileType === 'pdf';
  const isTyped = fetched.kind === 'text' && read.reader === 'text';

  // Empty pages (only files with page numbers)
  const emptyPages = [];
  for (let page = 1; page <= (read.pageCount || 0); page += 1) {
    if (!read.pageChars || !read.pageChars[page]) emptyPages.push(page);
  }

  const summary = {
    reader: read.reader,
    pages: read.pageCount || 0,
    chars,
    parts: parts.length,
    emptyPages,
  };

  // 1. No text at all
  if (chars === 0) {
    problems.push({
      code: 'NO_TEXT',
      level: 'failed',
      message: isPdf
        ? 'No text was found in this PDF. It is probably scanned (pictures of pages), which cannot be read yet.'
        : 'No text was found in this source.',
    });
  } else {
    // 2. Unreadable characters
    const junk = junkShare(allText);
    if (junk >= JUNK_SHARE_FAIL) {
      problems.push({
        code: 'BROKEN_TEXT',
        level: 'failed',
        message: `The text looks broken: ${percent(junk)} of the characters cannot be read. The file may use a font the reader cannot decode.`,
      });
    } else if (junk >= JUNK_SHARE_WARN) {
      problems.push({
        code: 'ODD_CHARACTERS',
        level: 'warning',
        message: `${percent(junk)} of the characters cannot be read. Some parts of the text may be wrong.`,
      });
    }

    // 3. Very little text (not for typed text: a short note is fine)
    if (!isTyped && chars < CHECK_MIN_CHARS) {
      problems.push({
        code: 'LITTLE_TEXT',
        level: 'warning',
        message: `Only ${chars} characters of text were found.`,
      });
    }

    // 4. A PDF with very little text per page looks scanned
    if (isPdf && summary.pages > 0 && chars / summary.pages < SCANNED_CHARS_PER_PAGE) {
      problems.push({
        code: 'LOOKS_SCANNED',
        level: 'warning',
        message: `Only about ${Math.round(chars / summary.pages)} characters per page were found over ${summary.pages} pages. Parts of this PDF may be scanned pictures that were not read.`,
      });
    }

    // 5. Empty pages: always a note, a warning when there are many
    if (emptyPages.length > 0) {
      const text = `Pages with no text: ${pageList(emptyPages)}.`;
      if (emptyPages.length / summary.pages >= EMPTY_PAGE_SHARE_WARN) {
        problems.push({
          code: 'EMPTY_PAGES',
          level: 'warning',
          message: `${emptyPages.length} of ${summary.pages} pages have no text (${pageList(emptyPages)}). They may be pictures or scans.`,
        });
      } else {
        notes.push(text);
      }
    }
  }

  const status = problems.some((p) => p.level === 'failed') ? 'failed'
    : problems.length > 0 ? 'warning'
      : 'ok';

  const head = `Read ${summary.pages ? `${summary.pages} pages, ` : ''}${chars} characters in ${summary.parts} parts (${summary.reader}).`;
  const message = [head, ...problems.map((p) => p.message), ...notes].join(' ');

  return { status, problems, notes, summary, message };
}

module.exports = { checkText, junkShare };
