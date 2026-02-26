import puppeteer from 'puppeteer';

const [, , targetUrl] = process.argv;

if (!targetUrl) {
  console.error('Usage: node scripts/a11y/run-keyboard-audit.mjs <url>');
  process.exit(1);
}

const timeout = Number(process.env.A11Y_TIMEOUT || 120000);
const waitMs = Number(process.env.A11Y_WAIT || 1000);

const pointerEvents = ['click', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout', 'mousemove', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];
const keyboardEvents = ['keydown', 'keyup', 'keypress', 'focus', 'blur'];

let browser;

try {
  browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--allow-insecure-localhost',
      '--ignore-certificate-errors'
    ],
    ignoreHTTPSErrors: true
  });

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

    function isDecorativeImage(img) {
      const role = cleanText(img.getAttribute('role')).toLowerCase();
      if (role === 'presentation' || role === 'none') return true;
      if (img.getAttribute('aria-hidden') === 'true') return true;
      if (img.closest('[aria-hidden="true"]')) return true;
      return false;
    }

    function isInteractiveElement(el) {
      if (!(el instanceof Element)) return false;
      if (el.matches('a[href], button, input:not([type="hidden"]), select, textarea, summary')) return true;
      if (el.hasAttribute('contenteditable')) return true;
      const tabindex = el.getAttribute('tabindex');
      if (tabindex !== null && Number(tabindex) >= 0) return true;
      const role = cleanText(el.getAttribute('role')).toLowerCase();
      if (role && interactiveRoles.has(role)) return true;
      if (['aria-expanded', 'aria-controls', 'aria-haspopup', 'aria-pressed'].some((attr) => el.hasAttribute(attr))) return true;
      return false;
    }

    function isLikelyContainerOnly(el) {
      if (!(el instanceof Element)) return false;
      if (el.matches('html, body')) return true;
      if (el.matches('.swiper, .swiper-container, .swiper-wrapper')) return true;
      const focusableChildren = el.querySelector('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusableChildren && !el.hasAttribute('role') && !el.hasAttribute('tabindex')) {
        return true;
      }
      return false;
    }

    function isFocusableCandidate(el) {
      if (!isVisible(el)) return false;
      if (el.hasAttribute('disabled')) return false;
      if (el.getAttribute('tabindex') === '-1') return false;
      return isInteractiveElement(el);
    }

    const issuesOut = [];
    const dedupe = new Set();

    function pushIssue(el, code, message, type = 'warning', typeCode = 2) {
      const selector = cssPath(el);
      const context = cleanText((el && el.outerHTML) || '').slice(0, 400);
      const key = `${code}::${selector}::${message}`;
      if (dedupe.has(key)) return;
      dedupe.add(key);
      issuesOut.push({
        code,
        type,
        typeCode,
        message,
        context,
        selector,
        runner: 'custom-keyboard-audit',
        runnerExtras: {}
      });
    }

    const allElements = Array.from(document.querySelectorAll('*'));

    // WCAG 2.1.1 (keyboard): non-focusable elements that act interactive.
    for (const el of allElements) {
      if (!isVisible(el)) continue;

      if (
        el.closest('a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable]')
        && !isKeyboardFocusable(el)
      ) {
        continue;
      }

      const hasPointerHandler = hasHandler(el, pointerEventsSet, 'on');
      const hasKeyboardHandler = hasHandler(el, keyboardEventsSet, 'on');
      const role = cleanText(el.getAttribute('role')).toLowerCase();
      const hasInteractiveRole = role && interactiveRoles.has(role);
      const hasInteractiveAria = ['aria-expanded', 'aria-controls', 'aria-haspopup', 'aria-pressed'].some((attr) => el.hasAttribute(attr));

      if (!(hasPointerHandler || hasInteractiveRole || hasInteractiveAria)) {
        continue;
      }

      if (isLikelyContainerOnly(el)) {
        continue;
      }

      if (isKeyboardFocusable(el)) {
        continue;
      }

      let reason = 'Potential keyboard-only issue: interactive element is not keyboard focusable.';
      if (hasPointerHandler && !hasKeyboardHandler) {
        reason = 'Potential keyboard-only issue: pointer interaction detected without keyboard handler on non-focusable element.';
      } else if (hasInteractiveRole || hasInteractiveAria) {
        reason = 'Potential keyboard-only issue: interactive role/ARIA state on non-focusable element.';
      }

      pushIssue(
        el,
        'WCAG2AAA.Principle2.Guideline2_1.2_1_1.Custom.KeyboardOnly',
        reason,
        'warning',
        2
      );
    }

    // WCAG 1.1.1 (non-text content): images without usable alt text.
    for (const img of document.querySelectorAll('img')) {
      if (img.matches('.lb-image, .lazyload-placeholder')) continue;
      const alt = img.getAttribute('alt');
      if (alt === null) {
        pushIssue(
          img,
          'WCAG2AAA.Principle1.Guideline1_1.1_1_1.Custom.ImageAltMissing',
          'Image is missing an alt attribute.',
          'error',
          1
        );
        continue;
      }

      if (cleanText(alt) === '' && !isDecorativeImage(img)) {
        const parentLink = img.closest('a[href], button');
        const parentName = parentLink ? accessibleName(parentLink) : '';
        if (!parentName) {
          pushIssue(
            img,
            'WCAG2AAA.Principle1.Guideline1_1.1_1_1.Custom.ImageAltEmpty',
            'Image has empty alt text but does not appear decorative.',
            'warning',
            2
          );
        }
      }
    }

    // WCAG 4.1.2 + 1.3.1: interactive controls need accessible names/labels.
    const candidateSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role], [tabindex], [contenteditable]';
    for (const el of document.querySelectorAll(candidateSelector)) {
      if (!isVisible(el)) continue;
      if (!isInteractiveElement(el)) continue;

      const name = accessibleName(el);
      if (!name) {
        pushIssue(
          el,
          'WCAG2AAA.Principle4.Guideline4_1.4_1_2.Custom.NameMissing',
          'Interactive element is missing an accessible name.',
          'error',
          1
        );
      }

      if (el.matches('input:not([type="hidden"]), select, textarea')) {
        const inputType = cleanText(el.getAttribute('type')).toLowerCase();
        const shouldRequireLabel = !['submit', 'button', 'reset', 'image'].includes(inputType);
        if (!shouldRequireLabel) {
          continue;
        }
        const label = getLabelTextForControl(el);
        if (!label) {
          pushIssue(
            el,
            'WCAG2AAA.Principle1.Guideline1_3.1_3_1.Custom.FormLabelMissing',
            'Form control is missing a label or equivalent programmatic description.',
            'warning',
            2
          );
        }
      }
    }

    // WCAG 2.4.4: links should be descriptive.
    for (const link of document.querySelectorAll('a[href]')) {
      if (!isVisible(link)) continue;
      const name = cleanText(accessibleName(link)).toLowerCase();
      if (!name) {
        pushIssue(
          link,
          'WCAG2AAA.Principle2.Guideline2_4.2_4_4.Custom.LinkPurposeMissing',
          'Link has no discernible descriptive text.',
          'error',
          1
        );
        continue;
      }

      const normalized = name.replace(/[^\w\s]/g, '').trim();
      if (genericLinkTexts.has(normalized)) {
        pushIssue(
          link,
          'WCAG2AAA.Principle2.Guideline2_4.2_4_4.Custom.LinkPurposeWeak',
          'Link text is generic and may not be descriptive enough out of context.',
          'warning',
          2
        );
      }
    }

    // WCAG 2.4.1: skip links at top of page with valid target.
    const allSkipLinks = Array.from(document.querySelectorAll('a[href^="#"]')).filter((a) => {
      const text = cleanText(a.textContent).toLowerCase();
      const klass = cleanText(a.className).toLowerCase();
      return text.includes('skip') || klass.includes('skip-link');
    });

    if (!allSkipLinks.length) {
      pushIssue(
        document.body,
        'WCAG2AAA.Principle2.Guideline2_4.2_4_1.Custom.SkipLinkMissing',
        'No skip link was found to bypass repeated navigation.',
        'error',
        1
      );
    } else {
      let hasValidTarget = false;
      for (const skipLink of allSkipLinks) {
        const targetHref = cleanText(skipLink.getAttribute('href'));
        const id = targetHref.startsWith('#') ? decodeURIComponent(targetHref.slice(1)) : '';
        const target = id ? document.getElementById(id) : null;
        if (!target) {
          pushIssue(
            skipLink,
            'WCAG2AAA.Principle2.Guideline2_4.2_4_1.Custom.SkipTargetMissing',
            'Skip link target does not exist in the document.',
            'error',
            1
          );
        } else {
          hasValidTarget = true;
        }
      }

      if (!hasValidTarget) {
        pushIssue(
          document.body,
          'WCAG2AAA.Principle2.Guideline2_4.2_4_1.Custom.SkipNoValidTarget',
          'Skip links exist but none point to a valid target.',
          'error',
          1
        );
      }

      const focusCandidates = Array.from(document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable]'))
        .filter(isFocusableCandidate)
        .slice(0, 8);
      const skipInEarlyOrder = allSkipLinks.some((link) => focusCandidates.includes(link));
      if (!skipInEarlyOrder) {
        pushIssue(
          allSkipLinks[0],
          'WCAG2AAA.Principle2.Guideline2_4.2_4_1.Custom.SkipLateInOrder',
          'Skip link is not among the first focusable controls in tab order.',
          'warning',
          2
        );
      }
    }

    // WCAG 3.2.2: detect likely unexpected context changes.
    for (const el of document.querySelectorAll('[onchange],[onblur]')) {
      if (!isVisible(el)) continue;
      const code = `${cleanText(el.getAttribute('onchange'))};${cleanText(el.getAttribute('onblur'))}`.toLowerCase();
      if (/location\.|window\.open|submit\(|form\.submit/.test(code)) {
        pushIssue(
          el,
          'WCAG2AAA.Principle3.Guideline3_2.3_2_2.Custom.UnexpectedContextChange',
          'Element appears to trigger a context change on input/blur without an explicit user request.',
          'warning',
          2
        );
      }
    }

    // WCAG 2.4.5: multiple ways heuristic.
    const hasSearch = Boolean(document.querySelector('form[role="search"], input[type="search"], [aria-label*="search" i], [class*="search"]'));
    const hasSitemapLink = Boolean(Array.from(document.querySelectorAll('a[href]')).find((a) => /sitemap/i.test(`${a.getAttribute('href') || ''} ${a.textContent || ''}`)));
    const hasBreadcrumbs = Boolean(document.querySelector('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, nav[aria-label*="breadcrumb" i]'));
    const navLinkCount = document.querySelectorAll('nav a[href]').length;
    if (!hasSearch && !hasSitemapLink && !hasBreadcrumbs && navLinkCount < 5) {
      pushIssue(
        document.body,
        'WCAG2AAA.Principle2.Guideline2_4.2_4_5.Custom.MultipleWaysHeuristic',
        'Page does not appear to expose multiple navigation methods (search, sitemap, breadcrumbs, or robust navigation).',
        'warning',
        2
      );
    }

    return issuesOut;
  }, pointerEvents, keyboardEvents);

  process.stdout.write(JSON.stringify(issues));
  process.exit(0);
} catch (err) {
  const msg = err && err.message ? err.message : 'Keyboard audit failed.';
  console.error(msg);
  process.exit(1);
} finally {
  if (browser) {
    await browser.close();
  }
}
