// Kalshi: public trade API, no auth. One event per BoC meeting
// (KXCBDECISIONCANADA-26SEP), one binary market per outcome within the event.

import { fetchJson } from './http';
import { kalshiAuthHeaders, type KalshiAuth } from './kalshi-auth';
import { meetingForYearMonth } from './schedule';
import {
  normalizeOutcomes,
  rollup,
  round4,
  type Direction,
  type Outcome,
  type SourceBlock,
} from './snapshot';

const HOSTS = ['https://external-api.kalshi.com', 'https://api.elections.kalshi.com'];
const MARKETS_PATH = '/trade-api/v2/markets';
const MARKETS_QUERY = '?series_ticker=KXCBDECISIONCANADA&status=open&limit=1000';

// Kalshi 429s carry no Retry-After; the token bucket refills continuously and
// their docs recommend exponential backoff. Anonymous requests share a per-IP
// bucket with every other Cloudflare Workers tenant, so retries only
// sometimes win a token — authenticated requests (per-key bucket) are the
// reliable path.
const RETRY_DELAYS_MS = [500, 1000];

export const KALSHI_MARKET_URL =
  'https://kalshi.com/markets/kxcbdecisioncanada/bank-of-canada-policy-interest-rate-decision';

// Price fields exist in two API formats: integer cents (yes_bid) and/or
// string dollars (yes_bid_dollars). Live responses as of 2026-07 send only
// the dollar strings, but both are handled.
export interface KalshiMarket {
  event_ticker: string;
  ticker: string;
  status?: string;
  yes_sub_title?: string;
  subtitle?: string;
  title?: string;
  yes_bid?: number;
  yes_ask?: number;
  last_price?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  volume?: number;
  volume_fp?: string;
}

interface KalshiMarketsResponse {
  markets?: KalshiMarket[];
}

// Illiquid Kalshi books rest at bid 0.00 / ask 0.99, where the midpoint
// (~0.50) is meaningless. Beyond this spread width the quote is treated as
// uninformative and last price is used instead.
const MAX_INFORMATIVE_SPREAD = 0.2;

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

function price(market: KalshiMarket, field: 'yes_bid' | 'yes_ask' | 'last_price'): number | null {
  const dollars = market[`${field}_dollars`];
  if (typeof dollars === 'string' && dollars !== '') {
    const value = Number(dollars);
    return Number.isFinite(value) ? value : null;
  }
  const cents = market[field];
  if (typeof cents === 'number' && Number.isFinite(cents)) return cents / 100;
  return null;
}

/** Midpoint of yes bid/ask; last price when the spread is missing, zero-width, or uninformatively wide. */
export function marketProbability(market: KalshiMarket): number | null {
  const bid = price(market, 'yes_bid');
  const ask = price(market, 'yes_ask');
  const last = price(market, 'last_price');
  if (bid !== null && ask !== null) {
    const width = ask - bid;
    if (width > 0 && width <= MAX_INFORMATIVE_SPREAD) return (bid + ask) / 2;
  }
  return last;
}

export function classifyKalshiLabel(label: string): Direction | null {
  const text = label.toLowerCase();
  if (text.includes('cut')) return 'cut';
  if (text.includes('maintain') || text.includes('no change') || text.includes('hike of 0')) {
    return 'hold';
  }
  if (text.includes('hike')) return 'hike';
  return null;
}

function marketVolume(market: KalshiMarket): number | undefined {
  if (typeof market.volume_fp === 'string') {
    const value = Number(market.volume_fp);
    if (Number.isFinite(value)) return value;
  }
  if (typeof market.volume === 'number') return market.volume;
  return undefined;
}

/** Map "KXCBDECISIONCANADA-26SEP" to the scheduled meeting date, if one matches. */
export function meetingDateForEventTicker(eventTicker: string): string | undefined {
  const match = /-(\d{2})([A-Z]{3})$/.exec(eventTicker);
  if (!match) return undefined;
  const year = 2000 + Number(match[1]);
  const month = MONTHS[match[2] as string];
  if (!month) return undefined;
  return meetingForYearMonth(year, month)?.date;
}

/** Group markets by event, keyed by meeting date. Pure; exported for tests. */
export function parseKalshiMarkets(markets: KalshiMarket[]): Map<string, SourceBlock> {
  const byDate = new Map<string, KalshiMarket[]>();
  for (const market of markets) {
    const date = meetingDateForEventTicker(market.event_ticker);
    if (!date) continue;
    const group = byDate.get(date) ?? [];
    group.push(market);
    byDate.set(date, group);
  }

  const blocks = new Map<string, SourceBlock>();
  for (const [date, group] of byDate) {
    const outcomes: Outcome[] = [];
    for (const market of group) {
      const probability = marketProbability(market);
      if (probability === null) continue;
      outcomes.push({
        label: market.yes_sub_title ?? market.subtitle ?? market.title ?? market.ticker,
        probability,
        volume: marketVolume(market),
      });
    }
    const normalized = normalizeOutcomes(outcomes).map((o) => ({
      ...o,
      probability: round4(o.probability),
    }));
    if (normalized.length === 0) continue;
    const directions = rollup(normalized, classifyKalshiLabel);
    blocks.set(date, {
      status: 'ok',
      outcomes: normalized,
      rollup: {
        cut: round4(directions.cut),
        hold: round4(directions.hold),
        hike: round4(directions.hike),
      },
      url: KALSHI_MARKET_URL,
    });
  }
  return blocks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch open BoC decision markets. Tries the primary host then the fallback,
 * retrying 429s with backoff. With `auth` (env KALSHI_API_KEY_ID +
 * KALSHI_PRIVATE_KEY) requests are signed, moving rate limiting from the
 * shared egress IP to our own API key. `baseUrlOverride` (env
 * KALSHI_BASE_URL) points tests at a fixture server.
 */
export async function fetchKalshi(
  baseUrlOverride?: string,
  auth?: KalshiAuth,
): Promise<Map<string, SourceBlock>> {
  const hosts = baseUrlOverride ? [baseUrlOverride] : HOSTS;
  let lastError: unknown;
  for (const host of hosts) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const headers = auth ? await kalshiAuthHeaders(auth, 'GET', MARKETS_PATH) : undefined;
        const body = await fetchJson<KalshiMarketsResponse>(
          `${host}${MARKETS_PATH}${MARKETS_QUERY}`,
          { headers },
        );
        return parseKalshiMarkets(body.markets ?? []);
      } catch (error) {
        lastError = error;
        const rateLimited = String(error).includes('responded 429');
        const delay = RETRY_DELAYS_MS[attempt];
        if (!rateLimited || delay === undefined) break; // non-429 -> next host
        await sleep(delay + Math.floor(Math.random() * 250));
      }
    }
  }
  throw lastError;
}
