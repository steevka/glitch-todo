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
    ntfyTopic: 'bad topic!',
    ntfyServer: 'javascript:alert(1)',
    mode: 'weird',
    maxPrice: '450',
    minPrice: 9999,
    heartbeatHour: 99,
  });
  assert.equal(s.peakMinSec, 5);
  assert.equal(s.peakMaxSec, 5);
  assert.equal(s.offMinSec, 45);
  assert.equal(s.ntfyTopic, '');
  assert.equal(s.ntfyServer, 'https://ntfy.sh');
  assert.equal(s.mode, 'background');
  assert.equal(s.maxPrice, 450);
  assert.equal(s.minPrice, 450);
  assert.equal(s.heartbeatHour, 23);
  assert.equal(Core.normalizeSettings({ ntfyServer: 'https://my.ntfy.example/' }).ntfyServer, 'https://my.ntfy.example');
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
