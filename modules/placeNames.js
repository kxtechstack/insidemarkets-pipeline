/**
 * modules/placeNames.js
 *
 * One standard name for every country and region, so the same place is
 * never saved in different ways ("US", "USA", "U.S." -> "United States").
 * Used when signals are saved, and to compare a signal's country with the
 * countries a client focuses on (client profile uses codes like SG, UK, AE).
 *
 *   standardPlace('USA')            -> 'United States'
 *   standardPlace('ksa')            -> 'Saudi Arabia'
 *   standardPlace('UK')             -> 'United Kingdom'
 *   standardPlaces('UAE, KSA')      -> ['United Arab Emirates', 'Saudi Arabia']
 *   placeCovers('European Union', 'France') -> true   (France is in the EU)
 *
 * Nothing here is about one client. To add a spelling, add it to its line.
 */

// standard name -> other ways it is written (codes, short forms, old names)
const PLACES = {
  // ── regions ──
  'Global': ['global', 'worldwide', 'world', 'international', 'multiple', 'multiple countries', 'various'],
  'European Union': ['eu', 'e.u.', 'european union', 'eu27', 'eu-27'],
  'Europe': ['europe'],
  'GCC': ['gcc', 'gulf', 'gulf region', 'gulf cooperation council', 'gcc countries', 'arabian gulf'],
  'Middle East': ['middle east', 'mena', 'middle east and north africa'],
  'ASEAN': ['asean', 'southeast asia', 'south east asia', 'south-east asia'],
  'Asia Pacific': ['asia pacific', 'asia-pacific', 'apac', 'asia'],
  'Africa': ['africa'],
  'Latin America': ['latin america', 'latam', 'south america'],
  'North America': ['north america'],
  // ── countries ──
  'United States': ['us', 'u.s.', 'u.s', 'usa', 'u.s.a.', 'u.s.a', 'united states', 'united states of america', 'america'],
  'United Kingdom': ['uk', 'u.k.', 'gb', 'great britain', 'britain', 'united kingdom', 'england', 'scotland', 'wales'],
  'United Arab Emirates': ['ae', 'uae', 'u.a.e.', 'u.a.e', 'united arab emirates', 'emirates', 'dubai', 'abu dhabi'],
  'Saudi Arabia': ['sa', 'ksa', 'saudi', 'saudi arabia', 'kingdom of saudi arabia'],
  'Qatar': ['qa', 'qatar'],
  'Kuwait': ['kw', 'kuwait'],
  'Bahrain': ['bh', 'bahrain'],
  'Oman': ['om', 'oman'],
  'Egypt': ['eg', 'egypt'],
  'Jordan': ['jo', 'jordan'],
  'Turkey': ['tr', 'turkey', 'turkiye', 'türkiye'],
  'Israel': ['il', 'israel'],
  'India': ['in', 'india'],
  'Pakistan': ['pk', 'pakistan'],
  'Bangladesh': ['bd', 'bangladesh'],
  'Sri Lanka': ['lk', 'sri lanka'],
  'Singapore': ['sg', 'singapore'],
  'Malaysia': ['my', 'malaysia'],
  'Indonesia': ['id', 'indonesia'],
  'Thailand': ['th', 'thailand'],
  'Vietnam': ['vn', 'vietnam', 'viet nam'],
  'Philippines': ['ph', 'philippines'],
  'China': ['cn', 'china', 'prc', "people's republic of china", 'peoples republic of china', 'mainland china'],
  'Hong Kong': ['hk', 'hong kong'],
  'Taiwan': ['tw', 'taiwan'],
  'Japan': ['jp', 'japan'],
  'South Korea': ['kr', 'korea', 'south korea', 'republic of korea', 'korea, republic of', 'rok'],
  'Australia': ['au', 'australia'],
  'New Zealand': ['nz', 'new zealand'],
  'Canada': ['ca', 'canada'],
  'Mexico': ['mx', 'mexico'],
  'Brazil': ['br', 'brazil', 'brasil'],
  'Argentina': ['ar', 'argentina'],
  'Chile': ['cl', 'chile'],
  'Colombia': ['co', 'colombia'],
  'South Africa': ['za', 'south africa'],
  'Nigeria': ['ng', 'nigeria'],
  'Kenya': ['ke', 'kenya'],
  'Morocco': ['ma', 'morocco'],
  'France': ['fr', 'france'],
  'Germany': ['de', 'germany'],
  'Italy': ['it', 'italy'],
  'Spain': ['es', 'spain'],
  'Portugal': ['pt', 'portugal'],
  'Netherlands': ['nl', 'netherlands', 'the netherlands', 'holland'],
  'Belgium': ['be', 'belgium'],
  'Switzerland': ['ch', 'switzerland'],
  'Austria': ['at', 'austria'],
  'Ireland': ['ie', 'ireland'],
  'Sweden': ['se', 'sweden'],
  'Norway': ['no', 'norway'],
  'Denmark': ['dk', 'denmark'],
  'Finland': ['fi', 'finland'],
  'Poland': ['pl', 'poland'],
  'Czech Republic': ['cz', 'czech republic', 'czechia'],
  'Greece': ['gr', 'greece'],
  'Romania': ['ro', 'romania'],
  'Hungary': ['hu', 'hungary'],
  'Russia': ['ru', 'russia', 'russian federation'],
  'Ukraine': ['ua', 'ukraine'],
};

// which countries a region covers (a region signal is "in" the client's
// country when the country is part of it, and the other way round)
const REGION_MEMBERS = {
  'European Union': ['France', 'Germany', 'Italy', 'Spain', 'Portugal', 'Netherlands', 'Belgium', 'Austria', 'Ireland',
    'Sweden', 'Denmark', 'Finland', 'Poland', 'Czech Republic', 'Greece', 'Romania', 'Hungary'],
  'Europe': ['France', 'Germany', 'Italy', 'Spain', 'Portugal', 'Netherlands', 'Belgium', 'Austria', 'Ireland',
    'Sweden', 'Denmark', 'Finland', 'Poland', 'Czech Republic', 'Greece', 'Romania', 'Hungary',
    'United Kingdom', 'Switzerland', 'Norway', 'Ukraine', 'Russia'],
  'GCC': ['United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman'],
  'Middle East': ['United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman', 'Egypt', 'Jordan', 'Israel', 'Turkey'],
  'ASEAN': ['Singapore', 'Malaysia', 'Indonesia', 'Thailand', 'Vietnam', 'Philippines'],
  'Asia Pacific': ['Singapore', 'Malaysia', 'Indonesia', 'Thailand', 'Vietnam', 'Philippines', 'China', 'Hong Kong',
    'Taiwan', 'Japan', 'South Korea', 'Australia', 'New Zealand', 'India'],
  'Africa': ['Egypt', 'South Africa', 'Nigeria', 'Kenya', 'Morocco'],
  'Latin America': ['Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia'],
  'North America': ['United States', 'Canada', 'Mexico'],
};

const key = (text) => String(text || '').toLowerCase().normalize('NFC')
  .replace(/[’`]/g, "'").replace(/\s+/g, ' ').replace(/^the /, '').trim().replace(/[.,;:]+$/, '');

const LOOKUP = new Map();
for (const [name, forms] of Object.entries(PLACES)) {
  LOOKUP.set(key(name), name);
  for (const f of forms) LOOKUP.set(key(f), name);
}

/** One place written any way -> its standard name. Unknown places keep their own words (tidied). */
function standardPlace(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const k = key(raw);
  if (!k || /^(unknown|n\/a|none|not specified|unspecified)$/.test(k)) return null;
  if (LOOKUP.has(k)) return LOOKUP.get(k);
  // "Dubai, UAE" or "Riyadh (Saudi Arabia)": use the part we know
  const parts = k.split(/[,()]/).map((p) => p.trim()).filter(Boolean);
  for (const p of parts.reverse()) if (LOOKUP.has(p)) return LOOKUP.get(p);
  return raw.replace(/\s+/g, ' ');
}

/** A list or a "UAE, KSA and Qatar" string -> standard names, no repeats. */
function standardPlaces(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[,;/]|\band\b|&/i);
  const out = [];
  for (const item of items) {
    const p = standardPlace(item);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** True when place A and place B are the same, or one is a region that contains the other. */
function placeCovers(a, b) {
  const A = standardPlace(a);
  const B = standardPlace(b);
  if (!A || !B) return false;
  if (A === B) return true;
  return (REGION_MEMBERS[A] || []).includes(B) || (REGION_MEMBERS[B] || []).includes(A);
}

module.exports = { standardPlace, standardPlaces, placeCovers, PLACES, REGION_MEMBERS };
