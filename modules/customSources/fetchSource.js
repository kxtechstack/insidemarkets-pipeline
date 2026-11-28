/**
 * modules/customSources/fetchSource.js
 *
 * Step 2 of reading a custom source: get the bytes, safely.
 *
 * In:  the job from receiveSource.js
 * Out: {
 *   kind,         // what we really got: file / website / text
 *   fileType,     // pdf, docx, xlsx, pptx, doc, xls, ppt, html or text
 *   bytes,        // the downloaded bytes (Buffer), null for typed text
 *   text,         // typed text, or a plain text file
 *   fileName,     // a name with the right ending (.pdf, .docx ...) for the file reader
 *   contentType,  // what the site said it sent
 *   finalUrl,     // the link after all redirects
 *   blocked,      // a website refused robots (403 / 429 / 503): { status }.
 *                 // The next step can then try Firecrawl.
 * }
 *
 * Safety rules for links (a link is typed by a person, so we never trust it):
 *   - Only http and https, only ports 80 and 443, no "user:password@" in the link.
 *   - The link must point to a public internet address. Never to our own
 *     machines: localhost, private networks (10.x, 172.16-31.x, 192.168.x),
 *     Docker names like "qdrant", the cloud metadata address 169.254.169.254 ...
 *   - The address is checked at the moment we connect, so a site cannot pass
 *     the check and then switch to an internal address.
 *   - Every redirect is checked again the same way.
 *   - Size limit (stops as soon as it goes over, also after unzipping) and a time limit.
 *
 * Uploaded files: downloaded from the bucket with the backend key. The file
 * must sit in the folder of the source's own client.
 *
 * We decide what we got from the file's first bytes, not only from what the
 * site says. A "website" link that is really a PDF goes to the file reader.
 * A "pdf" link that opens a web page (often a login page) is refused.
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const {
  STORAGE_BUCKET, MAX_DOWNLOAD_MB, FETCH_TIMEOUT_MS, MAX_REDIRECTS,
  ALLOWED_PORTS, USER_AGENT, BLOCKED_STATUSES,
} = require('./customSourceConfig');
const { SourceError } = require('./sourceError');

let sharedDb = null;
function defaultDb() {
  if (!sharedDb) sharedDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return sharedDb;
}

// ── Which internet addresses are NOT allowed ────────────────────────────
const NOT_PUBLIC = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([address, bits]) => NOT_PUBLIC.addSubnet(address, bits, 'ipv4'));
[
  // (::ffff:x.x.x.x is not listed here: Node would then block every IPv4
  // address. unwrapIpv4 turns it into the IPv4 address, checked above.)
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].forEach(([address, bits]) => NOT_PUBLIC.addSubnet(address, bits, 'ipv6'));

// An IPv6 address that only wraps an IPv4 one (::ffff:127.0.0.1) is checked as the IPv4 one
function unwrapIpv4(address) {
  const lower = String(address).toLowerCase().replace(/^\[|\]$/g, '');
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return lower;
}

// true = a normal public internet address
function isPublicAddress(address) {
  const plain = unwrapIpv4(address);
  const version = net.isIP(plain);
  if (version === 4) return !NOT_PUBLIC.check(plain, 'ipv4');
  if (version === 6) return !NOT_PUBLIC.check(plain, 'ipv6');
  return false; // not an address at all
}

const blockedAddress = (host) =>
  new SourceError('BLOCKED_ADDRESS', `The link points to a private or internal address (${host}). Only public web links are allowed.`);

/**
 * Checks a link before we open it. Throws a SourceError if it is not allowed.
 * @param {URL} link
 * @param {object} rules  { isAllowedAddress, allowedPorts }
 */
function checkLink(link, rules) {
  if (link.protocol !== 'http:' && link.protocol !== 'https:') {
    throw new SourceError('BAD_LINK', 'Only http:// and https:// links are allowed.');
  }
  if (link.username || link.password) {
    throw new SourceError('BAD_LINK', 'Links with a user name or password in them are not allowed.');
  }
  const port = link.port ? Number(link.port) : (link.protocol === 'https:' ? 443 : 80);
  if (!rules.allowedPorts.includes(port)) {
    throw new SourceError('BLOCKED_PORT', `The link uses port ${port}. Only normal web links (ports ${rules.allowedPorts.join(' and ')}) are allowed.`);
  }
  // A link written with a bare address (http://10.0.0.5/) is checked here,
  // because no name lookup happens for it.
  const host = link.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !rules.isAllowedAddress(host)) throw blockedAddress(host);
}

// Name lookup that refuses non-public addresses. It runs at the moment of
// connecting, so there is no gap between the check and the connection.
function guardedLookup(isAllowedAddress) {
  return (hostname, options, callback) => {
    const opts = typeof options === 'object' && options !== null ? options : { family: options || 0 };
    dns.lookup(hostname, { all: true, family: opts.family || 0, hints: opts.hints }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses || addresses.length === 0) return callback(new SourceError('LINK_NOT_FOUND', `The site ${hostname} was not found.`));
      // Every address the name points to must be public
      const bad = addresses.find((a) => !isAllowedAddress(a.address));
      if (bad) return callback(blockedAddress(`${hostname} -> ${bad.address}`));
      if (opts.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

// One request, no redirects followed here
function requestOnce(link, rules, msLeft) {
  return new Promise((resolve, reject) => {
    const lib = link.protocol === 'https:' ? https : http;
    const request = lib.request(link, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      lookup: guardedLookup(rules.isAllowedAddress),
      agent: false, // a fresh connection every time, so every connection is checked
      timeout: msLeft,
    }, resolve);
    request.on('timeout', () => request.destroy(new SourceError('TIMEOUT', 'The site took too long to answer.')));
    request.on('error', reject);
    request.end();
  });
}

// Reads the reply body, unzips it if needed, and stops as soon as it is too big
function readBody(reply, maxBytes, msLeft) {
  return new Promise((resolve, reject) => {
    const declared = Number(reply.headers['content-length']);
    if (declared && declared > maxBytes) {
      reply.destroy();
      return reject(tooBig(maxBytes));
    }
    const encoding = String(reply.headers['content-encoding'] || '').toLowerCase().trim();
    let stream = reply;
    if (encoding === 'gzip' || encoding === 'x-gzip') stream = reply.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') stream = reply.pipe(zlib.createInflate());
    else if (encoding === 'br') stream = reply.pipe(zlib.createBrotliDecompress());

    const parts = [];
    let size = 0;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        reply.destroy();
        if (stream !== reply) stream.destroy();
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(new SourceError('TIMEOUT', 'The download took too long.')), Math.max(msLeft, 1));

    stream.on('data', (part) => {
      size += part.length;
      if (size > maxBytes) return finish(tooBig(maxBytes));
      parts.push(part);
    });
    stream.on('end', () => finish(null, Buffer.concat(parts)));
    stream.on('error', (e) => finish(e.code === 'Z_DATA_ERROR' || e.code === 'ERR_PADDING_1'
      ? new SourceError('BAD_DOWNLOAD', 'The site sent a broken compressed reply.')
      : e));
    reply.on('error', (e) => finish(e));
  });
}

const tooBig = (maxBytes) =>
  new SourceError('TOO_BIG', `The file or page is bigger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);

/**
 * Opens a link, follows redirects (each one checked), and returns the reply.
 * @returns {{ status, headers, bytes, finalUrl }}
 */
async function downloadLink(url, rules) {
  const deadline = Date.now() + rules.timeoutMs;
  let link;
  try {
    link = new URL(url);
  } catch {
    throw new SourceError('BAD_LINK', 'This is not a valid web link.');
  }

  for (let hop = 0; hop <= rules.maxRedirects; hop += 1) {
    checkLink(link, rules);
    const msLeft = deadline - Date.now();
    if (msLeft <= 0) throw new SourceError('TIMEOUT', 'The site took too long to answer.');

    let reply;
    try {
      reply = await requestOnce(link, rules, msLeft);
    } catch (e) {
      if (e instanceof SourceError) throw e;
      if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') throw new SourceError('LINK_NOT_FOUND', `The site ${link.hostname} was not found.`);
      if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') throw new SourceError('LINK_UNREACHABLE', `Could not connect to ${link.hostname}.`);
      if (String(e.code || '').startsWith('ERR_TLS') || /certificate/i.test(e.message)) {
        throw new SourceError('LINK_UNREACHABLE', `The secure connection to ${link.hostname} failed (${e.message}).`);
      }
      throw e;
    }

    const status = reply.statusCode;
    if (status >= 300 && status < 400 && reply.headers.location) {
      reply.resume(); // throw away the redirect page
      try {
        link = new URL(reply.headers.location, link);
      } catch {
        throw new SourceError('BAD_LINK', 'The site sent us on to a link that is not valid.');
      }
      continue;
    }

    if (status < 200 || status >= 300) {
      reply.resume();
      return { status, headers: reply.headers, bytes: null, finalUrl: link.href };
    }

    const bytes = await readBody(reply, rules.maxBytes, deadline - Date.now());
    return { status, headers: reply.headers, bytes, finalUrl: link.href };
  }
  throw new SourceError('TOO_MANY_REDIRECTS', `The link sent us on more than ${rules.maxRedirects} times.`);
}

// ── What did we get? ────────────────────────────────────────────────────
const FILE_TYPES = ['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'];

/**
 * Decides the type from the first bytes (and the name / what the site said as a hint).
 * @returns one of FILE_TYPES, 'html', 'text' or 'unknown'
 */
function detectFileType(bytes, contentType = '', nameHint = '') {
  if (!bytes || bytes.length === 0) return 'unknown';
  const head = bytes.subarray(0, 1024);
  const type = String(contentType).toLowerCase();
  const ext = path.extname(String(nameHint).split(/[?#]/)[0]).toLowerCase().replace('.', '');

  if (head.includes('%PDF-')) return 'pdf';

  // Word / Excel / PowerPoint (new): a zip with known folders inside
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    if (bytes.includes('word/')) return 'docx';
    if (bytes.includes('xl/')) return 'xlsx';
    if (bytes.includes('ppt/')) return 'pptx';
    return 'unknown';
  }

  // Word / Excel / PowerPoint (old)
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return ['doc', 'xls', 'ppt'].includes(ext) ? ext : 'doc';
  }

  // Text of some kind: no zero bytes at the start
  const sample = bytes.subarray(0, 4096);
  if (sample.includes(0)) return 'unknown';
  const start = sample.toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if (type.includes('html') || type.includes('xhtml') || start.startsWith('<!doctype html') || start.startsWith('<html') || /<html[\s>]/.test(start.slice(0, 1024))) {
    return 'html';
  }
  if (type.startsWith('text/') || ['txt', 'csv', 'md'].includes(ext)) return 'text';
  return 'unknown';
}

// A clean file name with the right ending, for the file reader
function fileNameFor(nameHint, fileType) {
  let base = '';
  try {
    base = decodeURIComponent(path.basename(String(nameHint).split(/[?#]/)[0]));
  } catch {
    base = path.basename(String(nameHint).split(/[?#]/)[0]);
  }
  base = base.replace(/\.[^.]*$/, '').replace(/[^\w\- ]+/g, '_').trim().slice(0, 80) || 'document';
  return `${base}.${fileType === 'html' ? 'html' : fileType === 'text' ? 'txt' : fileType}`;
}

// Turns the downloaded bytes into the result, or stops with a clear message
function describe(job, bytes, contentType, nameHint, finalUrl) {
  if (!bytes || bytes.length === 0) throw new SourceError('EMPTY_DOWNLOAD', 'The file or page was empty.');
  const fileType = detectFileType(bytes, contentType, nameHint);
  const result = { kind: null, fileType, bytes, text: null, fileName: fileNameFor(nameHint, fileType), contentType: contentType || null, finalUrl, blocked: null };

  if (FILE_TYPES.includes(fileType)) return { ...result, kind: 'file' };
  if (fileType === 'html') {
    if (job.kind === 'file') {
      throw new SourceError('NOT_A_FILE', 'The file link opened a web page, not a file. The file may need a login, or the link may be wrong.');
    }
    return { ...result, kind: 'website' };
  }
  if (fileType === 'text') return { ...result, kind: 'text', text: bytes.toString('utf8').replace(/^﻿/, '') };
  throw new SourceError('UNSUPPORTED_CONTENT',
    `This kind of file is not supported${contentType ? ` (${contentType})` : ''}. Supported: PDF, Word, Excel, PowerPoint, web pages and plain text.`);
}

/**
 * @param {object} job   from receiveSource.js
 * @param {object} [deps] { db, isAllowedAddress, allowedPorts, timeoutMs, maxBytes } (the tests change these)
 */
async function fetchSource(job, deps = {}) {
  const rules = {
    isAllowedAddress: deps.isAllowedAddress || isPublicAddress,
    allowedPorts: deps.allowedPorts || ALLOWED_PORTS,
    timeoutMs: deps.timeoutMs || FETCH_TIMEOUT_MS,
    maxBytes: deps.maxBytes || MAX_DOWNLOAD_MB * 1024 * 1024,
    maxRedirects: deps.maxRedirects ?? MAX_REDIRECTS,
  };

  // Typed text: nothing to download
  if (job.kind === 'text') {
    return { kind: 'text', fileType: 'text', bytes: null, text: job.text, fileName: null, contentType: null, finalUrl: null, blocked: null };
  }

  // Uploaded file
  if (job.storagePath) {
    const storagePath = job.storagePath.replace(/^\/+/, '');
    if (!storagePath.startsWith(`${job.clientId}/`) || storagePath.split('/').includes('..')) {
      throw new SourceError('WRONG_FOLDER', 'The uploaded file is not in this client\'s folder.');
    }
    const db = deps.db || defaultDb();
    const { data, error } = await db.storage.from(STORAGE_BUCKET).download(storagePath);
    if (error || !data) {
      const msg = (error && error.message) || 'no data';
      if (/not.?found|does not exist|404/i.test(msg)) throw new SourceError('FILE_NOT_FOUND', 'The uploaded file was not found in storage. Please upload it again.');
      throw new Error(`Could not download the uploaded file: ${msg}`);
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    if (bytes.length > rules.maxBytes) throw tooBig(rules.maxBytes);
    return describe(job, bytes, data.type || '', storagePath, null);
  }

  // A link (website, or a link to a file)
  const reply = await downloadLink(job.url, rules);
  const { status } = reply;

  if (status >= 200 && status < 300) {
    return describe(job, reply.bytes, reply.headers['content-type'] || '', new URL(reply.finalUrl).pathname, reply.finalUrl);
  }
  if (status === 401) throw new SourceError('LOGIN_NEEDED', 'The site asks for a login. Only pages anyone can open are supported.');
  if (status === 404 || status === 410) throw new SourceError('LINK_NOT_FOUND', `The site says this page does not exist (status ${status}).`);
  if (BLOCKED_STATUSES.includes(status)) {
    if (job.kind === 'website') {
      // Let the next step try Firecrawl
      return { kind: 'website', fileType: 'html', bytes: null, text: null, fileName: null, contentType: null, finalUrl: reply.finalUrl, blocked: { status } };
    }
    throw new SourceError('BLOCKED_BY_SITE', `The site refused our download (status ${status}).`);
  }
  throw new SourceError('HTTP_ERROR', `The site answered with an error (status ${status}).`);
}

module.exports = { fetchSource, isPublicAddress, checkLink, detectFileType, fileNameFor, unwrapIpv4 };
