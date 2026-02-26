import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, writeInitConfig } from './config.mjs';
import { readUrlList } from './utils.mjs';
import { scanPage } from './scanners/page.mjs';
import { scanBatch } from './scanners/batch.mjs';
import { urlsFromSitemap } from './scanners/xml.mjs';
import { runAuditBatch, runAuditFromList, runAuditFromXml, runAuditPage } from './audit.mjs';
import { targetStandardFromLevel } from './wcag.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  wcag-a11y-scanner init [--output-dir <dir>]',
    '  wcag-a11y-scanner scan page <url> [--output-dir <dir>]',
    '  wcag-a11y-scanner scan list <urls.txt> [--output-dir <dir>]',
    '  wcag-a11y-scanner scan xml <sitemap.xml> [--base-url <url>] [--output-dir <dir>]',
    '  wcag-a11y-scanner audit page <url> [--level AA|AAA] [--output-dir <dir>]',
    '  wcag-a11y-scanner audit list <urls.txt> [--level AA|AAA] [--output-dir <dir>]',
    '  wcag-a11y-scanner audit xml <sitemap.xml> [--base-url <url>] [--level AA|AAA] [--output-dir <dir>]'
  ].join('\n');
}

export async function runCli(argv) {
  const args = parseArgs(argv);
  const [cmd, sub, target] = args._;
  const cwd = process.cwd();

  if (!cmd) {
    console.log(usage());
    return;
  }

  if (cmd === 'init') {
    const outputDir = args['output-dir'] || undefined;
    const configPath = writeInitConfig(cwd, outputDir ? { outputDir } : {});
    console.log(`Created ${configPath}`);
    console.log('Next run: wcag-a11y-scanner scan page https://example.local');
    return;
  }

  if (cmd !== 'scan' || !sub || !target) {
    if (cmd !== 'audit' || !sub || !target) {
      console.log(usage());
      return;
    }
  }

  const cfg = loadConfig(cwd, {
    cwd,
    outputDir: args['output-dir'] || undefined,
    includeWarnings: args['include-warnings'] === 'false' ? false : undefined,
    includeNotices: args['include-notices'] === 'true' ? true : undefined
  });

  if (sub === 'page') {
    if (cmd === 'audit') {
      const auditLevel = String(args.level || 'AA').toUpperCase() === 'AAA' ? 'AAA' : 'AA';
      const result = await runAuditPage(target, {
        ...cfg,
        auditLevel,
        standard: args.standard || targetStandardFromLevel(auditLevel),
        auditOutputDir: args['output-dir'] || 'audits'
      }, target);
      console.log(`Audit complete: ${result.summary.overall.status} (${result.summary.target.standard})`);
      console.log(`Saved audit JSON: ${result.auditJsonFile}`);
      console.log(`Saved audit HTML: ${result.auditHtmlFile}`);
      return;
    }

    const result = await scanPage(target, cfg);
    const errors = result.typeCounts.error || 0;
    const warnings = result.typeCounts.warning || 0;
    const notices = result.typeCounts.notice || 0;
    const unknown = result.typeCounts.unknown || 0;
    console.log(`Scan complete: ${result.issueCount} issue(s) [error=${errors}, warning=${warnings}, notice=${notices}, unknown=${unknown}]`);
    console.log(`Saved report: ${result.jsonFile}`);
    console.log(`Saved HTML: ${result.htmlFile}`);
    return;
  }

  if (sub === 'list') {
    if (cmd === 'audit') {
      const auditLevel = String(args.level || 'AA').toUpperCase() === 'AAA' ? 'AAA' : 'AA';
      const result = await runAuditFromList(target, {
        ...cfg,
        auditLevel,
        standard: args.standard || targetStandardFromLevel(auditLevel),
        auditOutputDir: args['output-dir'] || 'audits'
      });
      console.log(`Audit complete: ${result.summary.overall.status} (${result.summary.target.standard})`);
      console.log(`Saved audit JSON: ${result.auditJsonFile}`);
      console.log(`Saved audit HTML: ${result.auditHtmlFile}`);
      return;
    }

    const urls = readUrlList(path.resolve(target));
    if (!urls.length) throw new Error(`No URLs found in ${target}`);
    const result = await scanBatch(urls, cfg, target);
    console.log(`Saved batch reports to: ${result.reportRoot}`);
    console.log(`Saved summary: ${result.summaryFile}`);
    return;
  }

  if (sub === 'xml') {
    if (cmd === 'audit') {
      const auditLevel = String(args.level || 'AA').toUpperCase() === 'AAA' ? 'AAA' : 'AA';
      const result = await runAuditFromXml(
        target,
        args['base-url'] || '',
        {
          ...cfg,
          auditLevel,
          standard: args.standard || targetStandardFromLevel(auditLevel),
          auditOutputDir: args['output-dir'] || 'audits'
        },
        cwd
      );
      console.log(`Audit complete: ${result.summary.overall.status} (${result.summary.target.standard})`);
      console.log(`Saved audit JSON: ${result.auditJsonFile}`);
      console.log(`Saved audit HTML: ${result.auditHtmlFile}`);
      return;
    }

    const urls = urlsFromSitemap(target, args['base-url'] || '');
    if (!urls.length) throw new Error(`No URLs discovered from sitemap: ${target}`);

    const urlListDir = path.resolve(cwd, '.a11y-scanner');
    fs.mkdirSync(urlListDir, { recursive: true });
    const urlListFile = path.join(urlListDir, `urls-${Date.now()}.txt`);
    fs.writeFileSync(urlListFile, `${urls.join('\n')}\n`, 'utf8');

    const result = await scanBatch(urls, cfg, path.relative(cwd, urlListFile));
    console.log(`Saved URL list: ${urlListFile}`);
    console.log(`Saved batch reports to: ${result.reportRoot}`);
    console.log(`Saved summary: ${result.summaryFile}`);
    return;
  }

  if (cmd === 'scan') throw new Error(`Unknown scan mode: ${sub}`);
  if (cmd === 'audit') throw new Error(`Unknown audit mode: ${sub}`);
  throw new Error(`Unknown command: ${cmd}`);
}
