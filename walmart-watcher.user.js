// ==UserScript==
// @name         Walmart Restock Watcher
// @namespace    https://github.com/steevka/glitch-todo
// @version      1.4.0
// @description  Watches a Walmart product page (built for the PS5 Pro Open Box) and alerts you with a siren, a desktop notification and a phone push the moment it is in stock under your price. It never buys anything for you.
// @author       steevka
// @match        https://www.walmart.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        window.focus
// @connect      api.pushover.net
// @connect      hc-ping.com
// @updateURL    https://raw.githubusercontent.com/steevka/glitch-todo/glitch/walmart-watcher.user.js
// @downloadURL  https://raw.githubusercontent.com/steevka/glitch-todo/glitch/walmart-watcher.user.js
// @supportURL   https://github.com/steevka/glitch-todo
// ==/UserScript==

(function () {
  'use strict';

  /* ======================================================================
   * Core: pure logic (page parsing, deal rules, scheduling). No browser
   * APIs in here so it can be unit tested in Node (see test/unit.test.js).
   * ==================================================================== */
  const Core = (() => {
    const VERSION = '1.3.0';
    const TZ = 'America/Los_Angeles';
    const MIN_INTERVAL_SEC = 5;

    const DEFAULT_SETTINGS = {
      maxPrice: 600,
      minPrice: 100,
      mode: 'background', // 'background' = fetch page quietly; 'reload' = reload the tab
      peakStart: '07:00', // Pacific time
      peakEnd: '13:00',
      peakMinSec: 15,
      peakMaxSec: 25,
      offMinSec: 45,
      offMaxSec: 75,
      requireWalmartSeller: true,
      requireOpenBox: false,
      pushoverUser: '', // your Pushover user key (30 characters)
      pushoverToken: '', // API token of a Pushover application you create
      healthcheckUrl: '', // healthchecks.io ping URL; pinged about once a minute while watching
      sound: true,
      volume: 0.7,
      desktopNotify: true,
      openTabOnFound: true,
      autoResumeMin: 15,
      heartbeatHour: 7, // Pacific hour for the daily "still running" push; -1 = off
      blockedRetryMin: 10,
      keepAwake: false,
    };

    // ---------- small helpers ----------
    function parseMoney(v) {
      if (v === null || v === undefined || v === '') return null;
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      const m = String(v).match(/-?\d[\d,]*(?:\.\d+)?/);
      if (!m) return null;
      const n = parseFloat(m[0].replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }

    function fmtMoney(n) {
      return n === null || n === undefined ? '?' : '$' + Number(n).toFixed(2);
    }

    function clampNum(v, lo, hi, fallback) {
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(hi, Math.max(lo, n));
    }

    function safeJson(text) {
      try {
        return JSON.parse(String(text).trim());
      } catch (e) {
        return null;
      }
    }

    function dig(obj, path) {
      let cur = obj;
      for (const k of path) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = cur[k];
      }
      return cur;
    }

    // Iterative depth-first search with node/depth caps (pages are big).
    function deepFindAll(root, pred, { maxDepth = 12, maxNodes = 200000, limit = 20, skipRoot = false } = {}) {
      const out = [];
      const stack = [[root, 0]];
      let seen = 0;
      while (stack.length && seen < maxNodes && out.length < limit) {
        const [node, depth] = stack.pop();
        seen++;
        if (!node || typeof node !== 'object') continue;
        if (!(skipRoot && node === root) && !Array.isArray(node)) {
          let hit = false;
          try {
            hit = pred(node);
          } catch (e) {
            hit = false;
          }
          if (hit) out.push(node);
        }
        if (depth >= maxDepth) continue;
        const vals = Array.isArray(node) ? node : Object.values(node);
        for (let i = vals.length - 1; i >= 0; i--) {
          if (vals[i] && typeof vals[i] === 'object') stack.push([vals[i], depth + 1]);
        }
      }
      return out;
    }

    // ---------- settings ----------
    function normalizeSettings(raw, floorSec = MIN_INTERVAL_SEC) {
      const d = DEFAULT_SETTINGS;
      const r = Object.assign({}, d, raw || {});
      const s = {};
      s.maxPrice = clampNum(r.maxPrice, 0, 100000, d.maxPrice);
      s.minPrice = clampNum(r.minPrice, 0, s.maxPrice, Math.min(d.minPrice, s.maxPrice));
      s.mode = r.mode === 'reload' ? 'reload' : 'background';
      s.peakStart = /^\d{1,2}:\d{2}$/.test(String(r.peakStart)) ? String(r.peakStart) : d.peakStart;
      s.peakEnd = /^\d{1,2}:\d{2}$/.test(String(r.peakEnd)) ? String(r.peakEnd) : d.peakEnd;
      s.peakMinSec = clampNum(r.peakMinSec, floorSec, 3600, Math.max(floorSec, d.peakMinSec));
      s.peakMaxSec = clampNum(r.peakMaxSec, s.peakMinSec, 3600, Math.max(s.peakMinSec, d.peakMaxSec));
      s.offMinSec = clampNum(r.offMinSec, floorSec, 3600, Math.max(floorSec, d.offMinSec));
      s.offMaxSec = clampNum(r.offMaxSec, s.offMinSec, 3600, Math.max(s.offMinSec, d.offMaxSec));
      s.requireWalmartSeller = !!r.requireWalmartSeller;
      s.requireOpenBox = !!r.requireOpenBox;
      const key = (v) => {
        const t = String(v || '').trim();
        return /^[A-Za-z0-9]{30}$/.test(t) ? t : '';
      };
      s.pushoverUser = key(r.pushoverUser);
      s.pushoverToken = key(r.pushoverToken);
      const hc = String(r.healthcheckUrl || '').trim();
      s.healthcheckUrl = /^https:\/\/[^\s/]+\.[^\s]+$/.test(hc) ? hc : '';
      s.sound = !!r.sound;
      s.volume = clampNum(r.volume, 0, 1, d.volume);
      s.desktopNotify = !!r.desktopNotify;
      s.openTabOnFound = !!r.openTabOnFound;
      s.autoResumeMin = clampNum(r.autoResumeMin, 0, 24 * 60, d.autoResumeMin);
      s.heartbeatHour = Math.round(clampNum(r.heartbeatHour, -1, 23, d.heartbeatHour));
      s.blockedRetryMin = clampNum(r.blockedRetryMin, 2, 240, d.blockedRetryMin);
      s.keepAwake = !!r.keepAwake;
      return s;
    }

    // ---------- time / scheduling ----------
    let dtf = null;
    function timeParts(date) {
      if (!dtf) {
        dtf = new Intl.DateTimeFormat('en-US', {
          timeZone: TZ,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        });
      }
      const p = {};
      for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
      const hour = parseInt(p.hour, 10) % 24;
      const minute = parseInt(p.minute, 10);
      return { dateKey: `${p.year}-${p.month}-${p.day}`, hour, minute, minutes: hour * 60 + minute };
    }

    function hhmmToMinutes(s) {
      const [h, m] = String(s).split(':').map((x) => parseInt(x, 10));
      return ((h % 24) * 60 + (m % 60) + 1440) % 1440;
    }

    function inWindow(minutes, start, end) {
      if (start === end) return true;
      if (start < end) return minutes >= start && minutes < end;
      return minutes >= start || minutes < end; // window wraps midnight
    }

    function isPeak(settings, date) {
      return inWindow(timeParts(date).minutes, hhmmToMinutes(settings.peakStart), hhmmToMinutes(settings.peakEnd));
    }

    function nextDelayMs(settings, date, consecutiveErrors = 0, rand = Math.random) {
      const peak = isPeak(settings, date);
      const lo = peak ? settings.peakMinSec : settings.offMinSec;
      const hi = peak ? settings.peakMaxSec : settings.offMaxSec;
      let sec = lo + (hi - lo) * rand();
      if (consecutiveErrors > 0) sec = Math.min(sec * Math.pow(2, Math.min(consecutiveErrors, 6)), 15 * 60);
      return { ms: Math.round(sec * 1000), peak };
    }

    // ---------- URLs ----------
    const KEEP_PARAMS = ['conditionGroupCode', 'selectedSellerId', 'selected'];

    function itemIdFromUrl(url) {
      try {
        const u = new URL(url, 'https://www.walmart.com');
        const m = u.pathname.match(/^\/ip\/(?:[^/]+\/)*?(\d{4,})\/?$/);
        return m ? m[1] : null;
      } catch (e) {
        return null;
      }
    }

    function canonicalUrl(url) {
      const u = new URL(url, 'https://www.walmart.com');
      const q = new URLSearchParams();
      for (const k of KEEP_PARAMS) if (u.searchParams.has(k)) q.set(k, u.searchParams.get(k));
      const qs = q.toString();
      return u.origin + u.pathname + (qs ? '?' + qs : '');
    }

    // ---------- page parsing ----------
    function scriptBodies(html, attrTest) {
      const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
      const out = [];
      let m;
      while ((m = re.exec(html))) if (attrTest(m[1])) out.push(m[2]);
      return out;
    }

    function nextAvailable(status) {
      const a = String(status || '').toUpperCase().replace(/[\s-]+/g, '_');
      if (!a) return null;
      if (/OUT_OF_STOCK|UNAVAILABLE|NOT_AVAILABLE|DISCONTINUED|NOT_IN_STOCK|SOLD_OUT|OUTOFSTOCK/.test(a)) return false;
      if (/IN_STOCK|INSTOCK|LIMITED|AVAILABLE/.test(a)) return true;
      return null;
    }

    function ldAvailable(v) {
      const a = String(v || '').replace(/^https?:\/\/schema\.org\//i, '');
      if (!a) return null;
      if (/^(InStock|LimitedAvailability|OnlineOnly)$/i.test(a)) return true;
      if (/OutOfStock|SoldOut|Discontinued|InStoreOnly|PreOrder|PreSale|BackOrder/i.test(a)) return false;
      return null;
    }

    // A condition label on the object itself, e.g. {conditionType: "Open box"}
    // or {condition: {name: "Open box"}}. Codes/ids are ignored.
    function ownCondition(obj) {
      if (!obj || typeof obj !== 'object') return null;
      for (const k of Object.keys(obj)) {
        if (!/condition/i.test(k) || /(code|id)$/i.test(k)) continue;
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) return v.trim().replace(/^https?:\/\/schema\.org\//i, '');
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const nk of ['name', 'displayName', 'label', 'title', 'value', 'type']) {
            if (typeof v[nk] === 'string' && v[nk].trim()) return v[nk].trim();
          }
        }
      }
      return null;
    }

    function sellerOf(obj) {
      if (!obj || typeof obj !== 'object') return null;
      const direct = obj.sellerDisplayName || obj.sellerName;
      if (typeof direct === 'string' && direct.trim()) return direct.trim();
      const s = obj.seller;
      if (typeof s === 'string' && s.trim()) return s.trim();
      if (s && typeof s === 'object') {
        const n = s.name || s.displayName || s.sellerDisplayName || s.sellerName;
        if (typeof n === 'string' && n.trim()) return n.trim();
      }
      return null;
    }

    function priceOf(obj) {
      if (!obj || typeof obj !== 'object') return null;
      const pi = obj.priceInfo;
      const candidates = [
        dig(pi, ['currentPrice', 'price']),
        dig(pi, ['currentPrice', 'priceString']),
        dig(obj, ['currentPrice', 'price']),
        typeof obj.price === 'number' || typeof obj.price === 'string' ? obj.price : undefined,
      ];
      for (const c of candidates) {
        const n = parseMoney(c);
        if (n !== null) return n;
      }
      return null;
    }

    function findNextProduct(data, itemId) {
      const direct = dig(data, ['props', 'pageProps', 'initialData', 'data', 'product']);
      if (direct && typeof direct === 'object' && (direct.priceInfo || direct.availabilityStatus || direct.name)) {
        return { product: direct, path: 'props.pageProps.initialData.data.product' };
      }
      if (!itemId) return null;
      const hits = deepFindAll(
        data,
        (o) => String(o.usItemId) === String(itemId) && 'availabilityStatus' in o && !!o.priceInfo,
        { limit: 1 }
      );
      return hits.length ? { product: hits[0], path: 'search:usItemId' } : null;
    }

    function nextOffers(product) {
      const offers = [];
      const primary = {
        source: 'next-data',
        price: priceOf(product),
        availability: product.availabilityStatus || null,
        available: nextAvailable(product.availabilityStatus),
        seller: sellerOf(product),
        condition: ownCondition(product),
        confidence: 'high',
      };
      if (primary.price !== null || primary.available !== null) offers.push(primary);

      // Extra offers nested inside the product that are explicitly Open Box
      // (e.g. a "more seller options" list). Variants/carousels are ignored
      // because they don't carry an open-box condition label.
      const nested = deepFindAll(
        product,
        (o) => {
          const hasAvail = 'availabilityStatus' in o || 'availability' in o;
          if (!hasAvail || priceOf(o) === null) return false;
          const c = ownCondition(o);
          return !!c && /open[\s-]?box/i.test(c);
        },
        { skipRoot: true, maxDepth: 8, maxNodes: 50000, limit: 10 }
      );
      for (const o of nested) {
        const status = o.availabilityStatus || o.availability;
        offers.push({
          source: 'next-data:open-box-offer',
          price: priceOf(o),
          availability: status || null,
          available: nextAvailable(status) ?? ldAvailable(status),
          seller: sellerOf(o),
          condition: ownCondition(o),
          confidence: 'high',
        });
      }
      return offers;
    }

    function findLdProduct(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 6) return null;
      if (Array.isArray(node)) {
        for (const n of node) {
          const r = findLdProduct(n, depth + 1);
          if (r) return r;
        }
        return null;
      }
      const t = node['@type'];
      if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) return node;
      if (node['@graph']) return findLdProduct(node['@graph'], depth + 1);
      return null;
    }

    function ldOffers(product) {
      let raw = product.offers;
      if (!raw) return [];
      if (!Array.isArray(raw)) raw = [raw];
      const flat = [];
      for (const o of raw) {
        if (!o || typeof o !== 'object') continue;
        if (Array.isArray(o.offers) && o.offers.length) flat.push(...o.offers);
        else flat.push(o);
      }
      return flat.slice(0, 10).map((o) => ({
        source: 'json-ld',
        price: parseMoney(o.price ?? o.lowPrice ?? dig(o, ['priceSpecification', 'price'])),
        availability: o.availability || null,
        available: ldAvailable(o.availability),
        seller: sellerOf(o),
        condition: ownCondition(o) || ownCondition(product),
        confidence: 'high',
      }));
    }

    function microdataOffers(html) {
      const priceTag = html.match(/<[^>]*itemprop=["']price["'][^>]*>/i);
      if (!priceTag) return [];
      const price = parseMoney((priceTag[0].match(/content=["']([^"']+)["']/i) || [])[1]);
      const availTag = html.match(/<[^>]*itemprop=["']availability["'][^>]*>/i);
      const availRaw = availTag ? (availTag[0].match(/(?:href|content)=["']([^"']+)["']/i) || [])[1] : null;
      if (price === null) return [];
      return [
        {
          source: 'microdata',
          price,
          availability: availRaw || null,
          available: ldAvailable(availRaw),
          seller: null,
          condition: null,
          confidence: 'low',
        },
      ];
    }

    function pathOf(url) {
      try {
        return new URL(url, 'https://www.walmart.com').pathname;
      } catch (e) {
        return '';
      }
    }

    function looksBlocked(html, url, status) {
      if (/^\/blocked/i.test(pathOf(url))) return true;
      if (status === 429 || status === 412) return true;
      return /px-captcha|Robot or human\?|Activate and hold the button/i.test(html || '');
    }

    // Summarize an object's structure (keys + short values) for debug reports.
    function shape(v, depth = 3) {
      if (v === null || typeof v !== 'object') {
        return typeof v === 'string' && v.length > 80 ? v.slice(0, 77) + '...' : v;
      }
      if (depth <= 0) return Array.isArray(v) ? `[array(${v.length})]` : '{...}';
      if (Array.isArray(v)) return v.length ? [shape(v[0], depth - 1), `(${v.length} items)`] : [];
      const out = {};
      for (const k of Object.keys(v).slice(0, 80)) out[k] = shape(v[k], depth - 1);
      return out;
    }

    function analyze(html, opts = {}) {
      html = String(html || '');
      const url = opts.url || '';
      const res = {
        at: Date.now(),
        blocked: false,
        name: null,
        itemId: opts.itemId || itemIdFromUrl(url) || null,
        offers: [],
        sources: [],
        notes: [],
      };
      if (/^\/blocked/i.test(pathOf(url))) {
        res.blocked = true;
        res.notes.push('redirected to /blocked');
        return res;
      }

      const nd = scriptBodies(html, (a) => /__NEXT_DATA__/.test(a))[0];
      if (nd) {
        const data = safeJson(nd);
        if (!data) res.notes.push('__NEXT_DATA__ present but not valid JSON');
        else {
          const found = findNextProduct(data, res.itemId);
          if (found) {
            res.sources.push('next-data');
            res.name = typeof found.product.name === 'string' ? found.product.name : null;
            res.offers.push(...nextOffers(found.product));
            if (opts.debug) res.debug = { nextDataPath: found.path, productShape: shape(found.product, 3) };
          } else {
            res.notes.push('no product in __NEXT_DATA__');
            if (opts.debug) res.debug = { nextDataTopShape: shape(data, 4) };
          }
        }
      } else {
        res.notes.push('no __NEXT_DATA__ script');
      }

      for (const body of scriptBodies(html, (a) => /application\/ld\+json/i.test(a))) {
        const p = findLdProduct(safeJson(body));
        if (!p) continue;
        res.sources.push('json-ld');
        if (!res.name && typeof p.name === 'string') res.name = p.name;
        res.offers.push(...ldOffers(p));
        if (opts.debug) (res.debug = res.debug || {}).jsonLd = shape(p, 4);
        break;
      }

      if (!res.offers.length) {
        const md = microdataOffers(html);
        if (md.length) {
          res.sources.push('microdata');
          res.offers.push(...md);
        }
      }

      if (!res.offers.length && looksBlocked(html, url, opts.status)) {
        res.blocked = true;
        res.notes.push('bot check page');
      }
      return res;
    }

    // ---------- deal rules ----------
    function reasonsAgainst(offer, s) {
      const r = [];
      if (offer.available !== true) r.push(offer.available === false ? 'out of stock' : 'stock status unknown');
      if (offer.price === null || offer.price === undefined) r.push('no price');
      else {
        if (offer.price > s.maxPrice) r.push(`${fmtMoney(offer.price)} is above your ${fmtMoney(s.maxPrice)} max`);
        if (offer.price < s.minPrice) r.push(`${fmtMoney(offer.price)} is below your ${fmtMoney(s.minPrice)} minimum`);
      }
      if (s.requireWalmartSeller && offer.seller && !/walmart/i.test(offer.seller)) {
        r.push(`sold by ${offer.seller}, not Walmart`);
      }
      if (s.requireOpenBox && !(offer.condition && /open[\s-]?box/i.test(offer.condition))) {
        r.push(offer.condition ? `condition is "${offer.condition}"` : 'condition unknown');
      }
      return r;
    }

    function evaluate(res, s) {
      if (res.blocked) {
        return { status: 'blocked', deal: false, best: null, matches: [], summary: 'Walmart showed a bot check' };
      }
      if (!res.offers.length) {
        return {
          status: 'unknown',
          deal: false,
          best: null,
          matches: [],
          summary: "Couldn't read price/stock from the page",
        };
      }
      const checked = res.offers.map((o) => ({ offer: o, reasons: reasonsAgainst(o, s) }));
      const matches = checked
        .filter((c) => !c.reasons.length)
        .map((c) => c.offer)
        .sort((a, b) => a.price - b.price);
      if (matches.length) {
        const b = matches[0];
        return {
          status: 'deal',
          deal: true,
          best: b,
          matches,
          summary: `IN STOCK at ${fmtMoney(b.price)}${b.seller ? ` (sold by ${b.seller})` : ''}`,
        };
      }
      const inStock = checked.find((c) => c.offer.available === true);
      if (inStock) {
        return {
          status: 'in-stock-filtered',
          deal: false,
          best: null,
          matches: [],
          summary: `In stock but skipped: ${inStock.reasons.join('; ')}`,
        };
      }
      const known = res.offers.find((o) => o.available === false);
      if (known) {
        const priced = res.offers.find((o) => o.price !== null);
        return {
          status: 'out-of-stock',
          deal: false,
          best: null,
          matches: [],
          summary: `Out of stock${priced ? ` (listed ${fmtMoney(priced.price)})` : ''}`,
        };
      }
      return { status: 'unknown', deal: false, best: null, matches: [], summary: 'Stock status not shown on the page' };
    }

    // ---------- history ----------
    // Kept per item and never wiped by Stop: every time the item showed up
    // in stock (including ones skipped by your rules), checks per day, and
    // gaps when the watcher wasn't checking (Mac asleep, Chrome closed...).
    const HISTORY_LIMITS = { sightings: 200, gaps: 200, days: 90 };

    function emptyHistory() {
      return { v: 1, since: null, lastCheckAt: null, sightings: [], days: {}, gaps: [] };
    }

    function copyHistory(hist) {
      const h = Object.assign(emptyHistory(), hist || {});
      h.sightings = (h.sightings || []).slice();
      h.gaps = (h.gaps || []).slice();
      h.days = Object.assign({}, h.days);
      return h;
    }

    // How long without a check counts as "not watching". Error backoff can
    // legitimately wait up to 15 minutes.
    function gapThresholdMs(settings, consecutiveErrors = 0) {
      if (consecutiveErrors > 0) return 16 * 60000;
      return Math.max(5 * 60000, settings.offMaxSec * 4000, settings.peakMaxSec * 4000);
    }

    function openSighting(h) {
      const last = h.sightings[h.sightings.length - 1];
      return last && last.end === null ? last : null;
    }

    // status: one of evaluate()'s statuses, or 'error'. offer: the in-stock
    // offer when status is 'deal' or 'in-stock-filtered'.
    function recordCheck(hist, { at, status, offer, summary, gapMs }) {
      const h = copyHistory(hist);
      if (!h.since) h.since = at;
      if (h.lastCheckAt && gapMs && at - h.lastCheckAt > gapMs) {
        h.gaps.push({ from: h.lastCheckAt, to: at });
        if (h.gaps.length > HISTORY_LIMITS.gaps) h.gaps.splice(0, h.gaps.length - HISTORY_LIMITS.gaps);
      }
      h.lastCheckAt = at;

      const dk = timeParts(new Date(at)).dateKey;
      const d = Object.assign({ checks: 0, inStock: 0, blocks: 0, errors: 0, unknown: 0, first: at, last: at }, h.days[dk]);
      d.checks++;
      d.last = at;
      if (status === 'blocked') d.blocks++;
      else if (status === 'error') d.errors++;
      else if (status === 'unknown') d.unknown++;
      const available = status === 'deal' || status === 'in-stock-filtered';
      if (available) d.inStock++;
      h.days[dk] = d;
      const keys = Object.keys(h.days).sort();
      while (keys.length > HISTORY_LIMITS.days) delete h.days[keys.shift()];

      const open = openSighting(h);
      const idx = h.sightings.length - 1;
      if (available) {
        const o = offer || {};
        const price = o.price ?? null;
        const seller = o.seller || null;
        if (open && open.price === price && open.seller === seller) {
          const upd = Object.assign({}, open, { lastSeen: at, checks: (open.checks || 1) + 1 });
          if (status === 'deal' && !open.matched) Object.assign(upd, { matched: true, note: null });
          h.sightings[idx] = upd;
        } else {
          if (open) h.sightings[idx] = Object.assign({}, open, { end: at });
          h.sightings.push({
            start: at,
            lastSeen: at,
            end: null,
            price,
            seller,
            condition: o.condition || null,
            matched: status === 'deal',
            note: status === 'deal' ? null : String(summary || '').replace(/^In stock but skipped:\s*/i, '') || null,
            checks: 1,
            alerted: false,
            response: null,
            responseAt: null,
          });
          if (h.sightings.length > HISTORY_LIMITS.sightings) {
            h.sightings.splice(0, h.sightings.length - HISTORY_LIMITS.sightings);
          }
        }
      } else if (status === 'out-of-stock' && open) {
        h.sightings[idx] = Object.assign({}, open, { end: at });
      }
      return h;
    }

    // Watching was paused on purpose (found, stopped): the silence until the
    // next check is not a gap.
    function markResumed(hist) {
      return Object.assign(copyHistory(hist), { lastCheckAt: null });
    }

    function updateLatestSighting(hist, patch) {
      const h = copyHistory(hist);
      const i = h.sightings.length - 1;
      if (i >= 0) h.sightings[i] = Object.assign({}, h.sightings[i], patch);
      return h;
    }

    function historySummary(hist, fromT = 0) {
      const h = copyHistory(hist);
      const sightings = h.sightings.filter((x) => x.lastSeen >= fromT);
      const gaps = h.gaps.filter((g) => g.to >= fromT);
      const gapMs = gaps.reduce((a, g) => a + (g.to - Math.max(g.from, fromT)), 0);
      let checks = 0;
      for (const d of Object.values(h.days)) if (d.last >= fromT) checks += d.checks;
      return { sightings, matched: sightings.filter((x) => x.matched), gaps, gapMs, checks };
    }

    function dealKey(offer) {
      return offer ? `${offer.price}|${offer.seller || ''}|${offer.condition || ''}` : '';
    }

    return {
      VERSION,
      TZ,
      MIN_INTERVAL_SEC,
      DEFAULT_SETTINGS,
      parseMoney,
      fmtMoney,
      normalizeSettings,
      timeParts,
      hhmmToMinutes,
      inWindow,
      isPeak,
      nextDelayMs,
      itemIdFromUrl,
      canonicalUrl,
      analyze,
      evaluate,
      reasonsAgainst,
      dealKey,
      emptyHistory,
      gapThresholdMs,
      recordCheck,
      markResumed,
      updateLatestSighting,
      historySummary,
      looksBlocked,
    };
  })();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Core;
    return;
  }

  /* ======================================================================
   * App: runs inside Tampermonkey on walmart.com.
   * ==================================================================== */
  const FLOOR_SEC = window.__WW_TEST_FAST__ ? 0.2 : Core.MIN_INTERVAL_SEC;
  const TAG = '[Walmart Watcher]';

  const Store = {
    get(k, d) {
      try {
        const v = GM_getValue(k);
        return v === undefined || v === null ? d : v;
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        GM_setValue(k, v);
      } catch (e) {
        console.warn(TAG, 'storage failed', e);
      }
    },
    listen(k, fn) {
      try {
        return GM_addValueChangeListener(k, fn);
      } catch (e) {
        return null;
      }
    },
    unlisten(id) {
      try {
        if (id !== null && id !== undefined) GM_removeValueChangeListener(id);
      } catch (e) {
        /* ignore */
      }
    },
  };

  // A per-tab id that survives reloads (sessionStorage). Chrome copies
  // sessionStorage into duplicated tabs, so a copy that hears another live
  // tab answer to the same id picks a new one.
  const newTabId = () => Math.random().toString(36).slice(2, 10);
  let TAB_ID = (() => {
    try {
      let id = sessionStorage.getItem('ww:tab');
      if (!id) {
        id = newTabId();
        sessionStorage.setItem('ww:tab', id);
      }
      return id;
    } catch (e) {
      return newTabId();
    }
  })();
  try {
    const bc = new BroadcastChannel('walmart-restock-watcher');
    const nonce = newTabId();
    bc.onmessage = (e) => {
      const m = e.data || {};
      if (m.q === TAB_ID && m.nonce !== nonce) bc.postMessage({ dup: TAB_ID, to: m.nonce });
      if (m.dup === TAB_ID && m.to === nonce) {
        TAB_ID = newTabId();
        try {
          sessionStorage.setItem('ww:tab', TAB_ID);
        } catch (err) {
          /* ignore */
        }
      }
    };
    bc.postMessage({ q: TAB_ID, nonce });
  } catch (e) {
    /* BroadcastChannel unavailable: duplicates are rare, ignore */
  }

  function addLog(msg, level = 'info') {
    const L = Store.get('log', []);
    L.push({ t: Date.now(), msg, level });
    while (L.length > 150) L.shift();
    Store.set('log', L);
    (level === 'warn' ? console.warn : console.log)(TAG, msg);
  }

  function getSettings() {
    const raw = Store.get('settings', {});
    return Core.normalizeSettings(raw, FLOOR_SEC);
  }

  function saveSettings(patch) {
    const merged = Object.assign({}, Store.get('settings', {}), patch);
    Store.set('settings', Core.normalizeSettings(merged, FLOOR_SEC));
  }

  // ---------- timers that survive background-tab throttling ----------
  // Chrome slows timers in hidden tabs (down to once a minute). Timers in a
  // Web Worker are not throttled that way, so use one when the page allows
  // it, with a normal setTimeout as a backstop.
  const Timer = (() => {
    let worker = null;
    let seq = 0;
    const pending = new Map();
    try {
      const src =
        'const t=new Map();onmessage=e=>{const d=e.data;if(d.cancel){clearTimeout(t.get(d.id));t.delete(d.id);return;}' +
        't.set(d.id,setTimeout(()=>{t.delete(d.id);postMessage(d.id)},d.ms))}';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = (e) => fire(e.data);
      worker.onerror = () => {
        worker = null;
      };
    } catch (e) {
      worker = null;
    }
    function fire(id) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.backstop);
      try {
        p.fn();
      } catch (e) {
        console.error(TAG, e);
      }
    }
    function after(ms, fn) {
      const id = ++seq;
      const entry = { fn, backstop: null };
      pending.set(id, entry);
      if (worker) {
        try {
          worker.postMessage({ id, ms });
        } catch (e) {
          worker = null;
        }
      }
      // Backstop: fires if the worker is unavailable or silently dead.
      entry.backstop = setTimeout(() => fire(id), worker ? ms + 5000 : ms);
      return () => {
        pending.delete(id);
        clearTimeout(entry.backstop);
        if (worker) {
          try {
            worker.postMessage({ id, cancel: true });
          } catch (e) {
            /* ignore */
          }
        }
      };
    }
    return { after, get usingWorker() { return !!worker; } };
  })();

  // ---------- alerts ----------
  const Sound = {
    ctx: null,
    siren: null,
    onChange: null,
    get armed() {
      return !!this.ctx && this.ctx.state === 'running';
    },
    unlock() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!this.ctx) {
          this.ctx = new AC();
          this.ctx.onstatechange = () => this.onChange && this.onChange();
        }
        if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      } catch (e) {
        /* ignore */
      }
    },
    tone(freq, start, dur, vol) {
      const c = this.ctx;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(vol, start + 0.01);
      g.gain.setValueAtTime(vol, start + dur - 0.02);
      g.gain.linearRampToValueAtTime(0, start + dur);
      o.connect(g);
      g.connect(c.destination);
      o.start(start);
      o.stop(start + dur + 0.02);
    },
    startSiren(volume, maxMs = 10 * 1000) {
      this.stopSiren();
      this.unlock();
      if (!this.ctx) return false;
      const play = () => {
        if (!this.armed) return;
        const t = this.ctx.currentTime + 0.02;
        for (let i = 0; i < 6; i++) this.tone(i % 2 ? 660 : 990, t + i * 0.2, 0.18, volume * 0.5);
      };
      play();
      this.siren = { iv: setInterval(play, 1600), to: setTimeout(() => this.stopSiren(), maxMs) };
      return this.armed;
    },
    stopSiren() {
      if (!this.siren) return;
      clearInterval(this.siren.iv);
      clearTimeout(this.siren.to);
      this.siren = null;
    },
  };

  const TitleFlash = {
    iv: null,
    orig: null,
    start(text, maxMs = 0) {
      this.stop();
      this.orig = document.title;
      let on = false;
      this.iv = setInterval(() => {
        on = !on;
        document.title = on ? text : this.orig;
      }, 1000);
      if (maxMs) setTimeout(() => this.stop(), maxMs);
    },
    stop() {
      if (!this.iv) return;
      clearInterval(this.iv);
      this.iv = null;
      document.title = this.orig || document.title;
    },
  };

  const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

  // Pushes are written with a 1–5 priority (5 = urgent). Pushover uses -2..2;
  // we cap at 1 ("high", bypasses quiet hours) so each push alerts exactly once.
  // Pushover's 2 ("emergency") repeats until acknowledged, which is useless
  // for an item that sells out in seconds.
  function pushoverPriority(p) {
    return Math.max(-2, Math.min(1, Math.round((typeof p === 'number' ? p : 3) - 3)));
  }

  function pushOnce(payload) {
    const s = getSettings();
    return new Promise((resolve) => {
      if (!s.pushoverUser || !s.pushoverToken) return resolve('Pushover keys not set');
      const prio = pushoverPriority(payload.priority);
      const form = new URLSearchParams({
        token: s.pushoverToken,
        user: s.pushoverUser,
        title: payload.title || '',
        message: payload.message || '',
        priority: String(prio),
      });
      if (payload.click) {
        form.set('url', payload.click);
        form.set('url_title', 'Open the Walmart listing');
      }
      if (payload.priority >= 5) form.set('sound', 'siren');
      try {
        GM_xmlhttpRequest({
          method: 'POST',
          url: PUSHOVER_URL,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          data: form.toString(),
          timeout: 15000,
          onload: (r) => {
            if (r.status >= 200 && r.status < 300) return resolve(true);
            let errors = null;
            try {
              errors = JSON.parse(r.responseText).errors;
            } catch (e) {
              /* not JSON */
            }
            resolve(Array.isArray(errors) && errors.length ? errors.join('; ') : `HTTP ${r.status}`);
          },
          onerror: () => resolve('network error'),
          ontimeout: () => resolve('timed out'),
        });
      } catch (e) {
        resolve(e.message || 'unavailable');
      }
    });
  }

  // Phone push via Pushover. An urgent push that fails to send is retried a few
  // times; one that gets through is never repeated.
  async function push(payload) {
    const tries = payload.priority >= 5 ? 4 : 1;
    let result;
    for (let i = 0; i < tries; i++) {
      result = await pushOnce(payload);
      if (result === true) {
        Store.set('lastPush', { t: Date.now(), ok: true, title: payload.title });
        return true;
      }
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
    Store.set('lastPush', { t: Date.now(), ok: false, error: String(result), title: payload.title });
    addLog(`Phone push failed (${result})`, 'warn');
    return false;
  }

  // Dead-man's switch: healthchecks.io alerts you when these pings stop
  // (Mac asleep, Chrome closed, tab unloaded, watcher stopped).
  const HC_EVERY_MS = 60000;
  let lastHcAttempt = 0;
  function pingHealthcheck(force = false) {
    const s = getSettings();
    if (!s.healthcheckUrl) return Promise.resolve('no URL set');
    if (!force && Date.now() - lastHcAttempt < HC_EVERY_MS) return Promise.resolve('skipped');
    lastHcAttempt = Date.now();
    return new Promise((resolve) => {
      const done = (ok, error) => {
        const prev = Store.get('lastHcPing', null);
        Store.set('lastHcPing', ok ? { t: Date.now(), ok: true } : { t: Date.now(), ok: false, error });
        if (!ok && (!prev || prev.ok)) addLog(`Health check ping failed (${error})`, 'warn');
        if (ok && prev && !prev.ok) addLog('Health check ping working again');
        resolve(ok ? true : error);
      };
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: s.healthcheckUrl,
          timeout: 10000,
          onload: (r) => (r.status >= 200 && r.status < 300 ? done(true) : done(false, `HTTP ${r.status}`)),
          onerror: () => done(false, 'network error'),
          ontimeout: () => done(false, 'timed out'),
        });
      } catch (e) {
        done(false, e.message || 'unavailable');
      }
    });
  }

  function desktopNotify(title, text) {
    try {
      GM_notification({
        title,
        text,
        silent: false,
        highlight: true,
        onclick: () => {
          try {
            window.focus();
          } catch (e) {
            /* ignore */
          }
        },
      });
    } catch (e) {
      /* ignore */
    }
  }

  function openTab(url) {
    try {
      GM_openInTab(url, { active: true, insert: true, setParent: true });
    } catch (e) {
      window.open(url, '_blank');
    }
  }

  // Outline the Buy now / Add to cart button on a live product page.
  function highlightBuyButton(timeoutMs = 15000) {
    const t0 = Date.now();
    const tryOnce = () => {
      const els = Array.from(document.querySelectorAll('button, a[role="button"], [data-automation-id]'));
      const target =
        els.find((el) => /^\s*buy now\s*$/i.test(el.textContent || '') && el.offsetParent !== null) ||
        els.find((el) => /^\s*add to cart\s*$/i.test(el.textContent || '') && el.offsetParent !== null);
      if (target) {
        target.style.outline = '5px solid #16a34a';
        target.style.outlineOffset = '3px';
        target.style.boxShadow = '0 0 0 10px rgba(22,163,74,.25)';
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (Date.now() - t0 < timeoutMs) setTimeout(tryOnce, 500);
    };
    tryOnce();
  }

  const WakeLock = {
    lock: null,
    async want(on) {
      try {
        if (!on) {
          if (this.lock) await this.lock.release();
          this.lock = null;
          return;
        }
        if (!this.lock && navigator.wakeLock && document.visibilityState === 'visible') {
          this.lock = await navigator.wakeLock.request('screen');
          this.lock.addEventListener('release', () => {
            this.lock = null;
          });
        }
      } catch (e) {
        this.lock = null;
      }
    },
  };

  // ---------- tiny DOM builder (no innerHTML, so page CSP/Trusted Types can't break it) ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  }

  const CSS = `
    :host { all: initial; }
    .ww { position: fixed; left: 16px; bottom: 16px; z-index: 2147483647; width: 360px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 32px); overflow: auto; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0f172a; background: #fff; border: 1px solid #cbd5e1; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
    .ww.min { width: auto; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; user-select: none;
      border-bottom: 1px solid #e2e8f0; }
    .ww.min .head { border-bottom: 0; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #94a3b8; flex: none; }
    .title { font-weight: 700; flex: 1; white-space: nowrap; }
    .badge { font-size: 11px; font-weight: 700; letter-spacing: .04em; padding: 2px 8px; border-radius: 999px; background: #e2e8f0; color: #334155; }
    .st-watching .dot { background: #2563eb; animation: pulse 2s infinite; }
    .st-watching .badge { background: #dbeafe; color: #1d4ed8; }
    .st-found .dot { background: #16a34a; }
    .st-found .badge { background: #16a34a; color: #fff; }
    .st-found { border: 3px solid #16a34a; }
    .st-blocked .dot { background: #ea580c; }
    .st-blocked .badge { background: #ffedd5; color: #c2410c; }
    .st-follower .dot { background: #64748b; }
    @keyframes pulse { 50% { opacity: .35; } }
    .body { padding: 10px 12px 12px; display: grid; gap: 8px; }
    .ww.min .body { display: none; }
    .name { font-weight: 600; color: #334155; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .big { font-size: 15px; font-weight: 700; }
    .found-banner { background: #16a34a; color: #fff; border-radius: 8px; padding: 10px; font-size: 16px; font-weight: 800; text-align: center; }
    .meta { color: #475569; font-size: 12px; }
    .warn { background: #fff7ed; color: #9a3412; border: 1px solid #fed7aa; border-radius: 8px; padding: 6px 8px; font-size: 12px; }
    .note { background: #f1f5f9; color: #334155; border-radius: 8px; padding: 6px 8px; font-size: 12px; }
    .btns { display: flex; flex-wrap: wrap; gap: 6px; }
    button { font: inherit; font-weight: 600; border: 1px solid #cbd5e1; background: #f8fafc; color: #0f172a; border-radius: 8px;
      padding: 6px 10px; cursor: pointer; }
    button:hover { background: #eef2f7; }
    button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
    button.go { background: #16a34a; border-color: #16a34a; color: #fff; }
    button.danger { color: #b91c1c; }
    .settings { display: grid; gap: 6px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
    .settings label { display: grid; grid-template-columns: 1fr 120px; align-items: center; gap: 8px; font-size: 12px; }
    .settings label.chk { grid-template-columns: 1fr auto; }
    .settings input, .settings select { font: inherit; padding: 4px 6px; border: 1px solid #cbd5e1; border-radius: 6px; width: 100%; box-sizing: border-box; }
    .settings input[type=checkbox] { width: auto; }
    .settings h4 { margin: 6px 0 0; font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: .05em; }
    .seen { font-size: 12px; color: #475569; }
    .seen-hit { color: #15803d; font-weight: 700; }
    .history { display: grid; gap: 4px; border-top: 1px solid #e2e8f0; padding-top: 8px; font-size: 12px; }
    .history h4 { margin: 6px 0 0; font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: .05em; }
    .sight { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 6px 8px; }
    .sight.hit { background: #f0fdf4; border-color: #86efac; }
    .day { color: #334155; }
    .day.gap { color: #c2410c; }
    .log { border-top: 1px solid #e2e8f0; padding-top: 6px; font-size: 11px; color: #475569; display: grid; gap: 2px; max-height: 120px; overflow: auto; }
    .log .warn-line { color: #c2410c; }
    .log .deal-line { color: #15803d; font-weight: 700; }
  `;

  function fmtTime(t) {
    return t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—';
  }
  function fmtDateTime(t) {
    return t ? new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  }
  function fmtAgo(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  // ---------- floating panel ----------
  class Panel {
    constructor(watcher) {
      this.w = watcher;
      this.showSettings = false;
      this.showHistory = false;
      this.host = h('div', { id: 'walmart-restock-watcher' });
      this.root = this.host.attachShadow({ mode: 'open' });
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        this.root.adoptedStyleSheets = [sheet];
      } catch (e) {
        this.root.appendChild(h('style', { text: CSS }));
      }
      this.box = h('div', { class: 'ww' });
      this.root.appendChild(this.box);
      (document.body || document.documentElement).appendChild(this.host);
      this.minimized = Store.get('panelMinimized', false);
      this.tickIv = setInterval(() => this.renderLive(), 1000);
    }

    destroy() {
      clearInterval(this.tickIv);
      this.host.remove();
    }

    stateClass(w) {
      if (!w || w.status === 'stopped') return 'st-idle';
      if (w.status === 'found') return 'st-found';
      if (w.status === 'blocked') return 'st-blocked';
      if (!this.w.leader) return 'st-follower';
      return 'st-watching';
    }

    badgeText(w) {
      if (!w || w.status === 'stopped') return 'OFF';
      if (w.status === 'found') return 'IN STOCK!';
      if (w.status === 'blocked') return 'BOT CHECK';
      if (!this.w.leader) return 'OTHER TAB';
      return 'WATCHING';
    }

    render() {
      const w = this.w.record;
      const s = getSettings();
      this.box.className = `ww ${this.stateClass(w)}${this.minimized ? ' min' : ''}`;
      const head = h(
        'div',
        {
          class: 'head',
          onclick: () => {
            this.minimized = !this.minimized;
            Store.set('panelMinimized', this.minimized);
            this.render();
          },
        },
        h('span', { class: 'dot' }),
        h('span', { class: 'title', text: 'Restock Watcher' }),
        h('span', { class: 'badge', text: this.badgeText(w) })
      );
      this.live = h('div', { class: 'meta' });
      const body = h('div', { class: 'body' }, this.bodyParts(w, s), this.live);
      // Keep the open settings form across re-renders so typing isn't lost.
      if (this.showSettings) body.appendChild(this.settingsEl || (this.settingsEl = this.settingsForm(s)));
      else this.settingsEl = null;
      if (this.showHistory) body.appendChild(this.historyView());
      body.appendChild(this.logView());
      this.box.replaceChildren(head, body);
      this.renderLive();
    }

    bodyParts(w, s) {
      const parts = [];
      const name = (w && w.name) || this.w.pageName();
      parts.push(h('div', { class: 'name', title: name, text: name }));
      const hist = this.w.history;
      if (hist && hist.since) {
        const sights = hist.sightings || [];
        const last = sights[sights.length - 1];
        parts.push(
          h('div', {
            class: sights.some((x) => x.matched) ? 'seen seen-hit' : 'seen',
            text: last
              ? `Seen in stock ${sights.length}× · last ${fmtDateTime(last.start)} at ${Core.fmtMoney(last.price)}`
              : `Never seen in stock since ${fmtDateTime(hist.since)}`,
          })
        );
      }

      if (!w || w.status === 'stopped') {
        parts.push(
          h('div', { class: 'note', text: `Not watching this item. Alerts when it's in stock at or under ${Core.fmtMoney(s.maxPrice)}.` })
        );
        parts.push(
          h(
            'div',
            { class: 'btns' },
            h('button', { class: 'primary', onclick: () => this.w.startWatching(), text: 'Start watching' }),
            h('button', { onclick: () => this.w.testAlerts(), text: 'Test alerts' }),
            this.settingsButton(),
            this.historyButton()
          )
        );
        return parts;
      }

      if (w.status === 'found') {
        const d = w.lastDeal || {};
        parts.push(h('div', { class: 'found-banner', text: `IN STOCK at ${Core.fmtMoney(d.price)} — go buy it!` }));
        parts.push(
          h(
            'div',
            { class: 'note' },
            `Found at ${fmtTime(w.foundAt)}`,
            d.seller ? ` · sold by ${d.seller}` : '',
            d.condition ? ` · ${d.condition}` : '',
            '. Watching is paused.',
            s.autoResumeMin > 0 ? ` It resumes by itself ${s.autoResumeMin} min after it was found.` : ''
          )
        );
        parts.push(
          h(
            'div',
            { class: 'btns' },
            h('button', { class: 'go', onclick: () => this.w.openProduct(), text: 'Open product page' }),
            !w.ackAt ? h('button', { onclick: () => this.w.acknowledge(), text: 'Stop alarm' }) : null,
            h('button', { class: 'primary', onclick: () => this.w.resume(), text: 'Resume watching' }),
            h('button', { class: 'danger', onclick: () => this.w.stopWatching(), text: 'Stop' }),
            this.historyButton()
          )
        );
        return parts;
      }

      const last = w.last;
      parts.push(h('div', { class: 'big', text: last ? last.summary : 'Starting…' }));
      if (last && (last.status === 'unknown' || last.status === 'blocked')) {
        parts.push(
          h('div', {
            class: 'warn',
            text:
              last.status === 'blocked'
                ? 'Walmart asked for a human check. If a "press and hold" page appears, complete it and watching resumes on its own.'
                : "The page didn't show price/stock info. If this keeps happening, tap Copy debug info and send it over.",
          })
        );
      }
      if (!this.w.leader && w.status === 'watching') {
        parts.push(h('div', { class: 'note', text: 'Another tab is already watching this item, so this tab is idle.' }));
      }
      if (w.status === 'watching' && s.sound && !Sound.armed) {
        parts.push(
          h('div', { class: 'warn' }, 'Alarm sound is off until you click anywhere on this page (a browser rule). ',
            h('button', { onclick: () => { Sound.unlock(); this.render(); }, text: 'Enable sound' }))
        );
      }
      if (this.w.throttleNote) parts.push(h('div', { class: 'warn', text: this.w.throttleNote }));
      const ps = getSettings();
      if (!ps.pushoverUser || !ps.pushoverToken) {
        parts.push(h('div', { class: 'warn', text: 'Phone pushes are off: enter your Pushover user key and app token in Settings.' }));
      }
      const hcp = Store.get('lastHcPing', null);
      if (ps.healthcheckUrl && hcp && !hcp.ok && Date.now() - hcp.t < 3600 * 1000) {
        parts.push(h('div', { class: 'warn', text: `Health check ping failed (${hcp.error}). Check the URL in Settings.` }));
      }
      const lp = Store.get('lastPush', null);
      if (lp && !lp.ok && Date.now() - lp.t < 6 * 3600 * 1000) {
        parts.push(h('div', { class: 'warn', text: `Last phone push failed (${lp.error}). Check the Pushover keys in Settings.` }));
      }
      parts.push(
        h(
          'div',
          { class: 'btns' },
          !this.w.leader && w.status === 'watching'
            ? h('button', { class: 'primary', onclick: () => this.w.takeOver(), text: 'Watch from this tab' })
            : null,
          h('button', { class: 'danger', onclick: () => this.w.stopWatching(), text: 'Stop' }),
          h('button', { onclick: () => this.w.testAlerts(), text: 'Test alerts' }),
          this.settingsButton(),
          this.historyButton(),
          h('button', { onclick: (e) => this.w.copyDebug(e.target), text: 'Copy debug info' })
        )
      );
      return parts;
    }

    historyButton() {
      return h('button', {
        onclick: () => {
          this.showHistory = !this.showHistory;
          this.render();
        },
        text: this.showHistory ? 'Hide history' : 'History',
      });
    }

    historyView() {
      const hist = Object.assign(Core.emptyHistory(), this.w.history || {});
      const box = h('div', { class: 'history' });
      if (!hist.since) {
        box.appendChild(h('div', { class: 'note', text: 'No history yet. It starts with the first check.' }));
        return box;
      }
      const days = Object.keys(hist.days).sort();
      const total = days.reduce((a, k) => a + hist.days[k].checks, 0);
      box.appendChild(
        h('div', { class: 'meta', text: `Recording since ${fmtDateTime(hist.since)} · ${total.toLocaleString()} checks · last check ${fmtDateTime(hist.lastCheckAt)}` })
      );

      box.appendChild(h('h4', { text: 'Times it was in stock' }));
      const sights = hist.sightings.slice(-15).reverse();
      if (!sights.length) {
        box.appendChild(h('div', { class: 'note', text: 'Never seen in stock yet. The daily counts below show it has been checking.' }));
      }
      for (const x of sights) {
        let outcome;
        if (!x.matched) outcome = `Skipped: ${x.note || 'did not match your rules'}`;
        else if (x.alerted) {
          const resp =
            x.response === 'none'
              ? 'no response'
              : x.response
                ? `you ${x.response} at ${fmtTime(x.responseAt)}`
                : 'waiting for you';
          outcome = `Alerted you · ${resp}`;
        } else outcome = x.note ? `Matched · ${x.note}` : 'Matched';
        const seen = x.checks > 1 ? `seen ${x.checks}× over ${fmtAgo(x.lastSeen - x.start)}` : 'seen once';
        const dur = x.end !== null ? `${seen}, gone by ${fmtTime(x.end)}` : `${seen}, still in stock at the last check`;
        box.appendChild(
          h(
            'div',
            { class: x.matched ? 'sight hit' : 'sight' },
            h('b', { text: `${fmtDateTime(x.start)} · ${Core.fmtMoney(x.price)}` }),
            x.seller ? ` · ${x.seller}` : '',
            h('div', { text: `${outcome} · ${dur}` })
          )
        );
      }

      box.appendChild(h('h4', { text: 'Checks per day (Pacific dates)' }));
      for (const k of days.slice(-7).reverse()) {
        const d = hist.days[k];
        const gaps = hist.gaps.filter((g) => Core.timeParts(new Date(g.from)).dateKey === k);
        const gapMs = gaps.reduce((a, g) => a + (g.to - g.from), 0);
        const bits = [`${d.checks.toLocaleString()} checks`];
        if (d.inStock) bits.push(`in stock on ${d.inStock}`);
        if (d.blocks) bits.push(`${d.blocks} bot checks`);
        if (d.errors) bits.push(`${d.errors} errors`);
        if (gapMs) bits.push(`not checking for ${fmtAgo(gapMs)}`);
        const label = new Date(k + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        box.appendChild(h('div', { class: gapMs ? 'day gap' : 'day', text: `${label}: ${bits.join(' · ')}` }));
      }

      const gaps = hist.gaps.slice(-5).reverse();
      if (gaps.length) {
        box.appendChild(h('h4', { text: 'Recent gaps (Mac asleep, Chrome closed, tab away…)' }));
        for (const g of gaps) {
          box.appendChild(h('div', { class: 'day gap', text: `${fmtDateTime(g.from)} → ${fmtDateTime(g.to)} (${fmtAgo(g.to - g.from)})` }));
        }
      }
      box.appendChild(
        h(
          'div',
          { class: 'btns' },
          h('button', { onclick: (e) => this.w.copyHistory(e.target), text: 'Copy history' }),
          h('button', { class: 'danger', onclick: () => this.w.clearHistory(), text: 'Clear history' })
        )
      );
      return box;
    }

    settingsButton() {
      return h('button', {
        onclick: () => {
          this.showSettings = !this.showSettings;
          this.render();
        },
        text: this.showSettings ? 'Hide settings' : 'Settings',
      });
    }

    renderLive() {
      if (!this.live) return;
      const w = this.w.record;
      if (!w || w.status === 'stopped') {
        this.live.textContent = `v${Core.VERSION}`;
        return;
      }
      const st = w.stats || {};
      const bits = [];
      if (w.last) bits.push(`Last check ${fmtTime(w.last.at)}`);
      if (this.w.nextAt && w.status === 'watching' && this.w.leader) {
        bits.push(this.w.reloadPending ? `reload in ${fmtAgo(this.w.nextAt - Date.now())}` : `next in ${fmtAgo(this.w.nextAt - Date.now())}`);
      }
      if (st.since) bits.push(`${st.checks || 0} checks since ${fmtTime(st.since)}`);
      const s = getSettings();
      bits.push(Core.isPeak(s, new Date()) ? 'fast hours' : 'slow hours');
      this.live.textContent = bits.join(' · ');
    }

    settingsForm(s) {
      const inputs = {};
      const num = (key, label, step = 1) =>
        h('label', {}, label, (inputs[key] = h('input', { type: 'number', step: String(step), value: String(s[key]) })));
      const txt = (key, label) => h('label', {}, label, (inputs[key] = h('input', { type: 'text', value: String(s[key]) })));
      const chk = (key, label) =>
        h('label', { class: 'chk' }, label, (inputs[key] = h('input', { type: 'checkbox', checked: s[key] })));
      const mode = h(
        'select',
        {},
        h('option', { value: 'background', text: 'Background check (recommended)' }),
        h('option', { value: 'reload', text: 'Reload the tab' })
      );
      mode.value = s.mode;
      inputs.mode = mode;

      const save = () => {
        const patch = {};
        for (const [k, el] of Object.entries(inputs)) {
          patch[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? parseFloat(el.value) : el.value;
        }
        saveSettings(patch);
        addLog('Settings saved');
        this.showSettings = false;
        this.w.settingsChanged();
      };

      return h(
        'div',
        { class: 'settings' },
        h('h4', { text: 'Deal rules' }),
        num('maxPrice', 'Max price ($)', 0.01),
        num('minPrice', 'Min price ($) — ignores junk like accessories', 0.01),
        chk('requireWalmartSeller', 'Only "sold by Walmart"'),
        chk('requireOpenBox', 'Only if the page says "Open box"'),
        h('h4', { text: 'Speed (Pacific time)' }),
        txt('peakStart', 'Fast hours start'),
        txt('peakEnd', 'Fast hours end'),
        num('peakMinSec', 'Fast: min seconds between checks'),
        num('peakMaxSec', 'Fast: max seconds'),
        num('offMinSec', 'Slow: min seconds'),
        num('offMaxSec', 'Slow: max seconds'),
        h('label', {}, 'How to check', mode),
        h('h4', { text: 'Phone (Pushover app)' }),
        h('div', { class: 'note' }, 'Your user key is shown on the Pushover dashboard. The app token comes from an application you create at pushover.net/apps/build (any name, e.g. "Walmart Watcher"). Both are 30 characters.'),
        txt('pushoverUser', 'User key'),
        txt('pushoverToken', 'App token'),
        h('div', { class: 'note' }, 'Optional: a healthchecks.io ping URL (https://hc-ping.com/…). The watcher pings it about once a minute while watching, and healthchecks.io alerts you if the pings stop.'),
        txt('healthcheckUrl', 'Health check URL'),
        num('heartbeatHour', 'Daily "still running" push at hour (PT, -1 off)'),
        h('h4', { text: 'This computer' }),
        chk('sound', 'Alarm sound'),
        num('volume', 'Volume (0–1)', 0.1),
        chk('desktopNotify', 'Desktop notification'),
        chk('openTabOnFound', 'Open a fresh product tab when found'),
        chk('keepAwake', 'Keep screen awake while this tab is visible'),
        num('autoResumeMin', 'Resume watching this many min after a find (0 = never)'),
        num('blockedRetryMin', 'Retry after a bot check every N min'),
        h(
          'div',
          { class: 'btns' },
          h('button', { class: 'primary', onclick: save, text: 'Save settings' }),
          h('button', {
            onclick: () => {
              this.showSettings = false;
              this.render();
            },
            text: 'Cancel',
          })
        )
      );
    }

    logView() {
      const L = Store.get('log', []).slice(-8).reverse();
      return h(
        'div',
        { class: 'log' },
        L.map((e) =>
          h('div', { class: e.level === 'warn' ? 'warn-line' : e.level === 'deal' ? 'deal-line' : '', text: `${fmtTime(e.t)}  ${e.msg}` })
        )
      );
    }
  }

  // ---------- the watcher for one product page ----------
  class Watcher {
    constructor(itemId) {
      this.id = itemId;
      this.key = 'watch:' + itemId;
      this.leaseKey = 'lease:' + itemId;
      this.cancelTimer = null;
      this.nextAt = null;
      this.expectedAt = null;
      this.reloadPending = false;
      this.leader = false;
      this.busy = false;
      this.destroyed = false;
      this.checkedThisPage = false;
      this.navigating = false;
      this.alarmActive = false;
      this.throttleNote = null;
      this.lastHtml = null;
      this.pageLoadedAt = Date.now();
      try {
        sessionStorage.setItem('ww:item', itemId);
      } catch (e) {
        /* ignore */
      }
      this.panel = new Panel(this);
      Sound.onChange = () => this.panel.render();
      this.listeners = [
        Store.listen(this.key, (name, oldV, newV, remote) => remote && this.onRemoteChange(oldV, newV)),
        Store.listen('log', () => this.panel.render()),
      ];
      this.keepalive = setInterval(() => {
        if (this.leader) this.writeLease();
      }, 30000);
    }

    get record() {
      return Store.get(this.key, null);
    }

    save(patch) {
      const next = Object.assign({}, this.record || {}, patch);
      Store.set(this.key, next);
      return next;
    }

    get history() {
      return Store.get('history:' + this.id, null);
    }

    editHistory(fn) {
      Store.set('history:' + this.id, fn(this.history));
    }

    recordHistory(status, offer, summary, s) {
      const w = this.record || {};
      const gapMs = Core.gapThresholdMs(s || getSettings(), w.consecutiveErrors || 0);
      this.editHistory((hh) => Core.recordCheck(hh, { at: Date.now(), status, offer, summary, gapMs }));
    }

    markSightingResponse(response) {
      const hh = this.history;
      const last = hh && hh.sightings && hh.sightings[hh.sightings.length - 1];
      if (!last || !last.alerted || last.response) return;
      this.editHistory((x) => Core.updateLatestSighting(x, { response, responseAt: Date.now() }));
    }

    pageName() {
      const t = (document.title || '').replace(/\s*-\s*Walmart\.com\s*$/i, '').trim();
      return t || `Walmart item ${this.id}`;
    }

    start() {
      const w = this.record;
      if (w && w.status === 'blocked') {
        this.save({ status: 'watching' });
        addLog('Reloaded after a bot check, checking again');
      }
      const r = this.record;
      if (r && r.status === 'found' && !r.ackAt) highlightBuyButton();
      if (r && r.status !== 'stopped') this.schedule(getSettings().mode === 'reload' ? 0 : 1500);
      WakeLock.want(getSettings().keepAwake && r && r.status !== 'stopped');
      this.panel.render();
    }

    destroy() {
      this.destroyed = true;
      if (this.cancelTimer) this.cancelTimer();
      clearInterval(this.keepalive);
      this.listeners.forEach((id) => Store.unlisten(id));
      this.releaseLease();
      this.stopAlarm();
      this.panel.destroy();
    }

    // ----- scheduling -----
    schedule(ms) {
      if (this.destroyed) return;
      if (this.cancelTimer) this.cancelTimer();
      this.reloadPending = false;
      this.nextAt = Date.now() + ms;
      this.expectedAt = this.nextAt;
      this.cancelTimer = Timer.after(ms, () => this.tick());
    }

    scheduleReload(ms) {
      if (this.destroyed) return;
      if (this.cancelTimer) this.cancelTimer();
      this.reloadPending = true;
      this.nextAt = Date.now() + ms;
      this.expectedAt = this.nextAt;
      this.cancelTimer = Timer.after(ms, () => {
        const w = this.record;
        if (this.destroyed || !w || (w.status !== 'watching' && w.status !== 'blocked')) return this.tick();
        this.writeLease();
        location.reload();
      });
    }

    // ----- one-tab-at-a-time lease -----
    leaseTtl(s) {
      return Math.max(120000, s.peakMaxSec * 3000, s.offMaxSec * 3000);
    }
    writeLease() {
      Store.set(this.leaseKey, { tab: TAB_ID, ts: Date.now() });
    }
    acquireLease(s) {
      const L = Store.get(this.leaseKey, null);
      if (L && L.tab !== TAB_ID && Date.now() - L.ts < this.leaseTtl(s)) return false;
      this.writeLease();
      return true;
    }
    releaseLease() {
      const L = Store.get(this.leaseKey, null);
      if (L && L.tab === TAB_ID) Store.set(this.leaseKey, null);
      this.leader = false;
    }

    async tick() {
      if (this.destroyed || this.busy) return;
      this.busy = true;
      try {
        await this.tickInner();
      } catch (e) {
        console.error(TAG, e);
        addLog('Unexpected error: ' + (e && e.message), 'warn');
        this.schedule(30000);
      } finally {
        this.busy = false;
      }
    }

    async tickInner() {
      const now = Date.now();
      if (this.expectedAt && now - this.expectedAt > 20000) {
        this.throttleNote = `Chrome delayed a check by ${fmtAgo(now - this.expectedAt)}. Keep this window open and not minimized (see README).`;
        addLog(`Check delayed ${fmtAgo(now - this.expectedAt)} by the browser`, 'warn');
      } else if (this.throttleNote && this.expectedAt) {
        this.throttleNote = null;
      }
      this.expectedAt = null;

      const s = getSettings();
      let w = this.record;
      if (!w || w.status === 'stopped') {
        this.releaseLease();
        this.nextAt = null;
        this.panel.render();
        return;
      }
      if (!this.acquireLease(s)) {
        this.leader = false;
        this.panel.render();
        this.schedule(15000);
        return;
      }
      this.leader = true;

      this.housekeeping(s);
      w = this.record;
      if (w.status === 'watching') {
        if (s.mode === 'reload') {
          const fresh = !this.checkedThisPage && Date.now() - this.pageLoadedAt < 90000;
          if (fresh) await this.checkCurrentPage(s);
          else {
            this.scheduleReload(1000);
            this.panel.render();
            return;
          }
        } else {
          await this.checkByFetch(s);
        }
      }
      if (this.destroyed) return;
      w = this.record;
      if (w.status === 'watching') {
        const d = Core.nextDelayMs(s, new Date(), w.consecutiveErrors || 0);
        if (s.mode === 'reload') this.scheduleReload(d.ms);
        else this.schedule(d.ms);
      } else if (w.status === 'found') {
        this.schedule(15000);
      } else if (w.status === 'blocked' && !this.navigating) {
        this.scheduleReload(s.blockedRetryMin * 60000);
      }
      if (w.status === 'watching' || w.status === 'found') pingHealthcheck();
      this.panel.render();
    }

    housekeeping(s) {
      const w = this.record;
      const now = Date.now();
      if (w.status === 'found') {
        if (s.autoResumeMin > 0 && now - w.foundAt >= s.autoResumeMin * 60000) {
          this.stopAlarm();
          if (!w.ackAt) this.markSightingResponse('none');
          this.editHistory((hh) => Core.markResumed(hh));
          this.save({ status: 'watching', foundAt: null });
          addLog(`Resumed watching automatically (${s.autoResumeMin} min after the find)`);
        }
      }
      if (s.heartbeatHour >= 0) {
        const tp = Core.timeParts(new Date());
        const cur = this.record;
        if (tp.hour >= s.heartbeatHour && cur.lastHeartbeatDay !== tp.dateKey) {
          const st = cur.stats || {};
          const hs = Core.historySummary(this.history, st.since || now);
          this.save({ lastHeartbeatDay: tp.dateKey, stats: this.freshStats() });
          const seen = hs.sightings.length
            ? `Seen in stock ${hs.sightings.length}x: ` +
              hs.sightings
                .slice(-3)
                .map((x) => `${fmtDateTime(x.start)} ${Core.fmtMoney(x.price)}${x.matched ? (x.alerted ? ' (alerted you)' : '') : ' (skipped)'}`)
                .join('; ')
            : 'Not seen in stock.';
          push({
            title: hs.matched.length ? `Watcher: found ${hs.matched.length}x since last report` : 'Walmart Watcher is still running',
            message:
              `${cur.name || 'Item ' + this.id}\n` +
              `Since ${new Date(st.since || now).toLocaleString()}: ${st.checks || 0} checks, ` +
              `${st.blocks || 0} bot checks, ${st.errors || 0} errors` +
              (hs.gapMs ? `, not checking for ${fmtAgo(hs.gapMs)} total` : '') +
              `.\n${seen}\nLast result: ${cur.last ? cur.last.summary : 'none yet'}`,
            priority: hs.matched.length ? 3 : 2,
            tags: [hs.matched.length ? 'package' : 'white_check_mark'],
          });
        }
      }
    }

    freshStats() {
      return { since: Date.now(), checks: 0, deals: 0, blocks: 0, errors: 0, unknown: 0 };
    }

    // ----- checking -----
    async checkByFetch(s) {
      const w = this.record;
      let html = '';
      let status = 0;
      let finalUrl = w.url;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000);
      try {
        const r = await fetch(w.url, {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          signal: ctrl.signal,
          headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        });
        status = r.status;
        finalUrl = r.url || w.url;
        html = await r.text();
      } catch (e) {
        clearTimeout(to);
        this.onError(e && e.name === 'AbortError' ? 'Check timed out' : `Network error (${(e && e.message) || e})`);
        return;
      }
      clearTimeout(to);
      this.lastHtml = html;
      const res = Core.analyze(html, { url: finalUrl, status, itemId: this.id });
      if (!res.blocked && !res.offers.length && status >= 400) {
        this.onError(`Walmart returned HTTP ${status}`);
        return;
      }
      this.handle(res, s);
    }

    async checkCurrentPage(s) {
      this.checkedThisPage = true;
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        if (document.getElementById('__NEXT_DATA__') || document.querySelector('script[type="application/ld+json"]')) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      const html = document.documentElement.outerHTML;
      this.lastHtml = html;
      this.handle(Core.analyze(html, { url: location.href, status: 200, itemId: this.id }), s);
    }

    onError(msg) {
      const w = this.record;
      const n = (w.consecutiveErrors || 0) + 1;
      const stats = Object.assign(this.freshStats(), w.stats || {});
      stats.errors++;
      this.save({
        consecutiveErrors: n,
        stats,
        last: { at: Date.now(), status: 'error', summary: msg },
      });
      this.recordHistory('error', null, msg);
      addLog(msg, 'warn');
      this.maybeProblemPush(n, `${n} checks in a row failed. Latest: ${msg}`);
    }

    maybeProblemPush(count, message) {
      const w = this.record;
      if (count < 10) return;
      if (w.lastProblemPushAt && Date.now() - w.lastProblemPushAt < 6 * 3600 * 1000) return;
      this.save({ lastProblemPushAt: Date.now() });
      push({ title: 'Walmart Watcher needs attention', message, priority: 4, tags: ['warning'], click: w.url });
    }

    handle(res, s) {
      const ev = Core.evaluate(res, s);
      const w = this.record;
      const stats = Object.assign(this.freshStats(), w.stats || {});
      stats.checks++;
      if (ev.status === 'blocked') stats.blocks++;
      if (ev.status === 'unknown') stats.unknown++;
      const first = res.offers[0] || {};
      const last = {
        at: Date.now(),
        status: ev.status,
        summary: ev.summary,
        price: first.price ?? null,
        available: first.available ?? null,
        seller: first.seller || null,
        condition: first.condition || null,
        sources: res.sources,
        notes: res.notes,
      };
      const patch = { last, stats };
      if (res.name) patch.name = res.name;
      const seenOffer = ev.best || res.offers.find((o) => o.available === true) || null;
      this.recordHistory(ev.status, seenOffer, ev.summary, s);
      const prevStatus = w.last && w.last.status;
      if (prevStatus !== ev.status) addLog(ev.summary, ev.status === 'deal' ? 'deal' : ev.status === 'blocked' || ev.status === 'unknown' ? 'warn' : 'info');

      if (ev.status === 'blocked') {
        patch.consecutiveErrors = (w.consecutiveErrors || 0) + 1;
        patch.status = 'blocked';
        this.save(patch);
        const onBotPage = s.mode === 'reload' || Core.analyze(document.documentElement.outerHTML, { url: location.href }).blocked;
        if (!onBotPage) {
          // Load the real page: the browser often passes the check on its own;
          // if not, the "press and hold" page shows up for you to solve.
          addLog('Opening the real page to clear the bot check');
          this.writeLease();
          this.navigating = true;
          setTimeout(() => {
            location.href = this.record.url;
          }, 1000);
        } else {
          // This tab itself is showing the bot check: ask the human, retry later.
          this.blockedPush();
        }
        return;
      }

      if (ev.status === 'unknown') {
        patch.consecutiveUnknown = (w.consecutiveUnknown || 0) + 1;
        this.save(patch);
        this.maybeProblemPush(
          patch.consecutiveUnknown,
          "The watcher can't read price/stock from the Walmart page anymore (maybe the page layout changed). Open the page and use Copy debug info."
        );
        return;
      }

      patch.consecutiveErrors = 0;
      patch.consecutiveUnknown = 0;
      this.save(patch);
      if (ev.deal) this.onDeal(ev, s);
    }

    blockedPush() {
      const w = this.record;
      if (w.lastBlockPushAt && Date.now() - w.lastBlockPushAt < 30 * 60000) return;
      this.save({ lastBlockPushAt: Date.now() });
      push({
        title: 'Walmart wants a human check',
        message: 'Open the watcher tab and complete the "press and hold" check. Watching resumes by itself afterwards.',
        priority: 4,
        tags: ['robot'],
        click: w.url,
      });
    }

    onDeal(ev, s) {
      const w = this.record;
      const now = Date.now();
      const key = Core.dealKey(ev.best);
      const quietMs = Math.max(10, s.autoResumeMin) * 60000;
      const recentlyAlerted = w.lastAlertAt && now - w.lastAlertAt < quietMs && w.lastDealKey === key;
      const stats = Object.assign(this.freshStats(), w.stats || {});
      stats.deals++;
      this.save(
        Object.assign(
          { status: 'found', foundAt: now, ackAt: null, lastDeal: ev.best, lastDealKey: key, stats },
          recentlyAlerted ? { ackAt: now } : { lastAlertAt: now }
        )
      );
      if (recentlyAlerted) {
        this.editHistory((hh) => Core.updateLatestSighting(hh, { note: 'already alerted you a few minutes earlier' }));
        addLog('Still in stock (already alerted, not alerting again yet)');
        return;
      }
      this.editHistory((hh) => Core.updateLatestSighting(hh, { alerted: true }));
      this.fireAlerts(ev.best, s);
      if (s.mode === 'background' && s.openTabOnFound) openTab(w.url);
      else highlightBuyButton();
    }

    fireAlerts(d, s) {
      const w = this.record;
      const title = `IN STOCK ${Core.fmtMoney(d.price)}: ${(w.name || 'Walmart item').slice(0, 60)}`;
      const msg =
        `${Core.fmtMoney(d.price)}${d.seller ? ' · sold by ' + d.seller : ''}${d.condition ? ' · ' + d.condition : ''}\n` +
        'Tap to open Walmart and hit Buy now.';
      push({ title, message: msg, priority: 5, tags: ['rotating_light', 'video_game'], click: w.url });
      if (s.desktopNotify) desktopNotify(title, msg);
      if (s.sound) Sound.startSiren(s.volume);
      TitleFlash.start(`🚨 IN STOCK ${Core.fmtMoney(d.price)}`);
      this.alarmActive = true;
    }

    stopAlarm() {
      Sound.stopSiren();
      TitleFlash.stop();
      this.alarmActive = false;
    }

    onRemoteChange(oldV, newV) {
      if (!newV || newV.status !== 'found' || newV.ackAt) this.stopAlarm();
      if (newV && newV.status === 'watching' && oldV && oldV.status !== 'watching') this.schedule(1000);
      if (newV && newV.status === 'stopped' && this.cancelTimer) {
        this.cancelTimer();
        this.nextAt = null;
      }
      WakeLock.want(getSettings().keepAwake && newV && newV.status !== 'stopped');
      this.panel.render();
    }

    // ----- buttons -----
    startWatching() {
      Sound.unlock();
      const url = Core.canonicalUrl(location.href);
      const tp = Core.timeParts(new Date());
      Store.set(this.key, {
        id: this.id,
        url,
        name: this.pageName(),
        status: 'watching',
        startedAt: Date.now(),
        stats: this.freshStats(),
        consecutiveErrors: 0,
        consecutiveUnknown: 0,
        lastHeartbeatDay: tp.dateKey,
      });
      this.editHistory((hh) => Core.markResumed(hh));
      this.writeLease();
      this.leader = true;
      this.checkedThisPage = false;
      this.pageLoadedAt = Date.now();
      addLog(`Started watching (max ${Core.fmtMoney(getSettings().maxPrice)})`);
      push({
        title: 'Walmart Watcher started',
        message: `Watching ${this.pageName()}.\nYou'll get an urgent alert here when it's in stock.`,
        priority: 3,
        tags: ['eyes'],
        click: url,
      });
      WakeLock.want(getSettings().keepAwake);
      this.schedule(500);
      this.panel.render();
    }

    stopWatching() {
      this.stopAlarm();
      this.save({ status: 'stopped' });
      if (this.cancelTimer) this.cancelTimer();
      this.nextAt = null;
      this.releaseLease();
      WakeLock.want(false);
      addLog('Stopped watching');
      this.panel.render();
    }

    acknowledge(response = 'stopped the alarm') {
      this.stopAlarm();
      if (!(this.record || {}).ackAt) this.markSightingResponse(response);
      this.save({ ackAt: Date.now() });
      this.panel.render();
    }

    resume() {
      this.stopAlarm();
      if (!(this.record || {}).ackAt) this.markSightingResponse('resumed watching');
      this.editHistory((hh) => Core.markResumed(hh));
      this.save({ status: 'watching', foundAt: null, ackAt: Date.now() });
      this.checkedThisPage = true; // current page is stale; reload mode will reload first
      addLog('Resumed watching');
      this.writeLease();
      this.leader = true;
      this.schedule(500);
      this.panel.render();
    }

    takeOver() {
      this.writeLease();
      this.leader = true;
      this.schedule(300);
      this.panel.render();
    }

    openProduct() {
      this.acknowledge('opened the product page');
      const w = this.record;
      if (Core.itemIdFromUrl(location.href) === this.id && getSettings().mode === 'reload') highlightBuyButton();
      else openTab(w.url);
    }

    settingsChanged() {
      const w = this.record;
      WakeLock.want(getSettings().keepAwake && w && w.status !== 'stopped');
      if (w && w.status === 'watching' && this.leader) this.schedule(1000);
      this.panel.render();
    }

    testAlerts() {
      Sound.unlock();
      const s = getSettings();
      push({
        title: 'Test alert from Walmart Watcher',
        message: 'If you got this on your phone, alerts work. The real one is marked urgent.',
        priority: 4,
        tags: ['bell'],
        click: location.href,
      }).then((ok) => {
        addLog(ok ? 'Test push sent to your phone' : 'Test push FAILED, check the Pushover keys', ok ? 'info' : 'warn');
      });
      if (s.healthcheckUrl) {
        pingHealthcheck(true).then((ok) => {
          addLog(ok === true ? 'Health check ping sent' : `Health check ping FAILED (${ok})`, ok === true ? 'info' : 'warn');
        });
      }
      if (s.desktopNotify) desktopNotify('Test alert', 'Desktop notifications work.');
      setTimeout(() => {
        if (s.sound) Sound.startSiren(s.volume, 3000);
        TitleFlash.start('🚨 TEST ALERT', 5000);
      }, 200);
    }

    async copyText(text, btn) {
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        const ta = h('textarea', { value: text });
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      if (btn) btn.textContent = 'Copied!';
      setTimeout(() => this.panel.render(), 1500);
    }

    copyHistory(btn) {
      const hist = Object.assign(Core.emptyHistory(), this.history || {});
      const lines = [`Walmart Restock Watcher history: ${(this.record || {}).name || this.id}`];
      lines.push(`Recording since ${fmtDateTime(hist.since)}; last check ${fmtDateTime(hist.lastCheckAt)}`, '', 'IN STOCK SIGHTINGS');
      if (!hist.sightings.length) lines.push('  none');
      for (const x of hist.sightings) {
        lines.push(
          `  ${new Date(x.start).toLocaleString()}  ${Core.fmtMoney(x.price)}  ${x.seller || ''}  ` +
            `${x.matched ? (x.alerted ? 'ALERTED' : 'matched') : 'skipped: ' + (x.note || '')}` +
            `${x.response ? ' / you ' + (x.response === 'none' ? 'did not respond' : x.response) : ''}` +
            `  last seen ${new Date(x.lastSeen).toLocaleTimeString()}${x.end ? ', gone by ' + new Date(x.end).toLocaleTimeString() : ''}`
        );
      }
      lines.push('', 'CHECKS PER DAY (Pacific)');
      for (const k of Object.keys(hist.days).sort()) {
        const d = hist.days[k];
        lines.push(`  ${k}  checks ${d.checks}  in-stock ${d.inStock}  bot-checks ${d.blocks}  errors ${d.errors}  unreadable ${d.unknown}`);
      }
      lines.push('', 'GAPS (not checking)');
      if (!hist.gaps.length) lines.push('  none');
      for (const g of hist.gaps) lines.push(`  ${new Date(g.from).toLocaleString()} -> ${new Date(g.to).toLocaleString()} (${fmtAgo(g.to - g.from)})`);
      this.copyText(lines.join('\n'), btn);
    }

    clearHistory() {
      if (!window.confirm('Clear the in-stock history and daily counts for this item?')) return;
      Store.set('history:' + this.id, null);
      addLog('History cleared');
      this.panel.render();
    }

    async copyDebug(btn) {
      const html = this.lastHtml || document.documentElement.outerHTML;
      const res = Core.analyze(html, { url: location.href, status: 200, itemId: this.id, debug: true });
      const s = getSettings();
      const report = {
        version: Core.VERSION,
        at: new Date().toISOString(),
        page: location.href,
        record: Object.assign({}, this.record, { url: undefined }),
        settings: Object.assign({}, s, { pushoverUser: '(hidden)', pushoverToken: '(hidden)', healthcheckUrl: s.healthcheckUrl ? '(set)' : '' }),
        worker: Timer.usingWorker,
        soundArmed: Sound.armed,
        analysis: res,
        evaluation: Core.evaluate(res, s),
      };
      this.copyText(JSON.stringify(report, null, 2), btn);
    }
  }

  // ---------- the "press and hold" bot-check page ----------
  function handleBlockedPage() {
    let id = null;
    try {
      id = sessionStorage.getItem('ww:item');
    } catch (e) {
      /* ignore */
    }
    if (!id) return;
    const key = 'watch:' + id;
    const w = Store.get(key, null);
    if (!w || w.status === 'stopped' || w.status === 'found') return;
    const s = getSettings();
    const stats = Object.assign({ since: Date.now(), checks: 0, deals: 0, blocks: 0, errors: 0, unknown: 0 }, w.stats || {});
    stats.blocks++;
    const patch = { status: 'blocked', stats, last: { at: Date.now(), status: 'blocked', summary: 'Walmart showed a bot check' } };
    const pushNow = !w.lastBlockPushAt || Date.now() - w.lastBlockPushAt > 30 * 60000;
    if (pushNow) patch.lastBlockPushAt = Date.now();
    Store.set(key, Object.assign({}, w, patch));
    Store.set(
      'history:' + id,
      Core.recordCheck(Store.get('history:' + id, null), {
        at: Date.now(),
        status: 'blocked',
        gapMs: Core.gapThresholdMs(s, w.consecutiveErrors || 0),
      })
    );
    addLog('Walmart is asking for a human check', 'warn');
    if (pushNow) {
      push({
        title: 'Walmart wants a human check',
        message: 'Complete the "press and hold" check in the watcher tab. Watching resumes by itself afterwards.',
        priority: 4,
        tags: ['robot'],
        click: w.url,
      });
    }
    const banner = h(
      'div',
      {},
      h('div', {
        text:
          `Restock Watcher is paused: complete Walmart's check on this page and watching resumes by itself. ` +
          `Otherwise it retries in ${s.blockedRetryMin} min.`,
      })
    );
    const host = h('div', {});
    const root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(
        'div>div{position:fixed;left:16px;right:16px;top:16px;z-index:2147483647;background:#ea580c;color:#fff;font:600 15px/1.4 -apple-system,sans-serif;padding:12px 16px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.3)}'
      );
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      /* unstyled is fine */
    }
    root.appendChild(banner);
    (document.body || document.documentElement).appendChild(host);
    Timer.after(s.blockedRetryMin * 60000, () => {
      const cur = Store.get(key, null);
      if (cur && cur.status === 'blocked') location.href = cur.url;
    });
  }

  // Shown when the watcher tab wanders off to another Walmart page.
  let awayBanner = null;
  function showAwayBanner() {
    let id = null;
    try {
      id = sessionStorage.getItem('ww:item');
    } catch (e) {
      /* ignore */
    }
    const w = id ? Store.get('watch:' + id, null) : null;
    if (!w || w.status !== 'watching') return;
    const host = h('div', {});
    const root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(
        '.b{position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#1e293b;color:#fff;font:600 13px/1.4 -apple-system,sans-serif;padding:10px 12px;border-radius:10px;display:flex;gap:10px;align-items:center}' +
          'button{font:inherit;border:0;border-radius:6px;padding:5px 9px;background:#2563eb;color:#fff;cursor:pointer}'
      );
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      /* unstyled is fine */
    }
    root.appendChild(
      h('div', { class: 'b' }, 'Restock Watcher: this tab left the product page, so nothing is being checked.',
        h('button', { onclick: () => (location.href = w.url), text: 'Go back' }))
    );
    (document.body || document.documentElement).appendChild(host);
    awayBanner = host;
  }

  // ---------- routing (Walmart is a single-page app) ----------
  let current = null;
  let lastHref = null;
  function route() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const id = Core.itemIdFromUrl(location.href);
    if (current && current.id === id) return;
    if (current) {
      current.destroy();
      current = null;
    }
    if (awayBanner) {
      awayBanner.remove();
      awayBanner = null;
    }
    if (/^\/blocked/i.test(location.pathname)) {
      handleBlockedPage();
      return;
    }
    if (id) {
      current = new Watcher(id);
      current.start();
    } else {
      showAwayBanner();
    }
  }

  const unlock = () => Sound.unlock();
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && current) {
      const w = current.record;
      WakeLock.want(getSettings().keepAwake && w && w.status !== 'stopped');
    }
  });
  route();
  setInterval(route, 1000);
})();
