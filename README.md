# Walmart Restock Watcher

A Tampermonkey userscript that watches a Walmart product page, built for the
**PS5 Pro Open Box** listing, and alerts you as soon as it's in stock at or
under your price. It uses a siren, a desktop notification and an urgent push
to your phone.

**It never buys anything.** You click Buy now yourself. Walmart's terms don't
allow bots to check out, and automated orders tend to get cancelled or get the
account flagged.

Target listing: <https://www.walmart.com/ip/18235967161?conditionGroupCode=3>
(`conditionGroupCode=3` selects the Open Box condition).

## How it works

- Every 15–25 seconds (randomized) between **7am and 1pm Pacific** (when drops
  were reported), and every 45–75 seconds the rest of the day, it quietly
  downloads the product page in the background and reads price, stock, seller
  and condition from the data Walmart embeds in the page. Your tab doesn't
  reload.
- If it's **in stock, sold by Walmart, and at or under your max price**
  (default **$600**):
  - it **stops checking**
  - sends **one** high-priority Pushover push to your phone with the siren
    sound (no repeats: the item sells out in seconds). Tap its link to open
    the listing
  - plays a **10-second siren**, shows a **desktop notification** and flashes the tab
    title
  - opens a **fresh tab** of the listing with the Buy now button outlined in
    green
- **If you miss it:** it resumes watching 15 minutes later on its own. If the
  same offer is still there, it alerts again.
- If Walmart shows its **"Robot or human? Press and hold"** check, the watcher
  reloads the real page, which often clears the check by itself. If the check
  is still there, it sends you a push to go complete it and retries every 10
  minutes. Solving captchas is up to you.
- A daily **"still running"** push at 7am Pacific tells you it's alive and
  whether the item showed up in stock since the last one. If that push
  doesn't arrive, the watcher stopped.
- Optionally, it pings **healthchecks.io** about once a minute, so you get a
  push within minutes if the watcher goes quiet (see setup step 3).
- It keeps a **history**, so you can see what happened while you were away (see
  below).
- If it can't read the page 10 times in a row (for example, if Walmart changed
  its layout), you get a "needs attention" push instead of silence.
- Only one tab checks at a time, even if you open the listing in several tabs.

## Setup (Mac + Chrome, about 10 minutes)

### 1. Tampermonkey
1. Install [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) from the Chrome Web Store.
2. **Required on current Chrome:** go to `chrome://extensions`, click
   **Details** on Tampermonkey, and turn on **Allow User Scripts**. On older
   Chrome versions, turn on **Developer mode** at the top right of
   `chrome://extensions` instead. If you skip this, the script silently won't
   run.
3. Open the **install link**:
   <https://raw.githubusercontent.com/steevka/glitch-todo/glitch/walmart-watcher.user.js>.
   Tampermonkey shows an install page; click **Install**. It then checks that
   link for updates automatically (you can force a check from the Tampermonkey
   dashboard → *Last updated* column).

### 2. Phone alerts (Pushover)
1. Install **Pushover** on your phone and sign in. Your **user key** is shown
   at the top of <https://pushover.net> when you're logged in.
2. Create an application for the watcher at
   <https://pushover.net/apps/build> (any name, e.g. "Walmart Watcher"). It
   gives you an **API token**.
3. Open the Walmart listing in Chrome. A **Restock Watcher** panel appears at
   the bottom left. Click **Settings**, paste the user key and the app token
   into the *Phone (Pushover app)* fields, and save.
4. In the Pushover app, make sure notifications are allowed. The in-stock
   alert is sent once as a **high-priority** push with the siren sound. High
   priority bypasses Pushover's quiet hours.

Keep both keys private; anyone with the app token can push to your phone.

### 3. Alert if the watcher goes quiet (healthchecks.io, optional)
The daily push only tells you the next morning that the watcher stopped.
healthchecks.io tells you within minutes.
1. Sign up at <https://healthchecks.io> (free) and click **Add Check**.
2. Set **Period** to 2 minutes and **Grace** to 15 minutes. The grace covers a
   Walmart bot check, which pauses checking for up to 10 minutes.
3. Under **Integrations**, add **Pushover** so the alert reaches your phone.
4. Copy the check's ping URL (`https://hc-ping.com/...`), paste it into the
   watcher's **Settings → Health check URL**, and save.
5. Click **Test alerts**: the check on healthchecks.io should turn green.

The watcher pings only while it's watching. **When you click Stop, pause the
check on healthchecks.io** or it will alert you.

### 4. Start it
1. In the panel, click **Test alerts**. You should get a phone push, a desktop
   notification and a short siren. Desktop notifications come from
   Tampermonkey through Chrome, so if none appears, allow notifications for
   Google Chrome in macOS System Settings → Notifications and check that no
   Focus mode is on.
2. Click **Start watching**. You'll get a "Watcher started" push.
3. Click once anywhere on the page. Chrome only allows sound after a click, and
   the panel reminds you if you haven't.

### 5. Keeping it running 24/7
- **Keep the Mac awake; the display can sleep.** Either go to System
  Settings → Displays → Advanced… (or Battery → Options on a laptop) and turn
  on "Prevent automatic sleeping when the display is off", or run
  `caffeinate -i` in Terminal and leave that window open. If the Mac sleeps,
  the watcher stops. If the Mac's sound goes through the monitor, the siren is
  silent while the monitor sleeps; the phone push still arrives.
- **Keep Chrome from unloading the tab.** Go to Chrome Settings → Performance →
  Memory Saver → "Always keep these sites active" → add `walmart.com`.
- **Give it its own window** that stays open and isn't minimized; a second
  monitor is ideal. The script already works around Chrome's slowdown of
  background tabs, and the panel warns you if Chrome delays checks anyway.
- **Don't browse Walmart in the watcher tab.** Use another tab. If the watcher
  tab leaves the product page, a banner offers to take you back.
- The watcher **survives Chrome restarts.** When Chrome reopens the tab, it
  picks up where it left off.

## The panel

| Button | What it does |
|---|---|
| Start watching / Stop | Turns watching on or off for this item |
| Stop alarm | Silences the siren on the Mac (it stops by itself after 10 seconds anyway) |
| Resume watching | Starts checking again after a find |
| Test alerts | Sends a test push, notification and siren |
| Settings | Price limits, speed, Pushover keys, sound and more |
| History | What happened while you were away (see below) |
| Copy debug info | Copies a report to paste to whoever maintains the script if the watcher can't read the page |

### History

The panel always shows a one-line summary, e.g. *"Seen in stock 2× · last Sat,
Sep 26, 10:02 AM at $477.04"*, or *"Never seen in stock since …"*. Click
**History** for the details:

- **Times it was in stock:** every sighting, including ones it skipped
  (over your price, a reseller) and why. For each: when it appeared, the
  price and seller, how many checks saw it, when it was gone, and whether you
  were alerted and how you responded ("stopped the alarm", "opened the
  product page", or "no response").
- **Checks per day:** how many checks ran each day, so you can tell it was
  really working, plus bot checks and errors.
- **Gaps:** stretches with no checking (Mac asleep, Chrome closed, tab
  navigated away), shown in orange. If a gap covers the 8am–noon window, you
  know you weren't covered then.

**Copy history** copies it all as text. History is kept per item (the last
200 sightings, 90 days of counts and 200 gaps). Stopping the watcher doesn't
erase it; only **Clear history** does.

### Settings worth knowing

| Setting | Default | Notes |
|---|---|---|
| Max price | $600 | The Redditor paid $477.04 |
| Min price | $100 | Ignores junk like accessories |
| Only "sold by Walmart" | on | Skips marketplace resellers |
| Only if the page says "Open box" | off | **Leave this off.** The link already selects Open Box, and on the real page the parser currently reads the condition as "New" (see Known issues), so turning it on blocks every alert |
| Fast hours (Pacific) | 07:00–13:00 | Set start = end to use the fast speed all day |
| Fast speed | 15–25 s | Minimum allowed is 5 s. Faster tends to trigger Walmart's bot check |
| Slow speed | 45–75 s | Used outside fast hours |
| How to check | Background | "Reload the tab" works like the Redditor's Firefox refresher. Use it if background checks keep hitting bot checks |

## Data use

Each background check downloads one compressed HTML page, roughly
0.1–0.3 MB. At the default speeds that's a few hundred MB a day.

## Development

The page parser, deal rules and scheduler are plain functions at the top of
the script and are covered by unit tests. The end-to-end tests run the real
script in Chromium against a fake walmart.com, covering in stock, out of
stock, over price, third-party seller, bot checks (redirect and in place),
reload mode, multiple tabs, auto-resume, an unreadable page,
restarts and the history view.

```sh
npm install                      # once
npx playwright install chromium  # once, and again after Playwright upgrades
npm test                         # unit tests (Node 18+)
npm run test:e2e                 # browser tests
```

Tampermonkey updates only when `@version` in the script header goes up, so
bump it (and `VERSION` in the script and `package.json`) on every change you
push to the `glitch` branch.

### What the real page looks like

Checked against the live listing on Sep 26, 2026:

- The product data is in the page's `__NEXT_DATA__` script at
  `props.pageProps.initialData.data.product`. That's what the watcher reads.
- There is **no schema.org Product JSON-LD** on the page, so the JSON-LD
  source never contributes. Microdata is also absent.
- Background checks go through: repeated fetches returned the full page in
  about a second, with no bot check.
- The embedded data can run ahead of the visible page. It said in stock at
  $1,369.99 from a marketplace seller while the buy box showed no price and
  no Add to cart.

### Known issues

- **Condition is misread.** The product's `conditionType` says "New" on the
  Open Box listing. The real condition is in `gradingLabel` ("Open Box") and
  `conditionV2.groupCode` (3). This is why the "Open box" setting should
  stay off.
- **Per-condition offers are ignored.** `product.conditionOffers[]` holds one
  entry per condition, but with shapes the parser doesn't read:
  `availabilityStatus: {value}`, `price: {price}`, `condition: {text}`. A
  Walmart-sold open-box offer listed only there would be missed.
- The test fixtures still model an idealized page with JSON-LD, not the real
  shape above.

If a real page ever reads as "Couldn't read price/stock", use **Copy debug
info**. The report includes the page's data layout, which is what's needed to
fix the parser.

---

# Discord → Amazon Auto-Buy (`amazon-autobuy.user.js`)

A second userscript, separate from the Walmart watcher. It reads the
Falcodrin **#rtx5080** alert channel in a Discord **browser tab**. When an
alert matches what you want, it opens the Amazon listing and checks out with
your saved card and address.

**Unlike the Walmart watcher, this one places orders.** That breaks
Amazon's Conditions of Use. Amazon may cancel the order or restrict the
account, and you accept that risk by arming it.

## What it buys (defaults, change in Settings)

- **Models (real RTX 5080s only, air-cooled):**
  - **Flagship:** ASUS ROG Astral, MSI Suprim SOC (air), Gigabyte AORUS Master
  - **Sweet spot:** ASUS TUF, MSI Gaming Trio, Gigabyte Gaming OC, PNY Epic-X, ASUS ProArt
  - Never: base models (Prime, Ventus, Inspire, Windforce, Zotac Solid, PNY plain
    triple-fan), Suprim **Liquid** (AIO), TUF **BTF** (needs a back-connect board),
    water-block cards, Ti, laptops/prebuilts, accessories.
  - All of these fit a Lian Li A3-mATX without bottom fans (415 mm, 4 slots).
- **Sellers:** new only from **Amazon.com**; used only from **Amazon Resale**
  (Like New / Very Good). Never third-party sellers, Used - Good, or Renewed.
- **Caps (item price, before tax):**

  | | New (Amazon.com) | Resale (Like New / Very Good) |
  |---|---|---|
  | Flagship | $1,810 | $1,650 |
  | Sweet spot | $1,810 | $1,600 |

  Checkout order total must be **≤ $2,000** (tax included).
  Against real alerts from Nov 4–15 2026, this would have fired on the new
  Suprim SOC ($1,799.99, twice) and the new PNY Epic-X ($1,799.99), and skipped
  the $1,805 Resale listings.
- **One order, ever,** until you clear the lock from the menu.
- It starts in **dry run**: it goes all the way to checkout, highlights
  Place your order, rings the siren and pushes to your phone, but doesn't click.
  Choose **Arm / disarm full auto** from the menu once a dry run has worked.

## How it works

1. **Discord tab:** watches new messages in the channel. It ignores messages
   that were already on screen and anything older than 2 minutes, so reloading
   or scrolling up never triggers a buy. MSI-store drops and unwanted conditions
   are skipped and logged.
2. On a match it opens the alert's Amazon link in a new tab, tagged so the
   script knows the tab is a buy attempt. Amazon pages you open yourself are
   left alone.
3. **Amazon product page:**
   - If the buy box is the offer you want (Amazon.com new), it clicks **Buy Now**,
     which checks out just that item.
   - Otherwise (Resale/used: no Buy Now), it loads the All Offers list, picks the
     cheapest offer matching your rules, and adds **exactly that offer, qty 1** to
     the cart. It refuses if the cart already has anything in it.
   - Invite-only listings: it clicks **Request invitation** and pushes you.
4. **Checkout:** reads Items and Order total from the page. It places the order only if
   Items ≤ max price, Order total ≤ cap, and quantity is 1. Otherwise it stops and
   pushes you the reason.
5. **Thank-you page:** "ORDER PLACED" push. The order lock is now on.

Captcha, sign-in prompts, a missing payment method, or a vanished offer all stop it with
a push. It never tries to solve a captcha.

## Setup

1. Tampermonkey as in the Walmart setup above (including **Allow User Scripts**).
2. Install: <https://raw.githubusercontent.com/steevka/glitch-todo/glitch/amazon-autobuy.user.js>
3. Tampermonkey icon → **Discord → Amazon Auto-Buy** → **Settings…** and paste your
   Pushover `pushoverUser` / `pushoverToken` (the same values as the Walmart watcher),
   and optionally a `healthcheckUrl`. Then **Send test push**.
4. In Chrome, open <https://discord.com/channels/767566223729754122/1338546225405890580>
   (**not** the Discord desktop app), pin the tab, and keep it **scrolled to the bottom**.
   A badge in the corner says what it's doing.
5. Chrome → Settings → Performance → **Always keep these sites active**: add
   `discord.com` and `amazon.com`, so the tabs aren't put to sleep.
6. On amazon.com, in the same Chrome profile: stay signed in, set a default address and
   card, turn on **Buy Now / 1-Click**, and **keep the cart empty** (move anything there
   to Save for later).
7. Dry run test: open any product page on Amazon (it doesn't have to be a 5080),
   Tampermonkey menu → **Test this product page (dry run)**, enter a max price. It goes
   to checkout and stops at Place your order. If it took the Resale path it **added the
   item to your cart**; remove it afterwards.
8. Real test: on something cheap you actually want, **Test buy this product (REAL
   order)**. It places the order if the item is ≤ your max and sold by Amazon.com (or
   Amazon Resale). Test buys don't set the order lock and work while disarmed.
9. When that worked, **Arm / disarm full auto**.

Menu: Settings…, Arm / disarm full auto, Reset order lock, Send test push, Show log,
and on Amazon pages the two test commands.

## Limits

- Alerts arrive a few seconds after the drop, so some offers will already be gone.
  You'll get an "offer is gone" push.
- Amazon changes its page layout. The parsing was built against real All Offers
  markup on 2026-11-16 (including the empty `.a-offscreen` price quirk), but the
  checkout page was only tested against a mock. That's why it starts in dry run.
- Discord only renders new messages while the channel is scrolled to the bottom.
- Tests: `npm test` (pure logic, using the real alert text and offer markup).
