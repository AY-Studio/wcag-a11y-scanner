import fs from 'node:fs';
import path from 'node:path';
import { criteriaByLevel, criterionFromCode, wcagLevel } from './wcag.mjs';
import { esc, readUrlList } from './utils.mjs';
import { scanPage } from './scanners/page.mjs';
import { scanBatch } from './scanners/batch.mjs';
import { urlsFromSitemap } from './scanners/xml.mjs';

const AUDIT_STANDARD = 'WCAG2AAA';
const AUDIT_LEVEL = 'AAA';

function buildAudit({ pages, generatedAt, source, scanStandard }) {
  const criteria = criteriaByLevel();
  const failures = new Map();
  const failedCriteria = new Set();
  const issueTotalsByLevel = { A: 0, AA: 0, AAA: 0, Unknown: 0 };
  const unknownByCode = new Map();

  let totalIssues = 0;
  for (const page of pages) {
    const list = Array.isArray(page.issues) ? page.issues : [];
    totalIssues += list.length;

    for (const issue of list) {
      const code = issue.code || 'unknown-code';
      const criterion = criterionFromCode(code);
      const level = wcagLevel(code);

      issueTotalsByLevel[level] = (issueTotalsByLevel[level] || 0) + 1;

      if (!criterion || !['A', 'AA', 'AAA'].includes(level)) {
        unknownByCode.set(code, (unknownByCode.get(code) || 0) + 1);
        continue;
      }

      if (!failures.has(criterion)) {
        failures.set(criterion, {
          criterion,
          level,
          issueCount: 0,
          pages: new Set(),
          messages: new Set()
        });
      }

      const row = failures.get(criterion);
      row.issueCount += 1;
      row.pages.add(page.url);
      if (issue.message) row.messages.add(String(issue.message).replace(/\s+/g, ' ').trim());
      failedCriteria.add(criterion);
    }
  }

  const scanErrorCount = pages.filter((page) => page.status !== 'ok').length;
  const pagesScanned = pages.filter((page) => page.status === 'ok').length;

  const failedCriteriaByLevel = {
    A: criteria.A.filter((criterion) => failedCriteria.has(criterion)).length,
    AA: criteria.AA.filter((criterion) => failedCriteria.has(criterion)).length,
    AAA: criteria.AAA.filter((criterion) => failedCriteria.has(criterion)).length
  };

  const rows = [];
  for (const level of ['A', 'AA', 'AAA']) {
    for (const criterion of criteria[level]) {
      const fail = failures.get(criterion);
      rows.push({
        criterion,
        level,
        status: fail ? 'FAIL' : scanErrorCount > 0 && pagesScanned === 0 ? 'NOT RUN' : 'PASS',
        issueCount: fail ? fail.issueCount : 0,
        pageCount: fail ? fail.pages.size : 0,
        sampleMessage: fail
          ? [...fail.messages][0] || ''
          : scanErrorCount > 0 && pagesScanned === 0
            ? 'Not evaluated due to scan errors.'
            : ''
      });
    }
  }

  const levelCards = ['A', 'AA', 'AAA'].map((level) => {
    const failedCount = failedCriteriaByLevel[level];
    const status = failedCount > 0 ? 'FAIL' : scanErrorCount > 0 && pagesScanned === 0 ? 'NOT RUN' : 'PASS';
    return {
      level,
      status,
      issueCount: issueTotalsByLevel[level] || 0,
      failedCriteriaCount: failedCount,
      totalCriteria: criteria[level].length,
      passedCriteriaCount: criteria[level].length - failedCount
    };
  });

  const overallStatus = failedCriteria.size > 0
    ? 'FAIL'
    : (scanErrorCount > 0 && pagesScanned === 0 ? 'NOT RUN' : 'PASS');

  return {
    generatedAt,
    source,
    target: {
      standard: AUDIT_STANDARD,
      level: AUDIT_LEVEL,
      scanStandard
    },
    pages: {
      requested: pages.length,
      scanned: pagesScanned,
      scanErrors: scanErrorCount
    },
    totals: {
      issues: totalIssues,
      issuesByLevel: issueTotalsByLevel,
      failedCriteria: failedCriteria.size,
      failedCriteriaByLevel,
      failedRuleCodes: new Set(
        pages.flatMap((page) => (Array.isArray(page.issues) ? page.issues : []).map((issue) => issue.code || 'unknown-code'))
      ).size
    },
    overall: {
      status: overallStatus
    },
    levels: levelCards,
    criteria: rows,
    unknown: {
      issueCount: issueTotalsByLevel.Unknown || 0,
      codeCount: unknownByCode.size,
      byCode: [...unknownByCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count)
    }
  };
}

function writeAuditHtml(reportPath, summary) {
  function criteriaSection(level) {
    const rows = summary.criteria
      .filter((row) => row.level === level)
      .sort((a, b) => a.criterion.localeCompare(b.criterion))
      .map((row) => {
        const cls = row.status === 'PASS' ? 'pass' : row.status === 'FAIL' ? 'fail' : 'norun';
        return `<tr><td>${esc(row.criterion)}</td><td><span class="mini ${cls}">${esc(row.status)}</span></td><td>${row.issueCount}</td><td>${row.pageCount}</td><td>${esc(row.sampleMessage || '-')}</td></tr>`;
      })
      .join('');
    return `<h3>${esc(level)} Guidelines</h3><div class="table"><table><thead><tr><th>SC</th><th>Status</th><th>Issues</th><th>Pages</th><th>Sample</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No criteria.</td></tr>'}</tbody></table></div>`;
  }

  const levelCards = summary.levels.map((level) => {
    const cls = level.status === 'PASS' ? 'pass' : level.status === 'FAIL' ? 'fail' : 'norun';
    return `<article class="level-card ${cls}"><h3>${esc(level.level)} (${level.issueCount})</h3><p class="status">${esc(level.status)}</p><p class="meta">Guideline failures: ${level.failedCriteriaCount}</p></article>`;
  }).join('');

  const unknownRows = summary.unknown.byCode
    .slice(0, 25)
    .map((row) => `<tr><td><code>${esc(row.code)}</code></td><td>${row.count}</td></tr>`)
    .join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>WCAG Compliance Audit</title>
<style>
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f5f7fb;color:#0f172a}
main{max-width:1100px;margin:0 auto;padding:24px 16px 36px}
h1{margin:0 0 8px;font-size:28px}p{margin:0 0 10px;color:#334155}
.top{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:14px 0 18px}
.badge{display:inline-block;padding:8px 12px;border-radius:999px;font-weight:700;font-size:13px;border:1px solid}
.badge.pass{background:#dcfce7;color:#166534;border-color:#86efac}.badge.fail{background:#fee2e2;color:#991b1b;border-color:#fca5a5}.badge.norun{background:#fef3c7;color:#92400e;border-color:#fcd34d}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px}
.metric{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px}.metric .k{font-size:11px;text-transform:uppercase;color:#64748b}.metric .v{font-size:24px;font-weight:700;color:#0f172a}
.level-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin:6px 0 18px}
.level-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px}.level-card h3{margin:0 0 4px}.level-card .status{margin:0 0 4px;font-weight:700}.level-card .meta{margin:0;color:#475569;font-size:14px}
.level-card.pass{border-color:#86efac}.level-card.fail{border-color:#fca5a5}.level-card.norun{border-color:#fcd34d}
.table{overflow:auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;margin-top:8px}
table{width:100%;border-collapse:collapse;min-width:760px}th,td{padding:9px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top}th{text-align:left;background:#f8fafc}
.mini{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid}.mini.pass{background:#dcfce7;color:#166534;border-color:#86efac}.mini.fail{background:#fee2e2;color:#991b1b;border-color:#fca5a5}.mini.norun{background:#fef3c7;color:#92400e;border-color:#fcd34d}
.note{font-size:13px;color:#475569;margin-top:12px}
</style></head><body><main>
<h1>WCAG Compliance Audit</h1>
<p>Source: <code>${esc(summary.source)}</code> · Generated: ${esc(summary.generatedAt)}</p>
<p>Target: <strong>${esc(summary.target.standard)}</strong> · Scan Depth: <strong>${esc(summary.target.scanStandard)}</strong></p>
<div class="top"><span class="badge ${summary.overall.status === 'PASS' ? 'pass' : summary.overall.status === 'FAIL' ? 'fail' : 'norun'}">${esc(summary.target.standard)} ${esc(summary.overall.status)}</span></div>
<section class="metrics">
<div class="metric"><div class="k">Total Scan Issues</div><div class="v">${summary.totals.issues}</div></div>
<div class="metric"><div class="k">Failed Guidelines</div><div class="v">${summary.totals.failedCriteria}</div></div>
<div class="metric"><div class="k">A / AA / AAA</div><div class="v">${summary.totals.issuesByLevel.A} / ${summary.totals.issuesByLevel.AA} / ${summary.totals.issuesByLevel.AAA}</div></div>
<div class="metric"><div class="k">Pages Scanned</div><div class="v">${summary.pages.scanned}</div></div>
<div class="metric"><div class="k">Scan Errors</div><div class="v">${summary.pages.scanErrors}</div></div>
</section>
<p><strong>Issue totals:</strong> A (${summary.totals.issuesByLevel.A}), AA (${summary.totals.issuesByLevel.AA}), AAA (${summary.totals.issuesByLevel.AAA}), Unknown (${summary.totals.issuesByLevel.Unknown || 0})</p>
<p><strong>Guideline failures:</strong> A (${summary.totals.failedCriteriaByLevel.A}), AA (${summary.totals.failedCriteriaByLevel.AA}), AAA (${summary.totals.failedCriteriaByLevel.AAA})</p>
<h2>Level Status</h2>
<section class="level-grid">${levelCards}</section>
<h2>Criteria Matrix</h2>
${criteriaSection('A')}
${criteriaSection('AA')}
${criteriaSection('AAA')}
<h2>Unmapped Rules</h2>
<div class="table"><table><thead><tr><th>Rule</th><th>Count</th></tr></thead><tbody>${unknownRows || '<tr><td colspan="2">No unmapped rules.</td></tr>'}</tbody></table></div>
<p class="note">Audit uses the same scanner output as scan mode; this view changes presentation only.</p>
</main></body></html>`;

  fs.writeFileSync(reportPath, html, 'utf8');
}

function readIssuesFromJson(absPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export async function runAuditPage(url, cfg, sourceLabel = 'page') {
  const scanStandard = cfg.scanStandard || cfg.standard || AUDIT_STANDARD;
  const runCfg = {
    ...cfg,
    standard: scanStandard,
    outputDir: cfg.auditOutputDir || 'a11y/audits'
  };

  const pageResult = await scanPage(url, runCfg);
  const issues = readIssuesFromJson(pageResult.jsonFile);
  const hasRunnerError = issues.some((issue) => issue && issue.code === 'A11Y.RUNNER.ERROR');
  const pages = [{ url, status: hasRunnerError ? 'error' : 'ok', issues }];

  const summary = buildAudit({
    pages,
    generatedAt: new Date().toISOString(),
    source: sourceLabel,
    scanStandard
  });

  const auditJsonFile = path.join(pageResult.reportRoot, 'audit.json');
  const auditHtmlFile = path.join(pageResult.reportRoot, 'audit.html');
  fs.writeFileSync(auditJsonFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  writeAuditHtml(auditHtmlFile, summary);

  return {
    reportRoot: pageResult.reportRoot,
    auditJsonFile,
    auditHtmlFile,
    summary,
    pageResult
  };
}

export async function runAuditBatch(urls, cfg, sourceLabel = 'urls.txt') {
  const scanStandard = cfg.scanStandard || cfg.standard || AUDIT_STANDARD;
  const runCfg = {
    ...cfg,
    standard: scanStandard,
    outputDir: cfg.auditOutputDir || 'a11y/audits'
  };

  const batchResult = await scanBatch(urls, runCfg, sourceLabel);
  const manifest = JSON.parse(fs.readFileSync(batchResult.manifestFile, 'utf8'));

  const pages = manifest.results.map((result) => {
    const abs = path.join(batchResult.reportRoot, result.jsonFile);
    return {
      url: result.url,
      status: result.status,
      issues: readIssuesFromJson(abs)
    };
  });

  const summary = buildAudit({
    pages,
    generatedAt: new Date().toISOString(),
    source: sourceLabel,
    scanStandard
  });

  const auditJsonFile = path.join(batchResult.reportRoot, 'audit.json');
  const auditHtmlFile = path.join(batchResult.reportRoot, 'audit.html');
  fs.writeFileSync(auditJsonFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  writeAuditHtml(auditHtmlFile, summary);

  return {
    reportRoot: batchResult.reportRoot,
    auditJsonFile,
    auditHtmlFile,
    summary,
    batchResult
  };
}

export async function runAuditFromList(listPath, cfg) {
  const urls = readUrlList(path.resolve(listPath));
  if (!urls.length) throw new Error(`No URLs found in ${listPath}`);
  return runAuditBatch(urls, cfg, listPath);
}

export async function runAuditFromXml(sitemapUrl, baseUrl, cfg, cwd) {
  const urls = urlsFromSitemap(sitemapUrl, baseUrl || '');
  if (!urls.length) throw new Error(`No URLs discovered from sitemap: ${sitemapUrl}`);

  const urlListDir = path.resolve(cwd, '.a11y-scanner');
  fs.mkdirSync(urlListDir, { recursive: true });
  const urlListFile = path.join(urlListDir, `urls-${Date.now()}.txt`);
  fs.writeFileSync(urlListFile, `${urls.join('\n')}\n`, 'utf8');

  return runAuditBatch(urls, cfg, path.relative(cwd, urlListFile));
}
