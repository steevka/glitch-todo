'use strict';
// Parses Amazon's "All offers" (AOD) HTML without a browser.
// Uses the userscript's own condition/seller/money helpers so both sides agree.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m;
  });
}

function text(html) {
  if (!html) return '';
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// Outer HTML of the element whose id attribute matches, matched by tag depth.
function elementAt(html, tagStart) {
  const m = /^<([a-z0-9]+)/i.exec(html.slice(tagStart, tagStart + 20));
  if (!m) return '';
  const re = new RegExp('<(/?)' + m[1] + '\\b[^>]*>', 'gi');
  re.lastIndex = tagStart;
  let depth = 0;
  let r;
  while ((r = re.exec(html))) {
    if (r[0].endsWith('/>')) continue;
    depth += r[1] ? -1 : 1;
    if (depth === 0) return html.slice(tagStart, re.lastIndex);
  }
  return html.slice(tagStart);
}

function byId(html, id, exact = true) {
  const needle = 'id="' + id + (exact ? '"' : '');
  const i = html.indexOf(needle);
  if (i < 0) return '';
  return elementAt(html, html.lastIndexOf('<', i));
}

function allById(html, id) {
  const out = [];
  const needle = 'id="' + id + '"';
  let i = html.indexOf(needle);
  while (i >= 0) {
    const el = elementAt(html, html.lastIndexOf('<', i));
    out.push(el);
    i = html.indexOf(needle, html.lastIndexOf('<', i) + Math.max(el.length, 1));
  }
  return out;
}

function priceOf(html, Core) {
  const label = /class="[^"]*apex-pricetopay-accessibility-label[^"]*"[^>]*>([^<]*)</.exec(html);
  if (label && Core.parseMoney(label[1]) !== null) return Core.parseMoney(label[1]);
  const offs = [...html.matchAll(/class="a-offscreen"[^>]*>([^<]*)</g)];
  for (const o of offs) if (Core.parseMoney(o[1]) !== null) return Core.parseMoney(o[1]);
  const whole = /class="a-price-whole"[^>]*>([\d,]+)/.exec(html);
  if (whole) {
    const frac = /class="a-price-fraction"[^>]*>(\d+)/.exec(html.slice(whole.index));
    return Core.parseMoney(whole[1].replace(/,/g, '') + '.' + (frac ? frac[1] : '00'));
  }
  return null;
}

function parseAod(html, Core) {
  const title = text(byId(html, 'aod-asin-title-text'));
  const blocks = [...allById(html, 'aod-pinned-offer'), ...allById(html, 'aod-offer')];
  const offers = [];
  for (const b of blocks) {
    const heading = text(byId(b, 'aod-offer-heading'));
    const soldBy = text(byId(b, 'aod-offer-soldBy'));
    if (!heading && !soldBy) continue; // empty pinned slot (no featured offer)
    const priceBox = byId(b, 'aod-price-', false) || b;
    const olid = /name="items\[0\.base\]\[offerListingId\]"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*name="items\[0\.base\]\[offerListingId\]"/.exec(b);
    offers.push({
      condition: Core.parseCondition(heading),
      seller: Core.parseSeller(soldBy),
      price: priceOf(priceBox, Core),
      olid: olid ? decode(olid[1] || olid[2]) : null,
    });
  }
  return { title, offers };
}

// Amazon's robot check / throttle page instead of offers.
function looksBlocked(status, html) {
  if (status === 503 || status === 429) return true;
  return /validateCaptcha|api-services-support@amazon\.com|Type the characters you see/i.test(html || '');
}

module.exports = { parseAod, looksBlocked, text, byId };
