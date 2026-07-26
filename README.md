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

### Kalshi rate limits (read this if Kalshi shows "didn't respond")

Anonymous Kalshi requests are rate-limited per IP, and Cloudflare Workers egress IPs are
shared across many tenants — so production requests frequently get 429s even though the same
request works from a residential IP. Mitigations, in order of preference:

1. **API key** (if you can create one — key creation is restricted in some jurisdictions,
   including Canada): kalshi.com → Account & Security → API Keys, then set two **encrypted**
   env vars in the Pages dashboard: `KALSHI_API_KEY_ID` (the UUID) and `KALSHI_PRIVATE_KEY`
   (the downloaded PEM, pasted verbatim; PKCS#8 or PKCS#1, `\n`-escaped also accepted).
   Requests are then signed (RSA-PSS) and rate limiting applies per key instead of per IP.
2. **Relay on a different egress pool**: route Kalshi requests through a tiny proxy hosted
   somewhere whose IPs aren't shared with half the internet. This is what production uses —
   see "The Kalshi relay (Deno Deploy)" below.
3. **Do nothing**: the function retries 429s with backoff on every refresh, and any success is
   carried forward as `stale` between wins, so intermittent breakthroughs keep the card
   populated with an "as of" tag.

### The Kalshi relay (Deno Deploy)

Production routes all Kalshi traffic through a relay running as a Deno Deploy playground:

- **Playground (edit/deploy here):** https://console.deno.com/patsissons/bocodds
- **Deployment URL:** https://bocodds.patsissons.deno.net — wired up via `KALSHI_BASE_URL`
  in `wrangler.toml` `[vars]`, so the Pages Function calls the relay instead of
  `external-api.kalshi.com` directly.
- **Source of truth:** `proxy/kalshi-proxy.ts` in this repo.

The relay is deliberately minimal: it accepts only `GET /trade-api/v2/markets` (the one
endpoint this app uses), forwards the query string verbatim to `external-api.kalshi.com`,
returns the upstream body with a 15 s cache header, and 404s everything else. It never
touches authenticated routes and holds no secrets, so a playground is all it needs.

**Updating or redeploying the relay** — the playground is _not_ connected to this repo;
edits to `proxy/kalshi-proxy.ts` do **not** deploy themselves:

1. Make the change in `proxy/kalshi-proxy.ts` and commit it here (keep the repo the source
   of truth).
2. Open the playground and paste the full updated file over its contents. Saving a
   playground deploys it — the URL stays the same, so no Cloudflare change is needed.
3. Verify with a curl against the relay; a healthy response is Kalshi market JSON:

   ```sh
   curl 'https://bocodds.patsissons.deno.net/trade-api/v2/markets?series_ticker=KXCBDECISIONCANADA&status=open&limit=1'
   ```

4. Optionally force a fresh snapshot (see "Forcing an early refresh") and confirm the
   Kalshi card on the site shows numbers again.

To point production at a different relay (or bypass it), change `KALSHI_BASE_URL` in
`wrangler.toml` and push, or override the var in the Pages dashboard. Removing the var
entirely falls back to contacting Kalshi directly — which is exactly the setup that gets
429'd from Cloudflare, so keep the relay unless something better replaces it. Local dev
and the test suites never use the relay (tests point `KALSHI_BASE_URL` at a fixture
server).

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
