import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function ensureChrome(cacheDir) {
  const chromeRoot = path.join(cacheDir, 'chrome');

  function hasInstalledChrome() {
    if (!fs.existsSync(chromeRoot)) return false;
    const queue = [chromeRoot];
    let depth = 0;
    while (queue.length && depth < 8) {
      const dir = queue.shift();
      const names = fs.readdirSync(dir);
      for (const name of names) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) queue.push(full);
        if (name === 'Google Chrome for Testing' || name === 'chrome' || name === 'chrome.exe') return true;
      }
      depth += 1;
    }
    return false;
  }

  if (hasInstalledChrome()) return;

  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['puppeteer', 'browsers', 'install', 'chrome'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PUPPETEER_CACHE_DIR: cacheDir
    }
  });

  if (result.status !== 0) {
    throw new Error('Failed to install Puppeteer Chrome.');
  }
}
