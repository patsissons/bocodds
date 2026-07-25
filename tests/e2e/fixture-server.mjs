// Tiny dev-only upstream stub for e2e runs. Serves the committed fixtures on
// one port; the Pages Function is pointed here via *_BASE_URL bindings so the
// full stack (static assets + function + KV) runs deterministically offline.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.FIXTURE_PORT ?? 9788);

const kalshi = readFileSync('tests/fixtures/kalshi-markets.json', 'utf8');
const septemberEvent = readFileSync('tests/fixtures/polymarket-september-2026.json', 'utf8');
const search = readFileSync('tests/fixtures/polymarket-search.json', 'utf8');
const bocodds = readFileSync('tests/fixtures/bocodds-homepage.html', 'utf8');
const valet = readFileSync('tests/fixtures/boc-valet.json', 'utf8');

function respond(res, body, type = 'application/json') {
  res.writeHead(200, { 'Content-Type': type });
  res.end(body);
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/trade-api/')) return respond(res, kalshi);
  if (url.pathname === '/events') {
    const slug = url.searchParams.get('slug') ?? '';
    // Mirror production: the year-suffixed September slug resolves directly;
    // October only resolves via search; December has no event at all.
    if (slug === 'bank-of-canada-decision-in-september-2026') {
      return respond(res, septemberEvent);
    }
    return respond(res, '[]');
  }
  if (url.pathname === '/public-search') return respond(res, search);
  if (url.pathname.startsWith('/valet/')) return respond(res, valet);
  if (url.pathname === '/') return respond(res, bocodds, 'text/html');
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, () => {
  console.log(`fixture server on http://localhost:${PORT}`);
});
