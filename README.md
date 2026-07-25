# BoC Rate Odds

Bank of Canada policy-rate odds from three independent sources — Kalshi, Polymarket, and
BankofCanadaOdds.com — side by side, with disagreement flagged, plus the official decision
schedule and current policy rate. Static frontend, one Cloudflare Pages Function, zero npm
runtime dependencies.

## How it works

- `public/` — plain HTML/CSS/JS frontend. `app.js` fetches `/api/odds` once on load and renders;
  a browser refresh is the refresh.
- `functions/api/odds.ts` — the only server code. Returns a KV-cached snapshot; if the snapshot
  is older than 15 minutes it refetches all upstreams in parallel (5 s per-source timeout).
  A failing source is carried forward from the previous snapshot marked `stale`
  (`unavailable` on cold start) — partial failures never produce a 500.
- `lib/` — per-source clients and the shared snapshot math (normalization, cut/hold/hike
  rollups, divergence rule). Sources keep their native shapes: Kalshi bps buckets, Polymarket
  bucket markets, BankofCanadaOdds target-rate levels.

## Setup

```sh
npm install
```

Local config: create `.dev.vars` (gitignored; wrangler reads it during `npm run dev`):

```
ENABLE_BOCODDS=true
CONTACT_EMAIL=you@example.com
```

## Development

```sh
npm run dev
```

Runs `wrangler pages dev public --kv SNAPSHOTS` (wrangler 4.x): static assets from `public/`,
the function at `/api/odds`, and a local `SNAPSHOTS` KV namespace. Open http://localhost:8788.

## Tests and checks

```sh
npm run check      # prettier + eslint + tsc + vitest, run before every commit
npm test           # vitest unit tests (fixture-driven, offline)
npm run test:e2e   # Playwright: full stack against a local fixture server
```

The e2e suite starts a fixture server (`tests/e2e/fixture-server.mjs`) plus a wrangler instance
whose upstream base URLs point at it (`KALSHI_BASE_URL` etc.), so the real function runs
deterministically offline. First run: `npx playwright install chromium`.

## Deployment (Cloudflare Pages)

1. Create the Pages project (GitHub integration, or `npx wrangler pages deploy`).
   Build output directory: `public`. No build command needed.
2. Create a KV namespace and bind it as `SNAPSHOTS` in the Pages dashboard
   (Settings → Bindings → KV namespace).
3. Set production vars in the dashboard: `CONTACT_EMAIL`, and `ENABLE_BOCODDS` (see below;
   defaults to `false` in `wrangler.toml`).

## Enabling the BankofCanadaOdds.com source

Their FAQ permits referencing data with attribution; anything beyond that requires contacting
them. Until permission is confirmed, keep `ENABLE_BOCODDS=false` in production — the UI still
shows the source card with an outbound link, just no scraped numbers. Once confirmed, set
`ENABLE_BOCODDS=true`. The scraper sends a User-Agent containing `CONTACT_EMAIL`, is attributed
in the UI, and the 15-minute snapshot TTL caps traffic at ~4 requests/hour regardless of
visitors.

## Updating the yearly schedule

The Bank of Canada publishes next year's decision dates each August (press release: "schedule
for policy interest rate announcements"). Add them to `lib/schedule.ts` — that hardcoded list
is the only place the schedule lives.

## Disclaimer

Market-implied probabilities, not forecasts, not financial advice. Not affiliated with the
Bank of Canada, Kalshi, Polymarket, or BankofCanadaOdds.com.
