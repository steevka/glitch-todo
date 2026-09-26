'use strict';
// End-to-end tests of the userscript against a fake walmart.com (see harness.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, ITEM, CANON } = require('./harness');

test('background mode: watches, detects the deal, stops, alerts everywhere', async () => {
  const h = await setup();
  try {
    await h.page.goto(ITEM);
    await h.page.getByRole('button', { name: 'Start watching' }).click();
    await h.waitFor(() => h.pushes((b) => b.title === 'Walmart Watcher started').length === 1, 5000, 'start push');
    const started = h.pushes()[0].data;
    assert.equal(started.url, 'https://ntfy.sh');
    assert.equal(started.body.topic, 'test-topic-123');

    await h.waitFor(() => h.fetches().length >= 3, 8000, '3 background checks');
    assert.equal(h.docs().length, 1, 'page must not reload in background mode');
    for (const f of h.fetches()) assert.equal(f.url, CANON, 'fetches the clean URL (sid dropped)');
    await h.waitFor(async () => /Out of stock \(listed \$477\.04\)/.test(await h.panelText()), 5000, 'OOS text');

    // It comes in stock
    h.site.kind = 'deal';
    await h.waitFor(() => h.pushes((b) => b.priority === 5).length === 1, 8000, 'urgent push');
    const urgent = h.pushes((b) => b.priority === 5)[0].data.body;
    assert.match(urgent.title, /IN STOCK \$477\.04/);
    assert.equal(urgent.click, CANON);
    assert.ok(h.events.some((e) => e.type === 'notify' && /IN STOCK/.test(e.data.title)), 'desktop notification');
    await h.waitFor(() => h.events.some((e) => e.type === 'openTab'), 3000, 'fresh tab opened');
    assert.equal(h.events.find((e) => e.type === 'openTab').data.url, CANON);

    // Polling stops once found
    await h.waitFor(() => h.context.pages().length === 2, 5000, 'second tab exists');
    const n = h.fetches(h.page).length;
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(h.fetches(h.page).length, n, 'no more checks after the find');
    assert.equal(h.context.pages().length, 2, 'exactly one extra tab');
    assert.match(await h.panelText(), /IN STOCK at \$477\.04/);
    assert.match(await h.page.title(), /IN STOCK|Walmart/);

    // The fresh tab shows the found state and highlights Buy now
    const fresh = h.context.pages().find((p) => p !== h.page);
    await h.waitFor(async () => /IN STOCK at \$477\.04/.test(await h.panelText(fresh)), 5000, 'fresh tab banner');
    await h.waitFor(
      () => fresh.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Buy now' && b.style.outline.includes('solid'))),
      5000,
      'buy button highlighted'
    );
    assert.equal(h.fetches(fresh).length, 0, 'fresh tab does not poll');

    // Stop alarm, then resume: still in stock, but no duplicate urgent push
    await h.page.getByRole('button', { name: 'Stop alarm' }).click();
    await h.page.getByRole('button', { name: 'History' }).click();
    assert.match(await h.panelText(), /Alerted you · you stopped the alarm at/);
    await h.page.getByRole('button', { name: 'Hide history' }).click();
    await h.page.getByRole('button', { name: 'Resume watching' }).click();
    await h.waitFor(() => h.fetches().length > n, 5000, 'resumed checks');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(h.pushes((b) => b.priority === 5).length, 1, 'no duplicate alert for the same offer');

    // A different (cheaper) offer is a new alert
    await h.page.getByRole('button', { name: 'Resume watching' }).click();
    h.site.price = 455;
    await h.waitFor(() => h.pushes((b) => b.priority === 5).length === 2, 8000, 'second urgent push');
    assert.match(h.pushes((b) => b.priority === 5)[1].data.body.title, /\$455\.00/);
    assert.deepEqual(h.events.filter((e) => e.type === 'pageerror'), []);
  } finally {
    await h.close();
  }
});

test('over max price never alerts; raising the max in settings does', async () => {
  const h = await setup();
  try {
    h.site.kind = 'over';
    await h.page.goto(ITEM);
    await h.page.getByRole('button', { name: 'Start watching' }).click();
    await h.waitFor(() => h.fetches().length >= 4, 8000, 'checks');
    assert.equal(h.pushes((b) => b.priority === 5).length, 0);
    assert.match(await h.panelText(), /above your \$600\.00 max/);
    await h.page.getByRole('button', { name: 'History' }).click();
    assert.match(await h.panelText(), /\$749\.99 · Walmart\.com\s*Skipped: \$749\.99 is above your \$600\.00 max · seen \d+× over [^,]+, still in stock/);
    await h.page.getByRole('button', { name: 'Hide history' }).click();

    // Open settings, type, and make sure periodic re-renders don't wipe the input
    await h.page.getByRole('button', { name: 'Settings' }).click();
    const max = h.page.getByLabel('Max price ($)');
    await max.fill('800');
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(await max.inputValue(), '800', 'typing survives re-renders');
    await h.page.getByRole('button', { name: 'Save settings' }).click();
    await h.waitFor(() => h.pushes((b) => b.priority === 5).length === 1, 8000, 'alert after raising max');
    assert.deepEqual(h.events.filter((e) => e.type === 'pageerror'), []);
  } finally {
    await h.close();
  }
});

test('bot check: background fetch blocked -> loads the real page and carries on', async () => {
  const h = await setup();
  try {
    await h.page.goto(ITEM);
    await h.page.getByRole('button', { name: 'Start watching' }).click();
    await h.waitFor(() => h.fetches().length >= 2, 8000, 'checks');
    h.site.fetchKind = 'blocked'; // only background fetches get the bot page
    await h.waitFor(() => h.docs().length >= 2, 8000, 'navigated to real page');
    h.site.fetchKind = null;
    const before = h.fetches().length;
    await h.waitFor(() => h.fetches().length > before + 1, 15000, 'checks resumed after navigation');
    assert.match(await h.panelText(), /WATCHING/);
    assert.equal(h.pushes((b) => /human check/.test(b.title)).length, 0, 'no bother if the real page loaded fine');
  } finally {
    await h.close();
  }
});

test('bot check: real page redirected to /blocked -> banner + push, resumes after solving', async () => {
  const h = await setup();
  try {
    await h.page.goto(ITEM);
    await h.page.getByRole('button', { name: 'Start watching' }).click();
    await h.waitFor(() => h.fetches().length >= 2, 8000, 'checks');
    h.site.kind = 'redirect-blocked';
    await h.waitFor(() => h.page.url().includes('/blocked'), 10000, 'on /blocked');
    await h.waitFor(() => h.pushes((b) => /human check/.test(b.title)).length === 1, 5000, 'human-check push');
    await h.waitFor(async () => (await h.page.getByText(/Restock Watcher is paused/).count()) === 1, 5000, 'banner');

    // "Solve" the check: Walmart sends you back to the product page
    h.site.kind = 'oos';
    await h.page.goto(ITEM);
    const before = h.fetches().length;
    await h.waitFor(() => h.fetches().length > before + 1, 8000, 'resumed');
    assert.match(await h.panelText(), /WATCHING/);
  } finally {
    await h.close();
  }
});

test('reload mode: reloads the tab, stops reloading when found, highlights Buy now', async () => {
  const h = await setup({ mode: 'reload' });
  try {
    await h.page.goto(ITEM);
    await h.page.getByRole('button', { name: 'Start watching' }).click();
    await h.waitFor(() => h.docs().length >= 4, 10000, 'several reloads');
    assert.equal(h.fetches().length, 0, 'reload mode does not fetch in the background');
    h.site.kind = 'deal';
    await h.waitFor(() => h.pushes((b) => b.priority === 5).length === 1, 10000, 'urgent push');
    const n = h.docs().length;
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(h.docs().length, n, 'no reloads after the find');
    assert.equal(h.events.filter((e) => e.type === 'openTab').length, 0, 'no extra tab in reload mode');
    await h.waitFor(
      () => h.page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Buy now' && b.style.outline.includes('solid'))),
      5000,
      'buy button highlighted'
    );
  } finally {
    await h.close();
  }
});

test('two tabs on the same item: only one checks', async () => {
  const h = await setup();
  try {
    await h.page.goto(ITEM);
    await h.page.getByRole('button', { name: 'Start watching' }).click();
    const second = await h.context.newPage();
    await second.goto(ITEM);
    await h.waitFor(() => h.fetches(h.page).length >= 5, 10000, 'first tab checks');
    await h.waitFor(async () => /OTHER TAB/.test(await h.panelText(second)), 5000, 'second tab idle');
    assert.equal(h.fetches(second).length, 0, 'second tab must not double the traffic');

    // Close the first tab -> second takes over after the lease expires (fast in test: 2 min min TTL is too long,
    // so use the "Watch from this tab" button instead)
    await h.page.close();
    await second.getByRole('button', { name: 'Watch from this tab' }).click();
    await h.waitFor(() => h.fetches(second).length >= 2, 8000, 'second tab took over');
  } finally {
    await h.close();
  }
});

test('page it cannot read: warns in the panel and pushes once after 10 misses', async () => {
  const h = await setup();
  try {
    h.site.kind = 'garbage';
    await h.page.goto(ITEM);
    await h.page.getByRole('button', { name: 'Start watching' }).click();
    await h.waitFor(() => h.pushes((b) => /needs attention/.test(b.title)).length === 1, 15000, 'problem push');
    assert.match(await h.panelText(), /Copy debug info/);
    const n = h.fetches().length;
    await h.waitFor(() => h.fetches().length >= n + 3, 8000, 'keeps checking');
    assert.equal(h.pushes((b) => /needs attention/.test(b.title)).length, 1, 'rate limited');
    assert.equal(h.pushes((b) => b.priority === 5).length, 0, 'never a false IN STOCK alert');
  } finally {
    await h.close();
  }
});

test('stop really stops; state survives a page reload', async () => {
  const h = await setup();
  try {
    await h.page.goto(ITEM);
    await h.page.getByRole('button', { name: 'Start watching' }).click();
    await h.waitFor(() => h.fetches().length >= 2, 8000, 'checks');
    // Reload: should keep watching without clicking anything (e.g. Chrome restarted)
    await h.page.reload();
    const n = h.fetches().length;
    await h.waitFor(() => h.fetches().length >= n + 2, 8000, 'auto-resumed after reload');
    await h.page.getByRole('button', { name: 'Stop' }).click();
    const m = h.fetches().length;
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(h.fetches().length <= m + 1, 'stopped');
    assert.match(await h.panelText(), /Not watching/);
  } finally {
    await h.close();
  }
});

test('bot check shown in place at the product URL: push, then retry later (no reload loop)', async () => {
  const h = await setup();
  try {
    await h.page.goto(ITEM);
    await h.page.getByRole('button', { name: 'Start watching' }).click();
    await h.waitFor(() => h.fetches().length >= 2, 8000, 'checks');
    h.site.kind = 'blocked'; // every request, page loads included, gets the bot page
    await h.waitFor(() => h.pushes((b) => /human check/.test(b.title)).length === 1, 10000, 'human-check push');
    const docs = h.docs().length;
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(h.docs().length, docs, 'waits instead of reloading in a loop');
    assert.match(await h.panelText(), /BOT CHECK/);
  } finally {
    await h.close();
  }
});

test('a duplicated tab (copied sessionStorage) picks a new tab id', async () => {
  const h = await setup();
  try {
    await h.page.goto(ITEM);
    const id1 = await h.page.evaluate(() => sessionStorage.getItem('ww:tab'));
    assert.ok(id1);
    const dup = await h.context.newPage();
    await dup.addInitScript((id) => {
      if (location.hostname === 'www.walmart.com') sessionStorage.setItem('ww:tab', id);
    }, id1);
    await dup.goto(ITEM);
    await h.waitFor(async () => (await dup.evaluate(() => sessionStorage.getItem('ww:tab'))) !== id1, 5000, 'new id');
    assert.equal(await h.page.evaluate(() => sessionStorage.getItem('ww:tab')), id1, 'original keeps its id');
  } finally {
    await h.close();
  }
});

test('found but nobody reacts: reminder push, then resumes watching by itself', async () => {
  // reminderEveryMin / autoResumeMin minimums are 0.5 min, so this test takes ~45s.
  const h = await setup({ pushReminders: 1, reminderEveryMin: 0.5, autoResumeMin: 0.7 });
  try {
    h.site.kind = 'deal';
    await h.page.goto(ITEM);
    await h.page.getByRole('button', { name: 'Start watching' }).click();
    await h.waitFor(() => h.pushes((b) => b.priority === 5).length === 1, 8000, 'urgent push');
    h.site.kind = 'oos';
    await h.waitFor(() => h.pushes((b) => /^Reminder 1/.test(b.title)).length === 1, 50000, 'reminder push');
    const n = h.fetches(h.page).length;
    await h.waitFor(() => h.fetches(h.page).length > n + 1, 30000, 'auto-resumed checks');
    assert.equal(h.pushes((b) => /^Reminder/.test(b.title)).length, 1, 'only the configured number of reminders');
    await h.waitFor(async () => /Out of stock/.test(await h.panelText()), 5000, 'watching again');

    // History shows the find, that nobody responded, and that it went away
    assert.match(await h.panelText(), /Seen in stock 1× · last .* at \$477\.04/);
    await h.page.getByRole('button', { name: 'History' }).click();
    const text = await h.panelText();
    assert.match(text, /TIMES IT WAS IN STOCK/i);
    assert.match(text, /\$477\.04 · Walmart\.com/);
    assert.match(text, /Alerted you · no response · seen once, gone by/);
    assert.match(text, /CHECKS PER DAY/i);
    await h.page.getByRole('button', { name: 'Copy history' }).click();
  } finally {
    await h.close();
  }
});
