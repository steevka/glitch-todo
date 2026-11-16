'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-monitor-'));
const Core = require('../amazon-autobuy.user.js');
const { parseAod, looksBlocked } = require('../monitor/aod.js');
const M = require('../monitor/monitor.js');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const TUF = fx('aod-B0DQSMMCSH.html'); // real: TUF OC, 10 third-party offers, no featured offer
const PNY = fx('aod-B0DTJFZ4YS-resale.html'); // real PNY page, offer 5 edited to Amazon Resale VG $1,490

// The TUF page with its first offer turned into an Amazon Resale Like New one at `price`.
function tufWithResale(price) {
  const i = TUF.indexOf('id="aod-offer"');
  let block = TUF.slice(i, TUF.indexOf('id="aod-offer"', i + 10));
  assert.ok(block.includes('QyTech'), 'fixture still has QyTech');
  block = block.replace(/QyTech/g, 'Amazon Resale').replace(/>\s*New\s*</, '>Used - Like New<').replace(/\$2,561\.00/g, '$' + price).replace(/2,561/g, price.split('.')[0]);
  return TUF.slice(0, i) + block + TUF.slice(i + block.length);
}

test('parses real offers pages', () => {
  const t = parseAod(TUF, Core);
  assert.match(t.title, /ASUS TUF Gaming GeForce RTX.*5080/);
  assert.equal(t.offers.length, 10);
  assert.deepEqual(
    { c: t.offers[0].condition, s: t.offers[0].seller, p: t.offers[0].price },
    { c: 'New', s: 'QyTech', p: 2561 }
  );
  assert.ok(t.offers.every((o) => o.olid && o.price > 2000));

  const p = parseAod(PNY, Core);
  assert.equal(p.offers.length, 11);
  const resale = p.offers.find((o) => o.seller === 'Amazon Resale');
  assert.deepEqual({ c: resale.condition, p: resale.price }, { c: 'Used - Very Good', p: 1490 });
});

test('robot check detection', () => {
  assert.equal(looksBlocked(200, TUF), false);
  assert.equal(looksBlocked(503, ''), true);
  assert.equal(looksBlocked(200, '<form action="/errors/validateCaptcha">'), true);
});

function mockFetch(pages) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('pushover')) return { ok: true, status: 200, text: async () => '{}' };
    const asin = /asin=([A-Z0-9]{10})/.exec(url)[1];
    const p = pages[asin];
    return { ok: p.status === 200, status: p.status, text: async () => p.html };
  };
  return calls;
}

test('matches a wanted Resale TUF, ignores scalper offers, de-duplicates', async () => {
  const sent = [];
  const fakeClient = { write: (m) => sent.push(m) };
  M.clients.add(fakeClient);
  try {
    mockFetch({ B0DQSMMCSH: { status: 200, html: TUF } });
    await M.check({ asin: 'B0DQSMMCSH', name: 'ASUS TUF OC' });
    assert.equal(M.state.B0DQSMMCSH.tier, 'TUF');
    assert.equal(M.state.B0DQSMMCSH.best, null); // no Amazon / Resale offers
    assert.equal(sent.length, 0);

    mockFetch({ B0DQSMMCSH: { status: 200, html: tufWithResale('1,804.99') } });
    await M.check({ asin: 'B0DQSMMCSH', name: 'ASUS TUF OC' });
    assert.equal(sent.length, 1);
    const hit = JSON.parse(sent[0].split('data: ')[1]);
    assert.deepEqual(
      { asin: hit.asin, merchant: hit.merchant, condition: hit.condition, price: hit.price, tier: hit.tier },
      { asin: 'B0DQSMMCSH', merchant: 'Amazon Resale', condition: 'Used - Like New', price: 1804.99, tier: 'TUF' }
    );
    assert.match(hit.id, /^\d+$/); // the userscript's tab hash needs digits

    await M.check({ asin: 'B0DQSMMCSH', name: 'ASUS TUF OC' }); // same offer again: quiet
    assert.equal(sent.length, 1);

    mockFetch({ B0DQSMMCSH: { status: 200, html: tufWithResale('1,899.99') } }); // over the $1,810 cap
    await M.check({ asin: 'B0DQSMMCSH', name: 'ASUS TUF OC' });
    assert.equal(sent.length, 1);
    assert.equal(M.state.B0DQSMMCSH.best.price, 1899.99);
  } finally {
    M.clients.delete(fakeClient);
  }
});

test('a base-model page never matches even with a cheap Resale offer', async () => {
  const sent = [];
  const fakeClient = { write: (m) => sent.push(m) };
  M.clients.add(fakeClient);
  try {
    mockFetch({ B0DTJFZ4YS: { status: 200, html: PNY } });
    await M.check({ asin: 'B0DTJFZ4YS', name: 'PNY OC triple fan' });
    assert.equal(M.state.B0DTJFZ4YS.wanted, false);
    assert.equal(M.state.B0DTJFZ4YS.best.price, 1490);
    assert.equal(sent.length, 0);
  } finally {
    M.clients.delete(fakeClient);
  }
});

test('robot check pauses, without a hit', async () => {
  mockFetch({ B0DS2R6948: { status: 503, html: 'Sorry' } });
  await M.check({ asin: 'B0DS2R6948', name: 'Gigabyte Gaming OC' });
  assert.match(M.state.B0DS2R6948.error, /robot check.*pausing 360 min/);
});

test('HTTP: learn, status, test hit', async () => {
  await new Promise((r) => M.server.listen(0, r));
  const base = 'http://127.0.0.1:' + M.server.address().port;
  const realFetch = require('node:http');
  const post = (p, body) =>
    new Promise((resolve) => {
      const req = realFetch.request(base + p, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(JSON.parse(b)));
      });
      req.end(JSON.stringify(body));
    });
  const get = (p) =>
    new Promise((resolve) =>
      realFetch.get(base + p, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      })
    );
  try {
    assert.equal((await post('/learn', { asin: 'B0TESTTUF1', name: 'ASUS TUF Gaming GeForce RTX 5080 OC' })).learned, true);
    assert.equal((await post('/learn', { asin: 'B0TESTVNT1', name: 'MSI GeForce RTX 5080 Ventus 3X OC' })).learned, false);
    assert.equal((await post('/learn', { asin: 'nope', name: 'x' })).ok, false);
    assert.ok(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'learned.json'))).B0TESTTUF1);
    assert.ok(M.watchList().some((w) => w.asin === 'B0TESTTUF1'));

    const st = JSON.parse(await get('/status.json'));
    assert.ok(st.watch.length >= 20);
    assert.ok(st.hits.some((h) => h.tier === 'TUF'));

    const t = await post('/test-hit', { asin: 'B0CTESTBAT', maxPrice: '9' });
    assert.equal(t.ok, true);
    assert.equal(M.hits[M.hits.length - 1].test, true);
    assert.equal((await post('/test-hit', { asin: 'B0CTESTBAT' })).ok, false);
    assert.match(await get('/'), /gtd-monitor/);
  } finally {
    M.server.close();
  }
});

test('keeps Amazon cookies between requests', async () => {
  const sentCookies = [];
  global.fetch = async (url, init) => {
    sentCookies.push(init.headers.cookie);
    return { ok: true, status: 200, headers: new Headers([['set-cookie', 'session-id=135-1234567-7654321; path=/; domain=.amazon.com']]), text: async () => TUF };
  };
  await M.check({ asin: 'B0DQSMMCSH', name: 'ASUS TUF OC' });
  await M.check({ asin: 'B0DQSMMCSH', name: 'ASUS TUF OC' });
  assert.match(sentCookies[1], /session-id=135-1234567-7654321/);
});
