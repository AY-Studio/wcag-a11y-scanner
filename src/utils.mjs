import fs from 'node:fs';
import path from 'node:path';

export function timestampFolder() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join('-') + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

export function slugify(input) {
  return String(input || '')
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 120) || 'page';
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readUrlList(filePath) {
  return fs
    .readFileSync(path.resolve(filePath), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
