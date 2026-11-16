'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../amazon-autobuy.user.js');

const S = Core.normalizeSettings({});

// Real alerts from #rtx5080 (Falcodrin Server), 2026-11-15.
const RESALE_ALERT = `Falcodrin Server
APP
 — 9:43 PM
@5080
@Amazon
Name: ASUS ROG Astral GeForce RTX 5080 16GB GDDR7 OC Edition Gaming Graphics Card (Used - Like New)
Condition: Used - Like New
Merchant: Amazon Resale
Price: $1536.94
Current Price: $1536.94
Price as of: 11/15/2026 18:43:23
Product Link

As an Amazon Associate I earn from qualifying purchases.`;

const NEW_ALERT = `@5080
@Amazon
Name: ASUS TUF Gaming GeForce RTX 5080 16GB GDDR7 OC Edition Graphics Card (New)
Condition: New
Merchant: Amazon.com
Price: $1599.99
Current Price: $1599.99
Price as of: 11/15/2026 18:55:07
Product Link`;

const MSI_STORE_ALERT = `@5080
Drop Detected
Store: MSI
Product Category: 5080
All products link: https://us-store.msi.com/search?search=5080&limit=100
GeForce RTX 5080 16G SUPRIM DRACO EPIC EDITION ($1,799.99): https://us-store.msi.com/GeForce-RTX-5080-16G-SUPRIM-DRACO-EPIC-EDITION?search=5080&limit=100`;

const LINK = 'https://www.amazon.com/dp/B0DTJFZ4YS?tag=falcodrin-20&smid=A2L77EE7U53NWQ&th=1';

test('parses the Resale alert', () => {
  const a = Core.parseAlert(RESALE_ALERT, ['https://discord.com/channels/1/2', LINK]);
  assert.equal(a.condition, 'Used - Like New');
  assert.equal(a.merchant, 'Amazon Resale');
  assert.equal(a.price, 1536.94);
  assert.equal(a.url, LINK);
  assert.equal(a.asin, 'B0DTJFZ4YS');
  assert.match(a.name, /^ASUS ROG Astral/);
  assert.equal(Core.evaluateAlert(a, S).go, true);
});

test('parses the new Amazon.com alert', () => {
  const a = Core.parseAlert(NEW_ALERT, ['https://amzn.to/4abcXYZ']);
  assert.equal(a.merchant, 'Amazon.com');
  assert.equal(a.condition, 'New');
  assert.equal(a.price, 1599.99);
  assert.equal(a.asin, null); // short link; resolved on Amazon
  assert.equal(Core.evaluateAlert(a, S).go, true);
});

test('ignores MSI store drops', () => {
  const a = Core.parseAlert(MSI_STORE_ALERT, ['https://us-store.msi.com/search?search=5080']);
  assert.equal(Core.evaluateAlert(a, S).go, false);
});

test('price, merchant and condition rules', () => {
  const base = Core.parseAlert(RESALE_ALERT, [LINK]); // flagship Resale Like New, cap $1,650
  const ev = (p) => Core.evaluateAlert(Object.assign({}, base, p), S);
  assert.equal(ev({ price: 1650 }).go, true);
  assert.match(ev({ price: 1650.01 }).why, /above your \$1650\.00 cap for Flagship Used - Like New/);
  assert.equal(ev({ price: 1805, condition: 'New', merchant: 'Amazon.com' }).go, true);
  assert.match(ev({ price: 1810.01, condition: 'New', merchant: 'Amazon.com' }).why, /above your \$1810\.00 cap/);
  assert.match(ev({ price: 15.37 }).why, /sanity floor/);
  assert.match(ev({ condition: 'Used - Good' }).why, /not a wanted offer/);
  assert.match(ev({ merchant: 'SuperE, LLC' }).why, /not a wanted offer/);
  assert.match(ev({ condition: 'New', merchant: 'Amazon Resale' }).why, /not a wanted offer/);
  assert.equal(ev({ condition: 'Used - Very Good' }).go, true);
  assert.equal(ev({ condition: 'used - very good', merchant: 'amazon resale' }).go, true);
  assert.match(ev({ url: null }).why, /no Amazon link/);
  const sweet = ev({ name: 'MSI Gaming RTX 5080 16G Gaming Trio OC (Used - Like New)', price: 1600.5 });
  assert.match(sweet.why, /\$1600\.00 cap for Sweet spot/);
});

test('model tiers', () => {
  const tier = (n) => (Core.classify(S, n) || {}).name || null;
  assert.equal(tier('ASUS ROG Astral GeForce RTX 5080 16GB GDDR7 White OC Edition'), 'Flagship');
  assert.equal(tier('msi Gaming RTX 5080 16G SUPRIM SOC Graphics Card'), 'Flagship');
  assert.equal(tier('GIGABYTE AORUS GeForce RTX 5080 Master ICE 16G Graphics Card'), 'Flagship');
  assert.equal(tier('ASUS TUF Gaming GeForce RTX 5080 16GB GDDR7 OC Edition'), 'TUF');
  assert.equal(tier('msi Gaming RTX 5080 16G Gaming Trio OC White'), 'Sweet spot');
  assert.equal(tier('GIGABYTE GeForce RTX 5080 Gaming OC 16G Graphics Card, WINDFORCE Cooling System'), 'Sweet spot');
  assert.equal(tier('PNY NVIDIA GeForce RTX 5080 Epic-X RGB OC Triple-Fan'), 'Sweet spot');
  assert.equal(tier('ASUS ProArt GeForce RTX 5080 16GB GDDR7 OC Edition'), 'Sweet spot');
  // not wanted
  assert.equal(tier('msi Gaming RTX 5080 16G SUPRIM Liquid SOC'), null);
  assert.equal(tier('ASUS TUF Gaming GeForce RTX 5080 16GB GDDR7 BTF OC Edition'), null);
  assert.equal(tier('Gigabyte AORUS GeForce RTX 5080 Xtreme WATERFORCE WB 16G'), null);
  assert.equal(tier('Core GeForce RTX 5080/5070Ti Aorus Master + Windforce with Backplate (10290)'), null);
  assert.equal(tier('GeForce RTX RTX 5070 5080 5090 Gaming OC GPU Fan Replacement Set (OEM)'), null);
  assert.equal(tier('ASUS Prime GeForce RTX 5080 16GB GDDR7 OC Edition'), 'Prime');
  assert.equal(tier('Amazon Prime Day PNY GeForce RTX 5080 OC'), null);
  assert.equal(tier('GIGABYTE GeForce RTX 5080 WINDFORCE SFF 16G'), null);
  assert.equal(tier('msi Gaming RTX 5080 16G Ventus 3X OC Black'), null);
  assert.equal(tier('PNY NVIDIA GeForce RTX 5080 Triple-Fan Graphics Card'), null);
  assert.equal(tier('Lenovo Legion Pro 7i Gen 10 w/ Ultra 9, NVIDIA GeForce RTX 5080, 16” OLED'), null);
  assert.equal(tier('ASUS ROG Strix laptop RTX 5080'), null);
  assert.equal(tier('ASUS ROG Astral GeForce RTX 5070 Ti'), null);
});

test('real alerts Nov 4-15: new Suprim SOC, Epic-X and the Resale TUF fire', () => {
  const alerts = require('./fixtures-alerts');
  for (const a of alerts) {
    const links = a.links || (/Product Link/.test(a.text) ? [LINK] : []);
    const ev = Core.evaluateAlert(Core.parseAlert(a.text, links), S);
    assert.equal(ev.go, a.fire, `${ev.why} :: ${a.text.split('\n').find((l) => l.startsWith('Name:') || l.startsWith('Store:'))}`);
  }
});

test('condition fallbacks when the Condition line is missing', () => {
  const p = (t) => Core.parseAlert(t, [LINK]).condition;
  assert.equal(p('Name: X 5080 (Used - VeryGood)\nMerchant: Amazon Resale\nCurrent Price: $1500'), 'Used - Very Good');
  assert.equal(p('Name: X 5080 (Used - LikeNew)\nMerchant: Amazon Resale\nCurrent Price: $1500'), 'Used - Like New');
  assert.equal(p('Name: X 5080 (16GB GDDR7, 256-bit, NVIDIA Blackwell)\nMerchant: Amazon.com\nCurrent Price: $1500'), 'New');
  assert.equal(p('Name: X 5080 (16GB GDDR7, 256-bit)\nMerchant: Amazon Resale\nCurrent Price: $1500'), null);
  assert.equal(p('Name: X 5080\nCondition: Used - VeryGood\nMerchant: Amazon Resale'), 'Used - Very Good');
  assert.equal(Core.parseCondition('Refurbished - Excellent'), 'Renewed');
});

test('Discord ids', () => {
  assert.deepEqual(Core.parseMessageElementId('chat-messages-1338546225405890580-1571720248103669842'), {
    channelId: '1338546225405890580',
    messageId: '1571720248103669842',
  });
  assert.equal(Core.parseMessageElementId('message-content-123'), null);
  const t = Core.snowflakeTime('1571720248103669842');
  assert.ok(t > Date.UTC(2026, 0, 1) && t < Date.UTC(2027, 0, 1), new Date(t).toISOString());
});

test('Amazon URL helpers', () => {
  assert.equal(Core.isAmazonUrl('https://amzn.to/abc'), true);
  assert.equal(Core.isAmazonUrl('https://www.amazon.com/dp/B0DTJFZ4YS'), true);
  assert.equal(Core.isAmazonUrl('https://amazon.com.evil.example/dp/B0DTJFZ4YS'), false);
  assert.equal(Core.isAmazonUrl('https://us-store.msi.com/x'), false);
  assert.equal(Core.asinFromUrl('https://www.amazon.com/msi-Gaming-5080/dp/B0DT9Y2B49/ref=sr_1_3?x=1'), 'B0DT9Y2B49');
  assert.equal(Core.asinFromUrl('https://www.amazon.com/gp/product/B0DT9Y2B49'), 'B0DT9Y2B49');
});

test('offer parsing from real All Offers text', () => {
  assert.equal(Core.parseCondition(' Used - Very Good Added Updated Not added /* css */'), 'Used - Very Good');
  assert.equal(Core.parseCondition(' New Added Updated Not added'), 'New');
  assert.equal(Core.parseSeller(' Sold by Atomic Cellular Seller rating is 3.5 out of 5 stars (939 ratings)'), 'Atomic Cellular');
  assert.equal(Core.parseSeller('Sold by Amazon Resale'), 'Amazon Resale');
  assert.equal(Core.parseSeller(' Sold by  Amazon.com '), 'Amazon.com');
  assert.equal(Core.canonicalMerchant('Amazon.com Services LLC'), 'Amazon.com');
  assert.equal(Core.canonicalMerchant('Amazon Resale Deals'), 'Amazon Resale Deals');
});

test('pickOffer holds each offer to its condition cap', () => {
  const flag = Core.classify(S, 'ASUS ROG Astral GeForce RTX 5080 OC');
  const offers = [
    { condition: 'New', seller: 'MrReliable-USA', price: 1500 },
    { condition: 'Used - Good', seller: 'Amazon Resale', price: 1300 },
    { condition: 'Used - Very Good', seller: 'Amazon Resale', price: 1690 }, // over $1,650 used cap
    { condition: 'Used - Like New', seller: 'Amazon Resale', price: 1640 },
    { condition: 'New', seller: 'Amazon.com', price: 1799.99 },
  ];
  const p = Core.pickOffer(offers, S, flag);
  assert.equal(p.price, 1640);
  assert.equal(p.cap, 1650);
  const noUsed = Core.pickOffer(offers.filter((o) => o.price !== 1640), S, flag);
  assert.equal(noUsed.price, 1799.99);
  assert.equal(noUsed.cap, 1810);
  assert.equal(Core.pickOffer(offers.slice(0, 3), S, flag), null);
  assert.equal(Core.pickOffer(offers, S, null), null);
});

test('checkout gate', () => {
  const good = Core.checkoutTotals('Order Summary\nItems:\t$1,536.94\nShipping & handling:\t$0.00\nTotal before tax:\t$1,536.94\nEstimated tax to be collected:\t$149.85\nOrder total:\t$1,686.79');
  assert.deepEqual(good, { items: 1536.94, total: 1686.79, qtyOver1: false });
  assert.equal(Core.checkoutOk(good, S).ok, true);

  const twoThings = Core.checkoutTotals('Items (2): $1,736.93\nOrder total: $1,905.11');
  assert.match(Core.checkoutOk(twoThings, S, 1650).why, /items \$1736\.93 above/);

  const qty2 = Core.checkoutTotals('Qty: 2\nItems: $1,500.00\nOrder total: $1,640.00');
  assert.match(Core.checkoutOk(qty2, S).why, /quantity/);

  const pricey = Core.checkoutTotals('Items: $1,799.00\nOrder total: $2,001.00');
  assert.match(Core.checkoutOk(pricey, S).why, /above your \$2000\.00 cap/);
  const usedCap = Core.checkoutTotals('Items: $1,640.00\nOrder total: $1,800.00');
  assert.equal(Core.checkoutOk(usedCap, S, 1650).ok, true);
  assert.match(Core.checkoutOk(usedCap, S, 1600).why, /above the \$1600\.00 cap/);

  assert.match(Core.checkoutOk(Core.checkoutTotals('Place your order'), S).why, /could not read/);

  const turbo = Core.checkoutTotals('Buy now\nTotal $1,743.98\nPlace your order');
  assert.equal(turbo.total, 1743.98);
  assert.equal(Core.checkoutOk(turbo, S).ok, true);
});

test('Prime: new from Amazon.com up to $1,700', () => {
  const s = Core.normalizeSettings({});
  const al = (merchant, condition, price, name = 'ASUS Prime GeForce RTX 5080 16GB GDDR7 Gaming Graphics Card') =>
    Core.evaluateAlert({ name, merchant, condition, price, url: 'https://www.amazon.com/dp/B0DTPG3B1N', mentionsAmazon: true }, s).go;
  assert.equal(al('Amazon.com', 'New', 1599.99), true);
  assert.equal(al('Amazon.com', 'New', 1699.99, 'ASUS Prime GeForce RTX 5080 16GB GDDR7 OC Edition'), true);
  assert.equal(al('Amazon.com', 'New', 1699.99, 'ASUS Prime GeForce RTX 5080 EVO 16GB GDDR7 OC Edition'), true);
  assert.equal(al('Amazon.com', 'New', 1749.99, 'ASUS Prime GeForce RTX 5080 16GB GDDR7 OC Edition'), false);
  assert.equal(al('Amazon Resale', 'Used - Like New', 1388.12), false);
  assert.equal(al('BBlacklow', 'New', 1499.99), false);
});

test('settings normalise', () => {
  // An old saved copy of the rules is ignored unless customRules is on.
  const old = Core.normalizeSettings({ maxPrice: 1000, tiers: [], armed: true, pushoverUser: 'u' });
  assert.equal(old.maxPrice, Core.DEFAULT_SETTINGS.maxPrice);
  assert.equal(old.tiers.length, Core.DEFAULT_SETTINGS.tiers.length);
  assert.equal(old.armed, true);
  assert.equal(old.pushoverUser, 'u');
  const s = Core.normalizeSettings({ customRules: true, maxPrice: '1650', armed: 'yes', allowed: [{ merchant: 'Amazon.com' }] });
  assert.equal(s.maxPrice, 1650);
  assert.equal(Core.capFor(s, s.tiers[0], 'New'), 1650); // global ceiling wins
  assert.equal(s.armed, false); // only literal true arms it
  assert.deepEqual(s.allowed, []);
  assert.equal(Core.normalizeSettings({}).armed, false);
});
