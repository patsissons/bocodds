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
2. The `SNAPSHOTS` KV binding is declared in `wrangler.toml` (namespace
   `bocodds-snapshots`); Pages applies it automatically on deploy. If you fork this, create
   your own KV namespace and put its ID there (or bind it in the dashboard instead).
3. Set production vars in the dashboard: `CONTACT_EMAIL`, and `ENABLE_BOCODDS` (see below;
   defaults to `false` in `wrangler.toml`).

### Kalshi API key (required in practice)

Anonymous Kalshi requests are rate-limited per IP, and Cloudflare Workers egress IPs are
shared across many tenants — so production requests almost always get 429s. Create an API key
(kalshi.com → Account & Security → API Keys) and set two **encrypted** env vars in the Pages
dashboard:

- `KALSHI_API_KEY_ID` — the key ID (UUID shown at creation)
- `KALSHI_PRIVATE_KEY` — the downloaded private key PEM, pasted verbatim (PKCS#8 or PKCS#1;
  literal `\n` escapes also accepted)

Requests are then signed (RSA-PSS, per Kalshi's auth scheme) and rate limiting applies to your
key instead of the shared IP. Without the key, the function still retries 429s with backoff
and carries stale Kalshi data forward when blocked.

### Forcing an early refresh

Snapshots refresh on demand when older than 15 minutes. To rebuild one immediately (after a
fix, or when a source came back), set a `REFRESH_TOKEN` secret in the Pages dashboard
(Settings → Environment variables, encrypted) and request:

```
https://your-site/api/odds?refresh=<token>
```

Without the token (or with a wrong one) the request behaves like any other. Alternatively,
delete the `snapshot:latest` key from the KV namespace — the next request rebuilds it.

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
