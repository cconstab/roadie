// "Edit on page": turning what the owner did in the preview into a change to
// the site's files, or into words for the AI.
//
// The previewed page only reports what was clicked or typed (see preview-page.js).
// A text edit is applied here only when the old text is found in exactly one
// place in the site's files. Otherwise nothing is written, and the edit is
// handed to the AI as an exact instruction.
import fs from 'node:fs';
import { checkSitePath, isSecretPath } from './guards.js';
import { addFile, cleanUploadPath } from './uploads.js';

// Files whose text is page text, where a reworded sentence can be swapped in.
const MARKUP = /\.(html?|xhtml|njk|nunjucks|ejs|hbs|handlebars|mustache|liquid|php|erb|twig|vue|svelte|astro)$/i;
const PROSE = /\.(md|markdown|txt)$/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build)\/|\.min\.|(^|\/)package-lock\.json$/i;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TEXT = 5000;

// How a character of page text may be written in a file.
const NAMED = {
  '&': ['amp'], '<': ['lt'], '>': ['gt'], '"': ['quot'], "'": ['apos'], '\u00a0': ['nbsp'],
  '©': ['copy'], '®': ['reg'], '™': ['trade'], '—': ['mdash'], '–': ['ndash'], '…': ['hellip'],
  '‘': ['lsquo'], '’': ['rsquo'], '“': ['ldquo'], '”': ['rdquo'], '£': ['pound'], '€': ['euro'],
  '×': ['times'], '•': ['bull'], '·': ['middot'], '«': ['laquo'], '»': ['raquo'], '°': ['deg'],
  'é': ['eacute'], 'è': ['egrave'], 'à': ['agrave'], 'ü': ['uuml'], 'ö': ['ouml'], 'ä': ['auml'], 'ñ': ['ntilde'], 'ç': ['ccedil'],
};
const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');

// A pattern that finds `text` in a file however it was written there: any run
// of spaces or line breaks for a space, and entities (&amp; &#169; &copy;) for characters.
export function flexPattern(text) {
  let out = '';
  for (const ch of String(text).replace(/\s+/g, ' ')) {
    if (ch === ' ') { out += '(?:\\s|&nbsp;|&#160;|&#xa0;)+'; continue; }
    const code = ch.codePointAt(0);
    if (code < 128 && !NAMED[ch]) { out += escapeRe(ch); continue; }
    const forms = [escapeRe(ch), `&#${code};`, `&#[xX]0*${code.toString(16)};`, ...(NAMED[ch] || []).map((n) => `&${n};`)];
    out += `(?:${forms.join('|')})`;
  }
  return out;
}

const encode = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Split a reworded piece of text into what stayed the same at each end and what changed.
function splitChange(before, after) {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return { head: before.slice(0, p), was: before.slice(p, before.length - s), now: after.slice(p, after.length - s), tail: before.slice(before.length - s) };
}

// One change, ready to look for: { before, after, parent, first, last } from the page.
// Returns null when there is nothing usable in it.
function prepare(change, markup) {
  const before = String(change.before ?? '').slice(0, MAX_TEXT);
  let after = String(change.after ?? '').slice(0, MAX_TEXT);
  // Browsers swap in a non-breaking space where a typed space would not show.
  if (!before.includes('\u00a0')) after = after.replace(/\u00a0/g, ' ');
  const lead = before.match(/^\s*/)[0].length;
  const trail = before.length - before.match(/\s*$/)[0].length;
  const core = before.slice(lead, Math.max(lead, trail));
  const coreAfter = after.trim();
  if (!core) return null;
  const { head, was, now, tail } = splitChange(core, coreAfter);
  // In markup the text must sit where a piece of page text sits: straight after
  // a tag and straight before one. That keeps "Bakery" in <h1> apart from
  // "Bakery" in <title>, in an alt="" or in the middle of a sentence.
  const tag = /^[a-z][a-z0-9-]*$/.test(String(change.parent || '')) ? change.parent : null;
  const open = !markup ? '' : tag && change.first ? `(?<=(?i:<${tag})(?:\\s[^>]*)?>\\s*)` : '(?<=>\\s*)';
  const close = !markup ? '' : tag && change.last ? `(?=\\s*(?i:</${tag})\\s*>)` : '(?=\\s*<)';
  return {
    pattern: new RegExp(`${open}(${flexPattern(head)})(${flexPattern(was)})(${flexPattern(tail)})${close}`, 'g'),
    anywhere: new RegExp(flexPattern(core)), // not "g": it is only ever asked yes or no
    replacement: markup ? encode(now) : now,
  };
}

// The files that most likely make the page at this address: /about is about.html
// or about/index.html, in whichever folder the site keeps its pages.
export function pageFiles(page, files) {
  let p = '/';
  try { p = decodeURIComponent(String(page || '/').split(/[?#]/)[0]); } catch { /* keep "/" */ }
  if (!p.startsWith('/')) p = '/' + p;
  const wanted = p.endsWith('/') ? [`${p}index.html`, `${p}index.htm`] : [p, `${p}.html`, `${p}.htm`, `${p}/index.html`];
  const found = files.filter((f) => MARKUP.test(f) && wanted.some((w) => `/${f}`.toLowerCase().endsWith(w.toLowerCase())));
  const depth = Math.min(...found.map((f) => f.split('/').length));
  return found.filter((f) => f.split('/').length === depth);
}

function readText(dir, file) {
  const checked = checkSitePath(dir, file); // the same gate as the AI: no links out of the site
  if (!checked.ok) return null;
  try {
    const stat = fs.statSync(checked.abs);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const raw = fs.readFileSync(checked.abs);
    const text = raw.toString('utf8');
    if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(raw)) return null; // binary, or not UTF-8
    return { abs: checked.abs, text };
  } catch { return null; }
}

// Apply text changes made on a page. Returns
//   { ok: true, files: [...changed], alsoIn: [...other files holding the old text] }
//   { ok: false, reason: 'none' | 'many' | 'unclear', files: [...where the old text was seen] }
// Nothing is written unless every change was found in exactly one place.
export async function applyTextEdit({ gitops, dir, page, changes }) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 20) return { ok: false, reason: 'unclear', files: [] };
  const all = (await gitops.listFiles(dir)).filter((f) => !isSecretPath(f) && !SKIP.test(f));
  const editable = all.filter((f) => MARKUP.test(f) || PROSE.test(f));
  const pages = new Set(pageFiles(page, editable));
  const texts = new Map();
  const read = (file) => { if (!texts.has(file)) texts.set(file, readText(dir, file)); return texts.get(file); };

  const edits = new Map(); // file -> text after the changes so far
  const alsoIn = new Set();
  for (const change of changes) {
    const hits = []; // [file, count]
    const seen = new Set();
    for (const file of editable) {
      const entry = read(file);
      if (!entry) continue;
      const prepared = prepare(change, MARKUP.test(file));
      if (!prepared) return { ok: false, reason: 'unclear', files: [] };
      const text = edits.get(file) ?? entry.text;
      const count = [...text.matchAll(prepared.pattern)].length;
      if (count) hits.push([file, count, prepared]);
      else if (prepared.anywhere.test(text)) seen.add(file);
    }
    const onPage = hits.filter(([file]) => pages.has(file));
    const pool = onPage.length ? onPage : hits;
    const total = pool.reduce((n, [, count]) => n + count, 0);
    if (total !== 1) {
      return { ok: false, reason: total ? 'many' : 'none', files: [...new Set([...hits.map(([f]) => f), ...seen])].sort() };
    }
    const [file, , prepared] = pool[0];
    const text = edits.get(file) ?? read(file).text;
    edits.set(file, text.replace(prepared.pattern, (_all, head, _was, tail) => head + prepared.replacement + tail));
    // Say where else the old words are, when it matters: the same piece of text on
    // another page, and tests, which often check a page's words.
    for (const [other] of hits) if (other !== file && MARKUP.test(other)) alsoIn.add(other);
    for (const other of all) {
      if (other === file || alsoIn.has(other) || !/(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[a-z]+$/i.test(other)) continue;
      const entry = read(other);
      if (entry && prepared.anywhere.test(entry.text)) alsoIn.add(other);
    }
  }
  for (const [file, text] of edits) fs.writeFileSync(read(file).abs, text);
  return { ok: true, files: [...edits.keys()].sort(), alsoIn: [...alsoIn].filter((f) => !edits.has(f)).sort() };
}

// The pages of the site, as addresses for the preview: [{ path, file }], home first.
// A guess from the file names: the folder holding the home page is taken as the
// web root, "x/index.html" is served at "/x/", and other pages under their own name.
export function sitePages(files) {
  const pages = files.filter((f) => /\.html?$/i.test(f) && !isSecretPath(f) && !SKIP.test(f) && !f.split('/').some((p) => p.startsWith('.')));
  // The home page: the least deeply nested index.html and, between equals
  // ("public/" and "docs/"), the one whose folder holds the most pages.
  const folder = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '');
  const under = (dir) => pages.filter((f) => f.startsWith(dir)).length;
  const home = pages.filter((f) => /(^|\/)index\.html?$/i.test(f))
    .sort((a, b) => a.split('/').length - b.split('/').length || under(folder(b)) - under(folder(a)) || a.localeCompare(b))[0];
  const root = home ? folder(home) : '';
  const out = [];
  for (const file of pages) {
    if (!file.startsWith(root)) continue;
    const rel = file.slice(root.length).replace(/(^|\/)index\.html?$/i, '$1');
    out.push({ path: '/' + rel.split('/').map(encodeURIComponent).join('/'), file });
  }
  const depth = (p) => p.path.split('/').length - (p.path.endsWith('/') ? 1 : 0);
  out.sort((a, b) => depth(a) - depth(b) || a.path.localeCompare(b.path));
  return out.filter((p, i) => out.findIndex((q) => q.path === p.path) === i).slice(0, 300);
}

// A file name for a page from the words the owner typed: "Our Story" is our-story.html.
export function pageFileName(name) {
  const typed = String(name || '').trim();
  const ext = (typed.match(/\.html?$/i) || ['.html'])[0].toLowerCase();
  const stem = typed.replace(/\.html?$/i, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  if (!stem) throw new Error('Give the page a name, such as "about".');
  return stem + ext;
}

// Make a new page as a copy of an existing one, next to it, with its title and
// main heading changed. Never replaces a file. Returns { file, path, from }.
export function newPage({ dir, files, from, name, title }) {
  const pages = sitePages(files);
  const source = pages.find((p) => p.file === from) || pages.find((p) => p.path === from);
  if (!source) throw new Error('Choose one of the site\'s pages to start from.');
  const read = readText(dir, source.file);
  if (!read) throw new Error(`${source.file} could not be read as text.`);
  // Beside the page it copies, or beside the home page when that page is a folder's index.
  const folder = source.file.includes('/') ? source.file.slice(0, source.file.lastIndexOf('/')) : '';
  const rel = cleanUploadPath(folder, pageFileName(name));
  let text = read.text;
  const heading = String(title || '').trim().slice(0, 200);
  if (heading) {
    const safe = encode(heading);
    text = text.replace(/(<title[^>]*>)[^<]*(<\/title>)/i, (_m, a, b) => a + safe + b)
      .replace(/(<h1[^>]*>)[^<]*(<\/h1>)/i, (_m, a, b) => a + safe + b);
  }
  const added = addFile(dir, rel, Buffer.from(text, 'utf8'));
  const made = sitePages([...files, added.path]).find((p) => p.file === added.path);
  return { file: added.path, path: made ? made.path : '/' + added.path, from: source.file };
}

// Which file in the site is the picture at this address? Null unless exactly one fits.
export function locateImage(files, urlPath) {
  let p = '';
  try { p = decodeURIComponent(String(urlPath || '').split(/[?#]/)[0]); } catch { return null; }
  if (!p.startsWith('/') || p.includes('..')) return null;
  const found = files.filter((f) => !isSecretPath(f) && `/${f}`.toLowerCase().endsWith(p.toLowerCase()));
  const depth = Math.min(...found.map((f) => f.split('/').length));
  const nearest = found.filter((f) => f.split('/').length === depth);
  return nearest.length === 1 ? nearest[0] : null;
}

const clip = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, max); // eslint-disable-line no-control-regex

// What the owner clicked in the preview, tidied: only the fields Roadie expects, at sane lengths.
export function cleanPick(pick) {
  if (!pick || typeof pick !== 'object') return null;
  const out = { page: clip(pick.page, 300) || '/', tag: clip(pick.tag, 30).toLowerCase().replace(/[^a-z0-9-]/g, ''), selector: clip(pick.selector, 300), text: clip(pick.text, 200), html: clip(pick.html, 400) };
  if (!out.tag) return null;
  if (typeof pick.link === 'string' && pick.link) out.link = clip(pick.link, 300);
  if (pick.image && typeof pick.image === 'object') {
    out.image = { alt: clip(pick.image.alt, 200), attr: clip(pick.image.attr, 300), path: clip(pick.image.path, 300), file: clip(pick.image.file, 300) };
  }
  return out;
}

// One line for the chat list.
export function pickLabel(pick) {
  const what = pick.image ? `the image ${pick.image.file || pick.image.attr || ''}`.trim() : `<${pick.tag}>${pick.text ? ` “${pick.text.slice(0, 60)}${pick.text.length > 60 ? '…' : ''}”` : ''}`;
  return `Pointing at ${what} on ${pick.page}`;
}

// Background for the AI about the element the owner is pointing at.
export function pickContext(pick) {
  const lines = [
    'The owner clicked an element in the live preview and is talking about it. "This", "it" or "here" in their message means this element.',
    `Page address: ${pick.page}`,
    `Element: <${pick.tag}>, found by the CSS path: ${pick.selector}`,
  ];
  if (pick.text) lines.push(`Its text: ${JSON.stringify(pick.text)}`);
  if (pick.link) lines.push(`It is, or is inside, a link to: ${JSON.stringify(pick.link)}`);
  if (pick.image) {
    lines.push(`It is an image. src attribute: ${JSON.stringify(pick.image.attr)}; alt text: ${JSON.stringify(pick.image.alt)}`);
    if (pick.image.file) lines.push(`The image file in the site: ${pick.image.file}`);
  }
  if (pick.html) lines.push(`Its HTML as the browser has it (the source file may be laid out differently, or come from a template): ${pick.html}`);
  lines.push('Find it in the site\'s files before changing anything.');
  return lines.join('\n');
}

// Where a link may go, tidied: a page of this site, a web address, an email
// address, a phone number or a place on the same page. Throws in plain words.
export function linkTarget(typed) {
  const t = String(typed ?? '').trim();
  if (!t) throw new Error('Choose a page, or type an address.');
  // eslint-disable-next-line no-control-regex
  if (t.length > 500 || /[\u0000-\u0020"<>`]/.test(t)) throw new Error('That address has a space or a character that cannot be in a link.');
  if (/^(https?:\/\/|mailto:|tel:)[^\s]+$/i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) throw new Error('A link can go to a page of this site, an https address, an email address (mailto:) or a phone number (tel:).');
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(t)) return `mailto:${t}`;
  if (t.startsWith('#') || t.startsWith('/')) return t.startsWith('//') ? '/' + t.replace(/^\/+/, '') : t;
  if (/^(www\.)[^\s/]+\.[a-z]{2,}/i.test(t)) return `https://${t}`;
  return '/' + t;
}

// The request to the AI for a link the owner asked for from the page's toolbar.
export function linkRequest(pick, typed) {
  const to = linkTarget(typed);
  return pick.link
    ? `Change where this link goes: from ${JSON.stringify(pick.link)} to ${JSON.stringify(to)}. Change only this link, and write the address the way the site's other links are written.`
    : `Make this a link to ${JSON.stringify(to)}. Write the address the way the site's other links are written, keep the element looking the way it does now apart from being a link, and change nothing else.`;
}

// A text edit that could not be applied directly, as a message for the AI.
export function editRequest({ where, beforeText, afterText, result }) {
  const why = result.reason === 'many' ? 'That text appears in more than one place' : result.reason === 'none' ? 'That text is not written that way in any one file (it may come from a template or a script)' : 'The edit crossed more than plain text';
  return {
    text: `On ${where.page}, change the text of the <${where.tag}> element${where.selector ? ` (CSS path: ${where.selector})` : ''} from ${JSON.stringify(clip(beforeText, 1500))} to ${JSON.stringify(clip(afterText, 1500))}. Change only that element.`,
    why: `${why}, so Roadie has not changed any file.`,
    files: result.files || [],
  };
}
