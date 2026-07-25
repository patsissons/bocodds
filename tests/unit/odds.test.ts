import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestGet } from '../../functions/api/odds';
import type { Snapshot } from '../../lib/snapshot';

const kalshiBody = readFileSync('tests/fixtures/kalshi-markets.json', 'utf8');
const septemberBody = readFileSync('tests/fixtures/polymarket-september-2026.json', 'utf8');
const searchBody = readFileSync('tests/fixtures/polymarket-search.json', 'utf8');
const bocOddsBody = readFileSync('tests/fixtures/bocodds-homepage.html', 'utf8');
const valetBody = readFileSync('tests/fixtures/boc-valet.json', 'utf8');

const NOW = new Date('2026-07-25T14:30:00Z');

class MockKV {
  store = new Map<string, string>();
  get = vi.fn(async (key: string) => this.store.get(key) ?? null);
  put = vi.fn(async (key: string, value: string) => {
    this.store.set(key, value);
  });
}

type Route = { match: string; body: string; status?: number; fail?: boolean };

function stubFetch(routes: Route[]) {
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const route of routes) {
      if (!url.includes(route.match)) continue;
      if (route.fail) throw new Error(`simulated timeout for ${url}`);
      return new Response(route.body, { status: route.status ?? 200 });
    }
    throw new Error(`unrouted fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

const healthyRoutes: Route[] = [
  { match: 'external-api.kalshi.com', body: kalshiBody },
  { match: 'slug=bank-of-canada-decision-in-september&', body: '[]' },
  { match: 'slug=bank-of-canada-decision-in-september-2026', body: septemberBody },
  { match: '/events?slug=', body: '[]' },
  { match: '/public-search', body: searchBody },
  { match: 'bankofcanadaodds.com', body: bocOddsBody },
  { match: 'bankofcanada.ca/valet', body: valetBody },
];

function makeContext(kv: MockKV, envOverrides: Record<string, string> = {}) {
  const env = {
    SNAPSHOTS: kv,
    ENABLE_BOCODDS: 'true',
    CONTACT_EMAIL: 'test@example.com',
    ...envOverrides,
  };
  return {
    env,
    request: new Request('https://app.test/api/odds'),
    waitUntil: vi.fn(),
  } as unknown as Parameters<typeof onRequestGet>[0];
}

async function invoke(kv: MockKV, envOverrides: Record<string, string> = {}) {
  const response = await onRequestGet(makeContext(kv, envOverrides));
  return { response, body: (await response.json()) as Snapshot };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GET /api/odds', () => {
  it('builds a full snapshot from healthy upstreams (cold start)', async () => {
    stubFetch(healthyRoutes);
    const kv = new MockKV();
    const { response, body } = await invoke(kv);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');

    expect(body.generated_at).toBe('2026-07-25T14:30:00.000Z');
    expect(body.current_rate).toEqual({
      value: 2.25,
      as_of: '2026-07-23',
      source: 'boc_valet',
      status: 'ok',
    });
    expect(body.next_meeting).toBe('2026-09-02');
    expect(body.meetings.map((m) => m.date)).toEqual(['2026-09-02', '2026-10-28', '2026-12-09']);
    expect(body.schedule).toHaveLength(3);

    const september = body.meetings[0]!;
    expect(september.sources.kalshi!.status).toBe('ok');
    expect(september.sources.polymarket!.status).toBe('ok');
    expect(september.sources.bocodds!.status).toBe('ok');
    for (const source of Object.values(september.sources)) {
      if (source.status !== 'ok') continue;
      const { cut, hold, hike } = source.rollup!;
      expect(cut + hold + hike).toBeCloseTo(1.0, 3);
    }

    // Persisted to KV: latest + history.
    expect(kv.store.has('snapshot:latest')).toBe(true);
    expect(kv.store.has('snapshot:history:2026-07-25T14:30:00.000Z')).toBe(true);
  });

  it('serves a fresh snapshot from KV without touching upstreams', async () => {
    const fetchImpl = stubFetch(healthyRoutes);
    const kv = new MockKV();

    const first = await invoke(kv);
    const upstreamCalls = fetchImpl.mock.calls.length;
    expect(upstreamCalls).toBeGreaterThan(0);

    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60 * 1000)); // 5 min later
    const second = await invoke(kv);
    expect(fetchImpl.mock.calls.length).toBe(upstreamCalls); // no new upstream fetches
    expect(second.body).toEqual(first.body);
  });

  it('refetches after the 15-minute TTL expires', async () => {
    const fetchImpl = stubFetch(healthyRoutes);
    const kv = new MockKV();
    await invoke(kv);
    const upstreamCalls = fetchImpl.mock.calls.length;

    vi.setSystemTime(new Date(NOW.getTime() + 16 * 60 * 1000));
    const { body } = await invoke(kv);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(upstreamCalls);
    expect(body.generated_at).toBe('2026-07-25T14:46:00.000Z');
  });

  it('returns 200 with a stale carry-forward when one upstream dies', async () => {
    stubFetch(healthyRoutes);
    const kv = new MockKV();
    const first = await invoke(kv);

    // Kill Kalshi (both hosts) and expire the snapshot.
    stubFetch([
      { match: 'kalshi.com', body: '', fail: true },
      ...healthyRoutes.filter((r) => !r.match.includes('kalshi')),
    ]);
    vi.setSystemTime(new Date(NOW.getTime() + 20 * 60 * 1000));
    const { response, body } = await invoke(kv);

    expect(response.status).toBe(200);
    const september = body.meetings[0]!;
    expect(september.sources.kalshi!.status).toBe('stale');
    // Stale data is the previous snapshot's, with its original fetched_at.
    expect(september.sources.kalshi!.outcomes).toEqual(
      first.body.meetings[0]!.sources.kalshi!.outcomes,
    );
    expect(september.sources.kalshi!.fetched_at).toBe('2026-07-25T14:30:00.000Z');
    expect(september.sources.polymarket!.status).toBe('ok');
    expect(september.sources.bocodds!.status).toBe('ok');
  });

  it('marks a dead upstream unavailable on a cold start and still returns 200', async () => {
    stubFetch([
      { match: 'kalshi.com', body: '', fail: true },
      ...healthyRoutes.filter((r) => !r.match.includes('kalshi')),
    ]);
    const { response, body } = await invoke(new MockKV());
    expect(response.status).toBe(200);
    const september = body.meetings[0]!;
    expect(september.sources.kalshi!.status).toBe('unavailable');
    expect(september.sources.kalshi!.note).toBeTruthy();
    expect(september.sources.kalshi!.url).toContain('kalshi.com');
    expect(september.sources.polymarket!.status).toBe('ok');
  });

  it('shows bocodds as disabled (link only, no fetch) when ENABLE_BOCODDS is false', async () => {
    const fetchImpl = stubFetch(healthyRoutes);
    const { body } = await invoke(new MockKV(), { ENABLE_BOCODDS: 'false' });
    const september = body.meetings[0]!;
    expect(september.sources.bocodds!.status).toBe('disabled');
    expect(september.sources.bocodds!.url).toBe('https://bankofcanadaodds.com/');
    expect(september.sources.bocodds!.outcomes).toBeUndefined();
    const bocoddsCalls = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes('bankofcanadaodds.com'),
    );
    expect(bocoddsCalls).toHaveLength(0);
  });

  it('marks a meeting with no market as unavailable for that source', async () => {
    stubFetch(healthyRoutes);
    const { body } = await invoke(new MockKV());
    // The search fixture has no December 2026 Polymarket event.
    const december = body.meetings.find((m) => m.date === '2026-12-09')!;
    expect(december.sources.polymarket!.status).toBe('unavailable');
    expect(december.sources.kalshi!.status).toBe('ok');
  });

  it('flags divergence per meeting using ok sources only', async () => {
    stubFetch(healthyRoutes);
    const { body } = await invoke(new MockKV());
    for (const meeting of body.meetings) {
      expect(meeting.divergence).toHaveProperty('flagged');
      const okCount = Object.values(meeting.sources).filter((s) => s.status === 'ok').length;
      if (okCount < 2) expect(meeting.divergence.flagged).toBe(false);
    }
  });
});
