import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPolymarketLabel,
  eventMatchesMeeting,
  fetchPolymarket,
  marketYesProbability,
  parsePolymarketEvent,
  type PolymarketEvent,
} from '../../lib/polymarket';

// Live Gamma API responses captured 2026-07-25. Paths relative to project root.
const septemberEvents = JSON.parse(
  readFileSync('tests/fixtures/polymarket-september-2026.json', 'utf8'),
) as PolymarketEvent[];
const octoberCollision = JSON.parse(
  readFileSync('tests/fixtures/polymarket-october-2025-collision.json', 'utf8'),
) as PolymarketEvent[];
const searchBody = readFileSync('tests/fixtures/polymarket-search.json', 'utf8');

describe('classifyPolymarketLabel', () => {
  it('maps bucket labels to directions', () => {
    expect(classifyPolymarketLabel('25 bps decrease')).toBe('cut');
    expect(classifyPolymarketLabel('50+ bps decrease')).toBe('cut');
    expect(classifyPolymarketLabel('No Change')).toBe('hold');
    expect(classifyPolymarketLabel('25 bps increase')).toBe('hike');
    expect(classifyPolymarketLabel('mystery bucket')).toBeNull();
  });
});

describe('eventMatchesMeeting', () => {
  it('accepts the September 2026 event for the 2026-09-02 meeting', () => {
    expect(eventMatchesMeeting(septemberEvents[0]!, '2026-09-02')).toBe(true);
  });

  it('rejects the colliding October 2025 event for the 2026-10-28 meeting', () => {
    expect(eventMatchesMeeting(octoberCollision[0]!, '2026-10-28')).toBe(false);
  });

  it('rejects events with a missing or malformed end date', () => {
    expect(eventMatchesMeeting({ slug: 'x' }, '2026-09-02')).toBe(false);
    expect(eventMatchesMeeting({ slug: 'x', endDate: 'not a date' }, '2026-09-02')).toBe(false);
  });
});

describe('marketYesProbability', () => {
  it('parses the stringified outcomePrices array, taking the Yes price', () => {
    expect(
      marketYesProbability({ outcomes: '["Yes", "No"]', outcomePrices: '["0.801", "0.199"]' }),
    ).toBeCloseTo(0.801, 6);
    expect(
      marketYesProbability({ outcomes: '["No", "Yes"]', outcomePrices: '["0.199", "0.801"]' }),
    ).toBeCloseTo(0.801, 6);
  });

  it('returns null for unparseable prices', () => {
    expect(marketYesProbability({ outcomePrices: 'garbage' })).toBeNull();
    expect(marketYesProbability({})).toBeNull();
  });
});

describe('parsePolymarketEvent (live fixture)', () => {
  const block = parsePolymarketEvent(septemberEvents[0]!)!;

  it('normalizes bucket probabilities to sum to 1.0 ± 0.001', () => {
    const sum = block.outcomes!.reduce((s, o) => s + o.probability, 0);
    expect(sum).toBeCloseTo(1.0, 3);
    const { cut, hold, hike } = block.rollup!;
    expect(cut + hold + hike).toBeCloseTo(1.0, 3);
  });

  it('keeps native bucket labels with volume and liquidity', () => {
    const noChange = block.outcomes!.find((o) => o.label === 'No Change')!;
    expect(noChange.probability).toBeGreaterThan(0.5);
    expect(noChange.volume).toBeGreaterThan(0);
    expect(noChange.liquidity).toBeGreaterThan(0);
  });

  it('links to the event page using the real slug', () => {
    expect(block.url).toBe(
      'https://polymarket.com/event/bank-of-canada-decision-in-september-20260701223913897',
    );
  });
});

describe('fetchPolymarket slug resolution', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(routes: Record<string, string>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        for (const [fragment, body] of Object.entries(routes)) {
          if (url.includes(fragment)) return new Response(body, { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }),
    );
  }

  it('rejects a colliding wrong-year slug and resolves via search', async () => {
    // The bare October slug serves the real 2025 event; only search knows the
    // timestamp-suffixed 2026 slug.
    stubFetch({
      '/events?slug=bank-of-canada-decision-in-october': JSON.stringify(octoberCollision),
      '/public-search': searchBody,
    });
    const blocks = await fetchPolymarket(
      [{ date: '2026-10-28', time_et: '09:45' }],
      'https://gamma.test',
    );
    const block = blocks.get('2026-10-28');
    expect(block).toBeDefined();
    expect(block!.url).toContain('bank-of-canada-decision-in-october-20260715203359314');
  });

  it('omits the meeting entirely when nothing validates', async () => {
    stubFetch({
      '/events?slug=bank-of-canada-decision-in-october': JSON.stringify(octoberCollision),
      '/public-search': '{"events": []}',
    });
    const blocks = await fetchPolymarket(
      [{ date: '2026-10-28', time_et: '09:45' }],
      'https://gamma.test',
    );
    expect(blocks.size).toBe(0);
  });

  it('accepts a direct slug match when the end date validates', async () => {
    stubFetch({
      '/events?slug=bank-of-canada-decision-in-september': JSON.stringify(septemberEvents),
    });
    const blocks = await fetchPolymarket(
      [{ date: '2026-09-02', time_et: '09:45' }],
      'https://gamma.test',
    );
    expect(blocks.get('2026-09-02')).toBeDefined();
  });
});
