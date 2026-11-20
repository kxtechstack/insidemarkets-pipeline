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

// All other countries (standard name = how it is written here; lower case is matched).
// Without these, "Nigeria, United Kingdom" could not be told apart from "United States, Oregon".
const MORE_COUNTRIES = `Afghanistan|Albania|Algeria|Andorra|Angola|Antigua and Barbuda|Armenia|Azerbaijan|Bahamas|Barbados|Belarus|Belize|Benin|
Bermuda|Bhutan|Bolivia|Bosnia and Herzegovina|Botswana|Brunei|Bulgaria|Burkina Faso|Burundi|Cambodia|Cameroon|Cape Verde|Cayman Islands|
Central African Republic|Chad|Comoros|Congo|Costa Rica|Croatia|Cuba|Cyprus|Democratic Republic of the Congo|Djibouti|Dominica|
Dominican Republic|Ecuador|El Salvador|Equatorial Guinea|Eritrea|Estonia|Eswatini|Ethiopia|Fiji|Gabon|Gambia|Georgia|Ghana|Grenada|
Guatemala|Guinea|Guinea-Bissau|Guyana|Haiti|Honduras|Iceland|Iran|Iraq|Ivory Coast|Jamaica|Jersey|Guernsey|Isle of Man|Kazakhstan|
Kiribati|Kosovo|Kyrgyzstan|Laos|Latvia|Lebanon|Lesotho|Liberia|Libya|Liechtenstein|Lithuania|Luxembourg|Macau|Madagascar|Malawi|
Maldives|Mali|Malta|Marshall Islands|Mauritania|Mauritius|Micronesia|Moldova|Monaco|Mongolia|Montenegro|Mozambique|Myanmar|Namibia|
Nauru|Nepal|Nicaragua|Niger|North Korea|North Macedonia|Palau|Palestine|Panama|Papua New Guinea|Paraguay|Peru|Puerto Rico|Rwanda|
Saint Kitts and Nevis|Saint Lucia|Saint Vincent and the Grenadines|Samoa|San Marino|Senegal|Serbia|Seychelles|Sierra Leone|Slovakia|
Slovenia|Solomon Islands|Somalia|South Sudan|Sudan|Suriname|Syria|Tajikistan|Tanzania|Timor-Leste|Togo|Tonga|Trinidad and Tobago|
Tunisia|Turkmenistan|Tuvalu|Uganda|Uruguay|Uzbekistan|Vanuatu|Venezuela|Yemen|Zambia|Zimbabwe`.split('|').map((x) => x.trim()).filter(Boolean);
const MORE_ALIASES = {
  'Ivory Coast': ["cote d'ivoire", 'côte d\u2019ivoire', "côte d'ivoire"],
  'Brunei': ['brunei darussalam'],
  'Saint Kitts and Nevis': ['st. kitts and nevis', 'st kitts and nevis'],
  'Timor-Leste': ['east timor'],
  'Czech Republic': ['czechia'],
  'Democratic Republic of the Congo': ['dr congo', 'drc'],
  'Laos': ['lao pdr'],
};
for (const name of MORE_COUNTRIES) if (!PLACES[name]) PLACES[name] = [name.toLowerCase()];
for (const [name, forms] of Object.entries(MORE_ALIASES)) PLACES[name] = [...(PLACES[name] || [name.toLowerCase()]), ...forms];

// region names (everything else in PLACES is a country)
const REGIONS = new Set(['Global', 'European Union', 'Europe', 'GCC', 'Middle East', 'ASEAN', 'Asia Pacific', 'Africa', 'Latin America', 'North America']);
const isCountry = (name) => Boolean(PLACES[name]) && !REGIONS.has(name);

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
  // "the GCC region", "Gulf countries", "ASEAN markets": the place without
  // the general word around it
  const bare = k.replace(/^the\s+/, '').replace(/\s+(region|regions|area|countries|nations|states|zone|bloc|markets?|economies)$/, '').trim();
  if (bare !== k && bare.length >= 3 && LOOKUP.has(bare)) return LOOKUP.get(bare);   // not "my market" -> MY
  return raw.replace(/\s+/g, ' ');
}

/** A list or a "UAE, KSA and Qatar" string -> standard names, no repeats. */
function standardPlaces(value) {
  // split on commas first; split on "and" / "&" only when the part is not itself a known name
  // ("Bosnia and Herzegovina", "St. Kitts and Nevis" stay whole; "UAE and Morocco" is split)
  const items = Array.isArray(value) ? value : String(value || '').split(/[,;/]/)
    .flatMap((part) => (LOOKUP.has(key(part)) ? [part] : part.split(/\band\b|&/i)));
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

// ── "Korean", "Indian", "Qatari" -> the place ───────────────────────────
// Only used by the chat, and only next to words like "market" or
// "consumers" ("the Korean market" is a place, "Korean skincare" is a style).
// Most adjectives are the place name with an ending added (Korea-n, Egypt-ian,
// Japan-ese, Qatar-i, Europe-an); the few that are not are listed here.
const PLACE_ADJECTIVES = {
  chinese: 'China', emirati: 'United Arab Emirates', turkish: 'Turkey', british: 'United Kingdom',
  english: 'United Kingdom', french: 'France', german: 'Germany', spanish: 'Spain', mexican: 'Mexico',
  filipino: 'Philippines', thai: 'Thailand', lebanese: 'Lebanon', canadian: 'Canada', dutch: 'Netherlands',
  swiss: 'Switzerland', italian: 'Italy', saudi: 'Saudi Arabia', gulf: 'GCC', irish: 'Ireland',
  // (no "polish": in cosmetics it means nail polish)
  portuguese: 'Portugal', greek: 'Greece', swedish: 'Sweden', danish: 'Denmark',
  norwegian: 'Norway', finnish: 'Finland', peruvian: 'Peru', chilean: 'Chile', moroccan: 'Morocco',
  latin: 'Latin America', arab: 'Middle East', arabian: 'Middle East',
};
const KNOWN_PLACES = new Set(Object.keys(PLACES));
/** "korean" -> "South Korea", "egyptian" -> "Egypt", "skincare" -> null */
function placeFromAdjective(word) {
  const w = key(word);
  if (!w || w.length < 4 || /\s/.test(w)) return null;
  if (PLACE_ADJECTIVES[w]) return PLACE_ADJECTIVES[w];
  for (const ending of ['n', 'an', 'ian', 'ese', 'i', 'ish']) {
    if (!w.endsWith(ending)) continue;
    const base = w.slice(0, -ending.length);
    if (base.length < 4 || !LOOKUP.has(base)) continue;
    const place = LOOKUP.get(base);
    if (KNOWN_PLACES.has(place)) return place;
  }
  return null;
}

module.exports = { standardPlace, standardPlaces, placeCovers, isCountry, placeFromAdjective, PLACES, PLACE_ADJECTIVES, REGIONS, REGION_MEMBERS };
