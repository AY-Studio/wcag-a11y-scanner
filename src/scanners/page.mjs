import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureChrome } from '../ensure-browser.mjs';
import { ensureDir, slugify, timestampFolder } from '../utils.mjs';
import { writePageHtmlSummary } from '../report-html.mjs';

function runKeyboardAudit(url, cwd, cacheDir, chromePath) {
  if (!chromePath) return [];
  const script = new URL('../keyboard-audit.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, url], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      PUPPETEER_CACHE_DIR: cacheDir,
      A11Y_CHROME_PATH: chromePath
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

function systemChromePath() {
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium'
        ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function pa11yInvocation(cwd) {
  const localBin = path.join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'pa11y.cmd' : 'pa11y');
  if (fs.existsSync(localBin)) {
    return {
      command: localBin,
      args: []
    };
  }
  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['--yes', 'pa11y@9.0.1']
  };
}

function runPa11yScan({ runner, url, cfg, cwd, cacheDir, chromePath }) {
  const buildArgs = (targetUrl) => {
    const args = [...runner.args, targetUrl, '--reporter', 'json', '--standard', cfg.standard || 'WCAG2AAA', '--timeout', String(cfg.timeout), '--wait', String(cfg.wait)];
    if (cfg.includeAll || cfg.includeWarnings) args.push('--include-warnings');
    if (cfg.includeAll || cfg.includeNotices) args.push('--include-notices');
    if (Array.isArray(cfg.hideElements)) {
      for (const s of cfg.hideElements) args.push('--hide-elements', s);
    }
    return args;
  };

  const runOnce = (targetUrl, executablePath) => spawnSync(runner.command, buildArgs(targetUrl), {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PUPPETEER_CACHE_DIR: cacheDir,
      ...(executablePath ? { PUPPETEER_EXECUTABLE_PATH: executablePath } : {}),
      PUPPETEER_SKIP_DOWNLOAD: 'true'
    }
  });

  const attempts = [];
  if (chromePath) attempts.push(chromePath);
  const systemChrome = systemChromePath();
  if (systemChrome && systemChrome !== chromePath) attempts.push(systemChrome);
  attempts.push(null);

  const canRetryHttp = /^https:\/\//i.test(url);
  let last = null;

  for (const attemptPath of attempts) {
    let usedUrl = url;
    let run = runOnce(usedUrl, attemptPath);
    if ((run.stdout || '').trim().startsWith('[')) return { run, usedUrl, usedChromePath: attemptPath };

    const stderr = String(run.stderr || '');
    const certFailed = /ERR_CERT_AUTHORITY_INVALID/i.test(stderr);
    if (run.status !== 0 && certFailed && canRetryHttp) {
      usedUrl = url.replace(/^https:/i, 'http:');
      run = runOnce(usedUrl, attemptPath);
      if ((run.stdout || '').trim().startsWith('[')) return { run, usedUrl, usedChromePath: attemptPath };
    }

    last = { run, usedUrl, usedChromePath: attemptPath };
    const launchFailed = /Failed to launch the browser process|TROUBLESHOOTING: https:\/\/pptr\.dev\/troubleshooting/i.test(String(run.stderr || ''));
    if (!launchFailed) {
      return last;
    }
  }

  return last || { run: runOnce(url, null), usedUrl: url, usedChromePath: null };
}

export async function scanPage(url, cfg) {
  const cwd = cfg.cwd || process.cwd();
  const cacheDir = path.resolve(cwd, '.cache', 'puppeteer');
  let chromePath = null;
  try {
    chromePath = await ensureChrome(cacheDir);
  } catch {
    chromePath = systemChromePath();
  }

  const reportRoot = path.resolve(cwd, cfg.outputDir, timestampFolder());
  ensureDir(reportRoot);
  const slug = slugify(url);
  const jsonFile = path.join(reportRoot, `${slug}.json`);
  const htmlFile = path.join(reportRoot, `${slug}.html`);

  const runner = pa11yInvocation(cwd);
  const { run, usedUrl, usedChromePath } = runPa11yScan({ runner, url, cfg, cwd, cacheDir, chromePath });

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
      context: `Scan failed for ${usedUrl}`,
      selector: '',
      runner: 'pa11y-runner',
      runnerExtras: { exitStatus: run.status ?? 1 }
    }];
  }

  const customIssues = runKeyboardAudit(usedUrl, cwd, cacheDir, usedChromePath || chromePath);
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
