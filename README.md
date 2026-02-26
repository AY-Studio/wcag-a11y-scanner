# WCAG A11y Scanner

CLI for practical WCAG accessibility scanning and compliance sign-off.

## What It Does

`WCAG A11y Scanner` supports two workflows:
- `scan`: detailed technical output for fixing issues (JSON + HTML per page)
- `audit`: concise pass/fail bill-of-health output for project sign-off

It works with:
- single pages
- URL lists
- XML sitemaps
- local/staging/live domains

## Install

```bash
npm install -g wcag-a11y-scanner
```

Or in a project:

```bash
npm install --save-dev wcag-a11y-scanner
```

For local package development:

```bash
cd tools/wcag-a11y-scanner
npm install
npm link
```

## Quick Start

```bash
wcag-a11y-scanner init
wcag-a11y-scanner scan page "https://example.local"
wcag-a11y-scanner audit page "https://example.local"
```

## Commands

### Detailed Scan (for remediation)

```bash
wcag-a11y-scanner scan page "https://example.local/about"
wcag-a11y-scanner scan list "a11y/urls.txt"
wcag-a11y-scanner scan xml "https://example.local/page-sitemap.xml"
```

### Compliance Audit (for sign-off)

Default target is **WCAG 2.2 AA**.

```bash
wcag-a11y-scanner audit page "https://example.local"
wcag-a11y-scanner audit list "a11y/urls.txt"
wcag-a11y-scanner audit xml "https://example.local/page-sitemap.xml"
```

Set target level to AAA:

```bash
wcag-a11y-scanner audit page "https://example.local" --level AAA
```

## Output

### Scan output
- Default folder: `a11y/reports/<YYYY-MM-DD-HHMMSS>/`
- Files: per-page `.json` + `.html`, plus batch `summary.html`

### Audit output
- Default folder: `audits/<YYYY-MM-DD-HHMMSS>/`
- Files:
  - `audit.json`
  - `audit.html`
  - per-page scan files used to build the audit

Audit report includes:
- overall PASS/FAIL badge at chosen target (AA/AAA)
- A / AA / AAA status cards
- individual WCAG success criteria rows with pass/fail and counts
- criteria examples like `2.4.1`, `2.4.10`, etc.

## WCAG Coverage in Audit Matrix

The audit matrix maps individual success criteria and reports PASS/FAIL per criterion across:
- Level A
- Level AA
- Level AAA

Current matrix includes **86 WCAG criteria** used for automated sign-off scoring.

## Config

Create `.a11y-scanner.json` with:

```bash
wcag-a11y-scanner init
```

Example:

```json
{
  "outputDir": "a11y/reports",
  "timeout": 120000,
  "wait": 1000,
  "includeWarnings": true,
  "includeNotices": false,
  "includeAll": false,
  "hideElements": [
    "#cmplz-cookiebanner-container",
    "#cmplz-manage-consent",
    ".grecaptcha-badge",
    "#lightbox"
  ]
}
```

Override output directory at runtime:

```bash
wcag-a11y-scanner audit xml "https://example.local/page-sitemap.xml" --output-dir "./my-audits"
```

## Notes

- Automated audits are excellent for fast compliance benchmarking and regression checks.
- Formal accessibility certification still requires manual testing and assistive-technology checks.
