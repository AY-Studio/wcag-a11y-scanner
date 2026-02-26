import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_NAME = '.a11y-scanner.json';

const DEFAULTS = {
  outputDir: 'a11y/reports',
  timeout: 120000,
  wait: 1000,
  includeWarnings: true,
  includeNotices: false,
  includeAll: false,
  hideElements: [
    '#cmplz-cookiebanner-container',
    '#cmplz-manage-consent',
    '.grecaptcha-badge',
    '#lightbox'
  ]
};

export function loadConfig(cwd, cli = {}) {
  const configPath = path.resolve(cwd, CONFIG_NAME);
  let user = {};
  if (fs.existsSync(configPath)) {
    try {
      user = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      user = {};
    }
  }

  const outputDir = cli.outputDir || process.env.A11Y_OUTPUT_DIR || user.outputDir || DEFAULTS.outputDir;
  return {
    ...DEFAULTS,
    ...user,
    ...cli,
    outputDir,
    configPath
  };
}

export function writeInitConfig(cwd, overrides = {}) {
  const configPath = path.resolve(cwd, CONFIG_NAME);
  const config = {
    ...DEFAULTS,
    ...overrides
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return configPath;
}
