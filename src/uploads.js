// Files the owner adds to the site by hand (images above all), and the checks
// on them. Everything is written through checkSitePath, the same gate the AI's
// edits pass: inside the site folder, not .git, not a secrets file.
import fs from 'node:fs';
import path from 'node:path';
import { checkSitePath } from './guards.js';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;   // one file added to the site
export const MAX_AI_IMAGE_BYTES = 5 * 1024 * 1024;  // one image shown to the AI (the API's own limit)
export const MAX_AI_IMAGES = 5;

const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
};

// The content type for a file the browser can show as a picture, or null.
export function imageType(rel) {
  const ext = String(rel).split('.').pop().toLowerCase();
  return IMAGE_TYPES[ext] || null;
}

// What kind of picture these bytes really are, whatever the file was called.
// Only the four kinds the AI service accepts.
export function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i; // names Windows will not create

// Turn the folder and file name the owner chose into one path inside the site,
// with forward slashes. Throws, in plain words, when the name cannot be used.
export function cleanUploadPath(folder, name) {
  const parts = `${folder || ''}/${name || ''}`.split(/[\\/]+/).map((p) => p.trim()).filter(Boolean);
  if (!String(name || '').trim() || !parts.length) throw new Error('Give the file a name.');
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error('The folder must be inside the site: it cannot contain "." or "..".');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f<>:"|?*]/.test(part)) throw new Error(`"${part}" has a character that cannot be used in a file name (one of < > : " | ? *).`);
    if (/[. ]$/.test(part)) throw new Error(`"${part}" ends with a dot or a space, which Windows does not allow.`);
    if (RESERVED.test(part)) throw new Error(`"${part}" is a name Windows keeps for itself. Choose another.`);
    if (part.length > 120) throw new Error('That name is too long.');
  }
  const rel = parts.join('/');
  if (rel.length > 240) throw new Error('That path is too long.');
  return rel;
}

// Write one file into the site. An existing file is only replaced when asked.
export function addFile(siteDir, rel, data, { replace = false } = {}) {
  if (!Buffer.isBuffer(data) || !data.length) throw new Error('That file is empty.');
  if (data.length > MAX_UPLOAD_BYTES) throw new Error(`That file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB, which is too big to add here.`);
  const checked = checkSitePath(siteDir, rel);
  if (!checked.ok) throw new Error(checked.reason);
  let existed = false;
  try {
    const stat = fs.statSync(checked.abs);
    if (stat.isDirectory()) throw Object.assign(new Error(`${checked.rel} is a folder, so a file cannot take its name.`), { plain: true });
    existed = true;
  } catch (err) {
    if (err.plain) throw err;
  }
  if (existed && !replace) {
    throw Object.assign(new Error(`${checked.rel} already exists.`), { data: { exists: true, path: checked.rel } });
  }
  try {
    fs.mkdirSync(path.dirname(checked.abs), { recursive: true });
    fs.writeFileSync(checked.abs, data);
  } catch (err) {
    throw new Error(`Could not write ${checked.rel}: ${err.code === 'ENOTDIR' || err.code === 'EEXIST' ? 'part of that folder path is a file.' : err.message}`);
  }
  return { path: checked.rel, bytes: data.length, replaced: existed };
}

// Delete one file. Used by the AI's delete_file tool.
export function removeFile(siteDir, rel) {
  const checked = checkSitePath(siteDir, rel);
  if (!checked.ok) throw new Error(checked.reason);
  let stat;
  try { stat = fs.lstatSync(checked.abs); } catch { throw new Error(`${checked.rel} does not exist.`); }
  if (stat.isDirectory()) throw new Error(`${checked.rel} is a folder. Delete the files in it one at a time.`);
  fs.rmSync(checked.abs);
  pruneEmptyFolders(checked.root, path.dirname(checked.abs));
  return { path: checked.rel };
}

// Move or rename one file. Used by the AI's move_file tool. Never replaces a file.
export function moveFile(siteDir, from, to) {
  const a = checkSitePath(siteDir, from);
  if (!a.ok) throw new Error(a.reason);
  const b = checkSitePath(siteDir, to);
  if (!b.ok) throw new Error(b.reason);
  cleanUploadPath('', b.rel); // the new name must be one every system can hold
  let stat;
  try { stat = fs.lstatSync(a.abs); } catch { throw new Error(`${a.rel} does not exist.`); }
  if (stat.isDirectory()) throw new Error(`${a.rel} is a folder. Move the files in it one at a time.`);
  // A change of letter case only ("Logo.PNG" to "logo.png") is the same file on macOS and Windows.
  // There the new name "exists" already, as the very file being renamed, and
  // Windows hands the path back in the old spelling: keep the spelling asked for.
  const wanted = String(to).split(/[\\/]/).filter(Boolean).pop();
  if (path.basename(b.abs) !== wanted && path.basename(b.abs).toLowerCase() === wanted.toLowerCase()) {
    b.abs = path.join(path.dirname(b.abs), wanted);
    b.rel = [...b.rel.split('/').slice(0, -1), wanted].join('/');
  }
  let taken = null;
  try { taken = fs.lstatSync(b.abs); } catch { /* free */ }
  if (taken && !(taken.ino === stat.ino && taken.dev === stat.dev && a.abs.toLowerCase() === b.abs.toLowerCase())) {
    throw new Error(`${b.rel} already exists. Delete it first if it should be replaced.`);
  }
  fs.mkdirSync(path.dirname(b.abs), { recursive: true });
  fs.renameSync(a.abs, b.abs);
  pruneEmptyFolders(a.root, path.dirname(a.abs));
  return { from: a.rel, to: b.rel };
}

// Git does not keep empty folders, so neither does Roadie: remove the ones a
// delete or move left behind, stopping at the site folder itself. `root` is the
// site folder as checkSitePath resolved it, so the two paths are spelled alike.
function pruneEmptyFolders(root, start) {
  let dir = start;
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try { fs.rmdirSync(dir); } catch { return; } // not empty, or gone
    dir = path.dirname(dir);
  }
}

// Where images go in this site: the folders that already hold some, most used
// first, and the one to offer by default.
export function uploadFolders(files) {
  const counts = new Map();
  for (const file of files) {
    if (!imageType(file) || file.split('/').some((p) => p.startsWith('.') || p === 'node_modules')) continue;
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([dir]) => dir);
  // No images yet: next to the home page, in "images".
  const home = files.filter((f) => /(^|\/)index\.html?$/i.test(f) && !f.split('/').includes('node_modules'))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
  const root = home && home.includes('/') ? home.slice(0, home.lastIndexOf('/')) : '';
  const fallback = root ? `${root}/images` : 'images';
  // A folder made for pictures beats the site's top folder, even if a logo or favicon sits there.
  const suggested = used.find((d) => d && d !== root) || fallback;
  return { folders: [...new Set([suggested, ...used.filter(Boolean), fallback])], suggested };
}

// The pictures sent with a chat message, checked and ready for the AI service:
// [{ name, mediaType, data }] where data is base64.
export function cleanChatImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new Error('Malformed images.');
  if (images.length > MAX_AI_IMAGES) throw new Error(`Show the AI at most ${MAX_AI_IMAGES} images at a time.`);
  return images.map((image) => {
    const name = String(image && image.name || 'image').replace(/[\r\n]/g, ' ').slice(0, 120);
    const bytes = Buffer.from(String(image && image.data || ''), 'base64');
    if (!bytes.length) throw new Error(`${name} is empty.`);
    if (bytes.length > MAX_AI_IMAGE_BYTES) throw new Error(`${name} is larger than 5 MB, which is the most the AI accepts for one image.`);
    const mediaType = sniffImage(bytes);
    if (!mediaType) throw new Error(`${name} is not a PNG, JPEG, GIF or WebP image, so the AI cannot look at it.`);
    return { name, mediaType, data: bytes.toString('base64') };
  });
}
