// Polymarket: public Gamma API, no auth. One monthly event per BoC meeting
// ("Bank of Canada Decision in September?"), one market per outcome bucket.
//
// Slug resolution is defensive by spec: bare slugs collide across years (a
// bare "...-in-october" slug refers to October 2025), and current 2026 events
// carry timestamp-suffixed slugs (".-in-september-20260701223913897") that no
// slug pattern predicts. So: try {base} and {base}-{year}, then fall back to
// the public search endpoint. Every candidate, however found, is accepted
// only if its end date lands in the meeting's month and year.

import { fetchJson } from './http';
import type { ScheduledMeeting } from './schedule';
import {
  normalizeOutcomes,
  rollup,
  round4,
  type Direction,
  type Outcome,
  type SourceBlock,
} from './snapshot';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

export interface PolymarketMarket {
  question?: string;
  groupItemTitle?: string;
  /** Stringified JSON array in current API responses, e.g. '["Yes", "No"]'. */
  outcomes?: string | string[];
  /** Stringified JSON array aligned with `outcomes`, e.g. '["0.801", "0.199"]'. */
  outcomePrices?: string | string[];
  volume?: string | number;
  liquidity?: string | number;
}

export interface PolymarketEvent {
  slug?: string;
  title?: string;
  endDate?: string;
  description?: string;
  markets?: PolymarketMarket[];
}

interface SearchResponse {
  events?: PolymarketEvent[];
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

export function classifyPolymarketLabel(label: string): Direction | null {
  const text = label.toLowerCase();
  if (text.includes('decrease')) return 'cut';
  if (text.includes('no change')) return 'hold';
  if (text.includes('increase')) return 'hike';
  return null;
}

/** Accept an event only if its end date falls in the meeting's month and year. */
export function eventMatchesMeeting(event: PolymarketEvent, meetingDate: string): boolean {
  if (!event.endDate) return false;
  const end = new Date(event.endDate);
  if (Number.isNaN(end.getTime())) return false;
  const [year, month] = meetingDate.split('-').map(Number);
  return end.getUTCFullYear() === year && end.getUTCMonth() + 1 === month;
}

function parseStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function asNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The Yes price of one bucket market, or null if unparseable. */
export function marketYesProbability(market: PolymarketMarket): number | null {
  const outcomes = parseStringArray(market.outcomes);
  const prices = parseStringArray(market.outcomePrices);
  if (prices.length === 0) return null;
  const yesIndex = Math.max(
    0,
    outcomes.findIndex((o) => o.toLowerCase() === 'yes'),
  );
  const value = Number(prices[yesIndex]);
  return Number.isFinite(value) ? value : null;
}

/** Build a source block from a validated event. Pure; exported for tests. */
export function parsePolymarketEvent(event: PolymarketEvent): SourceBlock | null {
  const outcomes: Outcome[] = [];
  for (const market of event.markets ?? []) {
    const probability = marketYesProbability(market);
    if (probability === null) continue;
    const label = market.groupItemTitle || market.question;
    if (!label) continue;
    outcomes.push({
      label,
      probability,
      volume: asNumber(market.volume),
      liquidity: asNumber(market.liquidity),
    });
  }
  const normalized = normalizeOutcomes(outcomes).map((o) => ({
    ...o,
    probability: round4(o.probability),
  }));
  if (normalized.length === 0) return null;
  const directions = rollup(normalized, classifyPolymarketLabel);
  return {
    status: 'ok',
    outcomes: normalized,
    rollup: {
      cut: round4(directions.cut),
      hold: round4(directions.hold),
      hike: round4(directions.hike),
    },
    url: `https://polymarket.com/event/${event.slug ?? ''}`,
  };
}

function slugCandidates(meetingDate: string): string[] {
  const [year, month] = meetingDate.split('-').map(Number);
  const monthName = MONTH_NAMES[(month ?? 1) - 1];
  const base = `bank-of-canada-decision-in-${monthName}`;
  return [base, `${base}-${year}`];
}

async function fetchEventsBySlug(base: string, slug: string): Promise<PolymarketEvent[]> {
  return await fetchJson<PolymarketEvent[]>(`${base}/events?slug=${slug}`);
}

async function fetchSearchEvents(base: string): Promise<PolymarketEvent[]> {
  const query = encodeURIComponent('bank of canada');
  const body = await fetchJson<SearchResponse>(
    `${base}/public-search?q=${query}&events_status=active`,
  );
  return (body.events ?? []).filter((event) =>
    (event.title ?? '').toLowerCase().startsWith('bank of canada decision'),
  );
}

/**
 * Resolve and parse the event for each meeting. Meetings with no validating
 * event are omitted (never show wrong-year data). `baseUrlOverride`
 * (env POLYMARKET_BASE_URL) points tests at a fixture server.
 */
export async function fetchPolymarket(
  meetings: ScheduledMeeting[],
  baseUrlOverride?: string,
): Promise<Map<string, SourceBlock>> {
  const base = baseUrlOverride ?? GAMMA_BASE;
  let searchEvents: PolymarketEvent[] | null = null;

  const blocks = new Map<string, SourceBlock>();
  for (const meeting of meetings) {
    let matched: PolymarketEvent | undefined;

    for (const slug of slugCandidates(meeting.date)) {
      const candidates = await fetchEventsBySlug(base, slug);
      matched = candidates.find((event) => eventMatchesMeeting(event, meeting.date));
      if (matched) break;
    }

    if (!matched) {
      searchEvents ??= await fetchSearchEvents(base);
      matched = searchEvents.find((event) => eventMatchesMeeting(event, meeting.date));
    }

    if (!matched) continue;
    const block = parsePolymarketEvent(matched);
    if (block) blocks.set(meeting.date, block);
  }
  return blocks;
}
