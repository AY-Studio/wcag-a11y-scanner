import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function extractLocs(xml) {
  const locs = [];
  const re = /<loc>\s*([^<\s][^<]*)\s*<\/loc>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    locs.push(match[1].trim());
  }
  return locs;
}

function isSitemapXml(url) {
  return /\.xml($|\?)/i.test(url);
}

function isContentUrl(url) {
  try {
    const u = new URL(url);
    return (
      !u.pathname.startsWith('/wp-') &&
      !u.pathname.includes('/feed') &&
      !u.pathname.match(/\.(jpg|jpeg|png|gif|svg|pdf|webp|zip|docx?|xlsx?)$/i)
    );
  } catch {
    return false;
  }
}

function fetchXml(source) {
  if (fs.existsSync(source)) return fs.readFileSync(source, 'utf8');
  const result = spawnSync('curl', ['-ksL', source], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) throw new Error(`Failed to fetch XML: ${source}`);
  return result.stdout;
}

export function urlsFromSitemap(input, baseUrl = '') {
  const source = /^https?:\/\//i.test(input)
    ? input
    : (input.startsWith('/') && baseUrl ? new URL(input, `${baseUrl.replace(/\/+$/, '')}/`).toString() : path.resolve(input));

  const visited = new Set();
  const pageUrls = new Set();

  function crawl(s) {
    if (visited.has(s)) return;
    visited.add(s);

    const xml = fetchXml(s);
    const locs = extractLocs(xml);
    for (const loc of locs) {
      let abs;
      try {
        abs = fs.existsSync(s) ? loc : new URL(loc, s).toString();
      } catch {
        continue;
      }
      if (isSitemapXml(abs)) {
        crawl(abs);
      } else if (isContentUrl(abs)) {
        try {
          const u = new URL(abs);
          u.hash = '';
          pageUrls.add(u.toString());
        } catch {
          // ignore invalid url
        }
      }
    }
  }

  crawl(source);
  return [...pageUrls].sort();
}
