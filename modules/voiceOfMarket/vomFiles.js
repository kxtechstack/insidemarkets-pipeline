/**
 * modules/voiceOfMarket/vomFiles.js
 *
 * Voice of Market: gives every file in a post a temporary link, so it can be opened on the screen.
 * The files are in the PRIVATE bucket "vom-files", so they only open through these links.
 * Video links (YouTube etc.) are normal web addresses, so they are passed on as they are.
 *
 * How long a link works: admin.app_settings, key 'vom_link_hours' (default 3 hours, 24 at most).
 *
 * Address of the links: the backend talks to Supabase on SUPABASE_URL (maybe http and a port),
 * but the browser needs the public https address. SUPABASE_PUBLIC_URL in .env is that address.
 * If it is not set, the links are given as they come.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BUCKET = 'vom-files';
const DEFAULT_HOURS = 3;
const MAX_HOURS = 24;

const INTERNAL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const PUBLIC_BASE = (process.env.SUPABASE_PUBLIC_URL || '').replace(/\/+$/, '');

// Changes the start of a link from the backend address to the public https address
function toPublicUrl(url) {
  if (!url || !PUBLIC_BASE || !INTERNAL_BASE || PUBLIC_BASE === INTERNAL_BASE) return url;
  return url.startsWith(INTERNAL_BASE) ? PUBLIC_BASE + url.slice(INTERNAL_BASE.length) : url;
}

// How many hours a link works. Falls back to 3 if the setting is missing.
async function getLinkHours() {
  try {
    const { data, error } = await supabase.schema('admin').from('app_settings')
      .select('value').eq('key', 'vom_link_hours').maybeSingle();
    if (error) throw error;
    const hours = Number(data && data.value);
    if (hours > 0) return Math.min(hours, MAX_HOURS);
  } catch (e) {
    console.warn(`[VoiceOfMarket] could not read the link time setting, using ${DEFAULT_HOURS} hours: ${e.message}`);
  }
  return DEFAULT_HOURS;
}

// Takes a list of posts and puts a "url" on every file inside them.
//   image / pdf / slide  -> a temporary link
//   video_link           -> the pasted web link, as it is
// If one link cannot be made, that file gets url = null and url_error says why. The other files still work.
async function addTemporaryLinks(posts) {
  const list = posts || [];
  const paths = [];
  list.forEach((post) => (post.attachments || []).forEach((a) => {
    if (a.attachment_type !== 'video_link') paths.push(a.file_url);
  }));

  const linkByPath = new Map();
  const errorByPath = new Map();
  if (paths.length) {
    const seconds = (await getLinkHours()) * 3600;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls([...new Set(paths)], seconds);
    if (error) {
      console.error(`[VoiceOfMarket] could not make temporary links: ${error.message}`);
      paths.forEach((p) => errorByPath.set(p, 'Could not make a link for this file'));
    } else {
      (data || []).forEach((item) => {
        if (item.signedUrl) linkByPath.set(item.path, toPublicUrl(item.signedUrl));
        else errorByPath.set(item.path, item.error || 'File not found');
      });
    }
  }

  return list.map((post) => ({
    ...post,
    attachments: (post.attachments || []).map((a) => {
      if (a.attachment_type === 'video_link') return { ...a, url: a.file_url };
      return { ...a, url: linkByPath.get(a.file_url) || null, url_error: linkByPath.has(a.file_url) ? undefined : (errorByPath.get(a.file_url) || 'File not found') };
    }),
  }));
}

// Same thing for one post
async function addTemporaryLinksToPost(post) {
  return (await addTemporaryLinks([post]))[0];
}

module.exports = { addTemporaryLinks, addTemporaryLinksToPost, getLinkHours };