import fs from 'node:fs';
import path from 'node:path';
import { criteriaByLevel, criterionFromCode, targetStandardFromLevel, wcagLevel } from './wcag.mjs';
import { esc, readUrlList } from './utils.mjs';
import { scanPage } from './scanners/page.mjs';
import { scanBatch } from './scanners/batch.mjs';
import { urlsFromSitemap } from './scanners/xml.mjs';

function normalizeTargetLevel(level = '') {
  return String(level || '').toUpperCase() === 'AAA' ? 'AAA' : 'AA';
}

function statusesByLevel({ failedCriteria, targetLevel, scanErrorCount }) {
  const criteria = criteriaByLevel();
  const levels = ['A', 'AA', 'AAA'];
  const cards = levels.map((level) => {
    const totalCriteria = criteria[level].length;
    const failedList = criteria[level].filter((criterion) => failedCriteria.has(criterion));
    const failedCount = failedList.length;
    const passedCount = totalCriteria - failedCount;
    let status = failedCount === 0 ? 'PASS' : 'FAIL';
    if (scanErrorCount > 0 && failedCount === 0) {
      status = 'NOT RUN';
    }
    return { level, totalCriteria, passedCount, failedCount, status };
  });

  const requiredLevels = targetLevel === 'AAA' ? new Set(['A', 'AA', 'AAA']) : new Set(['A', 'AA']);
  const requiredFailures = cards
    .filter((card) => requiredLevels.has(card.level))
    .reduce((sum, card) => sum + card.failedCount, 0);

  return {
    cards,
    overall: {
      targetLevel,
      status: requiredFailures > 0 ? 'FAIL' : scanErrorCount > 0 ? 'NOT RUN' : 'PASS',
      requiredFailures,
      scanErrorCount
    }
  };
}

function buildAudit({ pages, targetLevel, targetStandard, generatedAt, source }) {
  const criteria = criteriaByLevel();
  const failures = new Map();
  const failedCriteria = new Set();
  const unknown = { issueCount: 0, byCode: new Map() };

  for (const page of pages) {
    if (page.status !== 'ok') continue;
    for (const issue of page.issues) {
      const code = issue.code || 'unknown-code';
      const criterion = criterionFromCode(code);
      if (!criterion) {
        unknown.issueCount += 1;
        unknown.byCode.set(code, (unknown.byCode.get(code) || 0) + 1);
        continue;
      }

      const level = wcagLevel(code);
      if (!['A', 'AA', 'AAA'].includes(level)) {
        unknown.issueCount += 1;
        unknown.byCode.set(code, (unknown.byCode.get(code) || 0) + 1);
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

  const rows = [];
  for (const level of ['A', 'AA', 'AAA']) {
    for (const criterion of criteria[level]) {
      const fail = failures.get(criterion);
      rows.push({
        criterion,
        level,
        status: fail ? 'FAIL' : scanErrorCount > 0 ? 'NOT RUN' : 'PASS',
        issueCount: fail ? fail.issueCount : 0,
        pageCount: fail ? fail.pages.size : 0,
        sampleMessage: fail
          ? [...fail.messages][0] || ''
          : scanErrorCount > 0
            ? 'Not evaluated due to one or more scan errors.'
            : ''
      });
    }
  }
  const levelStatus = statusesByLevel({ failedCriteria, targetLevel, scanErrorCount });

  return {
    generatedAt,
    source,
    target: {
      standard: targetStandard,
      level: targetLevel
    },
    pages: {
      requested: pages.length,
      scanned: pages.filter((page) => page.status === 'ok').length,
      scanErrors: scanErrorCount
    },
    overall: levelStatus.overall,
    levels: levelStatus.cards,
    criteria: rows,
    unknown: {
      issueCount: unknown.issueCount,
      codeCount: unknown.byCode.size,
      byCode: [...unknown.byCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count)
    }
  };
}

function writeAuditHtml(reportPath, summary) {
  const levelCards = summary.levels.map((level) => {
    const cls = level.status === 'PASS' ? 'pass' : level.status === 'FAIL' ? 'fail' : 'norun';
    return `<article class="level-card ${cls}"><h3>${esc(level.level)}</h3><p class="status">${esc(level.status)}</p><p class="meta">Pass ${level.passedCount}/${level.totalCriteria} · Fail ${level.failedCount}</p></article>`;
  }).join('');

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
.badge.pass{background:#dcfce7;color:#166534;border-color:#86efac}.badge.fail{background:#fee2e2;color:#991b1b;border-color:#fca5a5}
.badge.norun{background:#fef3c7;color:#92400e;border-color:#fcd34d}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px}
.metric{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px}.metric .k{font-size:11px;text-transform:uppercase;color:#64748b}.metric .v{font-size:24px;font-weight:700;color:#0f172a}
.level-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:6px 0 18px}
.level-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px}.level-card h3{margin:0 0 4px}.level-card .status{margin:0 0 4px;font-weight:700}.level-card .meta{margin:0;color:#475569;font-size:14px}
.level-card.pass{border-color:#86efac}.level-card.fail{border-color:#fca5a5}.level-card.norun{border-color:#fcd34d}
.table{overflow:auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;margin-top:8px}
table{width:100%;border-collapse:collapse;min-width:760px}th,td{padding:9px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top}th{text-align:left;background:#f8fafc}
.mini{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid}.mini.pass{background:#dcfce7;color:#166534;border-color:#86efac}.mini.fail{background:#fee2e2;color:#991b1b;border-color:#fca5a5}.mini.norun{background:#fef3c7;color:#92400e;border-color:#fcd34d}
.note{font-size:13px;color:#475569;margin-top:12px}
</style></head><body><main>
<h1>WCAG Compliance Audit</h1>
<p>Source: <code>${esc(summary.source)}</code> · Generated: ${esc(summary.generatedAt)}</p>
<p>Target: <strong>${esc(summary.target.standard)}</strong> · Scan Depth: <strong>${esc(summary.target.scanStandard || summary.target.standard)}</strong></p>
<div class="top"><span class="badge ${summary.overall.status === 'PASS' ? 'pass' : summary.overall.status === 'FAIL' ? 'fail' : 'norun'}">${esc(summary.target.standard)} ${esc(summary.overall.status)}</span></div>
<section class="metrics">
<div class="metric"><div class="k">Pages Requested</div><div class="v">${summary.pages.requested}</div></div>
<div class="metric"><div class="k">Pages Scanned</div><div class="v">${summary.pages.scanned}</div></div>
<div class="metric"><div class="k">Scan Errors</div><div class="v">${summary.pages.scanErrors}</div></div>
<div class="metric"><div class="k">Failed Criteria</div><div class="v">${summary.criteria.filter((row) => row.status === 'FAIL').length}</div></div>
</section>
<h2>Level Status</h2>
<section class="level-grid">${levelCards}</section>
<h2>Criteria Matrix</h2>
${criteriaSection('A')}
${criteriaSection('AA')}
${criteriaSection('AAA')}
<h2>Unmapped Rules</h2>
<div class="table"><table><thead><tr><th>Rule</th><th>Count</th></tr></thead><tbody>${unknownRows || '<tr><td colspan="2">No unmapped rules.</td></tr>'}</tbody></table></div>
<p class="note">This is an automated compliance health check for WCAG ${esc(summary.target.level)}. Manual testing is still required for full certification sign-off.</p>
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
  const targetLevel = normalizeTargetLevel(cfg.auditLevel);
  const targetStandard = targetStandardFromLevel(targetLevel);
  const scanStandard = cfg.scanStandard || cfg.standard || 'WCAG2AAA';
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
    targetLevel,
    targetStandard,
    generatedAt: new Date().toISOString(),
    source: sourceLabel
  });
  summary.target.scanStandard = scanStandard;

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
  const targetLevel = normalizeTargetLevel(cfg.auditLevel);
  const targetStandard = targetStandardFromLevel(targetLevel);
  const scanStandard = cfg.scanStandard || cfg.standard || 'WCAG2AAA';
  const runCfg = {
    ...cfg,
    standard: scanStandard,
    outputDir: cfg.auditOutputDir || 'a11y/audits'
  };

  const batchResult = await scanBatch(urls, runCfg, sourceLabel);
  const manifest = JSON.parse(fs.readFileSync(batchResult.manifestFile, 'utf8'));
  const pages = manifest.results.map((result) => ({
    url: result.url,
    status: result.status,
    issues: result.status === 'ok' ? readIssuesFromJson(path.join(batchResult.reportRoot, result.jsonFile)) : []
  }));

  const summary = buildAudit({
    pages,
    targetLevel,
    targetStandard,
    generatedAt: new Date().toISOString(),
    source: sourceLabel
  });
  summary.target.scanStandard = scanStandard;

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
