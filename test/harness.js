'use strict';
// Test harness: runs the real userscript in Chromium against a fake walmart.com.
// Tampermonkey's GM_* functions are replaced by small shims that record what
// the script does (phone pushes, notifications, opened tabs).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { productPage, blockedPage } = require('./fixtures');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'walmart-watcher.user.js'), 'utf8');
const ITEM = 'https://www.walmart.com/ip/18235967161?conditionGroupCode=3&sid=6EDC027A-3EF0';
const CANON = 'https://www.walmart.com/ip/18235967161?conditionGroupCode=3';

// Fast settings so the test doesn't wait 20 seconds per check.
const FAST = {
  peakStart: '00:00',
  peakEnd: '00:00', // all day = fast hours
  peakMinSec: 0.4,
  peakMaxSec: 0.6,
  offMinSec: 0.4,
  offMaxSec: 0.6,
  pushoverUser: 'u' + 'A'.repeat(29),
  pushoverToken: 'a' + 'B'.repeat(29),
  heartbeatHour: -1,
};

function gmShim(settings) {
  return `(() => {
    if (location.hostname !== 'www.walmart.com') return;
    window.__WW_TEST_FAST__ = true;
    const P = '__gm:';
    const listeners = [];
    let lid = 0;
    const read = (raw) => (raw === null || raw === undefined ? undefined : JSON.parse(raw));
    if (!localStorage.getItem(P + 'settings')) localStorage.setItem(P + 'settings', ${JSON.stringify(JSON.stringify(settings))});
    window.GM_getValue = (k, d) => { const v = read(localStorage.getItem(P + k)); return v === undefined ? d : v; };
    window.GM_setValue = (k, v) => {
      const old = read(localStorage.getItem(P + k));
      localStorage.setItem(P + k, JSON.stringify(v === undefined ? null : v));
      for (const l of listeners) if (l.k === k) l.fn(k, old, v, false);
    };
    window.addEventListener('storage', (e) => {
      if (!e.key || !e.key.startsWith(P)) return;
      const k = e.key.slice(P.length);
      for (const l of listeners) if (l.k === k) l.fn(k, read(e.oldValue), read(e.newValue), true);
    });
    window.GM_addValueChangeListener = (k, fn) => { listeners.push({ k, fn, id: ++lid }); return lid; };
    window.GM_removeValueChangeListener = (id) => { const i = listeners.findIndex((l) => l.id === id); if (i >= 0) listeners.splice(i, 1); };
    window.GM_xmlhttpRequest = (d) => {
      const body = Object.fromEntries(new URLSearchParams(d.data));
      for (const k of ['priority', 'retry', 'expire']) if (k in body) body[k] = Number(body[k]);
      window.__wwRecord('push', { url: d.url, body }).then(() => d.onload({ status: 200, responseText: '{"status":1}' }));
    };
    window.GM_notification = (d) => { window.__wwRecord('notify', { title: d.title, text: d.text }); };
    window.GM_openInTab = (u) => { window.__wwRecord('openTab', { url: u }); };
  })();`;
}

async function setup(settings = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const events = [];
  const requests = [];
  const site = { kind: 'oos', fetchKind: null, price: null };

  await context.exposeBinding('__wwRecord', ({ page }, type, data) => {
    events.push({ type, data, page });
    // Like Tampermonkey, open tabs from the extension side (no opener).
    if (type === 'openTab') context.newPage().then((p) => p.goto(data.url)).catch(() => {});
  });
  await context.addInitScript(
    gmShim(Object.assign({}, FAST, settings)) +
      `\nif (location.hostname === 'www.walmart.com') document.addEventListener('DOMContentLoaded', () => { ${SCRIPT}\n });`
  );
  await context.route('https://www.walmart.com/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const type = req.resourceType();
    let pg = null;
    try {
      pg = req.frame().page();
    } catch (e) {
      /* navigation in a brand-new popup: no frame yet */
    }
    requests.push({ url: req.url(), type, page: pg, t: Date.now() });
    if (url.pathname.startsWith('/blocked')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: blockedPage() });
    }
    if (!url.pathname.startsWith('/ip/')) return route.fulfill({ status: 404, body: 'nope' });
    const kind = type === 'fetch' && site.fetchKind ? site.fetchKind : site.kind;
    if (kind === 'redirect-blocked') {
      // Playwright can't intercept redirect hops, so fetches get the bot page
      // directly and page loads are sent on with a script.
      if (type === 'fetch') return route.fulfill({ status: 200, contentType: 'text/html', body: blockedPage() });
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<script>location.replace('/blocked?url=${encodeURIComponent(url.pathname)}')</script>`,
      });
    }
    const pages = {
      oos: () => productPage({ status: 'OUT_OF_STOCK' }),
      deal: () => productPage({ price: site.price || 477.04 }),
      over: () => productPage({ price: 749.99 }),
      blocked: () => blockedPage(),
      garbage: () => '<html><body>Something went wrong</body></html>',
    };
    return route.fulfill({ status: 200, contentType: 'text/html', body: pages[kind]() });
  });

  context.on('page', (p) => p.on('pageerror', (e) => events.push({ type: 'pageerror', data: String(e) })));
  const page = await context.newPage();
  const helpers = {
    browser,
    context,
    page,
    events,
    requests,
    site,
    pushes: (pred = () => true) => events.filter((e) => e.type === 'push' && pred(e.data.body)),
    fetches: (p) => requests.filter((r) => r.type === 'fetch' && (!p || r.page === p)),
    docs: (p) => requests.filter((r) => r.type === 'document' && (!p || r.page === p)),
    panelText: (p = page) => p.locator('#walmart-restock-watcher .ww').innerText(),
    async waitFor(fn, ms = 8000, label = 'condition') {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('timed out waiting for ' + label);
    },
    close: () => browser.close(),
  };
  return helpers;
}

module.exports = { setup, ITEM, CANON };
