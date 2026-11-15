import { test, expect } from '@playwright/test';
import { pagesUnderTest } from '../../pages.config.js';
import { triggerLazyImages } from '../../utils/lazy-load.js';
import { pauseSliders, stabilizePageForScreenshot } from '../../utils/flaky-elements.js';

/**
 * If a sign-in popup/form appears (e.g. password-protected dev site),
 * enter DEV_USERNAME/DEV_PASSWORD from env and submit. Wait for sign-in
 * to succeed (login form gone) before continuing so screenshots are never
 * taken of an unauthorized/login page.
 */
async function handleSignInIfNeeded(page) {
  const userField = page.locator(
    'input[type="text"][name="username"], input[type="text"][name="user"], input[name="log"], input[autocomplete="username"], input[type="email"]'
  ).first();
  const passField = page.locator(
    'input[type="password"], input[name="password"], input[name="pwd"]'
  ).first();

  const isSignInVisible = async () => {
    const hasUser = await userField.isVisible().catch(() => false);
    const hasPass = await passField.isVisible().catch(() => false);
    return hasUser && hasPass;
  };

  if (!(await isSignInVisible())) return;

  const username = process.env.DEV_USERNAME;
  const password = process.env.DEV_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'Sign-in form detected but DEV_USERNAME/DEV_PASSWORD are not set. ' +
        'Provide credentials to capture an authenticated screenshot.'
    );
  }

  await userField.fill(username);
  await passField.fill(password);

  const submit = page.locator(
    'button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login"), button:has-text("Submit")'
  ).first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click();
  } else {
    await passField.press('Enter');
  }

  // Wait for navigation/load and for the login form to disappear before taking screenshots.
  await page.waitForLoadState('load').catch(() => {});
  await expect(passField).toBeHidden({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => {});

  // Guard against submitting invalid credentials and still being on the sign-in page.
  if (await isSignInVisible()) {
    throw new Error('Sign-in did not complete successfully; login form is still visible.');
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/\b401\b|unauthorized|authorization required|access denied/i.test(bodyText)) {
    throw new Error('Sign-in did not complete successfully; unauthorized page content is still visible.');
  }
}

/**
 * Accept cookie/consent banners so they don't appear in screenshots.
 * Tries common CMP selectors (Complianz, CookieConsent, generic) and falls
 * back to hiding known overlays if no clickable accept action is found.
 */
async function acceptCookieBanner(page) {
  const candidates = [
    '.cmplz-accept, .cmplz-cookiebanner-container .cmplz-accept, [class*="cmplz"] button:has-text("Accept")',
    '#c-p-bn',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    '[aria-label*="Accept" i]',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#onetrust-accept-btn-handler',
  ];

  for (const selector of candidates) {
    const btn = page.locator(selector).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      break;
    }
  }

  // Ensure common cookie overlays/modals are hidden even if not dismissed.
  await page.evaluate(() => {
    const hideSelectors = [
      '#cm', '#cm-ov', '#cc--main', '#s-cnt', '#cs', '#cs-ov',
      '.cmplz-cookiebanner', '[id^="cmplz"]',
      '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay',
      '#onetrust-banner-sdk', '#onetrust-consent-sdk',
      '[class*="cookie" i][role="dialog"]',
      '[id*="cookie" i][class*="banner" i]',
    ];
    for (const sel of hideSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
      });
    }
  });
}

test.describe('Visual regression', () => {
  test.setTimeout(120_000);
  for (const pageUnderTest of pagesUnderTest) {
    test(`${pageUnderTest.name} — full page matches baseline`, async ({ page }) => {
      // The site's paid webfont host (Type Network) intermittently blocks
      // its font files with a CORS error. When that happens the page
      // renders in the fallback font, and when it doesn't the page is
      // taller — same page, different screenshot height. Abort the font
      // CDN so every run uses the same fallback.
      await page.route(/typenetwork\.com/, (route) => route.abort());

      // Elementor's sticky-header JS flips the top section to
      // position:fixed once the user scrolls — converting it back to
      // relative afterwards adds ~111px to the document height depending
      // on that race, which broke full-page determinism. Inject a style
      // straight into the HTML so the header is in normal flow from the
      // very first paint, and hide the cookie banner the same way.
      await page.route('**/*', async (route) => {
        if (route.request().resourceType() !== 'document') return route.continue();
        try {
          const response = await route.fetch();
          if (!response.ok()) {
            return route.fulfill({ response });
          }
          let html = await response.text();
          const inject = `<style id="vr-defs">
          header, .site-header, .elementor-top-section, .elementor-location-header,
          [data-elementor-type="header"], .elementor-sticky, .elementor-sticky--active, [id*="header"] {
            position: relative !important;
            top: auto !important;
            bottom: auto !important;
            left: auto !important;
            right: auto !important;
            inset: auto !important;
            transform: none !important;
          }
          .elementor-sticky__spacer { display: none !important; height: 0 !important; }
          #cm, #cm-ov, #cc--main, #s-cnt, #cs, #cs-ov,
          .cmplz-cookiebanner, [id^="cmplz"],
          #CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay,
          #onetrust-banner-sdk, #onetrust-consent-sdk {
            display: none !important;
            visibility: hidden !important;
          }
          html, body { scroll-behavior: auto !important; }
        </style>`;
          html = html.replace(/<head([^>]*)>/i, (m) => `${m}${inject}`);
          return route.fulfill({ response, body: html, contentType: 'text/html' });
        } catch {
          return route.continue().catch(() => {});
        }
      });

      let response;
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await page.goto(pageUnderTest.path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
          if (attempt < 2) {
            await page.waitForTimeout(2000).catch(() => {});
            // Re-register document route after a failed navigation attempt.
            await page.route(/typenetwork\.com/, (route) => route.abort()).catch(() => {});
            await page.route('**/*', async (route) => {
              if (route.request().resourceType() !== 'document') return route.continue();
              try {
                const res = await route.fetch();
                if (!res.ok()) {
                  return route.fulfill({ response: res });
                }
                let html = await res.text();
                const inject = `<style id="vr-defs">
          header, .site-header, .elementor-top-section, .elementor-location-header,
          [data-elementor-type="header"], .elementor-sticky, .elementor-sticky--active, [id*="header"] {
            position: relative !important;
            top: auto !important;
            bottom: auto !important;
            left: auto !important;
            right: auto !important;
            inset: auto !important;
            transform: none !important;
          }
          .elementor-sticky__spacer { display: none !important; height: 0 !important; }
          #cm, #cm-ov, #cc--main, #s-cnt, #cs, #cs-ov,
          .cmplz-cookiebanner, [id^="cmplz"],
          #CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay,
          #onetrust-banner-sdk, #onetrust-consent-sdk {
            display: none !important;
            visibility: hidden !important;
          }
          html, body { scroll-behavior: auto !important; }
        </style>`;
                html = html.replace(/<head([^>]*)>/i, (m) => `${m}${inject}`);
                return route.fulfill({ response: res, body: html, contentType: 'text/html' });
              } catch {
                return route.continue().catch(() => {});
              }
            }).catch(() => {});
            continue;
          }
        }
      }
      if (lastError) {
        // Last-resort fallback: if the page is partially usable, proceed to screenshot/stabilization.
        if (!page.url() || page.url() === 'about:blank') {
          await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
          throw lastError;
        }
      }

      // Enter credentials if a sign-in popup/form appears; otherwise continue
      await handleSignInIfNeeded(page);

      // Do not take/compare screenshots for unauthorized pages (e.g. HTTP 401 basic auth failures).
      const status = response?.status();
      if (status === 401 || status === 403) {
        throw new Error(
          `Received HTTP ${status} for ${pageUnderTest.path}. ` +
            'Sign-in/authentication did not succeed, so screenshot comparison was skipped. ' +
            'Verify DEV_USERNAME/DEV_PASSWORD and httpCredentials configuration.'
        );
      }

      const pageTitle = (await page.title().catch(() => '')).trim();
      const headingText = await page
        .locator('h1, h2')
        .first()
        .innerText()
        .catch(() => '');
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const authFailurePattern = /\b401\b|authorization required|access denied|unauthorized access/i;
      const isLikelyAuthFailurePage =
        /\b401\b|authorization required/i.test(pageTitle) ||
        /\b401\b|authorization required|access denied/i.test(headingText) ||
        (/unauthorized/i.test(bodyText) && bodyText.trim().length < 500);

      if (isLikelyAuthFailurePage && authFailurePattern.test(`${pageTitle}\n${headingText}\n${bodyText}`)) {
        throw new Error(
          `Unauthorized/access-denied page detected for ${pageUnderTest.path}. ` +
            'Sign-in/authentication did not succeed, so screenshot comparison was skipped.'
        );
      }

      // Simulate a real visitor: scroll gradually to trigger lazy-loaded images
      // Do this before cookie handling/stabilization to avoid scroll-state races.
      await triggerLazyImages(page);

      // Accept/hide cookie banners so they don't appear in the screenshot
      await acceptCookieBanner(page);

      // Turn off sliders and snap them to the first slide so the leadspace
      // renders a deterministic first-image frame.
      await pauseSliders(page);

      // Pin headers into normal flow at the top and clear fixed/overlay elements
      // so the full-page capture is deterministic and starts from the top.
      await stabilizePageForScreenshot(page);

      // Slider/cookie/header scripts may mutate layout after stabilization.
      await acceptCookieBanner(page);
      await pauseSliders(page);
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        if (document.body) document.body.scrollTop = 0;
      });

      await expect(page).toHaveScreenshot(`${pageUnderTest.name}-full.png`, {
        fullPage: true,
        // Vimeo embeds / video players are async and change frame to
        // frame — mask them so the diff only catches real page changes.
        mask: [
          page.locator('iframe[src*="vimeo" i]'),
          page.locator('iframe[src*="player.vimeo"]'),
          page.locator('iframe[srcdoc*="vimeo" i]'),
          page.locator('[class*="vimeo" i]'),
          page.locator('.elementor-widget-video'),
          page.locator('video'),
          ...(pageUnderTest.name === 'foodservice'
            ? [page.locator('.hero.foodservice')]
            : []),
        ],
      });
    });
  }
});

