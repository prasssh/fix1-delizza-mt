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
 * Accept the Complianz cookie banner so it doesn't appear in screenshots.
 * The banner is dismissed by clicking the "Accept" button.
 */
async function acceptCookieBanner(page) {
  const acceptButton = page.locator('.cmplz-accept, .cmplz-cookiebanner-container .cmplz-accept, [class*="cmplz"] button:has-text("Accept")');
  if (await acceptButton.count()) {
    await acceptButton.first().click({ timeout: 5000 }).catch(() => {
      // If the banner doesn't appear or can't be dismissed, continue anyway
    });
  }
}

test.describe('Visual regression', () => {
  test.setTimeout(90_000);
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
          .elementor-top-section, [id*="header"], .elementor-sticky, .elementor-sticky--active, .cmplz-cookiebanner, [id^="cmplz"] {
            position: relative !important; top: auto !important; bottom: auto !important;
          }
          .elementor-top-section, [id*="header"], .elementor-sticky, .elementor-sticky--active { display: block; }
          .cmplz-cookiebanner, [id^="cmplz"] { display: none !important; }
          /* Elementor inserts a header-sized spacer clone when the sticky JS
             initialises. With the header forced into normal flow that spacer
             would double the header height (+127px) on some runs. */
          .elementor-sticky__spacer { display: none !important; }
        </style>`;
          html = html.replace(/<head([^>]*)>/i, (m) => `${m}${inject}`);
          return route.fulfill({ response, body: html, contentType: 'text/html' });
        } catch {
          return route.continue().catch(() => {});
        }
      });

      let response;
      let lastError;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await page.goto(pageUnderTest.path, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
          if (attempt === 0) {
            await page.waitForTimeout(1500).catch(() => {});
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
          .elementor-top-section, [id*="header"], .elementor-sticky, .elementor-sticky--active, .cmplz-cookiebanner, [id^="cmplz"] {
            position: relative !important; top: auto !important; bottom: auto !important;
          }
          .elementor-top-section, [id*="header"], .elementor-sticky, .elementor-sticky--active { display: block; }
          .cmplz-cookiebanner, [id^="cmplz"] { display: none !important; }
          .elementor-sticky__spacer { display: none !important; }
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
        await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
        throw lastError;
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

      // Accept the cookie banner so it doesn't appear in the screenshot
      await acceptCookieBanner(page);

      // Simulate a real visitor: scroll gradually to trigger lazy-loaded images
      await triggerLazyImages(page);

      // Turn off sliders and snap them to the first slide so the leadspace
      // renders a deterministic first-image frame (no purple masking).
      await pauseSliders(page);

      // Pin the sticky header to the top only and clear leftover fixed
      // elements so the full-page capture has no extra space at the bottom
      await stabilizePageForScreenshot(page);

      // Slider JS may kick back in after stabilization; re-pause + reset
      await pauseSliders(page);
      await page.waitForTimeout(300);

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
        ],
      });
    });
  }
});

