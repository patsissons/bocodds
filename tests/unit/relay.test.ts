import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRelayRequest } from '../../proxy/relay';

function stubUpstream(body = '{"ok":true}', status = 200) {
  const impl = vi.fn(async (input: string | URL | Request) => {
    void input;
    return new Response(body, { status });
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relay', () => {
  it('forwards the Kalshi markets path with the query string intact', async () => {
    const impl = stubUpstream();
    const response = await handleRelayRequest(
      new Request('https://relay.test/trade-api/v2/markets?series_ticker=X&limit=1'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=15');
    expect(String(impl.mock.calls[0]![0])).toBe(
      'https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=X&limit=1',
    );
  });

  it('forwards the BoC Valet observations path to bankofcanada.ca', async () => {
    const impl = stubUpstream();
    const response = await handleRelayRequest(
      new Request('https://relay.test/valet/observations/V39079/json?recent=1'),
    );
    expect(response.status).toBe(200);
    expect(String(impl.mock.calls[0]![0])).toBe(
      'https://www.bankofcanada.ca/valet/observations/V39079/json?recent=1',
    );
  });

  it('passes upstream error statuses through', async () => {
    stubUpstream('nope', 429);
    const response = await handleRelayRequest(
      new Request('https://relay.test/trade-api/v2/markets'),
    );
    expect(response.status).toBe(429);
  });

  it('404s paths outside the allowlist without contacting any upstream', async () => {
    const impl = stubUpstream();
    const response = await handleRelayRequest(new Request('https://relay.test/valet/lists/json'));
    expect(response.status).toBe(404);
    expect(impl).not.toHaveBeenCalled();
  });

  it('404s non-GET methods even on allowlisted paths', async () => {
    const impl = stubUpstream();
    const response = await handleRelayRequest(
      new Request('https://relay.test/trade-api/v2/markets', { method: 'POST' }),
    );
    expect(response.status).toBe(404);
    expect(impl).not.toHaveBeenCalled();
  });
});
