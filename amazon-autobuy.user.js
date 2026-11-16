// ==UserScript==
// @name         Discord → Amazon Auto-Buy (RTX 5080)
// @namespace    https://github.com/steevka/glitch-todo
// @version      0.2.3
// @description  Watches a Discord stock-alert channel in the browser tab you have open. When an alert for an Amazon offer you want appears (right merchant, condition and price), it opens the listing and checks out with your saved card and address. One order max until you reset it.
// @author       steevka
// @match        https://discord.com/*
// @match        https://www.amazon.com/*
// @match        https://amzn.to/*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @connect      api.pushover.net
// @connect      hc-ping.com
// @updateURL    https://raw.githubusercontent.com/steevka/glitch-todo/glitch/amazon-autobuy.user.js
// @downloadURL  https://raw.githubusercontent.com/steevka/glitch-todo/glitch/amazon-autobuy.user.js
// @supportURL   https://github.com/steevka/glitch-todo
// ==/UserScript==

(function () {
  'use strict';

  /* ======================================================================
   * Core: pure logic, no browser APIs, unit tested in Node
   * (test/autobuy.unit.test.js).
   * ==================================================================== */
  const Core = (() => {
    const VERSION = '0.2.3';
    const DISCORD_EPOCH = 1420070400000;

    const DEFAULT_SETTINGS = {
      // Discord
      channelId: '1338546225405890580', // #rtx5080 in the Falcodrin server
      maxAlertAgeSec: 120, // ignore messages older than this (reloads, scrollback)
      // What to buy
      requirePattern: '\\b5080\\b', // product name must match (regex, case-insensitive)
      // Never: Ti, laptops/prebuilts, AIO (Liquid), BTF (needs a back-connect board),
      // water-block cards, and accessories (blocks, backplates, fans).
      excludePattern:
        '\\b5080\\s*ti\\b|laptop|notebook|desktop|prebuilt|gaming pc|\\bpc\\b|computer|liquid|\\bbtf\\b|waterforce|water ?block|backplate|replacement|bracket',
      // Which models, and the most to pay per condition (item price, before tax).
      tiers: [
        {
          name: 'Flagship',
          pattern: 'rog astral|suprim|aorus[^|]*master',
          caps: { New: 1810, 'Used - Like New': 1650, 'Used - Very Good': 1650 },
        },
        {
          name: 'Sweet spot',
          pattern: '\\btuf\\b|gaming trio|gigabyte.*\\bgaming oc\\b|epic-x|proart',
          caps: { New: 1810, 'Used - Like New': 1600, 'Used - Very Good': 1600 },
        },
      ],
      // Who we buy from: new only from Amazon itself, used only from Amazon Resale.
      allowed: [
        { merchant: 'Amazon.com', condition: 'New' },
        { merchant: 'Amazon Resale', condition: 'Used - Like New' },
        { merchant: 'Amazon Resale', condition: 'Used - Very Good' },
      ],
      minPrice: 800, // anything cheaper is almost certainly a parsing mistake
      maxPrice: 1810, // absolute item price ceiling, whatever the tier caps say
      maxOrderTotal: 2000, // checkout total cap including tax and shipping
      // Behaviour
      armed: false, // false = dry run: goes to checkout, stops before Place your order
      requestInvites: true, // click "Request invitation" on invite-only listings
      // Alerts
      pushoverUser: '',
      pushoverToken: '',
      healthcheckUrl: '', // healthchecks.io ping URL, pinged about once a minute from the Discord tab
      sound: true,
    };

    function normalizeSettings(raw) {
      const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
      const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
      s.minPrice = num(s.minPrice, DEFAULT_SETTINGS.minPrice);
      s.maxPrice = num(s.maxPrice, DEFAULT_SETTINGS.maxPrice);
      s.maxOrderTotal = num(s.maxOrderTotal, DEFAULT_SETTINGS.maxOrderTotal);
      s.maxAlertAgeSec = num(s.maxAlertAgeSec, DEFAULT_SETTINGS.maxAlertAgeSec);
      if (!Array.isArray(s.tiers)) s.tiers = DEFAULT_SETTINGS.tiers.slice();
      s.tiers = s.tiers.filter((t) => t && t.name && t.pattern && t.caps && typeof t.caps === 'object');
      if (!Array.isArray(s.allowed)) s.allowed = DEFAULT_SETTINGS.allowed.slice();
      s.allowed = s.allowed
        .filter((r) => r && r.merchant && r.condition)
        .map((r) => ({ merchant: String(r.merchant).trim(), condition: String(r.condition).trim() }));
      s.armed = s.armed === true;
      s.channelId = String(s.channelId || '').trim();
      return s;
    }

    function parseMoney(v) {
      if (v === null || v === undefined || v === '') return null;
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      const m = String(v).match(/\d[\d,]*(?:\.\d+)?/);
      if (!m) return null;
      const n = parseFloat(m[0].replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }

    function fmtMoney(n) {
      return n === null || n === undefined ? '?' : '$' + Number(n).toFixed(2);
    }

    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

    // Discord ids are snowflakes; the creation time is in the top bits.
    function snowflakeTime(id) {
      try {
        return Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
      } catch (e) {
        return null;
      }
    }

    // "chat-messages-<channelId>-<messageId>"
    function parseMessageElementId(elId) {
      const m = /^chat-messages-(\d+)-(\d+)$/.exec(elId || '');
      return m ? { channelId: m[1], messageId: m[2] } : null;
    }

    function isAmazonUrl(href) {
      try {
        const u = new URL(href);
        return /(^|\.)amazon\.com$/i.test(u.hostname) || /^(amzn\.to|amzn\.com|a\.co)$/i.test(u.hostname);
      } catch (e) {
        return false;
      }
    }

    function asinFromUrl(href) {
      const m = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Z0-9]{10})(?:[/?#]|$)/i.exec(href || '');
      return m ? m[1].toUpperCase() : null;
    }

    // Parse the alert text the Falcodrin bot posts:
    //   Name: ... / Condition: ... / Merchant: ... / Price: $1536.94 / Current Price: ...
    function parseAlert(text, links) {
      const t = String(text || '');
      const field = (name) => {
        const m = new RegExp('^\\s*' + name + ':[ \\t]*(.+)$', 'im').exec(t);
        return m ? m[1].trim() : null;
      };
      const amazonLinks = (links || []).filter(isAmazonUrl);
      const current = parseMoney(field('Current Price'));
      const listed = parseMoney(field('Price'));
      const name = field('Name');
      const merchant = field('Merchant');
      // The second monitor often omits "Condition:". Fall back to the
      // "(Used - LikeNew)" suffix on the name, then to New for Amazon.com.
      let condition = parseCondition(field('Condition'));
      if (!condition && name) {
        const suffix = /\(([^()]*)\)\s*$/.exec(name);
        if (suffix && /^\s*(new|renewed|used\s*-\s*[a-z ]+|refurbished[^)]*)\s*$/i.test(suffix[1])) condition = parseCondition(suffix[1]);
      }
      if (!condition && canonicalMerchant(merchant) === 'Amazon.com') condition = 'New';
      return {
        name,
        condition,
        merchant,
        price: current !== null ? current : listed,
        url: amazonLinks[0] || null,
        asin: amazonLinks.map(asinFromUrl).find(Boolean) || null,
        mentionsAmazon: /@amazon\b/i.test(t) || amazonLinks.length > 0,
      };
    }

    function ruleMatches(s, merchant, condition) {
      return s.allowed.some((r) => norm(r.merchant) === norm(merchant) && norm(r.condition) === norm(condition));
    }

    function nameOk(s, name) {
      const n = String(name || '');
      let req, exc;
      try {
        req = new RegExp(s.requirePattern || '.', 'i');
        exc = s.excludePattern ? new RegExp(s.excludePattern, 'i') : null;
      } catch (e) {
        return { ok: false, why: 'bad name pattern in settings: ' + e.message };
      }
      if (!req.test(n)) return { ok: false, why: 'name does not match ' + s.requirePattern };
      if (exc && exc.test(n)) return { ok: false, why: 'name matches exclude pattern' };
      return { ok: true };
    }

    // Which tier a product name belongs to (first match wins), or null.
    function classify(s, name) {
      if (!nameOk(s, name).ok) return null;
      for (const t of s.tiers) {
        try {
          if (new RegExp(t.pattern, 'i').test(name)) return t;
        } catch (e) {}
      }
      return null;
    }

    // Item price cap for a tier + condition (never above the global ceiling).
    function capFor(s, tier, condition) {
      if (!tier) return null;
      const key = Object.keys(tier.caps).find((k) => norm(k) === norm(condition));
      const cap = key ? parseMoney(tier.caps[key]) : null;
      return cap === null ? null : Math.min(cap, s.maxPrice);
    }

    // Decide whether a parsed alert should trigger a buy attempt.
    function evaluateAlert(a, s) {
      if (!a || !a.mentionsAmazon) return { go: false, why: 'not an Amazon alert' };
      if (!a.url) return { go: false, why: 'no Amazon link in the alert' };
      if (!a.name) return { go: false, why: 'could not read the product name' };
      const n = nameOk(s, a.name);
      if (!n.ok) return { go: false, why: n.why };
      const tier = classify(s, a.name);
      if (!tier) return { go: false, why: 'not a wanted model' };
      if (!ruleMatches(s, a.merchant, a.condition))
        return { go: false, why: `not a wanted offer (${a.merchant || '?'} / ${a.condition || '?'})` };
      if (a.price === null) return { go: false, why: 'no price in the alert' };
      if (a.price < s.minPrice) return { go: false, why: `price ${fmtMoney(a.price)} below the ${fmtMoney(s.minPrice)} sanity floor` };
      const cap = capFor(s, tier, a.condition);
      if (cap === null) return { go: false, why: `no cap set for ${tier.name} / ${a.condition}` };
      if (a.price > cap) return { go: false, why: `price ${fmtMoney(a.price)} above your ${fmtMoney(cap)} cap for ${tier.name} ${a.condition}` };
      return { go: true, tier: tier.name, cap, why: `${tier.name}: ${a.merchant} / ${a.condition} at ${fmtMoney(a.price)}` };
    }

    const CONDITIONS = ['Used - Like New', 'Used - Very Good', 'Used - Good', 'Used - Acceptable', 'Renewed', 'New'];

    // Tolerates "Used - LikeNew" / "Used - VeryGood" spellings.
    function parseCondition(text) {
      const t = norm(text).replace(/\s+/g, '');
      if (!t) return null;
      if (/refurbished/.test(t)) return 'Renewed';
      for (const c of CONDITIONS) {
        if (t.includes(c.toLowerCase().replace(/\s+/g, ''))) return c;
      }
      return null;
    }

    // "Sold by Amazon Resale Seller rating is ..." -> "Amazon Resale"
    function parseSeller(text) {
      let t = String(text || '').replace(/\s+/g, ' ').trim();
      t = t.replace(/^.*?\bsold by\b:?\s*/i, '');
      t = t.split(/\s+(?:Seller rating|Seller rating is|\(\d|Ships from|Just launched|\d+% positive|Returns?\b|Payment\b)/i)[0];
      return t.trim() || null;
    }

    // Normalise "Amazon.com Services LLC" etc. so rules compare cleanly.
    function canonicalMerchant(name) {
      const n = norm(name);
      if (!n) return null;
      if (n === 'amazon resale') return 'Amazon Resale';
      if (n === 'amazon' || n === 'amazon.com' || n.startsWith('amazon.com services')) return 'Amazon.com';
      return String(name).trim();
    }

    // Pick the cheapest acceptable offer from [{condition, seller, price, ...}]
    // for a product in `tier`; each offer is held to its own condition's cap.
    function pickOffer(offers, s, tier) {
      const ok = offers
        .map((o) => Object.assign({}, o, { merchant: canonicalMerchant(o.seller), cap: capFor(s, tier, o.condition) }))
        .filter((o) => o.price !== null && o.cap !== null && o.price >= s.minPrice && o.price <= o.cap)
        .filter((o) => ruleMatches(s, o.merchant, o.condition));
      ok.sort((a, b) => a.price - b.price);
      return ok[0] || null;
    }

    // Read the money amounts from a checkout page's visible text.
    function checkoutTotals(text) {
      const t = String(text || '').replace(/ /g, ' ');
      const grab = (re) => {
        const m = re.exec(t);
        return m ? parseMoney(m[1]) : null;
      };
      return {
        items: grab(/\bItems?(?:\s*\(\d+\))?\s*:?\s*\$\s*([\d,]+\.\d{2})/i),
        total:
          grab(/\bOrder total\s*:?\s*\$\s*([\d,]+\.\d{2})/i) ??
          grab(/\bTotal(?:\s*\(\d+ items?\))?\s*:?\s*\$\s*([\d,]+\.\d{2})/i),
        qtyOver1: /\b(?:Qty|Quantity)\s*:?\s*([2-9]|\d{2,})\b/i.test(t),
      };
    }

    // Final gate before clicking Place your order.
    function checkoutOk(totals, s, itemCap) {
      const cap = Math.min(itemCap || s.maxPrice, s.maxPrice);
      if (totals.total === null) return { ok: false, why: 'could not read the order total' };
      if (totals.qtyOver1) return { ok: false, why: 'quantity is more than 1' };
      if (totals.items !== null && totals.items > cap)
        return { ok: false, why: `items ${fmtMoney(totals.items)} above the ${fmtMoney(cap)} cap (other things in the cart?)` };
      if (totals.total > s.maxOrderTotal)
        return { ok: false, why: `order total ${fmtMoney(totals.total)} above your ${fmtMoney(s.maxOrderTotal)} cap` };
      if (totals.total < s.minPrice) return { ok: false, why: `order total ${fmtMoney(totals.total)} looks wrong` };
      return { ok: true, why: `items ${fmtMoney(totals.items)}, total ${fmtMoney(totals.total)}` };
    }

    return {
      VERSION,
      DEFAULT_SETTINGS,
      normalizeSettings,
      parseMoney,
      fmtMoney,
      snowflakeTime,
      parseMessageElementId,
      isAmazonUrl,
      asinFromUrl,
      parseAlert,
      nameOk,
      classify,
      capFor,
      evaluateAlert,
      parseCondition,
      parseSeller,
      canonicalMerchant,
      pickOffer,
      checkoutTotals,
      checkoutOk,
    };
  })();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Core;
    return;
  }

  /* ======================================================================
   * Browser side
   * ==================================================================== */
  const JOB_TTL_MS = 4 * 60 * 1000; // a buy attempt is abandoned after 4 minutes
  const HASH_KEY = 'gtdab';
  const isTop = window.top === window.self;

  const settings = () => Core.normalizeSettings(GM_getValue('settings', {}));
  const saveSettings = (s) => GM_setValue('settings', Core.normalizeSettings(s));

  function log(msg, extra) {
    const line = new Date().toLocaleTimeString() + ' [' + location.hostname.replace('www.', '') + '] ' + msg;
    console.log('[autobuy] ' + line, extra || '');
    const arr = GM_getValue('log', []);
    arr.push(line);
    GM_setValue('log', arr.slice(-300));
    badge(msg);
  }

  // ---------- alerts ----------
  function push(title, message, opts = {}) {
    const s = settings();
    if (!s.pushoverUser || !s.pushoverToken) {
      log('Pushover keys not set; push skipped: ' + title);
      return;
    }
    const body = new URLSearchParams({
      token: s.pushoverToken,
      user: s.pushoverUser,
      title,
      message,
      priority: String(opts.priority ?? 1),
      sound: opts.sound || (opts.priority >= 1 ? 'siren' : 'pushover'),
    });
    if (opts.url) {
      body.set('url', opts.url);
      body.set('url_title', 'Open on Amazon');
    }
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://api.pushover.net/1/messages.json',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: body.toString(),
      onload: (r) => r.status !== 200 && log('Pushover error ' + r.status + ': ' + r.responseText),
      onerror: () => log('Pushover request failed'),
    });
  }

  function desktop(title, text) {
    try {
      GM_notification({ title, text, timeout: 15000 });
    } catch (e) {}
  }

  function siren(seconds = 6) {
    if (!settings().sound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.25;
      osc.type = 'sawtooth';
      osc.connect(gain).connect(ctx.destination);
      const t0 = ctx.currentTime;
      for (let i = 0; i < seconds * 2; i++) {
        osc.frequency.setValueAtTime(700, t0 + i * 0.5);
        osc.frequency.linearRampToValueAtTime(1400, t0 + i * 0.5 + 0.45);
      }
      osc.start();
      osc.stop(t0 + seconds);
    } catch (e) {}
  }

  function alertAll(title, message, opts = {}) {
    push(title, message, opts);
    desktop(title, message);
    log('ALERT: ' + title + ' — ' + message); // last, so the badge shows the reason
    if (opts.siren !== false) siren(opts.sirenSec || 6);
  }

  // ---------- small status badge ----------
  let badgeEl = null;
  function badge(text) {
    if (!isTop || !document.body) return;
    if (!badgeEl) {
      badgeEl = document.createElement('div');
      badgeEl.style.cssText =
        'position:fixed;z-index:2147483647;right:12px;bottom:12px;max-width:420px;padding:8px 10px;border-radius:8px;' +
        'font:12px/1.35 system-ui,sans-serif;color:#fff;background:rgba(20,20,20,.88);box-shadow:0 2px 10px rgba(0,0,0,.4);pointer-events:none;white-space:pre-wrap';
      document.body.appendChild(badgeEl);
    }
    const s = settings();
    const lock = GM_getValue('orderLock', null);
    const mode = lock ? '🔒 LOCKED (order placed)' : s.armed ? '🟢 ARMED: will buy' : '🟡 DRY RUN';
    badgeEl.textContent = 'Auto-buy ' + Core.VERSION + ' · ' + mode + '\n' + text;
  }

  // ---------- job handoff (Discord tab -> Amazon tab) ----------
  const getJob = () => GM_getValue('job', null);
  const setJob = (j) => GM_setValue('job', j);
  function patchJob(id, patch) {
    const j = getJob();
    if (j && j.id === id) setJob(Object.assign(j, patch, { updated: Date.now() }));
  }
  function liveJob() {
    const j = getJob();
    if (!j || j.done || Date.now() - j.created > JOB_TTL_MS) return null;
    return j;
  }

  /* ======================================================================
   * Discord: watch the alert channel
   * ==================================================================== */
  function runDiscord() {
    const seen = new Set();
    let primed = false;
    let lastHc = 0;

    function channelOpen() {
      const s = settings();
      return location.pathname.split('/')[3] === s.channelId;
    }

    function scan() {
      const s = settings();
      if (!s.channelId) return;
      const items = document.querySelectorAll('li[id^="chat-messages-' + s.channelId + '-"]');
      for (const li of items) {
        const ids = Core.parseMessageElementId(li.id);
        if (!ids || seen.has(ids.messageId)) continue;
        seen.add(ids.messageId);
        if (!primed) continue; // messages already on screen when we started
        const ts = Core.snowflakeTime(ids.messageId);
        if (!ts || Date.now() - ts > s.maxAlertAgeSec * 1000) continue;
        handleMessage(li, ids, s);
      }
      if (!primed && items.length) {
        primed = true;
        log(`Watching channel ${s.channelId} (${items.length} old messages ignored)`);
      }
    }

    function handleMessage(li, ids, s) {
      const links = Array.from(li.querySelectorAll('a[href]')).map((a) => a.href);
      const alert = Core.parseAlert(li.innerText || '', links);
      const ev = Core.evaluateAlert(alert, s);
      if (!ev.go) {
        if (alert.mentionsAmazon) log('Skipped alert: ' + ev.why + ' — ' + (alert.name || '').slice(0, 60));
        return;
      }
      if (GM_getValue('orderLock', null)) {
        alertAll('Wanted 5080 alert (locked)', `Order lock is on, so I did not buy: ${ev.why}`, { url: alert.url, priority: 1 });
        return;
      }
      const cur = liveJob();
      if (cur && cur.stage !== 'failed' && Date.now() - cur.created < 60 * 1000) {
        log('Already working on a buy; ignoring ' + ev.why);
        return;
      }
      const job = {
        id: ids.messageId,
        created: Date.now(),
        alert,
        stage: 'opening',
        armed: s.armed,
      };
      setJob(job);
      log('GO: ' + ev.why + ' — opening Amazon');
      const url = alert.url.split('#')[0] + '#' + HASH_KEY + '=' + job.id;
      GM_openInTab(url, { active: true, insert: true, setParent: true });
      desktop('Buying: ' + ev.why, alert.name || '');
    }

    function tick() {
      if (!channelOpen()) {
        badge('Open the alert channel (#rtx5080) in this tab to start watching.');
        return;
      }
      scan();
      const s = settings();
      if (s.healthcheckUrl && Date.now() - lastHc > 60 * 1000) {
        lastHc = Date.now();
        GM_xmlhttpRequest({ method: 'GET', url: s.healthcheckUrl, onerror: () => {} });
      }
    }

    // React re-renders constantly; a cheap observer plus a 1s safety poll.
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (channelOpen()) scan();
      });
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(tick, 1000);

    // Switching channels re-primes so old messages there don't fire.
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        primed = false;
      }
    }, 500);

    GM_addValueChangeListener('job', (k, o, n) => {
      if (n && n.stage) badge(`Job ${n.stage}${n.note ? ': ' + n.note : ''}`);
    });
    tick();
  }

  /* ======================================================================
   * Amazon: carry the job through product page -> checkout
   * ==================================================================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs = 10000, everyMs = 100) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(everyMs);
    }
    return null;
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function findByText(selector, re) {
    return Array.from(document.querySelectorAll(selector)).find((el) => {
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      return re.test(t) && visible(el);
    });
  }

  function placeOrderButton() {
    const ids = [
      '#turbo-checkout-pyo-button',
      '#placeOrder',
      'input[name="placeYourOrder1"]',
      '#submitOrderButtonId input',
      '#bottomSubmitOrderButtonId input',
      '#submitOrderButtonId',
    ];
    for (const sel of ids) {
      const el = document.querySelector(sel);
      if (visible(el)) return el;
    }
    return findByText('input[type="submit"], button, span.a-button-text', /^place (your )?order/i);
  }

  function failJob(job, why, opts = {}) {
    patchJob(job.id, { stage: 'failed', note: why });
    alertAll('Auto-buy stopped', why, Object.assign({ url: job.alert && job.alert.url, priority: 1 }, opts));
  }

  function jobForThisPage() {
    const m = new RegExp('[#&]' + HASH_KEY + '=(\\d+)').exec(location.hash);
    const j = liveJob();
    if (!j) return null;
    if (m) return m[1] === j.id ? j : null;
    // Later pages (checkout, turbo iframe, thank-you) don't carry the hash.
    return j.stage !== 'opening' ? j : null;
  }

  function isProductPage() {
    return !!document.querySelector('#ASIN, input[name="ASIN"]') && !!document.querySelector('#productTitle');
  }

  function isThankYouPage() {
    return /\/(gp\/buy\/thankyou|checkout\/.*thankyou)/i.test(location.pathname) ||
      /order placed, thank you|thank you, your order has been placed/i.test(document.body.innerText.slice(0, 5000));
  }

  function isBlocked() {
    return /\/ap\/signin|\/errors\/validateCaptcha|\/ap\/cvf/i.test(location.pathname) ||
      !!document.querySelector('form[action*="validateCaptcha"]');
  }

  async function runAmazon() {
    if (/^amzn\.to$/i.test(location.hostname)) return; // just a redirect
    const job = jobForThisPage();
    if (!job) return;

    if (isBlocked()) return failJob(job, 'Amazon wants a captcha or sign-in. Do it now, then buy by hand.', { sirenSec: 10 });

    if (isThankYouPage()) {
      patchJob(job.id, { stage: 'ordered', done: true });
      alertAll('ORDER PLACED on Amazon', `${job.alert.name || 'RTX 5080'} — check your email for the confirmation.`, { priority: 1, sound: 'cashregister', sirenSec: 3 });
      return;
    }

    if (isProductPage() && (job.stage === 'opening' || job.stage === 'product')) return productPage(job);

    if (job.stage === 'checkout' || job.stage === 'buy-now') return checkoutPage(job);
  }

  // ----- product page -----
  // A test job (menu) buys whatever this page is, held to its own price cap.
  function settingsFor(job) {
    const s = settings();
    if (!job || !job.test) return s;
    const cap = job.testCap;
    return Object.assign({}, s, { minPrice: 0, maxPrice: cap, maxOrderTotal: testTotalCap(cap) });
  }
  // Item price + up to 12% sales tax; shipping must be free.
  function testTotalCap(cap) {
    return Math.ceil(cap * 1.12 * 100) / 100;
  }
  function tierFor(job, s, title) {
    if (!job || !job.test) return Core.classify(s, title);
    const caps = {};
    s.allowed.forEach((r) => (caps[r.condition] = job.testCap));
    return { name: 'Test', caps };
  }

  async function productPage(job) {
    patchJob(job.id, { stage: 'product' });
    const s = settingsFor(job);
    const asin = (document.querySelector('#ASIN, input[name="ASIN"]') || {}).value || Core.asinFromUrl(location.href);
    const title = (document.querySelector('#productTitle') || {}).innerText || '';
    log(`Product page ${asin}: ${title.slice(0, 70)}`);

    const tier = tierFor(job, s, title);
    if (!tier) return failJob(job, 'The Amazon page is not a wanted model: ' + title.slice(0, 80));

    // Invite-only drop: request the invite (allowed) and tell the user.
    const invite = findByText('#invitePlatform_feature_div input, #invitePlatform_feature_div button, #invitePlatform_feature_div span.a-button-text', /request (an )?invit/i);
    if (invite) {
      if (s.requestInvites) {
        invite.click();
        patchJob(job.id, { stage: 'invited', done: true });
        alertAll('Requested an Amazon invite', `${title.slice(0, 80)} is invite-only. Invite requested; watch your email.`, { priority: 0, siren: false, url: location.href });
      } else {
        failJob(job, 'Invite-only listing; invites are off in settings.');
      }
      return;
    }

    if (!job.test && GM_getValue('orderLock', null)) return failJob(job, 'Order lock is on; not buying.');

    // Path A: the buy box itself is the offer we want -> Buy Now (single-item checkout).
    const box = readBuyBox();
    log(`Buy box: ${box.merchant || '?'} / ${box.condition || '?'} at ${Core.fmtMoney(box.price)}`);
    const boxCap = Core.capFor(s, tier, box.condition);
    const boxOk = box.price !== null && boxCap !== null && box.price >= s.minPrice && box.price <= boxCap &&
      s.allowed.some((r) => r.merchant.toLowerCase() === String(box.merchant).toLowerCase() && r.condition.toLowerCase() === String(box.condition).toLowerCase());
    const buyNow = document.querySelector('#buy-now-button');
    if (boxOk && visible(buyNow)) {
      patchJob(job.id, { stage: 'buy-now', cap: boxCap, note: `${tier.name}: ${box.merchant} ${Core.fmtMoney(box.price)}` });
      log('Clicking Buy Now');
      buyNow.click();
      return; // checkout continues on the next page or inside the turbo iframe
    }

    // Path B: find the offer in the All Offers list and add exactly that one.
    let offers;
    try {
      offers = await fetchOffers(asin);
    } catch (e) {
      return failJob(job, 'Could not load the offers list: ' + e.message);
    }
    log(`Offers list: ${offers.length} offers`);
    const pick = Core.pickOffer(offers, s, tier);
    if (!pick) {
      const summary = offers.slice(0, 4).map((o) => `${Core.canonicalMerchant(o.seller)} ${o.condition} ${Core.fmtMoney(o.price)}`).join('; ');
      return failJob(job, 'The offer is gone (or over your price). Seen: ' + (summary || 'no offers'), { priority: 0 });
    }

    const cartCount = parseInt(((document.querySelector('#nav-cart-count') || {}).textContent || '0').trim(), 10) || 0;
    if (cartCount > 0)
      return failJob(job, `Your cart already has ${cartCount} item(s). Empty it (or Save for later) so only the 5080 gets bought. Offer: ${pick.merchant} ${pick.condition} ${Core.fmtMoney(pick.price)}`);

    log(`Adding ${pick.merchant} / ${pick.condition} at ${Core.fmtMoney(pick.price)} to cart`);
    try {
      await addToCart(pick);
    } catch (e) {
      return failJob(job, 'Add to cart failed: ' + e.message);
    }
    patchJob(job.id, { stage: 'checkout', cap: pick.cap, note: `${tier.name}: ${pick.merchant} ${pick.condition} ${Core.fmtMoney(pick.price)}` });
    location.href = '/gp/cart/view.html?ref_=nav_cart';
  }

  // Amazon sometimes leaves .a-offscreen empty and puts the price in an
  // accessibility label, or only in the visible whole/fraction spans.
  function priceIn(root) {
    if (!root) return null;
    const cands = [
      root.querySelector('.apex-pricetopay-accessibility-label'),
      ...root.querySelectorAll('.a-price .a-offscreen'),
    ];
    for (const el of cands) {
      const p = el && Core.parseMoney(el.textContent);
      if (p !== null) return p;
    }
    const whole = root.querySelector('.a-price .a-price-whole');
    if (whole) {
      const frac = (whole.parentElement.querySelector('.a-price-fraction') || {}).textContent || '00';
      return Core.parseMoney(whole.textContent.replace(/[^\d,]/g, '') + '.' + frac.replace(/\D/g, ''));
    }
    return null;
  }

  function readBuyBox() {
    const txt = (sel) => ((document.querySelector(sel) || {}).innerText || '').trim();
    const price = priceIn(document.querySelector('#corePrice_feature_div')) ??
      priceIn(document.querySelector('#corePriceDisplay_desktop_feature_div')) ??
      priceIn(document.querySelector('#apex_desktop'));
    const sellerText = txt('#merchantInfoFeature_feature_div') || txt('#merchant-info') || txt('#sellerProfileTriggerId');
    let merchant = null;
    if (/amazon resale/i.test(sellerText)) merchant = 'Amazon Resale';
    else if (/Seller\s+Amazon(\.com)?\b(?!\s+(Germany|Japan|UK|Canada|Mexico|Export))/i.test(sellerText) || /sold by amazon\.com/i.test(sellerText)) merchant = 'Amazon.com';
    else merchant = sellerText.split('\n').pop() || null;
    const boxText = txt('#buybox');
    const condition = /used\s*-\s*/i.test(boxText.slice(0, 600)) ? Core.parseCondition(boxText) : 'New';
    return { price, merchant, condition };
  }

  async function fetchOffers(asin) {
    const res = await fetch(`/gp/product/ajax/aodAjaxMain/?asin=${encodeURIComponent(asin)}&pc=dp&isonlyrenderofferlist=false`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const blocks = doc.querySelectorAll('#aod-pinned-offer, #aod-offer');
    return Array.from(blocks).map((b) => {
      const heading = (b.querySelector('#aod-offer-heading') || {}).textContent || '';
      const soldBy = (b.querySelector('#aod-offer-soldBy') || {}).textContent || '';
      return {
        condition: Core.parseCondition(heading),
        seller: Core.parseSeller(soldBy),
        price: priceIn(b.querySelector('[id^="aod-price-"]') || b),
        form: b.querySelector('form.AodAddToCart, form[action*="add-to-cart"]'),
      };
    });
  }

  async function addToCart(offer) {
    const f = offer.form;
    if (!f) throw new Error('offer has no add-to-cart form');
    const data = new FormData(f);
    data.set('items[0.base][quantity]', '1');
    const res = await fetch(f.getAttribute('action'), { method: 'POST', body: data, credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  }

  // ----- cart, checkout and the Buy Now pop-up -----
  async function checkoutPage(job) {
    const s = settingsFor(job);

    // Cart page: make sure it's only our item, then proceed.
    if (/\/(gp\/cart\/view|cart\b)/i.test(location.pathname)) {
      const lines = document.querySelectorAll('#sc-active-cart [data-asin][data-itemtype="active"], #sc-active-cart .sc-list-item[data-asin]');
      const asins = new Set(Array.from(lines).map((l) => l.getAttribute('data-asin')).filter(Boolean));
      if (asins.size > 1) return failJob(job, `Cart has ${asins.size} different items; stopping so nothing else gets bought.`);
      const proceed = await waitFor(() => document.querySelector('input[name="proceedToRetailCheckout"], #sc-buy-box-ptc-button input'), 8000);
      if (!proceed) return failJob(job, 'Could not find Proceed to checkout on the cart page.');
      log('Cart OK, proceeding to checkout');
      proceed.click();
      return;
    }

    const btn = await waitFor(placeOrderButton, 15000, 150);
    if (!btn) {
      if (!isTop) return; // some other Amazon iframe
      return failJob(job, 'Checkout did not show a Place your order button (maybe it needs a payment or address choice).', { url: location.href });
    }
    await sleep(400); // let totals render
    const totals = Core.checkoutTotals(document.body.innerText);
    const verdict = Core.checkoutOk(totals, s, job.cap);
    log('Checkout: ' + verdict.why);
    if (!verdict.ok) {
      highlight(btn);
      return failJob(job, 'Did not place the order: ' + verdict.why, { url: isTop ? location.href : job.alert.url });
    }

    if (!job.armed || (!job.test && !s.armed)) {
      highlight(btn);
      patchJob(job.id, { stage: 'dry-run', done: true, note: verdict.why });
      alertAll('DRY RUN: would have bought', `${verdict.why}. Tap Place your order yourself if you want it.`, { url: job.alert.url, sirenSec: 10 });
      return;
    }

    if (!job.test) {
      // Test buys don't set the lock, so the real 5080 run stays ready.
      if (GM_getValue('orderLock', null)) return failJob(job, 'Order lock is on; not buying.');
      GM_setValue('orderLock', { at: Date.now(), job: job.id, note: verdict.why });
    }
    patchJob(job.id, { stage: 'placing', note: verdict.why });
    log('Placing order: ' + verdict.why);
    btn.click();

    // Turbo (pop-up) checkout stays on the product page; confirm by watching for the thank-you.
    const ok = await waitFor(() => isThankYouPage() || /order placed|thank you/i.test(document.body.innerText.slice(0, 3000)), 20000, 300);
    if (ok) {
      patchJob(job.id, { stage: 'ordered', done: true });
      alertAll('ORDER PLACED on Amazon', `${job.alert.name || 'RTX 5080'} — ${verdict.why}`, { priority: 1, sound: 'cashregister', sirenSec: 3 });
    } else if (getJob() && getJob().stage === 'placing') {
      alertAll('Clicked Place your order', 'No confirmation seen yet. Check Amazon orders now.', { priority: 1, url: 'https://www.amazon.com/gp/css/order-history' });
    }
  }

  function highlight(el) {
    try {
      el.scrollIntoView({ block: 'center' });
      const target = el.closest('.a-button, span, button') || el;
      target.style.outline = '6px solid #18c964';
      target.style.outlineOffset = '4px';
    } catch (e) {}
  }

  /* ======================================================================
   * Menu commands (Tampermonkey icon -> this script)
   * ==================================================================== */
  function menus() {
    GM_registerMenuCommand('Settings…', () => {
      const s = settings();
      const shown = Object.assign({}, s);
      const json = prompt('Edit settings (JSON). Pushover keys and the healthchecks URL go here.', JSON.stringify(shown, null, 1));
      if (json === null) return;
      try {
        saveSettings(JSON.parse(json));
        alert('Saved.');
        badge('Settings saved');
      } catch (e) {
        alert('Not valid JSON, nothing saved: ' + e.message);
      }
    });
    GM_registerMenuCommand('Arm / disarm full auto', () => {
      const s = settings();
      s.armed = !s.armed;
      saveSettings(s);
      alert(s.armed ? 'ARMED: it will place the order.' : 'Dry run: it stops at Place your order.');
      badge(s.armed ? 'Armed' : 'Dry run');
    });
    GM_registerMenuCommand('Reset order lock', () => {
      const lock = GM_getValue('orderLock', null);
      if (!lock) return alert('No order lock set.');
      if (confirm('An order was placed ' + new Date(lock.at).toLocaleString() + ' (' + lock.note + '). Clear the lock so it can buy again?')) {
        GM_setValue('orderLock', null);
        badge('Order lock cleared');
      }
    });
    GM_registerMenuCommand('Send test push', () => push('Auto-buy test', 'Pushover is working.', { priority: 0 }));
    GM_registerMenuCommand('Show log', () => {
      const w = window.open('', '_blank');
      if (w) w.document.body.innerText = GM_getValue('log', []).slice().reverse().join('\n');
    });
    if (/amazon\.com$/.test(location.hostname)) {
      const testRun = (real) => {
        const title = (document.querySelector('#productTitle') || {}).innerText || '';
        if (!title) return alert('Open a product page first.');
        const box = readBuyBox();
        const ans = prompt(`${real ? 'REAL ORDER TEST' : 'Dry run'}: ${title.slice(0, 80)}\n\nBuy box: ${box.merchant || '?'} / ${box.condition || '?'} at ${Core.fmtMoney(box.price)}\nOnly Amazon.com new or Amazon Resale Like New / Very Good offers count.\n\nMax item price for this test:`, box.price ? String(box.price) : '');
        if (ans === null) return;
        const cap = Core.parseMoney(ans);
        if (!cap) return alert('Not a price.');
        if (real && !confirm(`This places a REAL order with your saved card and address, up to ${Core.fmtMoney(cap)} for the item (order total incl. tax up to ${Core.fmtMoney(testTotalCap(cap))}, free shipping only). Go?`)) return;
        setJob({ id: 't' + Date.now(), created: Date.now(), stage: 'product', armed: real, test: true, testCap: cap, alert: { name: title, url: location.href.split('#')[0], price: box.price } });
        badge(real ? 'Test buy: REAL order' : 'Test: dry run');
        productPage(getJob());
      };
      GM_registerMenuCommand('Test this product page (dry run)', () => testRun(false));
      GM_registerMenuCommand('Test buy this product (REAL order)', () => testRun(true));
    }
  }

  // ---------- boot ----------
  if (isTop) menus();
  if (location.hostname === 'discord.com') {
    if (isTop) runDiscord();
  } else {
    runAmazon().catch((e) => log('Error: ' + e.message));
  }
})();
