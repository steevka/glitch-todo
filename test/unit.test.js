'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../walmart-watcher.user.js');
const { productPage, blockedPage } = require('./fixtures');

const S = Core.normalizeSettings({ maxPrice: 500 });
const URL_OB = 'https://www.walmart.com/ip/18235967161?conditionGroupCode=3&sid=6EDC027A';

function run(html, settings = S, url = URL_OB, status = 200) {
  const res = Core.analyze(html, { url, status });
  return { res, ev: Core.evaluate(res, settings) };
}

test('URL helpers', () => {
  assert.equal(Core.itemIdFromUrl(URL_OB), '18235967161');
  assert.equal(Core.itemIdFromUrl('https://www.walmart.com/ip/Sony-PlayStation-5-Pro-Console/18235967161'), '18235967161');
  assert.equal(Core.itemIdFromUrl('https://www.walmart.com/ip/seort/Sony-PS5/123456?x=1'), '123456');
  assert.equal(Core.itemIdFromUrl('https://www.walmart.com/search?q=ps5'), null);
  assert.equal(Core.itemIdFromUrl('https://www.walmart.com/blocked?url=abc'), null);
  assert.equal(Core.canonicalUrl(URL_OB), 'https://www.walmart.com/ip/18235967161?conditionGroupCode=3');
  assert.equal(Core.canonicalUrl('https://www.walmart.com/ip/1234567?athbdg=L1600'), 'https://www.walmart.com/ip/1234567');
});

test('parseMoney', () => {
  assert.equal(Core.parseMoney('$1,394.00'), 1394);
  assert.equal(Core.parseMoney('Now $477.04'), 477.04);
  assert.equal(Core.parseMoney(477.04), 477.04);
  assert.equal(Core.parseMoney('$477.04/ea 1'), 477.04);
  assert.equal(Core.parseMoney(''), null);
  assert.equal(Core.parseMoney('free'), null);
  assert.equal(Core.parseMoney(null), null);
});

test('in stock open box at $477.04 is a deal', () => {
  const { res, ev } = run(productPage());
  assert.deepEqual(res.sources, ['next-data', 'json-ld']);
  assert.equal(res.name, 'Sony PlayStation 5 Pro Console');
  assert.equal(ev.status, 'deal');
  assert.equal(ev.deal, true);
  assert.equal(ev.best.price, 477.04);
  assert.match(ev.summary, /IN STOCK at \$477\.04/);
});

test('out of stock is not a deal, and carousel items are ignored', () => {
  const { ev } = run(productPage({ status: 'OUT_OF_STOCK' }));
  assert.equal(ev.status, 'out-of-stock');
  assert.equal(ev.deal, false);
  assert.match(ev.summary, /Out of stock \(listed \$477\.04\)/);
});

test('in stock but over max price', () => {
  const { ev } = run(productPage({ price: 749.99 }));
  assert.equal(ev.status, 'in-stock-filtered');
  assert.match(ev.summary, /above your \$500\.00 max/);
});

test('exactly at max price counts', () => {
  assert.equal(run(productPage({ price: 500 })).ev.deal, true);
});

test('below min price is ignored (junk/accessory protection)', () => {
  const { ev } = run(productPage({ price: 19.99 }));
  assert.equal(ev.deal, false);
  assert.match(ev.summary, /below your \$100\.00 minimum/);
});

test('third-party seller is skipped when Walmart-only is on', () => {
  const html = productPage({ seller: 'GameDealz LLC' });
  assert.equal(run(html).ev.deal, false);
  assert.match(run(html).ev.summary, /sold by GameDealz LLC, not Walmart/);
  const loose = Core.normalizeSettings({ maxPrice: 500, requireWalmartSeller: false });
  assert.equal(run(html, loose).ev.deal, true);
});

test('require open box setting', () => {
  const strict = Core.normalizeSettings({ maxPrice: 500, requireOpenBox: true });
  assert.equal(run(productPage({ condition: 'Open box' }), strict).ev.deal, true);
  // JSON-LD says UsedCondition, next-data says New -> no open box anywhere
  assert.equal(run(productPage({ condition: 'New' }), strict).ev.deal, false);
});

test('LIMITED_STOCK counts as available', () => {
  assert.equal(run(productPage({ status: 'LIMITED_STOCK' })).ev.deal, true);
});

test('JSON-LD alone is enough (Next data missing)', () => {
  const { res, ev } = run(productPage({ next: false }));
  assert.deepEqual(res.sources, ['json-ld']);
  assert.equal(ev.deal, true);
  const oos = run(productPage({ next: false, status: 'OUT_OF_STOCK' }));
  assert.equal(oos.ev.status, 'out-of-stock');
});

test('Next data alone is enough (JSON-LD missing)', () => {
  const { res, ev } = run(productPage({ ld: false }));
  assert.deepEqual(res.sources, ['next-data']);
  assert.equal(ev.deal, true);
});

test('Next data in an unexpected place is found by item id, carousel not', () => {
  const product = {
    usItemId: '18235967161',
    name: 'Sony PlayStation 5 Pro Console',
    availabilityStatus: 'IN_STOCK',
    sellerName: 'Walmart.com',
    priceInfo: { currentPrice: { price: 480 } },
  };
  const nextOverride = {
    props: { pageProps: { somethingNew: { blocks: [{ other: { usItemId: '999', availabilityStatus: 'IN_STOCK', priceInfo: { currentPrice: { price: 399 } } } }, { product }] } } },
  };
  const { res, ev } = run(productPage({ ld: false, nextOverride }));
  assert.equal(ev.deal, true);
  assert.equal(ev.best.price, 480);
  // Wrong item id -> must not pick up the carousel's $399 in-stock product
  const r2 = Core.analyze(productPage({ ld: false, nextOverride }), { url: 'https://www.walmart.com/ip/5555555' });
  assert.equal(Core.evaluate(r2, S).deal, false);
  assert.equal(res.itemId, '18235967161');
});

test('nested open-box offer inside the product is detected', () => {
  const html = productPage({
    ld: false,
    price: 749,
    condition: 'New',
    extraProductFields: {
      otherOffers: [
        { offerId: 'a', priceInfo: { currentPrice: { price: 699 } }, availabilityStatus: 'IN_STOCK', condition: { name: 'Restored' } },
        { offerId: 'b', priceInfo: { currentPrice: { price: 477.04 } }, availabilityStatus: 'IN_STOCK', condition: { name: 'Open Box' }, sellerName: 'Walmart.com' },
      ],
    },
  });
  const { ev } = run(html);
  assert.equal(ev.deal, true);
  assert.equal(ev.best.price, 477.04);
  assert.equal(ev.best.source, 'next-data:open-box-offer');
});

test('conflicting sources: any source seeing a deal alerts', () => {
  const html = productPage({ status: 'OUT_OF_STOCK', ldAvailability: 'https://schema.org/InStock' });
  assert.equal(run(html).ev.deal, true);
});

test('bot-check page is detected', () => {
  assert.equal(run(blockedPage()).ev.status, 'blocked');
  assert.equal(run('<html></html>', S, 'https://www.walmart.com/blocked?url=Lw==').ev.status, 'blocked');
  assert.equal(run('<html>nothing</html>', S, URL_OB, 429).ev.status, 'blocked');
});

test('a product page that mentions px-captcha somewhere is NOT blocked', () => {
  const html = productPage().replace('</body>', '<script>window.pxcfg={"id":"px-captcha"}</script></body>');
  assert.equal(run(html).ev.status, 'deal');
});

test('garbage page is unknown, not a false alarm', () => {
  assert.equal(run('<html><body>hello</body></html>').ev.status, 'unknown');
  assert.equal(run('<script id="__NEXT_DATA__">{broken</script>').ev.status, 'unknown');
  const r = Core.analyze('<script id="__NEXT_DATA__">{broken</script>', { url: URL_OB });
  assert.ok(r.notes.some((n) => /not valid JSON/.test(n)));
});

test('microdata fallback', () => {
  const html = '<div itemprop="offers"><meta itemprop="price" content="477.04"><link itemprop="availability" href="https://schema.org/InStock"></div>';
  const { res, ev } = run(html);
  assert.deepEqual(res.sources, ['microdata']);
  assert.equal(ev.deal, true);
});

test('debug report includes the product shape', () => {
  const r = Core.analyze(productPage(), { url: URL_OB, debug: true });
  assert.equal(r.debug.nextDataPath, 'props.pageProps.initialData.data.product');
  assert.ok(r.debug.productShape.priceInfo);
  assert.ok(r.debug.jsonLd);
});

test('settings are clamped and sanitized', () => {
  const s = Core.normalizeSettings({
    peakMinSec: 1,
    peakMaxSec: 0,
    offMinSec: 'abc',
    pushoverUser: 'bad key!',
    pushoverToken: ' ' + 'k'.repeat(30) + ' ',
    mode: 'weird',
    maxPrice: '450',
    minPrice: 9999,
    heartbeatHour: 99,
  });
  assert.equal(s.peakMinSec, 5);
  assert.equal(s.peakMaxSec, 5);
  assert.equal(s.offMinSec, 45);
  assert.equal(s.pushoverUser, '');
  assert.equal(s.pushoverToken, 'k'.repeat(30), 'keys are trimmed');
  assert.equal(s.mode, 'background');
  assert.equal(s.maxPrice, 450);
  assert.equal(s.minPrice, 450);
  assert.equal(s.heartbeatHour, 23);
  assert.equal(Core.normalizeSettings({ pushoverToken: 'too-short' }).pushoverToken, '');
});

test('time windows in Pacific time, including wrap-around', () => {
  // 2026-09-26 16:00Z = 09:00 PDT
  const nineAm = new Date('2026-09-26T16:00:00Z');
  assert.equal(Core.timeParts(nineAm).hour, 9);
  assert.equal(Core.timeParts(nineAm).dateKey, '2026-09-26');
  // 2026-12-01 16:00Z = 08:00 PST (DST handled)
  assert.equal(Core.timeParts(new Date('2026-12-01T16:00:00Z')).hour, 8);
  assert.equal(Core.inWindow(600, 420, 780), true);
  assert.equal(Core.inWindow(800, 420, 780), false);
  assert.equal(Core.inWindow(30, 1320, 120), true); // 22:00-02:00 wraps
  assert.equal(Core.inWindow(600, 1320, 120), false);
  assert.equal(Core.inWindow(0, 0, 0), true);
});

test('delays: fast hours, slow hours, jitter range, error backoff', () => {
  const s = Core.normalizeSettings({});
  const peak = new Date('2026-09-26T17:00:00Z'); // 10:00 PT
  const off = new Date('2026-09-27T06:00:00Z'); // 23:00 PT
  assert.equal(Core.nextDelayMs(s, peak, 0, () => 0).ms, 15000);
  assert.equal(Core.nextDelayMs(s, peak, 0, () => 0.999999).ms, 25000);
  assert.equal(Core.nextDelayMs(s, peak).peak, true);
  assert.equal(Core.nextDelayMs(s, off, 0, () => 0).ms, 45000);
  assert.equal(Core.nextDelayMs(s, off).peak, false);
  assert.equal(Core.nextDelayMs(s, peak, 1, () => 0).ms, 30000);
  assert.equal(Core.nextDelayMs(s, peak, 3, () => 0).ms, 120000);
  assert.equal(Core.nextDelayMs(s, off, 20, () => 0).ms, 15 * 60 * 1000); // capped
  for (let i = 0; i < 200; i++) {
    const ms = Core.nextDelayMs(s, peak).ms;
    assert.ok(ms >= 15000 && ms <= 25000, String(ms));
  }
});

test('dealKey distinguishes offers', () => {
  assert.notEqual(Core.dealKey({ price: 477, seller: 'Walmart.com' }), Core.dealKey({ price: 480, seller: 'Walmart.com' }));
  assert.equal(Core.dealKey(null), '');
});

// ---------- history ----------
const T0 = Date.parse('2026-09-26T17:00:00Z'); // 10:00 PT
const MIN = 60000;
const offerAt = (price, seller = 'Walmart.com') => ({ price, seller, condition: 'Open box' });

function replay(steps, start = null) {
  let h = start;
  for (const [t, status, offer, summary] of steps) {
    h = Core.recordCheck(h, { at: T0 + t, status, offer, summary, gapMs: 5 * MIN });
  }
  return h;
}

test('history: a deal sighting opens, stays open, and closes when out of stock', () => {
  const h = replay([
    [0, 'out-of-stock'],
    [0.3 * MIN, 'deal', offerAt(477.04)],
    [0.6 * MIN, 'deal', offerAt(477.04)],
    [1 * MIN, 'out-of-stock'],
    [1.3 * MIN, 'out-of-stock'],
  ]);
  assert.equal(h.sightings.length, 1);
  const x = h.sightings[0];
  assert.equal(x.price, 477.04);
  assert.equal(x.matched, true);
  assert.equal(x.checks, 2);
  assert.equal(x.start, T0 + 0.3 * MIN);
  assert.equal(x.lastSeen, T0 + 0.6 * MIN);
  assert.equal(x.end, T0 + 1 * MIN);
  const day = h.days['2026-09-26'];
  assert.equal(day.checks, 5);
  assert.equal(day.inStock, 2);
  assert.equal(h.since, T0);
});

test('history: skipped sightings are recorded with the reason', () => {
  const h = replay([[0, 'in-stock-filtered', offerAt(749.99), 'In stock but skipped: $749.99 is above your $500.00 max']]);
  assert.equal(h.sightings.length, 1);
  assert.equal(h.sightings[0].matched, false);
  assert.equal(h.sightings[0].note, '$749.99 is above your $500.00 max');
});

test('history: a new price or seller starts a new sighting', () => {
  const h = replay([
    [0, 'deal', offerAt(477.04)],
    [1 * MIN, 'deal', offerAt(455)],
    [2 * MIN, 'in-stock-filtered', offerAt(455, 'Reseller'), 'skipped'],
  ]);
  assert.equal(h.sightings.length, 3);
  assert.equal(h.sightings[0].end, T0 + 1 * MIN);
  assert.equal(h.sightings[1].end, T0 + 2 * MIN);
  assert.equal(h.sightings[2].end, null);
});

test('history: errors, bot checks and unreadable pages do not close a sighting', () => {
  const h = replay([
    [0, 'deal', offerAt(477.04)],
    [1 * MIN, 'error'],
    [2 * MIN, 'blocked'],
    [3 * MIN, 'unknown'],
  ]);
  assert.equal(h.sightings[0].end, null);
  const d = h.days['2026-09-26'];
  assert.deepEqual([d.errors, d.blocks, d.unknown], [1, 1, 1]);
});

test('history: gaps are recorded, but not after an intentional pause', () => {
  let h = replay([
    [0, 'out-of-stock'],
    [1 * MIN, 'out-of-stock'],
    [61 * MIN, 'out-of-stock'], // an hour of silence: Mac asleep
  ]);
  assert.equal(h.gaps.length, 1);
  assert.deepEqual(h.gaps[0], { from: T0 + 1 * MIN, to: T0 + 61 * MIN });
  h = Core.markResumed(h);
  h = replay([[200 * MIN, 'out-of-stock']], h);
  assert.equal(h.gaps.length, 1, 'no gap after markResumed');
});

test('history: gap threshold allows error backoff', () => {
  const s = Core.normalizeSettings({});
  assert.equal(Core.gapThresholdMs(s, 0), 5 * MIN);
  assert.equal(Core.gapThresholdMs(s, 3), 16 * MIN);
  assert.equal(Core.gapThresholdMs(Core.normalizeSettings({ offMinSec: 300, offMaxSec: 600 }), 0), 40 * MIN);
});

test('history: days roll over at Pacific midnight and are capped', () => {
  const lateNight = Date.parse('2026-09-27T06:59:00Z'); // 23:59 PT Sep 26
  let h = Core.recordCheck(null, { at: lateNight, status: 'out-of-stock' });
  h = Core.recordCheck(h, { at: lateNight + 2 * MIN, status: 'out-of-stock' });
  assert.deepEqual(Object.keys(h.days).sort(), ['2026-09-26', '2026-09-27']);
  let big = null;
  for (let i = 0; i < 100; i++) big = Core.recordCheck(big, { at: T0 + i * 86400000, status: 'out-of-stock' });
  assert.equal(Object.keys(big.days).length, 90);
});

test('history: sightings list is capped', () => {
  let h = null;
  for (let i = 0; i < 250; i++) {
    h = Core.recordCheck(h, { at: T0 + i * 2 * MIN, status: 'deal', offer: offerAt(400 + i) });
  }
  assert.equal(h.sightings.length, 200);
  assert.equal(h.sightings[199].price, 649);
});

test('history: updateLatestSighting and summary', () => {
  let h = replay([
    [0, 'in-stock-filtered', offerAt(749.99), 'over max'],
    [1 * MIN, 'out-of-stock'],
    [2 * MIN, 'deal', offerAt(477.04)],
  ]);
  h = Core.updateLatestSighting(h, { alerted: true, response: 'none' });
  assert.equal(h.sightings[1].alerted, true);
  assert.equal(h.sightings[0].alerted, false, 'only the latest is touched');
  const sum = Core.historySummary(h, T0 + 1.5 * MIN);
  assert.equal(sum.sightings.length, 1);
  assert.equal(sum.matched.length, 1);
  assert.deepEqual(Core.updateLatestSighting(null, { a: 1 }).sightings, []);
});

test('history: input is not mutated', () => {
  const h1 = replay([[0, 'deal', offerAt(477.04)]]);
  const snapshot = JSON.stringify(h1);
  Core.recordCheck(h1, { at: T0 + MIN, status: 'out-of-stock' });
  Core.updateLatestSighting(h1, { alerted: true });
  assert.equal(JSON.stringify(h1), snapshot);
});

test('health check URL: https only, trimmed, blank otherwise', () => {
  const url = 'https://hc-ping.com/0f3c9a1e-1234-4bcd-9ef0-123456789abc';
  assert.equal(Core.normalizeSettings({ healthcheckUrl: '  ' + url + ' ' }).healthcheckUrl, url);
  assert.equal(Core.normalizeSettings({ healthcheckUrl: 'http://hc-ping.com/abc' }).healthcheckUrl, '');
  assert.equal(Core.normalizeSettings({ healthcheckUrl: 'not a url' }).healthcheckUrl, '');
  assert.equal(Core.normalizeSettings({}).healthcheckUrl, '');
});
