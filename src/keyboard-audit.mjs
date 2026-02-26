import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const [, , targetUrl] = process.argv;

if (!targetUrl) {
  console.error('Usage: node scripts/a11y/run-keyboard-audit.mjs <url>');
  process.exit(1);
}

const timeout = Number(process.env.A11Y_TIMEOUT || 120000);
const waitMs = Number(process.env.A11Y_WAIT || 1000);
let chromePath = process.env.A11Y_CHROME_PATH || '';

function chromeCandidates() {
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
  const seen = new Set();
  const out = [];
  if (chromePath) {
    seen.add(chromePath);
    out.push(chromePath);
  }
  for (const candidate of candidates) {
    if (!seen.has(candidate) && fs.existsSync(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

if (!chromePath) {
  for (const candidate of chromeCandidates()) {
    if (fs.existsSync(candidate)) chromePath = candidate;
    if (chromePath) break;
  }
}

if (!chromePath) {
  console.error('Missing A11Y_CHROME_PATH and no system Chrome was found.');
  process.exit(1);
}

const pointerEvents = ['click', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout', 'mousemove', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];
const keyboardEvents = ['keydown', 'keyup', 'keypress', 'focus', 'blur'];

let browser;
let launchError;

try {
  for (const candidate of chromeCandidates()) {
    try {
      browser = await puppeteer.launch({
        executablePath: candidate,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--allow-insecure-localhost',
          '--ignore-certificate-errors'
        ],
        ignoreHTTPSErrors: true
      });
      break;
    } catch (error) {
      launchError = error;
    }
  }

  if (!browser) {
    throw launchError || new Error('Unable to launch Chrome for keyboard audit.');
  }

  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    const originalAddEventListener = EventTarget.prototype.addEventListener;

    EventTarget.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
      try {
        if (this && this.nodeType === 1 && typeof type === 'string') {
          const lowerType = type.toLowerCase();
          if (!Array.isArray(this.__a11yListenerTypes)) {
            Object.defineProperty(this, '__a11yListenerTypes', {
              value: [],
              writable: true,
              configurable: true
            });
          }
          this.__a11yListenerTypes.push(lowerType);
        }
      } catch {
        // Ignore instrumentation failures and continue with native registration.
      }

      return originalAddEventListener.call(this, type, listener, options);
    };
  });

  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout });
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const issues = await page.evaluate((pointerEventList, keyboardEventList) => {
    const interactiveRoles = new Set([
      'button',
      'checkbox',
      'combobox',
      'link',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'radio',
      'searchbox',
      'slider',
      'spinbutton',
      'switch',
      'tab',
      'textbox',
      'treeitem'
    ]);

    const genericLinkTexts = new Set([
      'click here',
      'here',
      'read more',
      'learn more',
      'more',
      'details',
      'view',
      'go',
      'link'
    ]);

    const pointerEventsSet = new Set(pointerEventList);
    const keyboardEventsSet = new Set(keyboardEventList);

    function cssPath(el) {
      if (!(el instanceof Element)) return '';

      const parts = [];
      let node = el;

      while (node && node.nodeType === 1 && parts.length < 10) {
        let part = node.tagName.toLowerCase();

        if (node.id) {
          part += `#${CSS.escape(node.id)}`;
          parts.unshift(part);
          break;
        }

        const classes = String(node.className || '')
          .split(/\s+/)
          .map((name) => name.trim())
          .filter(Boolean)
          .slice(0, 2);

        if (classes.length) {
          part += classes.map((name) => `.${CSS.escape(name)}`).join('');
        }

        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) {
            part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          }
        }

        parts.unshift(part);
        node = node.parentElement;
      }

      return parts.join(' > ');
    }

    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function isVisible(el) {
      if (!(el instanceof Element)) return false;
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') {
        return false;
      }

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }

      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    }

    function hasHandler(el, eventNames, inlinePrefix) {
      const inline = [...eventNames].some((eventName) => el.hasAttribute(`${inlinePrefix}${eventName}`));
      const prop = [...eventNames].some((eventName) => typeof el[`${inlinePrefix}${eventName}`] === 'function');
      const registered = Array.isArray(el.__a11yListenerTypes) && el.__a11yListenerTypes.some((type) => eventNames.has(type));
      return inline || prop || registered;
    }

    function isNativeKeyboardElement(el) {
      if (!(el instanceof Element)) return false;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.hasAttribute('href')) return true;
      if (['button', 'select', 'textarea', 'summary'].includes(tag)) return true;
      if (tag === 'input' && String(el.getAttribute('type') || '').toLowerCase() !== 'hidden') return true;
      return el.hasAttribute('contenteditable');
    }

    function isKeyboardFocusable(el) {
      if (isNativeKeyboardElement(el)) return true;
      const tabindex = el.getAttribute('tabindex');
      if (tabindex === null) return false;
      const value = Number(tabindex);
      return Number.isFinite(value) && value >= 0;
    }

    function getLabelledByText(el) {
      const ids = cleanText(el.getAttribute('aria-labelledby'));
      if (!ids) return '';
      const chunks = ids
        .split(/\s+/)
        .map((id) => {
          const source = document.getElementById(id);
          return source ? cleanText(source.textContent) : '';
        })
        .filter(Boolean);
      return cleanText(chunks.join(' '));
    }

    function getLabelTextForControl(el) {
      if (!(el instanceof Element)) return '';

      const viaLabelledBy = getLabelledByText(el);
      if (viaLabelledBy) return viaLabelledBy;

      const ariaLabel = cleanText(el.getAttribute('aria-label'));
      if (ariaLabel) return ariaLabel;

      if ('labels' in el && el.labels && el.labels.length) {
        const labelText = cleanText(Array.from(el.labels).map((label) => label.textContent).join(' '));
        if (labelText) return labelText;
      }

      const id = cleanText(el.getAttribute('id'));
      if (id) {
        const explicitLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (explicitLabel) {
          const explicitText = cleanText(explicitLabel.textContent);
          if (explicitText) return explicitText;
        }
      }

      const wrappedLabel = el.closest('label');
      if (wrappedLabel) {
        const wrappedText = cleanText(wrappedLabel.textContent);
        if (wrappedText) return wrappedText;
      }

      return '';
    }

    function accessibleName(el) {
      if (!(el instanceof Element)) return '';

      const labelledBy = getLabelledByText(el);
      if (labelledBy) return labelledBy;

      const ariaLabel = cleanText(el.getAttribute('aria-label'));
      if (ariaLabel) return ariaLabel;

      const tag = el.tagName.toLowerCase();
      if (tag === 'img') {
        return cleanText(el.getAttribute('alt'));
      }

      if (tag === 'input') {
        const type = cleanText(el.getAttribute('type')).toLowerCase();
        if (type === 'image') {
          const alt = cleanText(el.getAttribute('alt'));
          if (alt) return alt;
        }
        if (['submit', 'button', 'reset'].includes(type)) {
          const value = cleanText(el.getAttribute('value'));
          if (value) return value;
        }
      }

      const controlLabel = getLabelTextForControl(el);
      if (controlLabel) return controlLabel;

      if (tag === 'a') {
        const nestedImg = el.querySelector('img[alt]');
        if (nestedImg) {
          const nestedAlt = cleanText(nestedImg.getAttribute('alt'));
          if (nestedAlt) return nestedAlt;
        }
      }

      const title = cleanText(el.getAttribute('title'));
      if (title) return title;

      return cleanText(el.textContent);
    }

    function describeNode(el) {
      const name = accessibleName(el);
      const role = cleanText(el.getAttribute('role'));
      const tag = el.tagName.toLowerCase();
      const descriptor = cleanText(name || role || tag || 'element');
      return descriptor.slice(0, 120);
    }

    function issue({ code, type = 'error', message, selector, context, runner = 'custom-keyboard-audit', criterion = null }) {
      return {
        code,
        type,
        typeCode: type === 'error' ? 1 : type === 'warning' ? 2 : 3,
        message,
        context,
        selector,
        runner,
        runnerExtras: criterion ? { criterion } : undefined
      };
    }

    const issues = [];
    const seen = new Set();

    function pushIssue(data) {
      const key = `${data.code}::${data.selector}::${data.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push(issue(data));
    }

    const focusables = Array.from(document.querySelectorAll('a, button, input, select, textarea, summary, [tabindex], [role], [contenteditable]'));

    for (const el of focusables) {
      if (!isVisible(el)) continue;

      const selector = cssPath(el);
      const tag = el.tagName.toLowerCase();
      const role = cleanText(el.getAttribute('role')).toLowerCase();
      const name = accessibleName(el);

      if ((tag === 'a' || role === 'link') && !name) {
        pushIssue({
          code: 'WCAG2A.Principle4.Guideline4_1.4_1_2.H91.A.Empty',
          message: 'Link has no accessible name.',
          selector,
          context: `Element: ${describeNode(el)}`,
          criterion: '4.1.2'
        });
      }

      if (!name && (isNativeKeyboardElement(el) || interactiveRoles.has(role) || el.hasAttribute('onclick'))) {
        pushIssue({
          code: 'WCAG2A.Principle4.Guideline4_1.4_1_2.H91.A.Name',
          message: 'Interactive element has no accessible name.',
          selector,
          context: `Element: ${describeNode(el)}`,
          criterion: '4.1.2'
        });
      }

      if (tag === 'a') {
        const text = cleanText(name).toLowerCase();
        if (text && genericLinkTexts.has(text)) {
          pushIssue({
            code: 'WCAG2A.Principle2.Guideline2_4.2_4_4.H30.2',
            message: 'Link text is not descriptive enough.',
            selector,
            context: `Link text: "${cleanText(name)}"`,
            criterion: '2.4.4'
          });
        }
      }

      const pointerOnly = hasHandler(el, pointerEventsSet, 'on') && !hasHandler(el, keyboardEventsSet, 'on');
      const keyboardInaccessible = pointerOnly && !isKeyboardFocusable(el);
      if (keyboardInaccessible) {
        pushIssue({
          code: 'WCAG2A.Principle2.Guideline2_1.2_1_1.SCR2.G202.Fail',
          message: 'Element has pointer interaction but is not keyboard accessible.',
          selector,
          context: `Element: ${describeNode(el)}`,
          criterion: '2.1.1'
        });
      }
    }

    const skipTargets = [
      '#main',
      '#content',
      '#primary',
      '#main-content',
      '[role="main"]',
      'main'
    ];

    const skipLinks = Array.from(document.querySelectorAll('a[href^="#"]')).filter((a) => {
      const text = cleanText(a.textContent).toLowerCase();
      const href = cleanText(a.getAttribute('href')).toLowerCase();
      return text.startsWith('skip') || href.includes('main') || href.includes('content');
    });

    const hasMain = skipTargets.some((sel) => document.querySelector(sel));
    if (!skipLinks.length || !hasMain) {
      pushIssue({
        code: 'WCAG2A.Principle2.Guideline2_4.2_4_1.G1',
        message: 'No valid skip link to main content detected.',
        selector: 'body',
        context: 'Expected a keyboard-visible skip link pointing to main content.',
        criterion: '2.4.1'
      });
    }

    const fieldSelectors = 'input:not([type="hidden"]), select, textarea';
    const fields = Array.from(document.querySelectorAll(fieldSelectors));
    for (const field of fields) {
      if (!isVisible(field)) continue;

      const inputType = cleanText(field.getAttribute('type')).toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(inputType)) continue;

      const name = getLabelTextForControl(field);
      if (!name) {
        pushIssue({
          code: 'WCAG2A.Principle1.Guideline1_3.1_3_1.F68',
          message: 'Form control is missing a programmatic label.',
          selector: cssPath(field),
          context: `Field: ${describeNode(field)}`,
          criterion: '1.3.1'
        });
      }
    }

    return issues;
  }, pointerEvents, keyboardEvents);

  process.stdout.write(`${JSON.stringify(issues)}\n`);
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // no-op
    }
  }
}
