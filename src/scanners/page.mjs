import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureChrome } from '../ensure-browser.mjs';
import { ensureDir, slugify, timestampFolder } from '../utils.mjs';
import { writePageHtmlSummary } from '../report-html.mjs';

function runKeyboardAudit(url, cwd, cacheDir) {
  const script = new URL('../keyboard-audit.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, url], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      PUPPETEER_CACHE_DIR: cacheDir
    }
  });
  if (result.status !== 0) return [];
  const out = (result.stdout || '').trim();
  if (!out.startsWith('[')) return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function scanPage(url, cfg) {
  const cwd = cfg.cwd || process.cwd();
  const cacheDir = path.resolve(cwd, '.cache', 'puppeteer');
  ensureChrome(cacheDir);

  const reportRoot = path.resolve(cwd, cfg.outputDir, timestampFolder());
  ensureDir(reportRoot);
  const slug = slugify(url);
  const jsonFile = path.join(reportRoot, `${slug}.json`);
  const htmlFile = path.join(reportRoot, `${slug}.html`);

  const pa11yArgs = ['pa11y', url, '--reporter', 'json', '--standard', cfg.standard || 'WCAG2AAA', '--timeout', String(cfg.timeout), '--wait', String(cfg.wait)];
  if (cfg.includeAll || cfg.includeWarnings) pa11yArgs.push('--include-warnings');
  if (cfg.includeAll || cfg.includeNotices) pa11yArgs.push('--include-notices');
  if (Array.isArray(cfg.hideElements)) {
    for (const s of cfg.hideElements) pa11yArgs.push('--hide-elements', s);
  }

  const run = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', pa11yArgs, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PUPPETEER_CACHE_DIR: cacheDir
    }
  });

  let issues = [];
  const stdout = (run.stdout || '').trim();
  if (stdout.startsWith('[')) {
    try {
      issues = JSON.parse(stdout);
    } catch {
      issues = [];
    }
  } else {
    issues = [{
      code: 'A11Y.RUNNER.ERROR',
      type: 'error',
      typeCode: 1,
      message: (run.stderr || 'Pa11y did not return JSON output.').trim(),
      context: `Scan failed for ${url}`,
      selector: '',
      runner: 'pa11y-runner',
      runnerExtras: { exitStatus: run.status ?? 1 }
    }];
  }

  const customIssues = runKeyboardAudit(url, cwd, cacheDir);
  if (customIssues.length) {
    const dedupe = new Set(issues.map((i) => `${i.code || ''}::${i.selector || ''}::${i.message || ''}`));
    for (const issue of customIssues) {
      const key = `${issue.code || ''}::${issue.selector || ''}::${issue.message || ''}`;
      if (!dedupe.has(key)) {
        issues.push(issue);
        dedupe.add(key);
      }
    }
  }

  fs.writeFileSync(jsonFile, JSON.stringify(issues) + '\n');
  writePageHtmlSummary(jsonFile, htmlFile);

  const typeCounts = issues.reduce((acc, issue) => {
    const type = issue.type || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  return { reportRoot, jsonFile, htmlFile, issueCount: issues.length, typeCounts };
}
