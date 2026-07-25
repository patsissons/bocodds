// GET /api/odds — the single Pages Function.
//
// Refresh is demand-driven with a TTL: if the KV snapshot is younger than
// 15 minutes it is returned as-is; otherwise all upstreams are refetched in
// parallel (5 s per-source timeout via lib/http). A partial failure never
// yields a 500: the failing source's blocks are carried forward from the
// previous snapshot marked "stale" (or "unavailable" on a cold start).

import { fetchCurrentRate } from '../../lib/boc';
import { BOCODDS_URL, buildBocOddsBlocks, fetchBocOddsPage } from '../../lib/bocodds';
import { KALSHI_MARKET_URL, fetchKalshi } from '../../lib/kalshi';
import { fetchPolymarket } from '../../lib/polymarket';
import { remainingMeetings } from '../../lib/schedule';
import {
  computeDivergence,
  type CurrentRate,
  type Meeting,
  type Snapshot,
  type SourceBlock,
  type SourceName,
} from '../../lib/snapshot';

interface Env {
  SNAPSHOTS: KVNamespace;
  ENABLE_BOCODDS?: string;
  CONTACT_EMAIL?: string;
  // Test-only base URL overrides; production uses the real hosts.
  KALSHI_BASE_URL?: string;
  POLYMARKET_BASE_URL?: string;
  BOCODDS_BASE_URL?: string;
  BOC_VALET_BASE_URL?: string;
}

const SNAPSHOT_KEY = 'snapshot:latest';
const TTL_MS = 15 * 60 * 1000;

const POLYMARKET_PREDICTIONS_URL = 'https://polymarket.com/predictions/bank-of-canada';

const SOURCE_URLS: Record<SourceName, string> = {
  kalshi: KALSHI_MARKET_URL,
  polymarket: POLYMARKET_PREDICTIONS_URL,
  bocodds: BOCODDS_URL,
};

const SOURCE_LABELS: Record<SourceName, string> = {
  kalshi: 'Kalshi',
  polymarket: 'Polymarket',
  bocodds: 'BankofCanadaOdds.com',
};

function jsonResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

type SourceResult =
  { kind: 'ok'; blocks: Map<string, SourceBlock> } | { kind: 'failed' } | { kind: 'disabled' };

/** Carry one source's block forward from the previous snapshot, marked stale. */
function carryForward(previous: Snapshot | null, date: string, source: SourceName): SourceBlock {
  const block = previous?.meetings.find((m) => m.date === date)?.sources[source];
  if (block && (block.status === 'ok' || block.status === 'stale')) {
    return { ...block, status: 'stale' };
  }
  if (block && block.status === 'degraded') return block;
  return {
    status: 'unavailable',
    url: SOURCE_URLS[source],
    note: `${SOURCE_LABELS[source]} didn't respond.`,
  };
}

function blockFor(
  result: SourceResult,
  previous: Snapshot | null,
  date: string,
  source: SourceName,
  fetchedAt: string,
): SourceBlock {
  if (result.kind === 'disabled') {
    return {
      status: 'disabled',
      url: SOURCE_URLS[source],
      note: 'This source is not shown until data permission is confirmed.',
    };
  }
  if (result.kind === 'failed') return carryForward(previous, date, source);
  const block = result.blocks.get(date);
  if (!block) {
    return {
      status: 'unavailable',
      url: SOURCE_URLS[source],
      note: `${SOURCE_LABELS[source]} has no market for this meeting yet.`,
    };
  }
  return { ...block, fetched_at: fetchedAt };
}

async function buildSnapshot(env: Env, previous: Snapshot | null, now: Date): Promise<Snapshot> {
  const generatedAt = now.toISOString();
  const today = generatedAt.slice(0, 10);
  const meetings = remainingMeetings(today);
  const enableBocOdds = (env.ENABLE_BOCODDS ?? 'false').toLowerCase() === 'true';
  const contactEmail = env.CONTACT_EMAIL || 'unset@example.invalid';

  const [rateResult, kalshiResult, polymarketResult, bocOddsPageResult] = await Promise.allSettled([
    fetchCurrentRate(env.BOC_VALET_BASE_URL),
    fetchKalshi(env.KALSHI_BASE_URL),
    fetchPolymarket(meetings, env.POLYMARKET_BASE_URL),
    enableBocOdds
      ? fetchBocOddsPage(contactEmail, env.BOCODDS_BASE_URL)
      : Promise.reject(new Error('disabled')),
  ]);

  let currentRate: CurrentRate;
  if (rateResult.status === 'fulfilled') {
    currentRate = rateResult.value;
  } else if (previous && previous.current_rate.value !== null) {
    currentRate = { ...previous.current_rate, status: 'stale' };
  } else {
    currentRate = { value: null, as_of: null, source: 'boc_valet', status: 'unavailable' };
  }

  const sourceResults: Record<SourceName, SourceResult> = {
    kalshi:
      kalshiResult.status === 'fulfilled'
        ? { kind: 'ok', blocks: kalshiResult.value }
        : { kind: 'failed' },
    polymarket:
      polymarketResult.status === 'fulfilled'
        ? { kind: 'ok', blocks: polymarketResult.value }
        : { kind: 'failed' },
    bocodds: !enableBocOdds
      ? { kind: 'disabled' }
      : bocOddsPageResult.status === 'fulfilled'
        ? { kind: 'ok', blocks: buildBocOddsBlocks(bocOddsPageResult.value, currentRate.value) }
        : { kind: 'failed' },
  };

  const meetingEntries: Meeting[] = meetings.map((meeting) => {
    const sources: Meeting['sources'] = {};
    for (const source of ['kalshi', 'polymarket', 'bocodds'] as SourceName[]) {
      sources[source] = blockFor(
        sourceResults[source],
        previous,
        meeting.date,
        source,
        generatedAt,
      );
    }
    return {
      date: meeting.date,
      time_et: meeting.time_et,
      sources,
      divergence: computeDivergence(sources),
    };
  });

  return {
    generated_at: generatedAt,
    current_rate: currentRate,
    next_meeting: meetings[0]?.date ?? null,
    meetings: meetingEntries,
    schedule: meetings,
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const now = new Date();
  const cached = await context.env.SNAPSHOTS.get(SNAPSHOT_KEY);
  let previous: Snapshot | null = null;
  if (cached) {
    try {
      previous = JSON.parse(cached) as Snapshot;
    } catch {
      previous = null;
    }
  }

  if (previous && now.getTime() - new Date(previous.generated_at).getTime() < TTL_MS) {
    return jsonResponse(cached as string);
  }

  const snapshot = await buildSnapshot(context.env, previous, now);
  const body = JSON.stringify(snapshot);
  await context.env.SNAPSHOTS.put(SNAPSHOT_KEY, body);
  // Cheap history insurance: bankofcanadaodds has no historical API, so these
  // snapshots are the only record that will ever exist.
  context.waitUntil(context.env.SNAPSHOTS.put(`snapshot:history:${snapshot.generated_at}`, body));
  return jsonResponse(body);
};
