import fs from 'node:fs';
import path from 'node:path';
import { criterionFromCode, wcagLevel } from './wcag.mjs';
import { esc } from './utils.mjs';

export function writePageHtmlSummary(reportPath, outputPath) {
  const issues = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const byRule = new Map();
  const levelCounts = { AAA: 0, AA: 0, A: 0, Unknown: 0 };

  for (const issue of issues) {
    const code = issue.code || 'unknown-code';
    if (!byRule.has(code)) byRule.set(code, []);
    byRule.get(code).push(issue);
    const level = wcagLevel(code);
    levelCounts[level] = (levelCounts[level] || 0) + 1;
  }

  const rows = [...byRule.entries()].map(([code, list]) => {
    const first = list[0] || {};
    const selectors = [...new Set(list.map((i) => i.selector).filter(Boolean))].slice(0, 5);
    return {
      code,
      count: list.length,
      level: wcagLevel(code),
      criterion: criterionFromCode(code),
      message: (first.message || '').replace(/\s+/g, ' ').trim(),
      selectors,
      more: Math.max(0, list.length - selectors.length)
    };
  }).sort((a, b) => b.count - a.count);

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>A11y Summary - ${esc(path.basename(reportPath))}</title>
<style>
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f8fafc;color:#111827}
main{max-width:1280px;margin:0 auto;padding:20px 16px 28px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:18px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px}.k{font-size:12px;color:#6b7280;text-transform:uppercase}.v{font-size:22px;font-weight:700}
.badge{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700}.AAA{background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd}.AA{background:#d1fae5;color:#047857;border:1px solid #a7f3d0}.A{background:#ffedd5;color:#b45309;border:1px solid #fed7aa}.Unknown{background:#ede9fe;color:#6d28d9;border:1px solid #ddd6fe}
.table-wrap{overflow:auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px}
table{width:100%;border-collapse:collapse;min-width:960px}th,td{padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top}th{text-align:left;background:#f1f5f9}
</style></head><body><main>
<h1>Accessibility Summary</h1>
<p>Target: <strong>WCAG AAA</strong> | Source: <code>${esc(reportPath)}</code></p>
<section class="grid">
<div class="card"><div class="k">Total Issues</div><div class="v">${issues.length}</div></div>
<div class="card"><div class="k">Unique Rules</div><div class="v">${rows.length}</div></div>
<div class="card"><div class="k">A Issues</div><div class="v">${levelCounts.A}</div></div>
<div class="card"><div class="k">AA Issues</div><div class="v">${levelCounts.AA}</div></div>
<div class="card"><div class="k">AAA Issues</div><div class="v">${levelCounts.AAA}</div></div>
<div class="card"><div class="k">Unknown</div><div class="v">${levelCounts.Unknown}</div></div>
</section>
<div class="table-wrap"><table><thead><tr><th>Count</th><th>WCAG</th><th>SC</th><th>Rule</th><th>Message</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${r.count}</td><td><span class="badge ${esc(r.level)}">${esc(r.level)}</span></td><td>${esc(r.criterion || '-')}</td><td><code>${esc(r.code)}</code></td><td>${esc(r.message || '-')}</td></tr>`).join('')}
</tbody></table></div>
</main></body></html>`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');
}

export function writeBatchSummary(reportRoot, manifest, ruleRows, levelCounts) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>A11y Batch Summary</title>
<style>
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f8fafc;color:#111827}
main{max-width:1280px;margin:0 auto;padding:20px 16px 28px}.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:14px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px}.k{font-size:12px;color:#6b7280;text-transform:uppercase}.v{font-size:22px;font-weight:700}
.badge{padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700}.AAA{background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd}.AA{background:#d1fae5;color:#047857;border:1px solid #a7f3d0}.A{background:#ffedd5;color:#b45309;border:1px solid #fed7aa}.Unknown{background:#ede9fe;color:#6d28d9;border:1px solid #ddd6fe}
.table{overflow:auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:14px}table{width:100%;border-collapse:collapse;min-width:900px}th,td{padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top}th{text-align:left;background:#f1f5f9}
</style></head><body><main>
<h1>Accessibility Batch Summary</h1>
<p>Target: <strong>WCAG AAA</strong> | Generated: ${esc(manifest.generatedAt)} | URL list: <code>${esc(manifest.sourceUrlList)}</code></p>
<div class="grid">
<div class="card"><div class="k">Pages Requested</div><div class="v">${manifest.pageCount}</div></div>
<div class="card"><div class="k">Pages Scanned</div><div class="v">${manifest.results.filter((r) => r.status === 'ok').length}</div></div>
<div class="card"><div class="k">Scan Errors</div><div class="v">${manifest.results.filter((r) => r.status === 'error').length}</div></div>
<div class="card"><div class="k">Total Issues</div><div class="v">${manifest.results.filter((r) => r.status === 'ok').reduce((s, r) => s + r.issueCount, 0)}</div></div>
<div class="card"><div class="k">A Issues</div><div class="v">${levelCounts.A || 0}</div></div>
<div class="card"><div class="k">AA Issues</div><div class="v">${levelCounts.AA || 0}</div></div>
<div class="card"><div class="k">AAA Issues</div><div class="v">${levelCounts.AAA || 0}</div></div>
</div>
<h2>Pages</h2><div class="table"><table><thead><tr><th>URL</th><th>Status</th><th>Issues</th><th>JSON</th><th>HTML</th></tr></thead><tbody>
${manifest.results.map((r)=>`<tr><td>${esc(r.url)}</td><td>${esc(r.status)}</td><td>${r.status==='ok'?r.issueCount:'-'}</td><td>${r.jsonFile?`<a href="${esc(r.jsonFile)}">${esc(r.jsonFile)}</a>`:'-'}</td><td>${r.htmlFile?`<a href="${esc(r.htmlFile)}">${esc(r.htmlFile)}</a>`:'-'}</td></tr>`).join('')}
</tbody></table></div>
<h2>Top Rules</h2><div class="table"><table><thead><tr><th>Count</th><th>Pages</th><th>WCAG</th><th>SC</th><th>Code</th><th>Message</th></tr></thead><tbody>
${ruleRows.map((r)=>`<tr><td>${r.count}</td><td>${r.pageCount}</td><td><span class="badge ${esc(r.level)}">${esc(r.level)}</span></td><td>${esc(r.criterion || '-')}</td><td><code>${esc(r.code)}</code></td><td>${esc(r.message)}</td></tr>`).join('')}
</tbody></table></div>
</main></body></html>`;

  const summaryFile = path.join(reportRoot, 'summary.html');
  fs.writeFileSync(summaryFile, html, 'utf8');
  return summaryFile;
}
