/**
 * scripts/testVOM.js
 *
 * Tests the whole Voice of Market backend with dummy data:
 * categories, create / edit / publish / unpublish / delete, files, video links,
 * temporary links, private files, changing the order of files,
 * and "a client only sees its own posts".
 *
 * Run:  node scripts/testVOM.js
 * It uses the first 2 active clients in the database. Every dummy post is called "[TEST] ..." and is deleted at the end.
 */

require('dotenv').config();
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const posts = require('../modules/voiceOfMarket/vomPosts');
const files = require('../modules/voiceOfMarket/vomFiles');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET = 'vom-files';

let passed = 0;
let failed = 0;
const createdPostIds = [];
const touchedFolders = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

// The job must fail, and the error message must contain the given words
async function expectError(name, job, words) {
  try {
    await job();
    check(name, false, 'no error was raised');
  } catch (e) {
    check(name, !words || e.message.toLowerCase().includes(words.toLowerCase()), `error was: ${e.message}`);
  }
}

async function upload(path, text) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, Buffer.from(text), { contentType: 'application/pdf', upsert: true });
  return error ? error.message : null;
}

async function folderFiles(folder) {
  const { data } = await supabase.storage.from(BUCKET).list(folder);
  return (data || []).map((f) => f.name);
}

async function main() {
  // ---------- setup ----------
  console.log('\n1. Setup');
  const { data: clients, error: clientErr } = await supabase.schema('admin').from('clients')
    .select('id, company_name').eq('status', 'active').limit(2);
  if (clientErr) throw new Error(`Could not read admin.clients: ${clientErr.message}`);
  if (!clients || clients.length < 2) throw new Error('Need at least 2 active clients in admin.clients to run this test');
  const [clientA, clientB] = clients;
  console.log(`  Client A: ${clientA.company_name}   Client B: ${clientB.company_name}`);

  const categories = await posts.listCategories();
  check('11 categories are there', categories.length === 11, `found ${categories.length}`);
  check('categories are in order', categories.every((c, i) => i === 0 || categories[i - 1].sort_order <= c.sort_order));
  const catA = categories[0];
  const catB = categories[1];

  // ---------- create ----------
  console.log('\n2. Create a post');
  const draft = await posts.createPost({
    clientId: clientA.id, categoryId: catA.id, title: '[TEST] Draft post',
    body: '<h2>Heading</h2><p>Hello</p><script>alert("hack")</script><p onclick="bad()">Click</p>',
  });
  createdPostIds.push(draft.id);
  touchedFolders.push(`${clientA.id}/${draft.id}`);
  check('new post starts as a draft', draft.status === 'draft' && !draft.published_at);
  check('category name is filled', draft.category_name === catA.name);
  check('unsafe script is removed from the text', !/<script/i.test(draft.body) && !draft.body.includes('alert') && !/onclick/i.test(draft.body));
  check('headings are kept', /<h2>Heading<\/h2>/.test(draft.body));

  await expectError('empty title is refused', () => posts.createPost({ clientId: clientA.id, categoryId: catA.id, title: '   ' }), 'title');
  await expectError('title that is too long is refused', () => posts.createPost({ clientId: clientA.id, categoryId: catA.id, title: 'x'.repeat(301) }), 'too long');
  await expectError('bad client id is refused', () => posts.createPost({ clientId: 'abc', categoryId: catA.id, title: 'x' }), 'clientId');
  await expectError('bad category id is refused', () => posts.createPost({ clientId: clientA.id, categoryId: 'abc', title: 'x' }), 'categoryId');
  await expectError('client that does not exist is refused', () => posts.createPost({ clientId: randomUUID(), categoryId: catA.id, title: 'x' }), 'not found');
  await expectError('category that does not exist is refused', () => posts.createPost({ clientId: clientA.id, categoryId: randomUUID(), title: 'x' }), 'not found');

  // ---------- edit ----------
  console.log('\n3. Edit a post');
  const edited = await posts.updatePost(draft.id, { title: '[TEST] Draft post edited', categoryId: catB.id });
  check('title changed', edited.title === '[TEST] Draft post edited');
  check('category changed', edited.category_id === catB.id && edited.category_name === catB.name);
  check('text stayed the same', /Heading/.test(edited.body));
  const bodyOnly = await posts.updatePost(draft.id, { body: '<p>New text</p>' });
  check('text changed', /New text/.test(bodyOnly.body) && bodyOnly.title === '[TEST] Draft post edited');
  await expectError('empty title on edit is refused', () => posts.updatePost(draft.id, { title: ' ' }), 'title');
  await expectError('edit of a post that does not exist', () => posts.updatePost(randomUUID(), { title: 'x' }), 'not found');
  await expectError('bad post id', () => posts.getPost('abc'), 'postId');

  // ---------- publish rules ----------
  console.log('\n4. Empty post cannot be published');
  const empty = await posts.createPost({ clientId: clientA.id, categoryId: catA.id, title: '[TEST] Empty post', body: '' });
  createdPostIds.push(empty.id);
  await expectError('empty post is not published', () => posts.setStatus(empty.id, 'published'), 'empty');
  await expectError('wrong status word is refused', () => posts.setStatus(empty.id, 'live'), 'status');

  // ---------- files and video links ----------
  console.log('\n5. Files and video links');
  const video = await posts.addAttachment(draft.id, { type: 'video_link', fileUrl: 'https://www.youtube.com/watch?v=test123', fileName: 'Test video' });
  check('video link added', video.attachment_type === 'video_link' && video.sort_order === 1);
  await expectError('text that is not a link is refused', () => posts.addAttachment(draft.id, { type: 'video_link', fileUrl: 'not a link' }), 'web address');
  await expectError('link that is not http / https is refused', () => posts.addAttachment(draft.id, { type: 'video_link', fileUrl: 'ftp://example.com/a' }), 'http');
  await expectError('wrong file type is refused', () => posts.addAttachment(draft.id, { type: 'audio', fileUrl: 'x' }), 'type must be');
  await expectError('missing file path is refused', () => posts.addAttachment(draft.id, { type: 'pdf' }), 'missing');
  await expectError('file outside this post folder is refused', () => posts.addAttachment(draft.id, { type: 'pdf', fileUrl: 'wrong/folder/a.pdf' }), 'folder');
  await expectError('file for a post that does not exist', () => posts.addAttachment(randomUUID(), { type: 'video_link', fileUrl: 'https://a.com' }), 'not found');

  const pdfPath = `${clientA.id}/${draft.id}/test-report.pdf`;
  const uploadError = await upload(pdfPath, '%PDF-1.4 test file');
  check('test PDF uploaded to the private bucket', !uploadError, uploadError || '');
  const pdf = await posts.addAttachment(draft.id, { type: 'pdf', fileUrl: pdfPath, fileName: 'test-report.pdf' });
  check('PDF added after the video (order 2)', pdf.sort_order === 2);

  // ---------- publish ----------
  console.log('\n6. Publish');
  const published = await posts.setStatus(draft.id, 'published');
  check('post is published with a date', published.status === 'published' && !!published.published_at);
  const again = await posts.setStatus(draft.id, 'published');
  check('publishing again keeps the first date', again.published_at === published.published_at);
  check('files come in the right order', published.attachments[0].attachment_type === 'video_link' && published.attachments[1].attachment_type === 'pdf');

  // ---------- admin list ----------
  console.log('\n7. Admin list');
  const adminAll = await posts.listPostsForAdmin(clientA.id);
  check('admin sees the published post and the draft', adminAll.some((p) => p.id === draft.id) && adminAll.some((p) => p.id === empty.id));
  const adminDrafts = await posts.listPostsForAdmin(clientA.id, { status: 'draft' });
  check('draft filter works', adminDrafts.some((p) => p.id === empty.id) && !adminDrafts.some((p) => p.id === draft.id));
  const adminByCat = await posts.listPostsForAdmin(clientA.id, { categoryId: catB.id });
  check('category filter works', adminByCat.every((p) => p.category_id === catB.id) && adminByCat.some((p) => p.id === draft.id));
  await expectError('wrong status filter is refused', () => posts.listPostsForAdmin(clientA.id, { status: 'live' }), 'status');

  // ---------- client dashboard ----------
  console.log('\n8. Client dashboard');
  const listA = await posts.listPublishedForClient(clientA.id);
  check('client A sees the published post', listA.posts.some((p) => p.id === draft.id));
  check('client A does NOT see the draft', !listA.posts.some((p) => p.id === empty.id));
  check('every post shown is published', listA.posts.every((p) => p.status === 'published'));
  const listB = await posts.listPublishedForClient(clientB.id);
  check('client B does NOT see client A posts', !listB.posts.some((p) => p.client_id === clientA.id));
  check('all 11 categories come back with counts', listA.categories.length === 11);
  const countForB = listA.categories.find((c) => c.id === catB.id).count;
  check('category count matches the posts', countForB === listA.posts.filter((p) => p.category_id === catB.id).length);
  const listFiltered = await posts.listPublishedForClient(clientA.id, { categoryId: catB.id });
  check('category filter works for the client', listFiltered.posts.length > 0 && listFiltered.posts.every((p) => p.category_id === catB.id));
  const newest = listA.posts.map((p) => new Date(p.published_at).getTime());
  check('newest post comes first', newest.every((t, i) => i === 0 || newest[i - 1] >= t));

  // ---------- temporary links ----------
  console.log('\n9. Temporary links and private files');
  const hours = await files.getLinkHours();
  check('link time is between 1 and 24 hours', hours > 0 && hours <= 24, `got ${hours}`);
  const missingPath = `${clientA.id}/${draft.id}/missing.pdf`;
  const missingRow = await posts.addAttachment(draft.id, { type: 'pdf', fileUrl: missingPath, fileName: 'missing.pdf' });
  const withLinks = await files.addTemporaryLinksToPost(await posts.getPost(draft.id));
  const vid = withLinks.attachments.find((a) => a.attachment_type === 'video_link');
  const goodPdf = withLinks.attachments.find((a) => a.file_url === pdfPath);
  const lostPdf = withLinks.attachments.find((a) => a.file_url === missingPath);
  check('video link is passed on as it is', vid.url === 'https://www.youtube.com/watch?v=test123');
  check('PDF gets a temporary link', !!goodPdf.url && goodPdf.url.startsWith('http'));
  const opened = await fetch(goodPdf.url);
  check('temporary link opens the file', opened.status === 200, `status ${opened.status}`);
  const direct = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${pdfPath}`);
  check('the file does NOT open without a temporary link (private)', direct.status !== 200, `status ${direct.status}`);
  check('a missing file only fails itself', !lostPdf.url && !!lostPdf.url_error && !!goodPdf.url && !!vid.url);
  await posts.removeAttachment(missingRow.id);

  // ---------- unpublish ----------
  console.log('\n10. Unpublish');
  const back = await posts.setStatus(draft.id, 'draft');
  check('post is a draft again, no date', back.status === 'draft' && back.published_at === null);
  const listAfter = await posts.listPublishedForClient(clientA.id);
  check('client no longer sees it', !listAfter.posts.some((p) => p.id === draft.id));
  const republished = await posts.setStatus(draft.id, 'published');
  check('it can be published again', republished.status === 'published');

  // ---------- remove a file ----------
  console.log('\n11. Remove a file');
  const folder = `${clientA.id}/${draft.id}`;
  check('PDF is in storage before removing', (await folderFiles(folder)).includes('test-report.pdf'));
  await posts.removeAttachment(pdf.id);
  check('PDF is gone from the post', !(await posts.getPost(draft.id)).attachments.some((a) => a.id === pdf.id));
  check('PDF is gone from storage', !(await folderFiles(folder)).includes('test-report.pdf'));
  await expectError('removing a file that does not exist', () => posts.removeAttachment(randomUUID()), 'not found');
  await expectError('bad file id', () => posts.removeAttachment('abc'), 'attachmentId');

  // ---------- delete ----------
  console.log('\n12. Delete a post');
  const secondPath = `${folder}/second.pdf`;
  await upload(secondPath, '%PDF-1.4 second');
  await posts.addAttachment(draft.id, { type: 'pdf', fileUrl: secondPath, fileName: 'second.pdf' });
  await posts.deletePost(draft.id);
  await expectError('deleted post is gone', () => posts.getPost(draft.id), 'not found');
  const { count: leftRows } = await supabase.from('vom_post_attachments').select('id', { count: 'exact', head: true }).eq('post_id', draft.id);
  check('its file rows are gone', leftRows === 0, `${leftRows} left`);
  check('its files are gone from storage', (await folderFiles(folder)).length === 0);
  await expectError('deleting a post that does not exist', () => posts.deletePost(randomUUID()), 'not found');
  createdPostIds.splice(createdPostIds.indexOf(draft.id), 1);

  // ---------- reorder ----------
  console.log('\n13. Change the order of files');
  const orderPost = await posts.createPost({ clientId: clientA.id, categoryId: catA.id, title: '[TEST] Order post', body: '<p>x</p>' });
  createdPostIds.push(orderPost.id);
  const v1 = await posts.addAttachment(orderPost.id, { type: 'video_link', fileUrl: 'https://a.com/1' });
  const v2 = await posts.addAttachment(orderPost.id, { type: 'video_link', fileUrl: 'https://a.com/2' });
  const v3 = await posts.addAttachment(orderPost.id, { type: 'video_link', fileUrl: 'https://a.com/3' });
  const wanted = [v3.id, v1.id, v2.id].join();
  const reordered = await posts.reorderAttachments(orderPost.id, [v3.id, v1.id, v2.id]);
  check('new order is saved', reordered.attachments.map((a) => a.id).join() === wanted);
  const reloaded = await posts.getPost(orderPost.id);
  check('new order is still there after reloading', reloaded.attachments.map((a) => a.id).join() === wanted);
  await expectError('empty list is refused', () => posts.reorderAttachments(orderPost.id, []), 'list');
  await expectError('list with a missing file is refused', () => posts.reorderAttachments(orderPost.id, [v1.id, v2.id]), 'every file');
  await expectError('list with a file twice is refused', () => posts.reorderAttachments(orderPost.id, [v1.id, v1.id, v2.id]), 'twice');
  await expectError('file of another post is refused', () => posts.reorderAttachments(orderPost.id, [v1.id, v2.id, randomUUID()]), 'does not belong');
  await expectError('bad file id is refused', () => posts.reorderAttachments(orderPost.id, [v1.id, v2.id, 'abc']), 'id');
}

async function cleanUp() {
  for (const id of createdPostIds) {
    try { await posts.deletePost(id); } catch (e) { /* already gone */ }
  }
  for (const folder of touchedFolders) {
    const names = await folderFiles(folder);
    if (names.length) await supabase.storage.from(BUCKET).remove(names.map((n) => `${folder}/${n}`));
  }
}

main()
  .catch((e) => {
    failed += 1;
    console.log(`\n  STOPPED by an unexpected error: ${e.message}`);
  })
  .finally(async () => {
    await cleanUp();
    console.log(`\nDone. ${passed} passed, ${failed} failed.`);
    process.exit(failed ? 1 : 0);
  });