/**
 * modules/voiceOfMarket/route.js
 *
 * In server.js (before app.listen):
 *   const { registerVoiceOfMarketRoute } = require('./modules/voiceOfMarket/route');
 *   registerVoiceOfMarketRoute(app);
 *
 *  Admin console (the analyst):
 *  GET    /voice-of-market/categories                          the fixed list of categories (the tag dropdown)
 *  GET    /voice-of-market/admin/posts/:clientId               all posts of one client (drafts + published)  ?status=draft|published&categoryId=
 *  GET    /voice-of-market/admin/post/:postId                  one post, with its files
 *  POST   /voice-of-market/admin/posts                         body {clientId, categoryId, title, body}: new post (starts as a draft)
 *  PATCH  /voice-of-market/admin/posts/:postId                 body {title?, body?, categoryId?}: edit
 *  POST   /voice-of-market/admin/posts/:postId/publish         show it to the client
 *  POST   /voice-of-market/admin/posts/:postId/unpublish       back to draft
 *  DELETE /voice-of-market/admin/posts/:postId                 delete the post and its files
 *  POST   /voice-of-market/admin/posts/:postId/attachments     body {type, fileUrl, fileName?, sortOrder?}: add a file or video link
 *  DELETE /voice-of-market/admin/attachments/:attachmentId     remove one file or video link
 *
 *  Client dashboard:
 *  GET    /voice-of-market/posts/:clientId                     published posts + categories with counts  ?categoryId=
 *
 *  Every file comes back with a temporary "url" (see vomFiles.js).
 *  *  PATCH  /voice-of-market/admin/posts/:postId/attachments/order   body {order: [file ids]}: save the order of the files
 */

const {
  listCategories, listPostsForAdmin, getPost, createPost, updatePost,
  setStatus, deletePost, addAttachment, removeAttachment, reorderAttachments, listPublishedForClient,
} = require('./vomPosts');
const { addTemporaryLinks, addTemporaryLinksToPost } = require('./vomFiles');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, error: msg });

// Runs a route and turns any error into a clean { ok:false, error } answer
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(`[VoiceOfMarket] ${req.method} ${req.path} failed: ${e.message}`);
      return bad(res, e.message, status);
    }
  };
}

// The day the post was published, in India time (YYYY-MM-DD). The dashboard uses it for "Today" / "Yesterday".
function withPublishedDay(post) {
  if (!post.published_at) return { ...post, published_day: null };
  const day = new Date(new Date(post.published_at).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  return { ...post, published_day: day };
}

function registerVoiceOfMarketRoute(app) {
  // ---------------- categories ----------------
  app.get('/voice-of-market/categories', handle(async (req, res) => {
    return res.json({ ok: true, categories: await listCategories() });
  }));

  // ---------------- admin console ----------------
  app.get('/voice-of-market/admin/posts/:clientId', handle(async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    const posts = await listPostsForAdmin(clientId, { status: req.query.status, categoryId: req.query.categoryId });
    const withLinks = (await addTemporaryLinks(posts)).map(withPublishedDay);
    return res.json({ ok: true, total: withLinks.length, posts: withLinks });
  }));

  app.get('/voice-of-market/admin/post/:postId', handle(async (req, res) => {
    const post = await addTemporaryLinksToPost(await getPost(req.params.postId));
    return res.json({ ok: true, post: withPublishedDay(post) });
  }));

  app.post('/voice-of-market/admin/posts', handle(async (req, res) => {
    const b = req.body || {};
    const post = await createPost({ clientId: b.clientId, categoryId: b.categoryId, title: b.title, body: b.body });
    return res.status(201).json({ ok: true, post: withPublishedDay(post) });
  }));

  app.patch('/voice-of-market/admin/posts/:postId', handle(async (req, res) => {
    const b = req.body || {};
    const post = await updatePost(req.params.postId, { title: b.title, body: b.body, categoryId: b.categoryId });
    return res.json({ ok: true, post: withPublishedDay(await addTemporaryLinksToPost(post)) });
  }));

  app.post('/voice-of-market/admin/posts/:postId/publish', handle(async (req, res) => {
    const post = await setStatus(req.params.postId, 'published');
    return res.json({ ok: true, post: withPublishedDay(await addTemporaryLinksToPost(post)) });
  }));

  app.post('/voice-of-market/admin/posts/:postId/unpublish', handle(async (req, res) => {
    const post = await setStatus(req.params.postId, 'draft');
    return res.json({ ok: true, post: withPublishedDay(await addTemporaryLinksToPost(post)) });
  }));

  app.delete('/voice-of-market/admin/posts/:postId', handle(async (req, res) => {
    return res.json({ ok: true, ...(await deletePost(req.params.postId)) });
  }));

  app.post('/voice-of-market/admin/posts/:postId/attachments', handle(async (req, res) => {
    const b = req.body || {};
    const attachment = await addAttachment(req.params.postId, { type: b.type, fileUrl: b.fileUrl, fileName: b.fileName, sortOrder: b.sortOrder });
    return res.status(201).json({ ok: true, attachment });
  }));

  app.delete('/voice-of-market/admin/attachments/:attachmentId', handle(async (req, res) => {
    return res.json({ ok: true, ...(await removeAttachment(req.params.attachmentId)) });
  }));

    app.patch('/voice-of-market/admin/posts/:postId/attachments/order', handle(async (req, res) => {
    const post = await reorderAttachments(req.params.postId, (req.body || {}).order);
    return res.json({ ok: true, post: withPublishedDay(await addTemporaryLinksToPost(post)) });
  }));

  // ---------------- client dashboard ----------------
  app.get('/voice-of-market/posts/:clientId', handle(async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    const { categories, posts } = await listPublishedForClient(clientId, { categoryId: req.query.categoryId });
    const withLinks = (await addTemporaryLinks(posts)).map(withPublishedDay);
    return res.json({ ok: true, categories, total: withLinks.length, posts: withLinks });
  }));

  console.log('[VoiceOfMarket] routes registered');
}

module.exports = { registerVoiceOfMarketRoute };