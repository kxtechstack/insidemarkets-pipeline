// fetcher.js
const Exa = require('exa-js').default;
const exa = new Exa(process.env.EXA_API_KEY);

const daysAgoISO = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

// ---------- Ambiguous slash-date disambiguation ----------
// JS Date() assumes MM/DD/YYYY (US). Many of our sources (Malaysia, UK,
// India, EU, etc.) use DD/MM/YYYY. When both day and month are <=12,
// the format is genuinely ambiguous -- if reading it as MM/DD produces
// a future date but DD/MM would not, assume DD/MM was intended.
// FIXED: "25/10/2026" (day first) and "10/25/2026" (month first) were turned into
// strings JavaScript cannot read, so the date was lost and the article got no date.
// Now a slash date is turned into a clear ISO date ("2026-10-25"):
//   first part > 12  -> day/month      second part > 12 -> month/day
//   both <= 12       -> month/day, unless that is in the future and day/month is not
const disambiguateSlashDate = (rawDate) => {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(rawDate).trim());
  if (!match) return rawDate;
  const [, first, second, year, hh, mm] = match;
  const f = parseInt(first, 10);
  const s = parseInt(second, 10);
  const iso = (month, day) => {
    const d = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return hh ? `${d}T${String(hh).padStart(2, '0')}:${mm}:00Z` : d;
  };
  if (f > 12 && s <= 12) return iso(s, f);            // day/month
  if (s > 12 && f <= 12) return iso(f, s);            // month/day
  if (f <= 12 && s <= 12) {
    const asMonthDay = new Date(iso(f, s)).getTime();
    const asDayMonth = new Date(iso(s, f)).getTime();
    if (asMonthDay > Date.now() && asDayMonth <= Date.now()) return iso(s, f);
    return iso(f, s);
  }
  return rawDate;                                      // e.g. 31/31/2026: not a date
};

const FUTURE_DATE_GRACE_MS = 2 * 24 * 60 * 60 * 1000;

const sanitizePublishedDate = (rawDate, source, url) => {
  if (!rawDate) return null;

  const disambiguated = disambiguateSlashDate(rawDate);
  if (disambiguated !== rawDate) {
    console.log(`[DateSanitize] Reinterpreted ambiguous date "${rawDate}" as "${disambiguated}" (DD/MM vs MM/DD)`);
  }

  const parsed = new Date(disambiguated);
  if (isNaN(parsed.getTime())) {
    console.log(`[DateSanitize] Unparseable publishedDate "${rawDate}" from ${source} (${url}) -- dropping`);
    return null;
  }

  if (parsed.getTime() > Date.now() + FUTURE_DATE_GRACE_MS) {
    console.log(`[DateSanitize] Rejected future publishedDate "${rawDate}" from ${source} (${url}) -- dropping`);
    return null;
  }

  return parsed.toISOString();
};

const cheerio = require('cheerio');

const extractDateFromHtml = async (url) => {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KXBot/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const $ = cheerio.load(html);

    let found = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (found) return;
      try {
        const data = JSON.parse($(el).contents().text());
        const nodes = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
        for (const node of nodes) {
          if (node?.datePublished) { found = node.datePublished; break; }
        }
      } catch { /* skip malformed JSON-LD */ }
    });
    if (found) return found;

    const metaSelectors = [
      'meta[property="article:published_time"]',
      'meta[name="article:published_time"]',
      'meta[name="publish-date"]',
      'meta[name="publishdate"]',
      'meta[name="date"]',
      'meta[property="og:article:published_time"]',
      'meta[itemprop="datePublished"]',
    ];
    for (const sel of metaSelectors) {
      const content = $(sel).attr('content');
      if (content) return content;
    }

    const timeAttr = $('time[datetime]').first().attr('datetime');
    if (timeAttr) return timeAttr;

    return null;
  } catch (err) {
    console.log(`[DateFallback] HTML fetch failed for ${url}: ${err.message}`);
    return null;
  }
};


// ---------- EXA ----------
const fetchFromExa = async (promptText, lookbackDays = 90) => {
  console.log(`[TEST] fetchFromExa called with lookbackDays = ${lookbackDays}`);
  const response = await exa.searchAndContents(promptText, {
    numResults:25,
    type: 'auto',
    category: 'news',
    startPublishedDate: daysAgoISO(lookbackDays)
  });

  console.log(`Fetched ${response.results.length} articles from Exa`);

  return response.results.map(article => ({
    title: article.title,
    url: article.url,
    publishedDate: article.publishedDate,
    text: article.text || ''
  }));
};

// ---------- TAVILY ----------
const fetchFromTavily = async (promptText, lookbackDays = 90) => {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query: promptText,
      topic: 'news',
      max_results: 25,
      days: lookbackDays,
      include_answer: false,
      include_raw_content: false
    })
  });

  if (!res.ok) {
    throw new Error(`Tavily API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  console.log(`Fetched ${data.results.length} articles from Tavily`);

  return data.results.map(article => ({
    title: article.title,
    url: article.url,
    publishedDate: article.published_date || null,
    text: article.content || ''
  }));
};

// ---------- PARALLEL ----------
// Uses Parallel's BETA search endpoint (/v1beta/search), NOT the SDK's
// client.search() -- the stable SDK method silently ignores max_results,
// excerpts, and source_policy (confirmed via testParallel.js testing).
// The beta endpoint requires a special header to unlock those params.
//
// Note: source_policy.start_date is a soft freshness preference, not a
// hard guarantee -- some older/undated results can still come through.
// Also, unlike Exa's category:'news', Parallel has no way to exclude
// multi-topic "roundup" articles at the source -- that filtering still
// relies on qualityFilter.js and llmRelevanceProcessor.js downstream.
const fetchFromParallel = async (promptText, lookbackDays = 90) => {
  const startDateOnly = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  const res = await fetch('https://api.parallel.ai/v1beta/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.PARALLEL_API_KEY,
      'parallel-beta': 'search-extract-2025-10-10'
    },
    body: JSON.stringify({
      objective: promptText,
      search_queries: [promptText],
      max_results: 100,
      excerpts: { max_chars_per_result: 5000 },
      source_policy: { start_date: startDateOnly }
    })
  });

  if (!res.ok) {
    throw new Error(`Parallel API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const results = data.results || [];
  console.log(`Fetched ${results.length} articles from Parallel`);

  return results.map(article => ({
    title: article.title || '',
    url: article.url,
    publishedDate: article.publish_date || null,
    text: Array.isArray(article.excerpts) ? article.excerpts.join('\n\n') : ''
  }));
};

// ---------- PERPLEXITY (not implemented yet) ----------
const fetchFromPerplexity = async () => {
  throw new Error('Perplexity source is not implemented yet. Select Exa, Tavily, or Parallel.');
};

// ---------- REGISTRY ----------
const fetchers = {
  Exa: fetchFromExa,
  Tavily: fetchFromTavily,
  Parallel: fetchFromParallel,
  Perplexity: fetchFromPerplexity
};

const fetchArticles = async (source, promptText, lookbackDays = 90) => {
  const fetcher = fetchers[source];
  if (!fetcher) {
    throw new Error(`Unknown source: "${source}". Expected one of: ${Object.keys(fetchers).join(', ')}`);
  }
  const articles = await fetcher(promptText, lookbackDays);

  const results = [];
  for (const article of articles) {
    let publishedDate = sanitizePublishedDate(article.publishedDate, source, article.url);

    if (!publishedDate) {
      const htmlDate = await extractDateFromHtml(article.url);
      if (htmlDate) {
        publishedDate = sanitizePublishedDate(htmlDate, `${source}+html-fallback`, article.url);
        if (publishedDate) {
          console.log(`[DateFallback] Recovered date for ${article.url} via HTML: ${publishedDate}`);
        }
      }
    }

    results.push({ ...article, publishedDate });
  }

  return results;
};

module.exports = { fetchFromExa, fetchFromTavily, fetchFromParallel, fetchFromPerplexity, fetchArticles, sanitizePublishedDate, extractDateFromHtml };