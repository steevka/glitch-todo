'use strict';
// deflab stock monitor: checks the All Offers list of every wanted RTX 5080 listing,
// and streams matches to the userscript (open http://deflab:8787 in Chrome on the Mac),
// which does the actual buying in your logged-in browser. Node 22, no dependencies.

const http = require('http');
const fs = require('fs');
const path = require('path');

const CORE_PATH = process.env.CORE_PATH || path.join(__dirname, '..', 'amazon-autobuy.user.js');
const Core = require(CORE_PATH);
const { parseAod, looksBlocked } = require('./aod.js');

const PORT = +process.env.PORT || 8787;
const SPACING_MS = +process.env.SPACING_MS || 2000; // between requests to Amazon
const JITTER_MS = +process.env.JITTER_MS || 1000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUSHOVER_USER = process.env.PUSHOVER_USER || '';
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || '';
// Only watch listings in these tiers (comma list of tier names; empty = all wanted).
const WATCH_TIERS = (process.env.WATCH_TIERS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
// browser = real headless Chromium loading product pages; fetch = raw All Offers requests.
const MODE = (process.env.MODE || 'fetch').toLowerCase();
// Listings checked every other time (comma list), e.g. the one that actually drops in price.
const PRIORITY = (process.env.PRIORITY_ASINS || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
const NOT_BEFORE = process.env.NOT_BEFORE ? Date.parse(process.env.NOT_BEFORE) || 0 : 0; // ISO time of the first Amazon request
const BLOCK_PAUSE_MIN = +process.env.BLOCK_PAUSE_MIN || 360; // after a robot check, stay off Amazon this long
const START_AT = Math.max(Date.now() + (+process.env.START_DELAY_MIN || 0) * 60e3, NOT_BEFORE);
const REPEAT_HIT_MS = 20 * 60 * 1000; // same offer at same price: tell the browser again after 20 min
const HIT_REPLAY_MS = 90 * 1000; // a browser that (re)connects gets hits from the last 90 s
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const settings = Core.normalizeSettings(readJson(path.join(DATA_DIR, 'settings.json'), {}));
const seed = readJson(path.join(__dirname, 'asins.json'), { asins: {} }).asins;
const learnedFile = path.join(DATA_DIR, 'learned.json');
const learned = readJson(learnedFile, {});

const state = {}; // asin -> { name, title, tier, checks, lastCheck, ms, offers, best, wanted, error }
const hits = []; // most recent last
const lastHitKey = new Map(); // asin -> { key, at }
const clients = new Set();
const blocks = { until: 0, count: 0, total: 0 };
const started = Date.now();
let requests = 0;
let cursor = 0;
let lastRound = null;
let roundStart = Date.now();

function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return dflt;
  }
}

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function tierOf(asin, name) {
  const st = state[asin];
  const tier = Core.classify(settings, (st && st.title) || name + ' RTX 5080');
  return tier ? tier.name : null;
}

function watchList() {
  const all = Object.assign({}, seed, learned);
  return Object.keys(all)
    .filter((a) => /^[A-Z0-9]{10}$/.test(a))
    .map((asin) => ({ asin, name: all[asin] }))
    .filter((w) => !WATCH_TIERS.length || WATCH_TIERS.includes(String(tierOf(w.asin, w.name)).toLowerCase()));
}

// One consistent visitor: keep Amazon's cookies between requests (and restarts).
const cookieFile = path.join(DATA_DIR, 'cookies.json');
const cookies = readJson(cookieFile, {});
function cookieHeader() {
  return Object.entries(cookies)
    .map(([k, v]) => k + '=' + v)
    .join('; ');
}
function keepCookies(res) {
  const list = res.headers && typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  let changed = false;
  for (const c of list) {
    const m = /^([^=;\s]+)=([^;]*)/.exec(c);
    if (!m) continue;
    if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(c) || m[2] === '' || m[2] === '-') delete cookies[m[1]];
    else cookies[m[1]] = m[2];
    changed = true;
  }
  if (changed) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(cookieFile, JSON.stringify(cookies));
    } catch (e) {}
  }
}

function push(title, message, extra = {}) {
  if (!PUSHOVER_USER || !PUSHOVER_TOKEN) return;
  const body = new URLSearchParams(Object.assign({ token: PUSHOVER_TOKEN, user: PUSHOVER_USER, title, message }, extra));
  fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body }).catch((e) => log('push failed', e.message));
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function emitHit(hit) {
  hits.push(hit);
  while (hits.length > 50) hits.shift();
  log(`HIT ${hit.test ? '(test) ' : ''}${hit.asin} ${hit.merchant} ${hit.condition} ${Core.fmtMoney(hit.price)} -> ${clients.size} browser(s)`);
  broadcast('hit', hit);
}

const newId = () => String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');

// Raw request for the All Offers list (fast, but Amazon spots it as a script quickly).
async function loadAod(asin) {
  const res = await fetch(`https://www.amazon.com/gp/product/ajax/aodAjaxMain/?asin=${asin}&pc=dp&isonlyrenderofferlist=false`, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,*/*;q=0.8', cookie: cookieHeader() },
    signal: AbortSignal.timeout(15000),
  });
  keepCookies(res);
  const html = await res.text();
  if (looksBlocked(res.status, html)) return { status: res.status, blocked: true };
  if (!res.ok) return { status: res.status, error: 'HTTP ' + res.status };
  return Object.assign({ status: res.status }, parseAod(html, Core));
}

// Real headless Chromium loading the product page (MODE=browser).
let browser = null;
async function loadPage(asin) {
  if (!browser) {
    const { createBrowserChecker } = require('./browser.js');
    browser = await createBrowserChecker({ dataDir: DATA_DIR, log, Core });
    log('Chromium started');
  }
  try {
    return await browser.check(asin);
  } catch (e) {
    // A wedged browser gets restarted on the next check.
    const b = browser;
    browser = null;
    b.close().catch(() => {});
    throw e;
  }
}

async function check({ asin, name }) {
  const st = (state[asin] = state[asin] || { name, checks: 0 });
  st.name = name;
  const t0 = Date.now();
  let r;
  try {
    r = await (MODE === 'browser' ? loadPage(asin) : loadAod(asin));
  } catch (e) {
    st.error = 'load: ' + e.message.split('\n')[0].slice(0, 120);
    st.lastCheck = Date.now();
    return;
  } finally {
    requests++;
  }
  st.ms = Date.now() - t0;
  st.lastCheck = Date.now();
  st.checks++;

  if (r.blocked) {
    blocks.count++;
    blocks.total++;
    const mins = BLOCK_PAUSE_MIN * blocks.count;
    blocks.until = Date.now() + mins * 60e3;
    st.error = `Amazon robot check (HTTP ${r.status}); pausing ${mins} min`;
    log(st.error);
    broadcast('status', { blocked: true, until: blocks.until });
    push('Stock monitor paused', `Amazon showed a robot check. Pausing ${mins} min. Discord alerts still work.`);
    return;
  }
  blocks.count = 0;
  if (r.error) {
    st.error = r.error;
    return;
  }

  const { title, offers } = r;
  st.title = title || st.title;
  st.offers = offers.length;
  st.note = r.note || null;
  st.error = null;
  const tier = Core.classify(settings, st.title || name);
  st.tier = tier ? tier.name : null;
  st.wanted = !!tier;
  const ours = offers
    .map((o) => Object.assign({}, o, { merchant: Core.canonicalMerchant(o.seller) }))
    .filter((o) => settings.allowed.some((r) => r.merchant.toLowerCase() === o.merchant.toLowerCase()));
  ours.sort((a, b) => a.price - b.price);
  st.best = ours[0] ? { merchant: ours[0].merchant, condition: ours[0].condition, price: ours[0].price } : null;
  if (!tier) return;

  const pick = Core.pickOffer(offers, settings, tier);
  if (!pick) return;
  const key = `${pick.merchant}|${pick.condition}|${pick.price}`;
  const prev = lastHitKey.get(asin);
  if (prev && prev.key === key && Date.now() - prev.at < REPEAT_HIT_MS) return;
  lastHitKey.set(asin, { key, at: Date.now() });
  const hit = {
    id: newId(),
    at: Date.now(),
    asin,
    url: `https://www.amazon.com/dp/${asin}`,
    name: st.title || name,
    tier: tier.name,
    merchant: pick.merchant,
    condition: pick.condition,
    price: pick.price,
    cap: pick.cap,
  };
  emitHit(hit);
  push(
    `In stock: ${tier.name} 5080 ${Core.fmtMoney(pick.price)}`,
    `${pick.merchant} / ${pick.condition}: ${(st.title || name).slice(0, 90)}\n${clients.size ? 'Your Mac is on it.' : 'No browser connected! Buy it by hand.'}`,
    { url: hit.url, priority: clients.size ? '0' : '1' }
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Priority listings go between every other listing: P a P b P c ...
function schedule(list) {
  const pri = list.filter((w) => PRIORITY.includes(w.asin));
  const rest = list.filter((w) => !PRIORITY.includes(w.asin));
  if (!pri.length || !rest.length) return list;
  return rest.flatMap((w) => [...pri, w]);
}

async function loop() {
  for (;;) {
    const waitUntil = Math.max(blocks.until, START_AT);
    if (Date.now() < waitUntil) {
      await sleep(Math.min(waitUntil - Date.now(), 30e3));
      continue;
    }
    const list = schedule(watchList());
    if (!list.length) {
      await sleep(5000);
      continue;
    }
    if (cursor >= list.length) {
      cursor = 0;
      lastRound = { ms: Date.now() - roundStart, n: list.length };
      roundStart = Date.now();
    }
    const item = list[cursor++];
    // Pages that turned out not to be a wanted model are re-checked only every 30th round.
    const st = state[item.asin];
    if (st && st.wanted === false && st.checks % 30 !== 0) {
      st.checks++;
      continue;
    }
    try {
      await check(item);
    } catch (e) {
      log('check error', item.asin, e.message);
    }
    await sleep(SPACING_MS + Math.random() * JITTER_MS);
  }
}

// amzn.to / a.co short links: read the redirect target only (no request to amazon.com).
async function resolveAsin(url) {
  try {
    const u = new URL(url);
    if (!/^(amzn\.to|a\.co|amzn\.com)$/i.test(u.hostname)) return Core.asinFromUrl(url);
    const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
    return Core.asinFromUrl(r.headers.get('location') || '');
  } catch (e) {
    return null;
  }
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c.length + b.length < 1e5 ? c : ''));
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function status() {
  return {
    version: Core.VERSION,
    started,
    now: Date.now(),
    requests,
    spacingMs: SPACING_MS,
    watchTiers: WATCH_TIERS,
    mode: MODE,
    priority: PRIORITY,
    startsAt: START_AT > Date.now() ? START_AT : null,
    lastRound,
    browsers: clients.size,
    blockedUntil: blocks.until > Date.now() ? blocks.until : null,
    blocksTotal: blocks.total,
    pushover: !!(PUSHOVER_USER && PUSHOVER_TOKEN),
    hits: hits.slice(-10).reverse(),
    watch: watchList().map(({ asin, name }) => Object.assign({ asin, name, learned: !!learned[asin] && !seed[asin] }, state[asin] || {})),
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'page.html')));
  }
  if (req.method === 'GET' && u.pathname === '/status.json') return json(res, 200, status());
  if (req.method === 'GET' && u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    for (const h of hits) if (Date.now() - h.at < HIT_REPLAY_MS) res.write(`event: hit\ndata: ${JSON.stringify(h)}\n\n`);
    const ping = setInterval(() => res.write(`event: ping\ndata: ${Date.now()}\n\n`), 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/learn') {
    const b = await readBody(req);
    let asin = String(b.asin || '').toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin) && b.url) asin = (await resolveAsin(String(b.url))) || '';
    if (!/^[A-Z0-9]{10}$/.test(asin)) return json(res, 400, { ok: false });
    const isNew = !seed[asin] && !learned[asin];
    if (isNew && Core.classify(settings, String(b.name || ''))) {
      learned[asin] = String(b.name).slice(0, 120);
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(learnedFile, JSON.stringify(learned, null, 1));
      log('Learned', asin, learned[asin]);
    }
    return json(res, 200, { ok: true, asin, learned: !!learned[asin] && isNew, known: !!seed[asin] });
  }
  if (req.method === 'POST' && u.pathname === '/test-hit') {
    const b = await readBody(req);
    const asin = String(b.asin || '').toUpperCase();
    const cap = Core.parseMoney(b.maxPrice);
    if (!/^[A-Z0-9]{10}$/.test(asin) || !cap) return json(res, 400, { ok: false, why: 'need asin and maxPrice' });
    const hit = { id: newId(), at: Date.now(), test: true, testCap: cap, asin, url: `https://www.amazon.com/dp/${asin}`, name: 'Test from the monitor page', price: null };
    emitHit(hit);
    return json(res, 200, { ok: true, browsers: clients.size });
  }
  res.writeHead(404);
  res.end();
});

if (require.main === module) {
  server.listen(PORT, () =>
    log(`Stock monitor ${Core.VERSION} on :${PORT}, ${MODE} mode, watching ${watchList().length} listings (${WATCH_TIERS.join(',') || 'all tiers'}), ${SPACING_MS} ms apart${START_AT > Date.now() ? ', starting ' + new Date(START_AT).toISOString() : ''}`)
  );
  loop();
}

module.exports = { server, check, state, hits, clients, watchList };
