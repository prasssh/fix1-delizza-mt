/**
 * Disable sliders and snap them to the first slide so the leadspace
 * renders a deterministic first-image frame. Selector for the first
 * slider image: `.elementor-slides-wrapper .swiper-slide:not(.swiper-slide-duplicate)`
 * (first match in DOM), whose background lives on its `.swiper-slide-bg`
 * child — equivalently `.elementor-slides-wrapper .swiper-slide-active
 * .swiper-slide-bg` once the slider has been parked on slide one.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function pauseSliders(page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('.swiper, .swiper-container')) {
      const swiper = element.swiper || element.querySelector('.swiper')?.swiper;
      if (!swiper) continue;

      swiper.autoplay?.stop();
      // Neutralise autoplay both in the live params object and by
      // replacing the param, so Elementor's frontend can't restart the
      // timer from either place.
      if (swiper.params) {
        if (swiper.params.autoplay && typeof swiper.params.autoplay === 'object') {
          swiper.params.autoplay.enabled = false;
        }
        swiper.params.autoplay = false;
      }
      swiper.allowTouchMove = false;
      swiper.setTransition?.(0);
      swiper.wrapperEl?.style.setProperty('transition-duration', '0ms');

      // Snap back to the first slide so the screenshot is deterministic.
      try {
        if (swiper.params?.loop) {
          swiper.slideToLoop(0, 0);
        } else {
          swiper.slideTo(0, 0);
        }
      } catch {
        // Some widget variants don't expose slideTo — the autoplay stop
        // above is enough to keep whatever frame is showing from moving.
      }
    }
  });

  // Some instances need a beat after slideTo to settle on realIndex 0;
  // nudge any that didn't land there back to the first slide. Hidden,
  // zero-size cloned sliders can't slideTo without layout — they're not
  // painted, so their stale index is invisible anyway.
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('.swiper, .swiper-container')) {
      const swiper = element.swiper || element.querySelector('.swiper')?.swiper;
      if (!swiper) continue;
      if (swiper.realIndex === 0) continue;
      if (swiper.el && swiper.el.offsetWidth === 0) continue;
      try {
        if (swiper.params?.loop) {
          swiper.slideToLoop(0, 0);
        } else {
          swiper.slideTo(0, 0);
        }
      } catch {
        /* ignore */
      }
    }
  });

  // One more pass after a paint beat so the first-slide frame has
  // actually been composited before the screenshot is taken.
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('.swiper, .swiper-container')) {
      const swiper = element.swiper || element.querySelector('.swiper')?.swiper;
      if (!swiper) continue;
      if (swiper.realIndex === 0) continue;
      if (swiper.el && swiper.el.offsetWidth === 0) continue;
      try {
        if (swiper.params?.loop) {
          swiper.slideToLoop(0, 0);
        } else {
          swiper.slideTo(0, 0);
        }
      } catch {
        /* ignore */
      }
    }
  });
}

/**
 * A full-page screenshot stitches segments captured as the page (or the
 * expanded viewport) scrolls. Elements with `position: fixed`/`sticky`
 * (the site's header) get repainted at their live viewport position, so
 * they can end up mid-page or repeated in the capture instead of once at
 * the top. Pin them into normal flow at the document top so they appear
 * exactly once, stuck to the top of the screenshot.
 *
 * It also hides cookie-consent leftovers and off-canvas overlays, so nothing
 * fixed floats across the page, and then scrolls back to the top of the
 * document so the full-page capture starts from a clean origin.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function stabilizePageForScreenshot(page) {
  // Some sticky/fixed headers and UI state are only applied after scroll.
  // Scroll through the page once to activate them, then return to top.
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 300));
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 150));
  });

  await page.evaluate(() => {
    const cookieSelectors = [
      '#cm', '#cm-ov', '#cc--main', '#s-cnt', '#cs', '#cs-ov',
      '.cmplz-cookiebanner', '[id^="cmplz"]',
      '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay',
      '#onetrust-banner-sdk', '#onetrust-consent-sdk',
      '[id*="cookie" i][class*="overlay" i]',
    ];
    for (const sel of cookieSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
      });
    }

    // Remove Elementor sticky spacers so forcing header into flow doesn't
    // double the header height.
    document.querySelectorAll('.elementor-sticky__spacer').forEach((el) => {
      el.remove();
    });

    const headerSelectors = [
      'header',
      '.site-header',
      '.elementor-top-section',
      '.elementor-location-header',
      '[data-elementor-type="header"]',
      '.elementor-sticky',
      '.elementor-sticky--active',
      '[id*="header"]',
    ];

    const all = Array.from(document.querySelectorAll('body *'));
    const fixedSticky = all.filter((el) => {
      const cs = getComputedStyle(el);
      return cs.position === 'fixed' || cs.position === 'sticky';
    });

    const isHeaderLike = (el) => headerSelectors.some((sel) => {
      try { return el.matches(sel); } catch { return false; }
    });

    // Hide off-canvas/overlay fixed elements (menus, modals, backdrops) that
    // are not part of the visible page flow. Keep header-like elements so we
    // can pin them into normal flow at the top.
    for (const el of fixedSticky) {
      if (isHeaderLike(el)) continue;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const isHidden = cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') === 0;
      const isLargeOverlay = rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.8;
      const isOffscreen = rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight * 2 || rect.left > window.innerWidth * 2;
      if (isHidden || isLargeOverlay || isOffscreen || rect.width === 0 || rect.height === 0) {
        el.style.setProperty('display', 'none', 'important');
      }
    }

    const headers = [];
    for (const el of all) {
      if (!isHeaderLike(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      headers.push(el);
    }

    // Pin header-like elements into normal flow at the top of the capture.
    for (const el of headers) {
      el.style.setProperty('position', 'relative', 'important');
      el.style.setProperty('top', 'auto', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      el.style.setProperty('left', 'auto', 'important');
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('inset', 'auto', 'important');
      el.style.setProperty('transform', 'none', 'important');
      el.style.setProperty('margin-top', '0px', 'important');
      el.style.setProperty('z-index', 'auto', 'important');
    }

    // If the page reserved space for a fixed header on body/html, remove it so
    // the in-flow header doesn't create a duplicated gap at the top.
    const root = document.documentElement;
    const body = document.body;
    [root, body].forEach((el) => {
      el.style.setProperty('padding-top', '0px', 'important');
      el.style.setProperty('scroll-padding-top', '0px', 'important');
    });

    // Disable smooth scrolling and ensure capture starts from the document top.
    root.style.setProperty('scroll-behavior', 'auto', 'important');
    if (body) body.style.setProperty('scroll-behavior', 'auto', 'important');

    const style = document.createElement('style');
    style.id = 'vr-stabilize';
    style.textContent = `
      html, body { scroll-behavior: auto !important; overflow-anchor: none !important; }
      header, .site-header, .elementor-location-header, [data-elementor-type="header"], .elementor-sticky, .elementor-sticky--active, [id*="header"] {
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
      #onetrust-banner-sdk, #onetrust-consent-sdk { display: none !important; visibility: hidden !important; }
    `;
    document.head.appendChild(style);

    // Force layout/reflow after style changes.
    void document.body.offsetHeight;
    window.scrollTo(0, 0);
    root.scrollTop = 0;
    if (body) body.scrollTop = 0;
  });

  // Wait for layout/images/fonts to settle so full-page stitching is stable.
  await page.evaluate(() => {
    window.__vrLastHeight = -1;
    window.__vrStableCount = 0;
  }).catch(() => {});
  await page.waitForFunction(() => {
    const h = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
    );
    if (h === window.__vrLastHeight) {
      window.__vrStableCount = (window.__vrStableCount || 0) + 1;
      if (window.__vrStableCount >= 6) return true; // ~750ms of stability
    } else {
      window.__vrStableCount = 0;
    }
    window.__vrLastHeight = h;
    return false;
  }, null, { timeout: 10_000, polling: 125 }).catch(() => {});
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  });
}
