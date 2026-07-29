const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// How far back to look when building the "already seen" URL set for
// comparison. Bounded so this doesn't grow unbounded as processed_urls
// accumulates over months -- matches the same recency-window pattern
// already used in topicDedup.js (60 days) for consistency.
const RECENCY_WINDOW_DAYS = 90;

// Strips subdomain/environment noise and tracking params so mirrors of
// the same article (e.g. www.apgroup.com/x vs prd-en-int.apgroup.com/x,
// or the same URL with ?utm_source=... appended) are recognized as the
// same page. This is a heuristic, not a full public-suffix-list parser --
// it takes the last 2 hostname labels as the "root domain", which is
// correct for the vast majority of real-world domains (company.com,
// beautypress.co, etc.) but can be imprecise for multi-part TLDs
// (e.g. co.uk, com.au) where it may over-strip. Good enough for
// deduping press-release/news mirrors, which is the actual use case here.
const TRACKING_PARAM_PREFIXES = ['utm_', 'ref', 'source', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'];

const normalizeUrl = (rawUrl) => {
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    const hostParts = url.hostname.toLowerCase().split('.');

    // Take the last 2 labels as the root domain (e.g. "apgroup.com" from
    // "prd-en-int.apgroup.com" or "www.apgroup.com"). Strips away
    // environment/region subdomain prefixes that don't change the actual
    // content of the article.
    const rootDomain = hostParts.length >= 2
      ? hostParts.slice(-2).join('.')
      : url.hostname.toLowerCase();

    // Strip known tracking query params, keep any other query params
    // (some sites use query params as genuine routing, e.g. ?id=123)
    const cleanParams = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
      const keyLower = key.toLowerCase();
      const isTracking = TRACKING_PARAM_PREFIXES.some(prefix => keyLower.startsWith(prefix));
      if (!isTracking) cleanParams.set(key, value);
    }
    const queryString = cleanParams.toString();

    // Strip trailing slash from path for consistency
    const path = url.pathname.replace(/\/+$/, '');

    return `${rootDomain}${path}${queryString ? '?' + queryString : ''}`;
  } catch (err) {
    // Not a parseable URL -- fall back to the raw string so it's still
    // comparable (better than crashing or silently dropping the article)
    return rawUrl.toLowerCase().trim();
  }
};

// Level 1 - Batched Supabase URL duplicate check
//
// Scoped by client_id + module_id (NOT submodule_id). An article already
// seen by ANY submodule under a given module is treated as "seen" for
// the whole module -- this avoids duplicate LLM calls and duplicate
// entries showing up on the same frontend tab when two submodules of the
// same module (e.g. Policy & Risk Monitor's "Tax & Financial Policy" and
// "Regulatory Compliance") both happen to fetch the same article.
// A different module (a different frontend tab) still gets its own
// independent check, since that's a genuinely separate view for the client.
//
// CHANGED: now compares NORMALIZED urls (root domain + path, tracking
// params stripped) instead of exact string matches. Catches cases like
// www.apgroup.com/x vs prd-en-int.apgroup.com/x -- the same press release
// mirrored on a staging/regional subdomain -- which previously slipped
// through as two "different" URLs and became duplicate signals downstream.
const removeUrlDuplicates = async (articles, clientId, moduleId) => {
  if (!articles || articles.length === 0) return [];

  const cutoffIso = new Date(Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Pull all recently-seen URLs for this client+module (bounded by
    // recency window) so we can normalize and compare in code -- an
    // exact .in() match can't catch normalized/mirror duplicates.
    const { data: existingRecords, error } = await supabase
      .from('processed_urls')
      .select('source_url')
      .eq('client_id', clientId)
      .eq('module_id', moduleId)
      .gte('created_at', cutoffIso);

    if (error) throw error;

    const existingNormalizedSet = new Set(
      (existingRecords || []).map(r => normalizeUrl(r.source_url)).filter(Boolean)
    );

    const cleanArticles = [];
    const seenInThisBatch = new Set(); // catch duplicates WITHIN the same fetch too

    for (const article of articles) {
      const normalized = normalizeUrl(article.url);

      if (!normalized) {
        cleanArticles.push(article); // no URL to compare -- keep it, nothing to dedup against
        continue;
      }

      if (existingNormalizedSet.has(normalized) || seenInThisBatch.has(normalized)) {
        console.log(`Duplicate URL skipped (module: ${moduleId}): ${article.url} (normalized: ${normalized})`);
        continue;
      }

      seenInThisBatch.add(normalized);
      cleanArticles.push(article);
    }

    // Store newly seen URLs (raw, as before) so future runs can compare against them
    if (cleanArticles.length > 0) {
      const rows = cleanArticles.map(article => ({
        client_id: clientId,
        module_id: moduleId,
        source_url: article.url,
        title: article.title,
        published_date: article.publishedDate || null,
        created_at: new Date().toISOString()
      }));

      const { error: insertError } = await supabase
        .from('processed_urls')
        .insert(rows);

      if (insertError) {
        console.log('processed urls insert error:', insertError.message);
      }
    }

    console.log(`URL check (module: ${moduleId}): ${cleanArticles.length} passed out of ${articles.length}`);
    return cleanArticles;

  } catch (error) {
    console.log('Supabase bulk check error:', error.message);
    return articles;
  }
};

module.exports = {
  removeUrlDuplicates,
  normalizeUrl, // exported for testing/inspection
};