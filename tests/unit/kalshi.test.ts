import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyKalshiLabel,
  fetchKalshi,
  marketProbability,
  meetingDateForEventTicker,
  parseKalshiMarkets,
  type KalshiMarket,
} from '../../lib/kalshi';

// Live response from external-api.kalshi.com captured 2026-07-25.
// Path is relative to the project root (vitest's cwd).
const fixture = JSON.parse(readFileSync('tests/fixtures/kalshi-markets.json', 'utf8')) as {
  markets: KalshiMarket[];
};

describe('classifyKalshiLabel', () => {
  it('maps labels to directions, including hold phrasings', () => {
    expect(classifyKalshiLabel('Cut 25bps')).toBe('cut');
    expect(classifyKalshiLabel('Cut >25bps')).toBe('cut');
    expect(classifyKalshiLabel('Maintains rate')).toBe('hold');
    expect(classifyKalshiLabel('Hike of 0bps')).toBe('hold');
    expect(classifyKalshiLabel('No change')).toBe('hold');
    expect(classifyKalshiLabel('Hike 25bps')).toBe('hike');
    expect(classifyKalshiLabel('Hike >25bps')).toBe('hike');
    expect(classifyKalshiLabel('Something else')).toBeNull();
  });
});

describe('marketProbability', () => {
  it('uses the bid/ask midpoint for a tight spread (dollar strings)', () => {
    const market = {
      yes_bid_dollars: '0.7500',
      yes_ask_dollars: '0.8400',
      last_price_dollars: '0.9900',
    } as KalshiMarket;
    expect(marketProbability(market)).toBeCloseTo(0.795, 6);
  });

  it('uses the bid/ask midpoint for integer-cent fields', () => {
    const market = { yes_bid: 75, yes_ask: 84, last_price: 99 } as KalshiMarket;
    expect(marketProbability(market)).toBeCloseTo(0.795, 6);
  });

  it('falls back to last price on a zero-width or missing spread', () => {
    expect(
      marketProbability({
        yes_bid_dollars: '0.8000',
        yes_ask_dollars: '0.8000',
        last_price_dollars: '0.7900',
      } as KalshiMarket),
    ).toBeCloseTo(0.79, 6);
    expect(marketProbability({ last_price_dollars: '0.2400' } as KalshiMarket)).toBeCloseTo(
      0.24,
      6,
    );
  });

  it('falls back to last price on an uninformative wide spread (dead book)', () => {
    const market = {
      yes_bid_dollars: '0.0000',
      yes_ask_dollars: '0.9900',
      last_price_dollars: '0.2400',
    } as KalshiMarket;
    expect(marketProbability(market)).toBeCloseTo(0.24, 6);
  });
});

describe('meetingDateForEventTicker', () => {
  it('maps ticker suffixes to scheduled meeting dates', () => {
    expect(meetingDateForEventTicker('KXCBDECISIONCANADA-26SEP')).toBe('2026-09-02');
    expect(meetingDateForEventTicker('KXCBDECISIONCANADA-26DEC')).toBe('2026-12-09');
  });

  it('returns undefined for unscheduled or malformed tickers', () => {
    expect(meetingDateForEventTicker('KXCBDECISIONCANADA-26FEB')).toBeUndefined();
    expect(meetingDateForEventTicker('KXCBDECISIONCANADA-25SEP')).toBeUndefined();
    expect(meetingDateForEventTicker('NONSENSE')).toBeUndefined();
  });
});

describe('fetchKalshi 429 handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries a 429 with backoff and succeeds when the bucket refills', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls < 3) return new Response('rate limited', { status: 429 });
        return new Response(JSON.stringify(fixture), { status: 200 });
      }),
    );
    const promise = fetchKalshi('https://kalshi.test');
    await vi.runAllTimersAsync();
    const blocks = await promise;
    expect(calls).toBe(3);
    expect(blocks.size).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('signs requests when auth is provided', async () => {
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return new Response(JSON.stringify(fixture), { status: 200 });
      }),
    );
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    await fetchKalshi('https://kalshi.test', { keyId: 'key-uuid', privateKeyPem: pem });
    expect(seen[0]!['kalshi-access-key']).toBe('key-uuid');
    expect(seen[0]!['kalshi-access-timestamp']).toMatch(/^\d+$/);
    expect(seen[0]!['kalshi-access-signature']).toBeTruthy();
  });
});

describe('parseKalshiMarkets (live fixture)', () => {
  const blocks = parseKalshiMarkets(fixture.markets);

  it('produces a block for each remaining 2026 meeting with markets', () => {
    expect([...blocks.keys()].sort()).toEqual(['2026-09-02', '2026-10-28', '2026-12-09']);
  });

  it('normalizes each meeting to probabilities summing to 1.0 ± 0.001', () => {
    for (const block of blocks.values()) {
      const sum = (block.outcomes ?? []).reduce((s, o) => s + o.probability, 0);
      expect(sum).toBeCloseTo(1.0, 3);
      const { cut, hold, hike } = block.rollup!;
      expect(cut + hold + hike).toBeCloseTo(1.0, 3);
    }
  });

  it('keeps native labels, volume, and the market URL', () => {
    const september = blocks.get('2026-09-02')!;
    const labels = september.outcomes!.map((o) => o.label);
    expect(labels).toContain('Maintains rate');
    expect(labels).toContain('Cut 25bps');
    expect(september.outcomes!.every((o) => typeof o.volume === 'number')).toBe(true);
    expect(september.url).toContain('kalshi.com/markets/kxcbdecisioncanada');
  });

  it('reads a hold-majority September book from the fixture', () => {
    const september = blocks.get('2026-09-02')!;
    expect(september.rollup!.hold).toBeGreaterThan(0.5);
  });
});
