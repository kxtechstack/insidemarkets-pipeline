/**
 * modules/customSources/customSourceConfig.js
 *
 * Settings for reading custom sources (website / PDF / text), all in one place.
 * Values only. No prompt text here.
 * Each step adds its own settings below when it is built.
 */

module.exports = {
  // ── Step 1 (receiveSource.js) ──────────────────────────────────────────
  // What the admin console saves in admin.custom_data_sources.source_type,
  // and which reader handles it.
  //   website -> read one web page
  //   pdf     -> a file (uploaded, or a link to a file)
  //   file    -> same as pdf (in case the admin console renames "PDF" to "File")
  //   text    -> text typed into the admin console
  SOURCE_KINDS: {
    website: 'website',
    pdf: 'file',
    file: 'file',
    text: 'text',
  },

  // Longest typed text we accept (characters). About 300 pages of text.
  // Stops a huge paste from filling the database.
  MAX_TYPED_TEXT_CHARS: Number(process.env.CS_MAX_TYPED_TEXT_CHARS) || 1000000,

  // Name used when the source has no name.
  NO_NAME: 'Untitled source',

  // ── Step 2 (fetchSource.js) ────────────────────────────────────────────
  // Where the admin console uploads files.
  STORAGE_BUCKET: 'custom-source-files',

  // Biggest file or page we download (MB). The download stops as soon as it
  // goes over, so a huge file never fills the memory.
  MAX_DOWNLOAD_MB: Number(process.env.CS_MAX_DOWNLOAD_MB) || 50,

  // Longest time one download may take, all redirects included (ms).
  FETCH_TIMEOUT_MS: Number(process.env.CS_FETCH_TIMEOUT_MS) || 60 * 1000,

  // How many times a link may send us on to another link.
  MAX_REDIRECTS: 5,

  // Only normal web ports. Stops links like http://our-server:6333 that
  // would reach our own services (Qdrant, databases) from outside.
  ALLOWED_PORTS: [80, 443],

  // How we say who we are to websites (a normal browser, so fewer sites block us).
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  // Replies that mean "the site blocked a robot". For a website, the next
  // step can then try Firecrawl. For a file, the run stops with a message.
  BLOCKED_STATUSES: [403, 429, 503],

  // ── Step 3 (readText.js) ───────────────────────────────────────────────
  // Unstructured.io (reads PDF, Word, Excel, PowerPoint).
  // 'auto' lets Unstructured pick per page. 'hi_res' is better for tables and
  // scanned pages but costs more.
  // Used for Word, Excel and PowerPoint (PDFs with real text are read by readPdf.js).
  UNSTRUCTURED_STRATEGY: process.env.CS_UNSTRUCTURED_STRATEGY || 'auto',
  // Used for scanned PDFs (pictures of pages): read the pictures.
  UNSTRUCTURED_SCAN_STRATEGY: process.env.CS_UNSTRUCTURED_SCAN_STRATEGY || 'hi_res',
  UNSTRUCTURED_TIMEOUT_MS: Number(process.env.CS_UNSTRUCTURED_TIMEOUT_MS) || 5 * 60 * 1000,

  // Part labels from Unstructured that are never content: running headers,
  // footers, page numbers, page breaks, pictures. These are Unstructured's
  // own fixed label names, not a word list.
  DROP_PART_TYPES: ['Header', 'Footer', 'PageNumber', 'PageBreak', 'Image'],

  // A short line that repeats on most pages is a running header or footer
  // that Unstructured did not label (for example "Confidential, Company 2026").
  // It is removed and listed in the notes, never removed silently.
  REPEATED_LINE_MAX_CHARS: 120,  // only short lines can be headers
  REPEATED_LINE_MIN_PAGES: 3,    // the file needs at least this many pages
  REPEATED_LINE_PAGE_SHARE: 0.5, // on at least half of the pages

  // Website: if the main article has fewer characters than this, the page
  // probably did not load right (robot check, page built by JavaScript).
  // Then we try Firecrawl.
  // PDFs: we read the PDF's own text with PDF.js (readPdf.js).
  PDF_MAX_PAGES: 2000,
  PDF_CELL_GAP: 1.5,          // a gap wider than 1.5 x the letter size splits a line into cells (a table row)
  PDF_HEADING_SIZE: 1.2,      // text at least 1.2 x the normal letter size is a heading
  PDF_BOLD_HEADING_MAX_CHARS: 120, // a bold line on its own, up to this long, is a heading too
  PDF_PARAGRAPH_GAP: 1.75,    // a line further down than 1.75 x the letter size starts a new paragraph
  SCANNED_PAGE_MIN_CHARS: 30, // a page with less real text than this is a picture (scanned)
  SCANNED_SHARE_FOR_OCR: 0.5, // when half the pages or more are pictures, the whole PDF is read as pictures

  WEBSITE_MIN_CHARS: Number(process.env.CS_WEBSITE_MIN_CHARS) || 300,
  FIRECRAWL_TIMEOUT_MS: Number(process.env.CS_FIRECRAWL_TIMEOUT_MS) || 60 * 1000,

  // ── Step 4 (checkText.js) ──────────────────────────────────────────────
  // A file or web page with fewer characters than this gets a warning.
  // (Typed text can be short, so it is not checked for this.)
  CHECK_MIN_CHARS: 200,

  // A PDF with fewer characters than this per page, on average, is probably
  // scanned (pictures of pages): warning.
  SCANNED_CHARS_PER_PAGE: 100,

  // Empty pages are always listed in the notes. When this share of the pages
  // (or more) is empty, it also becomes a warning.
  EMPTY_PAGE_SHARE_WARN: 0.2,

  // Unreadable characters (broken font, wrong letters): warning at 5%, failed at 20%.
  JUNK_SHARE_WARN: 0.05,
  JUNK_SHARE_FAIL: 0.2,

  // ── Step 5 (cutPieces.js) ──────────────────────────────────────────────
  // Our search model (all-MiniLM-L6-v2) reads about 180 words fully. Longer
  // pieces are cut off inside the model, so their end is never searched.
  PIECE_TARGET_WORDS: 160, // a piece is closed at the next sentence end after this
  PIECE_MAX_WORDS: 200,    // a piece never goes over this (except one giant sentence, which is cut)
  PIECE_MIN_WORDS: 40,     // a tiny last piece of a section is joined to the piece before, if it fits

  // The last sentence of a piece is repeated at the start of the next one
  // (if it is not longer than this), so a fact on the border is not lost.
  OVERLAP_MAX_WORDS: 40,

  // A "title" longer than this is really a sentence (readers sometimes mark
  // big bold text as a title). It is kept as normal text.
  HEADING_MAX_CHARS: 200,

  // ── Step 6 (saveSource.js) ─────────────────────────────────────────────
  // The Qdrant collection for custom source pieces (new, not the old
  // custom_source_content). 384 = the size of all-MiniLM-L6-v2 vectors.
  QDRANT_COLLECTION: process.env.CS_QDRANT_COLLECTION || 'custom_source_pieces',
  VECTOR_SIZE: 384,
  QDRANT_BATCH: 100,   // vectors sent to Qdrant per call
  DB_BATCH: 500,       // piece rows sent to Supabase per call

  // ── Step 7 (reportRun.js) ──────────────────────────────────────────────
  // Longest message kept in custom_source_run_log.error_message.
  LOG_MESSAGE_MAX_CHARS: 3000,

  // ── Search (searchCustomSources.js) ────────────────────────────────────
  SEARCH_LIMIT: 8,        // how many pieces come back
  SEARCH_MIN_SCORE: 0.2,  // pieces less similar than this are left out (0 = nothing alike, 1 = same)
};
