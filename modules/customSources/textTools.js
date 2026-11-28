/**
 * modules/customSources/textTools.js
 *
 * Small text helpers shared by the readers (readText.js, readPdf.js).
 * None of them ever removes a real word.
 */

// Odd letters made normal ("fi" ligature -> "fi"), invisible characters and
// extra spaces removed. keepLines keeps line breaks (tables need them).
function cleanText(value, { keepLines = false } = {}) {
  let text = String(value || '').normalize('NFKC');
  text = text.replace(/ /g, ' ').replace(/[​-‍﻿]/g, '');
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  text = text.replace(/\r\n?/g, '\n');
  if (!keepLines) return text.replace(/\s+/g, ' ').trim();
  return text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * A part that starts with one symbol and a space ("• ", "▪ ", "* ", or a
 * bullet from a special font that comes out as "¢ ") is a list item: the
 * symbol is the bullet, not content. Returns { text, isBullet }.
 * A symbol followed by a number ("$5", "£ 20") is money, not a bullet, and
 * "+ 4" or "- 0.57" is a sign, not a bullet.
 */
function stripBullet(text) {
  const match = String(text).match(/^([\p{S}\p{Po}\p{Pd}])\s+(?=\S)/u);
  if (!match) return { text, isBullet: false };
  const rest = text.slice(match[0].length);
  if (/^\p{Sc}$/u.test(match[1]) && /^\d/.test(rest)) return { text, isBullet: false };
  if (/^[+\-\u2212\u2013]$/.test(match[1]) && /^\d/.test(rest)) return { text, isBullet: false }; // "- 0.57" is a minus number
  return { text: rest, isBullet: true };
}

/**
 * How a line is compared with the same line on other pages (to find
 * running headers and footers).
 * A footer often starts or ends with the page number ("... All Rights
 * Reserved. 7"), so a number at the very start or end counts as the same.
 * Numbers in the middle of a line are compared exactly ("sales grew 5%"
 * and "sales grew 7%" are different lines).
 * A line with fewer than 3 letters (like "+14%") is never a header or
 * footer: it gets no key (null), so it is always kept.
 */
function repeatKey(text) {
  const lower = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  if ((lower.match(/\p{L}/gu) || []).length < 3) return null;
  return lower.replace(/^\d+\s*|\s*\d+$/g, '#');
}

const short = (text, max = 60) => (text.length > max ? `${text.slice(0, max)}...` : text);

module.exports = { cleanText, stripBullet, repeatKey, short };
