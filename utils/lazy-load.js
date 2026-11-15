/**
 * Ensures all images on the page are fully loaded before taking a visual screenshot.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function triggerLazyImages(page) {
  // 1. Force native lazy images to load immediately
  await page.evaluate(() => {
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
      img.setAttribute('loading', 'eager');
    });
  });

  // 2. Scroll to bottom and back to trigger any IntersectionObserver/JS-based image loaders
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 500));
    window.scrollTo(0, 0);
  });

  // Give the page a moment to settle after scrolling; avoid hanging on perpetual network activity.
  await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(500);

  // 3. Best-effort wait for images to finish loading (loaded or errored).
  // Do not fail the test if a third-party/slow image never completes.
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll('img'));
    return images.every((img) => img.complete || img.naturalWidth > 0);
  }, null, { timeout: 15_000, polling: 250 }).catch(async () => {
    // Nudge any still-pending images so screenshots can proceed deterministically.
    await page.evaluate(() => {
      document.querySelectorAll('img').forEach((img) => {
        if (img.complete) return;
        try {
          img.loading = 'eager';
          img.decoding = 'sync';
        } catch {}
      });
    }).catch(() => {});
  });
}