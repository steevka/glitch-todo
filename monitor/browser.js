'use strict';
// Checks Amazon product pages in a real headless Chromium (Playwright), logged out,
// with a persistent profile so it looks like one ongoing visitor. Reads the buy box
// the same way the userscript does (Core.parseBuyBox).

const path = require('path');


// Runs inside the page.
function readPage() {
  const txt = (sel) => ((document.querySelector(sel) || {}).innerText || '').trim();
  const priceIn = (root) => {
    if (!root) return null;
    const num = (s) => {
      const m = String(s || '').match(/\d[\d,]*(?:\.\d+)?/);
      return m ? parseFloat(m[0].replace(/,/g, '')) : null;
    };
    const cands = [root.querySelector('.apex-pricetopay-accessibility-label'), ...root.querySelectorAll('.a-price .a-offscreen')];
    for (const el of cands) {
      const p = el && num(el.textContent);
      if (p !== null) return p;
    }
    const whole = root.querySelector('.a-price .a-price-whole');
    if (whole) {
      const frac = (whole.parentElement.querySelector('.a-price-fraction') || {}).textContent || '00';
      return num(whole.textContent.replace(/[^\d,]/g, '') + '.' + frac.replace(/\D/g, ''));
    }
    return null;
  };
  const body = (document.body && document.body.innerText) || '';
  const buyBox = document.querySelector('#buybox, #desktop_buybox');
  return {
    title: txt('#productTitle'),
    price:
      priceIn(document.querySelector('#corePrice_feature_div')) ??
      priceIn(document.querySelector('#corePriceDisplay_desktop_feature_div')) ??
      priceIn(document.querySelector('#apex_desktop')),
    sellerText: txt('#merchantInfoFeature_feature_div') || txt('#merchant-info') || txt('#sellerProfileTriggerId'),
    boxText: buyBox ? buyBox.innerText.trim() : '',
    canBuy: !!document.querySelector('#buy-now-button, #add-to-cart-button'),
    availability: txt('#availability').slice(0, 120),
    captcha: !!document.querySelector('form[action*="validateCaptcha"]') || /Type the characters you see|Enter the characters you see/i.test(body.slice(0, 3000)),
    continueShopping: /continue shopping/i.test(body.slice(0, 1500)) && !document.querySelector('#productTitle'),
    // For pages that aren't a normal product page: what is it?
    debug: document.querySelector('#productTitle') ? '' : `${location.href.slice(0, 120)} | ${document.title.slice(0, 80)} | ${body.replace(/\s+/g, ' ').slice(0, 200)}`,
  };
}

async function createBrowserChecker({ dataDir, log, Core, headless = true, setup = null }) {
  const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
  const profile = path.join(dataDir, 'chrome-profile');
  const opts = {
    headless,
    channel: 'chromium', // full Chromium in new headless mode, not the stripped headless shell
    args: ['--disable-blink-features=AutomationControlled'],
  };
  // Use the browser's own identity (real version and OS, so it matches every other signal
  // it sends), minus the "HeadlessChrome" tag.
  const probe = await chromium.launchPersistentContext(profile, opts);
  const realUA = await (probe.pages()[0] || (await probe.newPage())).evaluate(() => navigator.userAgent);
  await probe.close();
  const ctx = await chromium.launchPersistentContext(profile, {
    ...opts,
    userAgent: realUA.replace(/HeadlessChrome/g, 'Chrome'),
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1440, height: 900 },
  });
  if (setup) await setup(ctx); // tests route Amazon to saved pages
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(30000);

  async function check(asin) {
    const resp = await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500 + Math.random() * 1500);
    let info = await page.evaluate(readPage);
    // Amazon's soft "Continue shopping" interstitial: click through once, like a person would.
    if (info.continueShopping) {
      log('Clicking through the "Continue shopping" page');
      await page.getByRole('button', { name: /continue shopping/i }).click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(2000);
      info = await page.evaluate(readPage);
    }
    const status = resp ? resp.status() : 0;
    const blocked = info.captcha || info.continueShopping || status === 503 || status === 429;
    const box = Core.parseBuyBox(info.sellerText, info.boxText);
    const offers =
      info.price !== null && box.merchant && info.canBuy ? [{ condition: box.condition, seller: box.merchant, price: info.price }] : [];
    return { status, blocked, title: info.title, offers, note: info.debug ? `HTTP ${status} ${info.debug}` : info.availability };
  }

  return { check, close: () => ctx.close() };
}

module.exports = { createBrowserChecker, readPage };
