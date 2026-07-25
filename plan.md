# Build Plan: Bank of Canada Rate Odds Aggregator

A small static web app that shows Bank of Canada policy rate odds from three independent sources (Kalshi, Polymarket, bankofcanadaodds.com) side by side, highlights where they disagree, and shows the official BoC decision schedule. Deployed on Cloudflare Pages.

This document is the complete spec. Follow it as written. Where it says "verify", do the verification before relying on the assumption.

---

## 1. Goals and non-goals

**Goals**

- Show market-implied odds for each upcoming BoC rate decision from all three sources, each in its own native shape (do NOT force the sources into one unified schema).
- Roll each source up to a simple cut / hold / hike summary so disagreement between sources is visible at a glance, and flag meaningful divergence.
- Show the official BoC decision schedule and current policy rate, with links to official BoC pages.
- Link prominently to every data source.
- Minimalist, clean, modern design. Fast. Works on mobile.
- Static frontend. A browser refresh is how users get fresh data. Served data may be cached; that is acceptable and expected.

**Non-goals (v1)**

- No historical charts or time series UI.
- No user accounts, no interactivity beyond links, no live-updating tickers or countdown timers.
- No client-side polling or websockets.
- No scraping of the BoC schedule (it is hardcoded, see section 8).

---

## 2. Architecture

```
Browser
  |  GET /            (static: index.html, styles.css, app.js)
  |  GET /api/odds    (Pages Function)
  v
Cloudflare Pages
  functions/api/odds.ts
      |-- KV "SNAPSHOTS" key snapshot:latest fresh (< 15 min)?  -> return it
      |-- stale or missing -> fetch all 4 upstreams in parallel,
      |     build snapshot, write to KV, return it
      |-- any upstream fails -> use that source's data from the
            previous snapshot, mark it stale, still return 200
```

- One Cloudflare Pages project. Static assets at the root, one Pages Function at `functions/api/odds.ts`.
- One KV namespace bound as `SNAPSHOTS`.
- No cron, no separate Worker. Refresh is demand-driven with a TTL: the first request after the snapshot goes stale pays the upstream latency (1 to 3 s), everyone else gets KV speed. This exactly matches the product decision "browser refresh is sufficient, data may be cached".
- **Zero npm runtime dependencies.** Use the platform: `fetch`, `HTMLRewriter`, KV. Frontend is plain HTML/CSS/JS (no framework, no bundler). The function may be TypeScript (Pages compiles it natively).

### Repo structure

```
/
  index.html
  styles.css
  app.js
  functions/
    api/
      odds.ts
  lib/                  (imported by odds.ts)
    kalshi.ts
    polymarket.ts
    bocodds.ts
    boc.ts
    schedule.ts
    snapshot.ts         (types + assembly + rollups + divergence)
  wrangler.toml
  README.md
```

---

## 3. Data source: Kalshi (public API, no auth)

- Endpoint: `GET https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=KXCBDECISIONCANADA&status=open`
  - Fallback host if that fails: `https://api.elections.kalshi.com` (same path). Both serve public market data without authentication.
- The series has one **event per meeting**, ticker like `KXCBDECISIONCANADA-26SEP`, and one binary **market per outcome** within the event (e.g. "Hike of 0bps", "Cut of 25bps", "Hike of 25bps").
- Group markets by `event_ticker`. Map the ticker suffix (`26SEP`) to the meeting date using the hardcoded schedule in section 8 (match by year + month).
- **Probability** for each outcome = midpoint of yes bid and yes ask. If the spread is missing or zero-width, fall back to last price.
  - Price fields exist in two formats depending on API version: integer cents (`yes_bid`) and/or string dollars (`yes_bid_dollars`). Handle both; verify against a live response before finalizing.
- Keep per-outcome: label (use `yes_sub_title` or `subtitle`), probability, volume, and a link. Market URL: `https://kalshi.com/markets/kxcbdecisioncanada/bank-of-canada-policy-interest-rate-decision`.
- **Direction rollup**: outcome label containing "cut" -> cut; "hike of 0" or "no change" -> hold (yes, Kalshi phrases a hold as a 0bp hike); any other "hike" -> hike.
- Normalize the outcome set to sum to 1.0 (market prices rarely sum exactly).

## 4. Data source: Polymarket (public Gamma API, no auth)

- Monthly events named "Bank of Canada decision in {Month}?". Event slug pattern: `bank-of-canada-decision-in-{month}` (lowercase month name).
- Endpoint: `GET https://gamma-api.polymarket.com/events?slug={slug}` (returns an array) or `GET https://gamma-api.polymarket.com/events/slug/{slug}` (returns one object). No auth.
- **Slug resolution must be defensive**: slugs may collide across years (a bare `...-in-december` slug has previously referred to December 2025). For each remaining meeting, try `{base}` then `{base}-{year}`, and accept a candidate only if the event's end date (or the resolution date in its description) falls in the same month and year as the meeting. Reject otherwise. If nothing validates, omit Polymarket for that meeting rather than showing wrong-year data.
- Each event contains multiple **markets**, one per bucket (e.g. "No change", "25 bps decrease", "50+ bps decrease", "25 bps increase"). For each market:
  - Bucket label: `groupItemTitle` (fallback: parse from `question`).
  - Probability: `outcomePrices` is a **stringified JSON array** aligned with `outcomes` (typically `["Yes","No"]`). Parse it, take the Yes price as the probability.
  - Also keep `volume` and `liquidity` and surface them in the UI (these markets are thin; users should see that context).
- Event URL for links: `https://polymarket.com/event/{slug}`.
- **Direction rollup**: "decrease" -> cut; "no change" -> hold; "increase" -> hike. Normalize buckets to sum to 1.0.

## 5. Data source: bankofcanadaodds.com (HTML scrape, gated by config)

- No API. Fetch `https://bankofcanadaodds.com/` and parse the server-rendered HTML. The homepage contains, per upcoming meeting, a heading like `Target Rate Probabilities for Sep. 2, 2026 BoC Meeting` followed by a two-column table of target rate (e.g. `2.50%`) vs probability (e.g. `23%`). It also contains the current policy rate and a "Last updated" timestamp; capture both.
- Parse with `HTMLRewriter` (built into the Workers runtime) or, if the markup proves awkward to stream-parse, a small regex pass over the fetched text. No DOM libraries.
- **Validation is mandatory.** This site has shipped visibly broken values (e.g. a hike probability of "10,000.0%"). Rules:
  - Parse each probability to a number; discard any row outside [0, 100].
  - If the surviving rows sum to between 90 and 110, renormalize to 100. Otherwise mark this source `degraded` for that meeting and do not display its numbers (show "data unavailable" with the outbound link instead).
- **Direction rollup**: compare each target-rate row to the current policy rate (from the BoC Valet API, section 6): lower -> cut, equal -> hold, higher -> hike.
- **Etiquette and permission:**
  - Their FAQ permits referencing data with attribution; commercial or custom data access requires contacting them. Implement behind an env var `ENABLE_BOCODDS` (default `false` in production until permission is confirmed; `true` is fine for local dev). When disabled, the UI shows the source card with its outbound link but no scraped numbers.
  - Send a descriptive `User-Agent` including a contact email (read from env var `CONTACT_EMAIL`).
  - The 15-minute snapshot TTL means at most ~4 requests/hour to their site regardless of traffic. Do not fetch it any other way.
  - Attribution "Data: BankofCanadaOdds.com" with a link must appear on the card whenever their numbers are shown.

## 6. Data source: Bank of Canada (official, Valet API)

- Current policy rate: `GET https://www.bankofcanada.ca/valet/observations/V39079/json?recent=1`. Series V39079 should be the target for the overnight rate; **verify the series label in the response** (`seriesDetail`) and fail loudly in dev if it is not the overnight rate target.
- Free, official, no auth. Cache with the snapshot like everything else.
- Official links to include in the UI (section 9): policy rate page, schedule press release, latest decision press releases. See link list in section 9.

---

## 7. The `/api/odds` contract

`GET /api/odds` returns `200` with JSON. Never 500 for a partial failure; degrade per source.

```jsonc
{
  "generated_at": "2026-07-25T14:30:00Z",
  "current_rate": { "value": 2.25, "as_of": "2026-07-15", "source": "boc_valet", "status": "ok" },
  "next_meeting": "2026-09-02",
  "meetings": [
    {
      "date": "2026-09-02",
      "time_et": "09:45",
      "sources": {
        "kalshi": {
          "status": "ok", // ok | stale | degraded | disabled | unavailable
          "fetched_at": "2026-07-25T14:30:00Z",
          "outcomes": [
            // native shape: bps-change buckets
            { "label": "Hike of 0bps", "probability": 0.78, "volume": 12345 },
          ],
          "rollup": { "cut": 0.01, "hold": 0.78, "hike": 0.21 },
          "url": "https://kalshi.com/markets/kxcbdecisioncanada/...",
        },
        "polymarket": {
          "status": "ok",
          "fetched_at": "...",
          "outcomes": [
            // native shape: bucket markets
            { "label": "No change", "probability": 0.95, "volume": 5800, "liquidity": 18200 },
          ],
          "rollup": { "cut": 0.03, "hold": 0.95, "hike": 0.02 },
          "url": "https://polymarket.com/event/bank-of-canada-decision-in-september",
        },
        "bocodds": {
          "status": "ok",
          "fetched_at": "...",
          "last_updated_text": "July 25, 2026 8:56 am",
          "outcomes": [
            // native shape: target rate levels
            { "label": "2.25%", "probability": 0.77 },
            { "label": "2.50%", "probability": 0.23 },
          ],
          "rollup": { "cut": 0.0, "hold": 0.77, "hike": 0.23 },
          "url": "https://bankofcanadaodds.com/",
        },
      },
      "divergence": {
        "flagged": true,
        "max_gap": 0.18, // largest pairwise gap across cut/hold/hike
        "note": "hold", // which direction has the largest gap
      },
    },
  ],
  "schedule": [{ "date": "2026-09-02", "time_et": "09:45" }], // remaining meetings this year
}
```

- Probabilities are floats in [0, 1]. Rollups are computed server-side; the client does no math beyond formatting.
- **Divergence rule**: for each direction (cut/hold/hike), take max minus min across sources with `status: ok`; `max_gap` is the largest of those; `flagged` when `max_gap >= 0.10`. Needs at least 2 ok sources.
- **Caching**: KV key `snapshot:latest` holds the full response body plus `generated_at`. Function logic: if snapshot age < 15 min, return it. Otherwise refetch all upstreams in parallel with a 5 s per-source timeout; for any source that fails, carry forward that source's block from the previous snapshot with `status: "stale"` and its old `fetched_at`; write and return the new snapshot. Response headers: `Cache-Control: public, max-age=60`, `Access-Control-Allow-Origin: *`.
- **History (cheap insurance, no UI)**: on each successful refresh, also `put` the snapshot at `snapshot:history:{generated_at}`. Two lines of code; ignore it otherwise. bankofcanadaodds has no historical API, so this is the only record that will ever exist.

---

## 8. Meeting schedule (hardcoded constants)

`lib/schedule.ts` exports the official 2026 dates (all 09:45 ET): Jan 28, Mar 18, Apr 29, Jun 10, Jul 15, Sep 2, Oct 28, Dec 9. Filter to dates >= today for display. Include a loud comment: the BoC publishes next year's schedule each August at bankofcanada.ca (press release "schedule for policy interest rate announcements"); update this file annually. "Next decision" = the first remaining date; render it as plain text ("Wednesday, September 2, 09:45 ET, in 39 days"), computed once at page load. No ticking countdown.

---

## 9. Frontend spec

Single page, single column, max-width ~720 px, centered. Order top to bottom:

1. **Header**: app name + one-line description ("Bank of Canada rate odds from three independent sources"). Current policy rate and next decision date as plain text, not a hero stat block.
2. **Meeting sections**, one per remaining meeting, next meeting first and visually primary (later meetings slightly smaller / lower contrast). Each meeting section contains:
   - Date heading + divergence flag when `flagged` (small labelled marker, e.g. "sources disagree on hold: 77% vs 95%", using the two extreme values).
   - **The consensus strip (signature element, see design section)**: three aligned horizontal bars, one per source, on a shared 0 to 100% axis, segmented cut / hold / hike. Because they share an axis, disagreement is visible as misalignment of segment boundaries. Each bar is labelled with the source name and links to the source.
   - Below the strip, three compact per-source detail lists in the source's **native** terms: Kalshi bps buckets, Polymarket buckets with volume/liquidity shown, bankofcanadaodds target-rate levels with its "last updated" text and attribution line. Never translate one source's labels into another's.
   - Source states: `stale` -> show numbers with an "as of {time}" tag; `degraded`/`unavailable`/`disabled` -> keep the source row with its outbound link and a plain one-line explanation.
3. **Schedule**: remaining decision dates as a simple list, each linking to the BoC key-interest-rate page.
4. **Links & about**: outbound links to Kalshi series page, Polymarket BoC predictions page (`https://polymarket.com/predictions/bank-of-canada`), bankofcanadaodds.com, BoC policy rate page (`https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/`), BoC 2026 schedule press release, and BoC press releases. Short methodology note (midpoints, normalization, refresh cadence) and disclaimer: market-implied probabilities, not forecasts, not financial advice; not affiliated with the Bank of Canada or any source.

**Behavior**: `app.js` fetches `/api/odds` once on load and renders. No polling, no refresh button (browser refresh is the refresh). Three UI states: loading (skeleton bars), rendered, and error (friendly message + retry link + the static outbound links so the page is still useful).

**Accessibility floor**: every bar has visible text percentages (color is never the only channel), semantic headings, visible keyboard focus, honored `prefers-reduced-motion`, WCAG AA contrast in both themes.

---

## 10. Design direction

Minimalist and modern, but designed, not default. The subject is Canadian monetary policy: the palette borrows from Canadian polymer banknotes and the register is calm and institutional, closer to a well-set rate bulletin than a trading dashboard.

**Tokens** (define as CSS custom properties; dark theme via `prefers-color-scheme`):

- Palette (light): `--paper: #FAFAF7` (off-white, slightly warm), `--ink: #1A1D21`, `--muted: #6B7280`, `--rule: #E4E4DE` (hairline borders). Semantic, used only in bars and the divergence flag: `--cut: #2F6FB2` (banknote blue, rate goes down), `--hold: #14684B` ($20-note green, steady), `--hike: #A63A2E` ($50-note red, rate goes up). Dark theme: `--paper: #14161A`, `--ink: #ECECE6`, desaturate the three semantics ~15%.
- Type: **IBM Plex Sans** for UI text, **IBM Plex Mono** for every numeral (percentages, rates, dates in the strip) with `font-variant-numeric: tabular-nums` so columns of figures align. Self-host two weights each via `@font-face` (no CDN link tags); fall back to system stacks. Scale: 15 px body, 13 px captions, meeting dates ~22 px semibold; the app name is the only larger element.
- Layout: generous whitespace, hairline `--rule` dividers between meeting sections, no cards/shadows/gradients. 4 px spacing grid.
- **Signature element**: the consensus strip described in section 9. Spend all visual interest here; everything around it stays quiet. Segments are flat fills separated by 2 px of `--paper`; each bar 12 px tall with the source name in 13 px caption to the left and the hold % in mono to the right.
- Motion: on first render only, the strip segments grow to width over ~300 ms ease-out. Nothing else animates. Disabled entirely under `prefers-reduced-motion`.

Copy register: plain, specific, sentence case. Say "sources disagree" not "divergence detected". Errors say what happened and what to do ("Kalshi didn't respond. Showing its odds from 14:02.").

---

## 11. Config and deployment

- `wrangler.toml`: Pages config with KV binding `SNAPSHOTS`, vars `ENABLE_BOCODDS` (default false), `CONTACT_EMAIL`.
- Local dev: `npx wrangler pages dev . --kv SNAPSHOTS` (document the exact command in the README against the current wrangler version).
- Deploy: Cloudflare Pages via GitHub integration or `npx wrangler pages deploy`. Document creating the KV namespace and binding it in the Pages dashboard for production.
- README covers: setup, env vars, how to update the yearly schedule, and how to enable the bankofcanadaodds source once permission is confirmed.

## 12. Acceptance criteria

1. `GET /api/odds` returns the schema in section 7 with live Kalshi and Polymarket data for every remaining 2026 meeting that has markets; verified against the real APIs, not mocks.
2. Polymarket slug resolution rejects wrong-year events (unit test with a simulated colliding slug).
3. With `ENABLE_BOCODDS=true`, the parser extracts all upcoming meeting tables from a saved copy of the homepage HTML (fixture committed to the repo), and the validation rules reject a fixture row of "10,000.0%".
4. Killing any one upstream (simulate timeout) still yields a 200 with that source marked `stale` (or `unavailable` on first run) and the others `ok`.
5. Two consecutive requests within 15 minutes produce one set of upstream fetches (KV hit on the second; verify via logs).
6. Rollups: each source's cut+hold+hike sums to 1.0 ± 0.001; divergence flag fires on a constructed 12-point hold gap and not on a 5-point gap (unit tests).
7. Frontend renders correctly with: all sources ok; one source degraded; bocodds disabled; API unreachable. Mobile at 375 px wide has no horizontal scroll.
8. Lighthouse: performance and accessibility >= 95 on the deployed site. Total JS < 15 KB gzipped, no external requests except `/api/odds` and self-hosted fonts.
9. Attribution and disclaimer text present as specified in sections 5 and 9.
