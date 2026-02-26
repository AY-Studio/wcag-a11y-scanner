import fs from 'node:fs';
import path from 'node:path';
import { install, Browser, detectBrowserPlatform, resolveBuildId, computeExecutablePath } from '@puppeteer/browsers';

function findChromeExecutable(cacheDir) {
  const chromeRoot = path.join(cacheDir, 'chrome');
  if (!fs.existsSync(chromeRoot)) return null;

  const queue = [chromeRoot];
  while (queue.length) {
    const dir = queue.shift();
    const names = fs.readdirSync(dir);
    for (const name of names) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        queue.push(full);
      } else if (name === 'Google Chrome for Testing' || name === 'chrome' || name === 'chrome.exe') {
        return full;
      }
    }
  }

  return null;
}

export async function ensureChrome(cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });

  const existing = findChromeExecutable(cacheDir);
  if (existing) return existing;

  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error('Unsupported platform for Chrome installation via Puppeteer.');
  }

  const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
  await install({
    browser: Browser.CHROME,
    buildId,
    cacheDir,
    platform,
    unpack: true
  });

  const computed = computeExecutablePath({
    browser: Browser.CHROME,
    buildId,
    cacheDir,
    platform
  });

  if (computed && fs.existsSync(computed)) return computed;

  const discovered = findChromeExecutable(cacheDir);
  if (discovered) return discovered;

  throw new Error('Chrome installation completed, but executable was not found in cache.');
}
