/**
 * modules/customSources/receiveSource.js
 *
 * Step 1 of reading a custom source: load the source row and check it.
 *
 * In:  the source id (from the URL /custom-source/run/:sourceId)
 * Out: a "job" that the next steps use:
 *   {
 *     sourceId, clientId, sourceName,
 *     sourceType,              // what the admin console saved (website / pdf / file / text)
 *     kind,                    // which reader handles it: website / file / text
 *     url,                     // website, or a link to a file
 *     storagePath,             // an uploaded file in the bucket
 *     text,                    // typed text
 *   }
 *
 * Rules:
 *   - The client always comes from the source row, never from the request.
 *   - The client must exist in admin.clients.
 *   - Each kind must have what it needs (a link, a file or some text).
 *     If not, it stops here with a clear message for the logs.
 *   - An uploaded file wins over a link if both are set.
 *   - A link must start with http:// or https://. (fetchSource.js does the
 *     full safety check, this is only the first quick check.)
 */

const { createClient } = require('@supabase/supabase-js');
const { SOURCE_KINDS, MAX_TYPED_TEXT_CHARS, NO_NAME } = require('./customSourceConfig');
const { SourceError } = require('./sourceError');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let sharedDb = null;
function defaultDb() {
  if (!sharedDb) sharedDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return sharedDb;
}

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

// Quick check: a web link that starts with http:// or https://
function looksLikeWebLink(value) {
  try {
    const link = new URL(value);
    return link.protocol === 'http:' || link.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {string} sourceId
 * @param {object} [deps]  { db } a Supabase client (the tests pass a fake one)
 */
async function receiveSource(sourceId, deps = {}) {
  const db = deps.db || defaultDb();

  if (!UUID.test(clean(sourceId))) {
    throw new SourceError('BAD_SOURCE_ID', 'This source id is not valid.');
  }

  // 1. The source row
  const { data: row, error } = await db.schema('admin').from('custom_data_sources')
    .select('*').eq('id', clean(sourceId)).maybeSingle();
  if (error) throw new Error(`Could not read the source from the database: ${error.message}`);
  if (!row) throw new SourceError('SOURCE_NOT_FOUND', 'This source was not found. It may have been deleted.');

  // From here on we know the source, so every problem carries it.
  // Then the run log can still say which client and source failed, and why.
  const source = { sourceId: row.id, clientId: row.client_id, sourceName: clean(row.source_name) || NO_NAME };
  const fail = (code, message) => Object.assign(new SourceError(code, message), { source });

  // 2. The client (from the row only)
  const { data: client, error: clientError } = await db.schema('admin').from('clients')
    .select('id').eq('id', row.client_id).maybeSingle();
  if (clientError) throw new Error(`Could not read the client from the database: ${clientError.message}`);
  if (!client) throw fail('CLIENT_NOT_FOUND', 'The client of this source was not found.');

  // 3. Which reader
  const sourceType = clean(row.source_type).toLowerCase();
  const kind = SOURCE_KINDS[sourceType];
  if (!kind) {
    throw fail('UNKNOWN_TYPE',
      `Unknown source type "${row.source_type}". Expected one of: ${Object.keys(SOURCE_KINDS).join(', ')}.`);
  }

  const job = {
    ...source,
    sourceType,
    kind,
    url: null,
    storagePath: null,
    text: null,
  };

  // 4. What each kind needs
  const url = clean(row.url_or_path);
  const storagePath = clean(row.storage_path);

  if (kind === 'website') {
    if (!url) throw fail('MISSING_INPUT', 'No web link is set for this website source.');
    if (!looksLikeWebLink(url)) throw fail('BAD_LINK', 'The web link must start with http:// or https://.');
    job.url = url;
  }

  if (kind === 'file') {
    if (storagePath) {
      job.storagePath = storagePath;
    } else if (url) {
      if (!looksLikeWebLink(url)) throw fail('BAD_LINK', 'The file link must start with http:// or https://.');
      job.url = url;
    } else {
      throw fail('MISSING_INPUT', 'No file was uploaded and no file link is set for this source.');
    }
  }

  if (kind === 'text') {
    const text = clean(row.text_content);
    if (!text) throw fail('MISSING_INPUT', 'No text was given for this text source.');
    if (text.length > MAX_TYPED_TEXT_CHARS) {
      throw fail('TEXT_TOO_LONG',
        `The text is too long (${text.length} characters). The limit is ${MAX_TYPED_TEXT_CHARS}.`);
    }
    job.text = text;
  }

  return job;
}

module.exports = { receiveSource, looksLikeWebLink };
