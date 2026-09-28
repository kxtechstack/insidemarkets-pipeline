/**
 * customSourceExtractor.js
 * ==========================
 * Extracts RAW text from a custom data source, based on its source_type.
 * This is step 1 only -- just "get the text out." No synthesis, no
 * chunking, no embedding happens here (that's customSourceProcessor.js).
 *
 * Returns: { title, text } for every source type, so the processor
 * always gets the same shape regardless of where the content came from.
 */

const cheerio = require('cheerio');
const { UnstructuredClient } = require('unstructured-client');
const { createClient } = require('@supabase/supabase-js');
const FirecrawlApp = require('@mendable/firecrawl-js').default;
const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const unstructuredClient = new UnstructuredClient({
  security: {
    apiKeyAuth: process.env.UNSTRUCTURED_API_KEY,
  },
});

const STORAGE_BUCKET = 'custom-source-files';

// ── PDF text cleaner ─────────────────────────────────────────────────────
// Unstructured.io returns PDF text that preserves the VISUAL layout of the
// document -- headers, footers, sidebars, decorative icons, and standalone
// labels all come through as separate "elements". When we join them with
// newlines we get chunks like:
//   "52 markets Neuroscience sg (a) E-Commerce Panel Bath & Shower..."
// This function strips that layout noise so the LLM gets coherent prose.
const cleanPdfText = (raw) => {
  if (!raw) return '';

  let text = raw;

  // 1. Drop repeated boilerplate lines that appear on every page
  text = text
    .replace(/^.*Confidential and proprietary.*$/gim, '')
    .replace(/^.*©\s*\d{4}\s*Nielsen.*$/gim, '')
    .replace(/^.*All Rights Reserved.*$/gim, '')
    .replace(/^Page\s+\d+\s*$/gim, '')
    .replace(/^\s*\d{1,3}\s*$/gm, '');   // standalone page numbers

  // 2. Drop lines that are purely decorative / icon-adjacent
  //    (mostly punctuation, single chars, or garbage after stripping)
  text = text
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (!t) return true;                          // keep blank lines (paragraph breaks)
      if (t.length < 3) return false;               // drop 1-2 char lines
      // drop lines that are >50% non-alphanumeric (visual noise)
      const alnum = (t.match(/[A-Za-z0-9]/g) || []).length;
      if (alnum / t.length < 0.5) return false;
      // drop runs of single letters like "AL T e A R"
      const singleLetterRun = /\b([a-zA-Z]\s+){4,}[a-zA-Z]\b/;
      if (singleLetterRun.test(t)) return false;
      return true;
    })
    .join('\n');

  // 3. Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, '\n\n');

  // 4. Trim
  return text.trim();
};

// ---------- PLAIN TEXT ----------
// Source already has the text stored directly in the DB row -- nothing to fetch.
const extractFromText = async (source) => {
  return {
    title: source.source_name,
    text: source.text_content || '',
  };
};

// ---------- WEBSITE ----------
const extractFromWebsite = async (source) => {
  const url = source.url_or_path;
  if (!url) throw new Error('No url_or_path set for this website source');

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) throw new Error(`status ${response.status}`);

    const html = await response.text();
    const $ = cheerio.load(html);
    $('script, style, nav, header, footer, iframe, noscript, svg').remove();

    const pageTitle = $('title').text().trim() || source.source_name;
    const bodyText = $('body').text().replace(/\s{2,}/g, ' ').trim();

    if (!bodyText || bodyText.length < 50) throw new Error('little or no readable text');

    return { title: pageTitle, text: bodyText };

  } catch (fetchErr) {
    console.log(`[CustomSourceExtractor] Plain fetch failed for ${url} (${fetchErr.message}), trying Firecrawl fallback`);

    const result = await firecrawl.scrapeUrl(url, { formats: ['markdown'] });

    if (!result.markdown || result.markdown.length < 50) {
      throw new Error(`Failed to fetch website via both plain fetch and Firecrawl: ${fetchErr.message}`);
    }

    return { title: result.metadata?.title || source.source_name, text: result.markdown };
  }
};

// ---------- FILE (PDF, Word, Excel, etc. via link OR upload) ----------
// Uses unstructured.io to pull clean text out of any document type.
const extractFromFile = async (source) => {
  let fileBuffer;
  let fileName;

  if (source.storage_path) {
    // Uploaded file -- pull bytes from Supabase Storage
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .download(source.storage_path);

    if (error || !data) {
      throw new Error(`Failed to download file from storage: ${error?.message || 'no data returned'}`);
    }

    fileBuffer = Buffer.from(await data.arrayBuffer());
    fileName = source.storage_path.split('/').pop();

  } else if (source.url_or_path) {
    // File given as a link (e.g. PDF link) -- fetch it
    const response = await fetch(source.url_or_path);
    if (!response.ok) {
      throw new Error(`Failed to fetch file from URL: ${response.status} ${response.statusText}`);
    }
    fileBuffer = Buffer.from(await response.arrayBuffer());
    fileName = source.url_or_path.split('/').pop().split('?')[0] || 'document';

  } else {
    throw new Error('No storage_path or url_or_path set for this file source');
  }

  console.log(`[CustomSourceExtractor] Sending ${fileBuffer.length} bytes to Unstructured.io (strategy: hi_res)`);

  const result = await unstructuredClient.general.partition({
    partitionParameters: {
      files: {
        content: fileBuffer,
        fileName: fileName,
      },
      // CHANGED: 'auto' falls back to a fast text-only extraction on
      // visually complex pages (chart-heavy decks, image-heavy PDFs). For
      // the NIQ-style reports this yielded only ~18k chars from 33 pages.
      // 'hi_res' uses layout detection + OCR, which recovers content that
      // lives inside charts, images, and vector graphics. Slower and more
      // Unstructured credits per file, but the difference is significant
      // for design-heavy PDFs.
      strategy: 'hi_res',
    },
  });

  // unstructured.io's SDK returns the elements array directly (not wrapped
  // in a .elements property) -- handle both shapes just in case.
  const elements = Array.isArray(result) ? result : (result.elements || []);
  const rawText = elements.map(el => el.text || '').filter(Boolean).join('\n\n');

  if (!rawText || rawText.length < 20) {
    throw new Error('Unstructured.io returned little or no text for this file');
  }

  // Strip PDF layout noise (headers, footers, decorative labels, icon runs)
  // before handing text to the chunker + LLM.
  const text = cleanPdfText(rawText);

  if (!text || text.length < 20) {
    throw new Error('Text was too noisy after cleanup -- nothing usable extracted');
  }

  console.log(`[CustomSourceExtractor] PDF text cleaned: ${rawText.length} -> ${text.length} chars`);
  return { title: source.source_name, text };
};

// ---------- REGISTRY ----------
const extractors = {
  text: extractFromText,
  website: extractFromWebsite,
  pdf: extractFromFile,
  file: extractFromFile, // for when AI Studio renames "PDF Upload" to generic "Upload File"
};

const extractContent = async (source) => {
  const extractor = extractors[source.source_type];
  if (!extractor) {
    throw new Error(`Unknown source_type: "${source.source_type}". Expected one of: ${Object.keys(extractors).join(', ')}`);
  }
  return extractor(source);
};

module.exports = { extractContent, extractFromText, extractFromWebsite, extractFromFile, cleanPdfText };