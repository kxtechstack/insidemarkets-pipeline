/**
 * modules/voiceOfMarket/vomPosts.js
 *
 * Voice of Market: save, list, edit, delete and publish posts, and add / remove their files.
 * Used by modules/voiceOfMarket/route.js. Nothing here is hardcoded for one client.
 *
 * Tables: admin.vom_categories, public.vom_posts, public.vom_post_attachments
 * Files:  private bucket "vom-files", saved as  client id / post id / file name
 */

const { createClient } = require('@supabase/supabase-js');
const sanitizeHtml = require('sanitize-html');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BUCKET = 'vom-files';
const ATTACHMENT_TYPES = ['image', 'pdf', 'video_link', 'slide'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- small helpers ----------

// An error that also carries the web status code (400 = bad request, 404 = not found, 500 = our problem)
function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function check(error) {
  if (!error) return;
  if (error.code === '23503') throw fail('The client, category or post was not found');
  throw fail(error.message, 500);
}

function needId(value, label) {
  if (!UUID.test(String(value || ''))) throw fail(`bad ${label}`);
}

// Keeps only safe text formatting from the editor (headings, bold, lists, links, tables)
function cleanBody(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li',
      'a', 'blockquote', 'hr', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
  });
}

function hasText(html) {
  return sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} }).trim().length > 0;
}

// ---------- categories ----------

async function loadCategories() {
  const { data, error } = await supabase.schema('admin').from('vom_categories')
    .select('id, name, sort_order, is_active').order('sort_order');
  check(error);
  return data || [];
}

async function listCategories() {
  return (await loadCategories()).filter((c) => c.is_active).map(({ id, name, sort_order }) => ({ id, name, sort_order }));
}

// ---------- shaping a post for the screens ----------

function shapePost(post, categoryNames) {
  const { vom_post_attachments: files, ...rest } = post;
  return {
    ...rest,
    category_name: categoryNames.get(post.category_id) || null,
    attachments: (files || []).sort((a, b) => a.sort_order - b.sort_order),
  };
}

async function categoryNameMap() {
  return new Map((await loadCategories()).map((c) => [c.id, c.name]));
}

// ---------- admin side ----------

// All posts of one client (drafts and published). Optional: { status, categoryId }
async function listPostsForAdmin(clientId, { status, categoryId } = {}) {
  needId(clientId, 'clientId');
  let q = supabase.from('vom_posts').select('*, vom_post_attachments(*)')
    .eq('client_id', clientId).order('updated_at', { ascending: false });
  if (status) {
    if (!['draft', 'published'].includes(status)) throw fail('status must be draft or published');
    q = q.eq('status', status);
  }
  if (categoryId) { needId(categoryId, 'categoryId'); q = q.eq('category_id', categoryId); }
  const { data, error } = await q;
  check(error);
  const names = await categoryNameMap();
  return (data || []).map((p) => shapePost(p, names));
}

async function getPost(postId) {
  needId(postId, 'postId');
  const { data, error } = await supabase.from('vom_posts').select('*, vom_post_attachments(*)').eq('id', postId).maybeSingle();
  check(error);
  if (!data) throw fail('Post not found', 404);
  return shapePost(data, await categoryNameMap());
}

// New posts always start as a draft
async function createPost({ clientId, categoryId, title, body }) {
  needId(clientId, 'clientId');
  needId(categoryId, 'categoryId');
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw fail('Please give the post a title');
  if (cleanTitle.length > 300) throw fail('The title is too long (300 letters at most)');
  const { data, error } = await supabase.from('vom_posts')
    .insert({ client_id: clientId, category_id: categoryId, title: cleanTitle, body: cleanBody(body), status: 'draft' })
    .select('id').single();
  check(error);
  return getPost(data.id);
}

// Change only the things that were sent: { title, body, categoryId }
async function updatePost(postId, { title, body, categoryId } = {}) {
  needId(postId, 'postId');
  const change = { updated_at: new Date().toISOString() };
  if (title !== undefined) {
    const t = String(title).trim();
    if (!t) throw fail('The title cannot be empty');
    if (t.length > 300) throw fail('The title is too long (300 letters at most)');
    change.title = t;
  }
  if (body !== undefined) change.body = cleanBody(body);
  if (categoryId !== undefined) { needId(categoryId, 'categoryId'); change.category_id = categoryId; }
  const { data, error } = await supabase.from('vom_posts').update(change).eq('id', postId).select('id');
  check(error);
  if (!data || !data.length) throw fail('Post not found', 404);
  return getPost(postId);
}

// Publish or move back to draft
async function setStatus(postId, status) {
  if (!['draft', 'published'].includes(status)) throw fail('status must be draft or published');
  const post = await getPost(postId);
  if (status === 'published') {
    if (!post.title) throw fail('Please give the post a title before publishing');
    if (!hasText(post.body) && !post.attachments.length) throw fail('The post is empty. Add some text or a file before publishing');
  }
  const change = {
    status,
    published_at: status === 'published' ? (post.published_at || new Date().toISOString()) : null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('vom_posts').update(change).eq('id', postId);
  check(error);
  return getPost(postId);
}

// Removes the post, its attachment rows (automatic) and its uploaded files
async function deletePost(postId) {
  const post = await getPost(postId);
  const { error } = await supabase.from('vom_posts').delete().eq('id', postId);
  check(error);
  await removeStoredFiles(post.attachments);
  return { deleted: true, id: postId };
}

// ---------- files and video links ----------

// For image / pdf / slide: file_url is the path inside the bucket (client id / post id / file name)
// For video_link: file_url is the pasted web link
async function removeStoredFiles(attachments) {
  const paths = (attachments || []).filter((a) => a.attachment_type !== 'video_link').map((a) => a.file_url);
  if (!paths.length) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) console.error(`[VoiceOfMarket] could not remove files from storage: ${error.message}`);
}

async function addAttachment(postId, { type, fileUrl, fileName, sortOrder } = {}) {
  const post = await getPost(postId);
  if (!ATTACHMENT_TYPES.includes(type)) throw fail(`type must be one of: ${ATTACHMENT_TYPES.join(', ')}`);
  const url = String(fileUrl || '').trim();
  if (!url) throw fail('file_url is missing');

  if (type === 'video_link') {
    let parsed;
    try { parsed = new URL(url); } catch (e) { throw fail('That video link is not a web address'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw fail('The video link must start with http or https');
  } else if (!url.startsWith(`${post.client_id}/${postId}/`)) {
    throw fail('The file must be saved in the folder of this client and post');
  }

  let order = Number.isInteger(sortOrder) ? sortOrder : null;
  if (order === null) {
    const last = post.attachments.length ? Math.max(...post.attachments.map((a) => a.sort_order)) : 0;
    order = last + 1;
  }

  const { data, error } = await supabase.from('vom_post_attachments')
    .insert({ post_id: postId, attachment_type: type, file_url: url, file_name: fileName || url.split('/').pop(), sort_order: order })
    .select('*').single();
  check(error);
  await supabase.from('vom_posts').update({ updated_at: new Date().toISOString() }).eq('id', postId);
  return data;
}

async function removeAttachment(attachmentId) {
  needId(attachmentId, 'attachmentId');
  const { data, error } = await supabase.from('vom_post_attachments').delete().eq('id', attachmentId).select('*');
  check(error);
  if (!data || !data.length) throw fail('File not found', 404);
  await removeStoredFiles(data);
  await supabase.from('vom_posts').update({ updated_at: new Date().toISOString() }).eq('id', data[0].post_id);
  return { deleted: true, id: attachmentId };
}

// Saves a new order for the files of a post.
// orderedIds = the ids of ALL files of the post, in the order they should have (the first one gets 1).
async function reorderAttachments(postId, orderedIds) {
  const post = await getPost(postId);
  if (!Array.isArray(orderedIds) || !orderedIds.length) throw fail('Please send the list of file ids in the new order');
  if (orderedIds.length !== post.attachments.length) throw fail('Please send every file of the post in the new order');

  const mine = new Set(post.attachments.map((a) => a.id));
  const seen = new Set();
  for (const id of orderedIds) {
    needId(id, 'attachment id');
    if (!mine.has(id)) throw fail('One of the files does not belong to this post');
    if (seen.has(id)) throw fail('A file is listed twice');
    seen.add(id);
  }

  for (let i = 0; i < orderedIds.length; i++) {
    const { error } = await supabase.from('vom_post_attachments')
      .update({ sort_order: i + 1 }).eq('id', orderedIds[i]).eq('post_id', postId);
    check(error);
  }
  await supabase.from('vom_posts').update({ updated_at: new Date().toISOString() }).eq('id', postId);
  return getPost(postId);
}

// ---------- client dashboard side ----------

// Published posts of ONE client, newest first. Also the category list with a count for each one.
// Optional: { categoryId } to see only one category.
async function listPublishedForClient(clientId, { categoryId } = {}) {
  needId(clientId, 'clientId');

  const { data: all, error: countError } = await supabase.from('vom_posts')
    .select('id, category_id').eq('client_id', clientId).eq('status', 'published');
  check(countError);
  const counts = new Map();
  (all || []).forEach((p) => counts.set(p.category_id, (counts.get(p.category_id) || 0) + 1));
  const categories = (await listCategories()).map((c) => ({ ...c, count: counts.get(c.id) || 0 }));

  let q = supabase.from('vom_posts').select('*, vom_post_attachments(*)')
    .eq('client_id', clientId).eq('status', 'published').order('published_at', { ascending: false });
  if (categoryId) { needId(categoryId, 'categoryId'); q = q.eq('category_id', categoryId); }
  const { data, error } = await q;
  check(error);
  const names = await categoryNameMap();
  return { categories, posts: (data || []).map((p) => shapePost(p, names)) };
}

module.exports = {
  listCategories,
  listPostsForAdmin,
  getPost,
  createPost,
  updatePost,
  setStatus,
  deletePost,
  addAttachment,
  removeAttachment,
  reorderAttachments,
  listPublishedForClient,
};