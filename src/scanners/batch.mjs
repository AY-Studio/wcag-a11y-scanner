import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureChrome } from '../ensure-browser.mjs';
import { ensureDir, slugify, timestampFolder } from '../utils.mjs';
import { criterionFromCode, wcagLevel } from '../wcag.mjs';
import { writeBatchSummary, writePageHtmlSummary } from '../report-html.mjs';

function runKeyboardAudit(url, cwd, cacheDir, chromePath) {
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
    return JSON.parse(out);
  } catch {
    return [];
  }
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

  const runOnce = (targetUrl) => spawnSync(runner.command, buildArgs(targetUrl), {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PUPPETEER_CACHE_DIR: cacheDir,
      PUPPETEER_EXECUTABLE_PATH: chromePath,
      PUPPETEER_SKIP_DOWNLOAD: 'true'
    }
  });

  let usedUrl = url;
  let run = runOnce(usedUrl);
  const stderr = String(run.stderr || '');
  const certFailed = /ERR_CERT_AUTHORITY_INVALID/i.test(stderr);
  const canRetryHttp = /^https:\/\//i.test(url);
  if (run.status !== 0 && certFailed && canRetryHttp) {
    usedUrl = url.replace(/^https:/i, 'http:');
    run = runOnce(usedUrl);
  }

  return { run, usedUrl };
}

export async function scanBatch(urls, cfg, sourceLabel = 'urls.txt') {
  const cwd = cfg.cwd || process.cwd();
  const cacheDir = path.resolve(cwd, '.cache', 'puppeteer');
  const chromePath = await ensureChrome(cacheDir);

  const reportRoot = path.resolve(cwd, cfg.outputDir, timestampFolder());
  ensureDir(reportRoot);
  const used = new Set();
  const results = [];

  for (const url of urls) {
    const base = slugify(url);
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);

    const jsonFile = path.join(reportRoot, `${slug}.json`);
    const htmlFile = path.join(reportRoot, `${slug}.html`);

    const runner = pa11yInvocation(cwd);
    const { run, usedUrl } = runPa11yScan({ runner, url, cfg, cwd, cacheDir, chromePath });

    const stdout = (run.stdout || '').trim();
    let issues = [];
    let status = 'ok';

    if (stdout.startsWith('[')) {
      try {
        issues = JSON.parse(stdout);
      } catch {
        issues = [];
      }
      const customIssues = runKeyboardAudit(usedUrl, cwd, cacheDir, chromePath);
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
    } else {
      status = 'error';
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
      fs.writeFileSync(jsonFile, JSON.stringify(issues) + '\n');
      writePageHtmlSummary(jsonFile, htmlFile);
    }

    results.push({
      url,
      slug,
      status,
      issueCount: issues.length,
      jsonFile: path.relative(reportRoot, jsonFile),
      htmlFile: path.relative(reportRoot, htmlFile)
    });

    console.log(`[${results.length}/${urls.length}] ${url} -> ${issues.length} issue(s)`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    target: cfg.standard || 'WCAG2AAA',
    sourceUrlList: sourceLabel,
    pageCount: urls.length,
    results
  };

  const manifestFile = path.join(reportRoot, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  const ruleMap = new Map();
  const levelCounts = { AAA: 0, AA: 0, A: 0, Unknown: 0 };
  for (const r of results) {
    if (r.status !== 'ok') continue;
    const abs = path.join(reportRoot, r.jsonFile);
    const issues = JSON.parse(fs.readFileSync(abs, 'utf8'));
    for (const issue of issues) {
      const code = issue.code || 'unknown-code';
      if (!ruleMap.has(code)) {
        ruleMap.set(code, {
          code,
          criterion: criterionFromCode(code),
          level: wcagLevel(code),
          message: (issue.message || '').replace(/\s+/g, ' ').trim(),
          count: 0,
          pages: new Set()
        });
      }
      const item = ruleMap.get(code);
      item.count += 1;
      item.pages.add(r.url);
      levelCounts[item.level] = (levelCounts[item.level] || 0) + 1;
    }
  }

  const ruleRows = [...ruleMap.values()]
    .map((r) => ({ ...r, pageCount: r.pages.size }))
    .sort((a, b) => b.count - a.count);

  const summaryFile = writeBatchSummary(reportRoot, manifest, ruleRows, levelCounts);
  return { reportRoot, manifestFile, summaryFile };
}
