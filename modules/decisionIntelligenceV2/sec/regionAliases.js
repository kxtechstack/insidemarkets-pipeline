/**
 * modules/decisionIntelligenceV2/sec/regionAliases.js
 *
 * Region name → alias list. Used by secHandler.js to determine whether a
 * given region is actually represented in the client's retrieved hits.
 *
 * Ported from modules/decisionIntelligence/retrieveClientData.js
 * (REGION_ALIASES). Extended with a few more common regions.
 *
 * No behavior tied to this file — it's a pure lookup table. Safe to edit,
 * extend, or delete without breaking anything.
 */

const REGION_ALIASES = {
  // ── Asia ────────────────────────────────────────────────────────────
  'south korea':      ['south korea', 'korea', 'seoul', 'k-beauty', 'korean'],
  'north korea':      ['north korea', 'dprk', 'pyongyang'],
  'china':            ['china', 'chinese', 'beijing', 'shanghai', 'prc'],
  'japan':            ['japan', 'japanese', 'tokyo'],
  'india':            ['india', 'indian', 'delhi', 'mumbai', 'bengaluru'],
  'indonesia':        ['indonesia', 'indonesian', 'jakarta'],
  'vietnam':          ['vietnam', 'vietnamese'],
  'thailand':         ['thailand', 'thai', 'bangkok'],
  'singapore':        ['singapore', 'singaporean'],
  'malaysia':         ['malaysia', 'malaysian', 'kuala lumpur'],
  'philippines':      ['philippines', 'filipino', 'manila'],
  'taiwan':           ['taiwan', 'taiwanese', 'taipei'],

  // ── Middle East ─────────────────────────────────────────────────────
  'united arab emirates': ['united arab emirates', 'uae', 'emirates', 'dubai', 'abu dhabi'],
  'saudi arabia':     ['saudi arabia', 'saudi', 'ksa', 'riyadh'],
  'israel':           ['israel', 'israeli', 'tel aviv'],
  'turkey':           ['turkey', 'turkish', 'istanbul'],

  // ── Europe ──────────────────────────────────────────────────────────
  'united kingdom':   ['united kingdom', 'uk', 'britain', 'great britain', 'england', 'scotland', 'wales'],
  'germany':          ['germany', 'german', 'berlin'],
  'france':           ['france', 'french', 'paris'],
  'italy':            ['italy', 'italian', 'milan', 'rome'],
  'spain':            ['spain', 'spanish', 'madrid', 'barcelona'],
  'netherlands':      ['netherlands', 'dutch', 'amsterdam'],
  'switzerland':      ['switzerland', 'swiss', 'zurich', 'geneva'],
  'sweden':           ['sweden', 'swedish', 'stockholm'],
  'norway':           ['norway', 'norwegian', 'oslo'],
  'denmark':          ['denmark', 'danish', 'copenhagen'],
  'poland':           ['poland', 'polish', 'warsaw'],
  'ireland':          ['ireland', 'irish', 'dublin'],

  // ── Americas (non-US) ───────────────────────────────────────────────
  'canada':           ['canada', 'canadian', 'toronto', 'vancouver'],
  'mexico':           ['mexico', 'mexican', 'mexico city'],
  'brazil':           ['brazil', 'brazilian', 'sao paulo', 'são paulo'],
  'argentina':        ['argentina', 'argentine', 'buenos aires'],
  'chile':            ['chile', 'chilean', 'santiago'],

  // ── Africa ──────────────────────────────────────────────────────────
  'south africa':     ['south africa', 'south african', 'johannesburg', 'cape town'],
  'nigeria':          ['nigeria', 'nigerian', 'lagos'],
  'kenya':            ['kenya', 'kenyan', 'nairobi'],
  'egypt':            ['egypt', 'egyptian', 'cairo'],

  // ── Regional groupings ──────────────────────────────────────────────
  'european union':   ['european union', 'eu', 'europe', 'european'],
  'europe':           ['europe', 'european', 'eu'],
  'asia':             ['asia', 'asian'],
  'southeast asia':   ['southeast asia', 'south east asia', 'asean', 'sea'],
  'middle east':      ['middle east', 'mena', 'gulf'],
  'africa':           ['africa', 'african'],
  'latin america':    ['latin america', 'latam', 'south america'],
  'caribbean':        ['caribbean'],
  'oceania':          ['oceania', 'pacific'],
  'apac':             ['apac', 'asia pacific', 'asia-pacific'],
  'emea':             ['emea'],
};

/**
 * Given a region name (as returned by detectNonUSGeography), returns the
 * list of literal aliases to search for in hit text.
 *
 * Falls back to [region.toLowerCase()] if the region isn't in the table,
 * so unknown regions still work — they just match on the literal name.
 */
function getRegionAliases(region) {
  if (!region) return [];
  const key = String(region).toLowerCase().trim();
  if (REGION_ALIASES[key]) return REGION_ALIASES[key];
  return [key];
}

module.exports = {
  REGION_ALIASES,
  getRegionAliases,
};