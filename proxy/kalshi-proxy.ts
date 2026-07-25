// Minimal Kalshi relay for when the main deployment's egress IPs are
// rate-limited (Cloudflare Workers share anonymous per-IP quota across all
// tenants; see README "Kalshi rate limits"). Deploy this on a platform with a
// different egress pool — e.g. Deno Deploy's free tier (dash.deno.com → New
// Playground → paste this file) — then set KALSHI_BASE_URL to the deployment
// URL in the Pages dashboard.
//
// It only relays the one endpoint this app uses, forwards the query string
// verbatim, and never touches authenticated routes.

const UPSTREAM = 'https://external-api.kalshi.com';
const ALLOWED_PATH = '/trade-api/v2/markets';

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== ALLOWED_PATH) {
    return new Response('not found', { status: 404 });
  }
  const upstream = await fetch(`${UPSTREAM}${ALLOWED_PATH}${url.search}`, {
    headers: { 'User-Agent': 'bocodds-kalshi-relay/1.0 (+https://bocodds.com)' },
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=15',
    },
  });
});
