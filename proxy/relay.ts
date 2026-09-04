// Minimal upstream relay for hosts that reject Cloudflare Workers egress:
// Workers share anonymous per-IP quota across all tenants, so Kalshi
// rate-limits it (429) and the Bank of Canada WAF blocks it outright. Deploy
// this on a platform with a different egress pool — production uses a Deno
// Deploy playground; see README "The upstream relay (Deno Deploy)" for the
// deployment and update procedure. This file is the source of truth: paste it
// into the playground to redeploy.
//
// It only relays the endpoints this app uses, forwards the query string
// verbatim, and never touches authenticated routes.

const ROUTES: Record<string, string> = {
  // Kalshi markets: shared Workers egress IPs are anonymously rate-limited.
  '/trade-api/v2/markets': 'https://external-api.kalshi.com',
  // BoC Valet policy rate: the BoC WAF blocks Workers egress IPs outright.
  '/valet/observations/V39079/json': 'https://www.bankofcanada.ca',
};

export async function handleRelayRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const upstream = ROUTES[url.pathname];
  if (request.method !== 'GET' || !upstream) {
    return new Response('not found', { status: 404 });
  }
  const response = await fetch(`${upstream}${url.pathname}${url.search}`, {
    headers: { 'User-Agent': 'bocodds-relay/1.0 (+https://bocodds.com)' },
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=15',
    },
  });
}

// The Deno global only exists on Deno Deploy; vitest imports the handler.
declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void } | undefined;
if (typeof Deno !== 'undefined') Deno.serve(handleRelayRequest);
