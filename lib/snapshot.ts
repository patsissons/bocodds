// Types for the /api/odds response (the contract in plan.md section 7),
// plus the shared math: probability normalization, direction rollups, and
// the cross-source divergence rule.

import type { ScheduledMeeting } from './schedule';

export type SourceStatus = 'ok' | 'stale' | 'degraded' | 'disabled' | 'unavailable';
export type SourceName = 'kalshi' | 'polymarket' | 'bocodds';
export type Direction = 'cut' | 'hold' | 'hike';

export interface Outcome {
  label: string;
  probability: number;
  volume?: number;
  liquidity?: number;
}

export type Rollup = Record<Direction, number>;

export interface SourceBlock {
  status: SourceStatus;
  fetched_at?: string;
  /** bocodds only: the site's own "Last updated" text. */
  last_updated_text?: string;
  outcomes?: Outcome[];
  rollup?: Rollup;
  url: string;
  /** Plain-language explanation for degraded/disabled/unavailable states. */
  note?: string;
  /** Raw upstream error for ops diagnosis; not rendered in the UI. */
  error?: string;
}

export interface Divergence {
  flagged: boolean;
  /** Largest pairwise gap across cut/hold/hike among ok sources; null with <2 ok sources. */
  max_gap: number | null;
  /** Direction with the largest gap; null when max_gap is null. */
  note: Direction | null;
}

export interface Meeting {
  date: string;
  time_et: string;
  sources: Partial<Record<SourceName, SourceBlock>>;
  divergence: Divergence;
}

export interface CurrentRate {
  value: number | null;
  as_of: string | null;
  source: 'boc_valet';
  status: 'ok' | 'stale' | 'unavailable';
}

export interface Snapshot {
  generated_at: string;
  current_rate: CurrentRate;
  next_meeting: string | null;
  meetings: Meeting[];
  schedule: ScheduledMeeting[];
}

export const DIVERGENCE_THRESHOLD = 0.1;

/**
 * Scale outcome probabilities so they sum to 1.0 (market prices rarely do).
 * Outcomes with a non-finite or negative probability are dropped first.
 * Returns [] if nothing valid remains or the total is zero.
 */
export function normalizeOutcomes<T extends Outcome>(outcomes: T[]): T[] {
  const valid = outcomes.filter((o) => Number.isFinite(o.probability) && o.probability >= 0);
  const total = valid.reduce((sum, o) => sum + o.probability, 0);
  if (total <= 0) return [];
  return valid.map((o) => ({ ...o, probability: o.probability / total }));
}

/**
 * Roll normalized outcomes up to cut/hold/hike using a per-source classifier.
 * Outcomes the classifier cannot place are ignored (their mass is dropped),
 * so callers should classify every label they emit.
 */
export function rollup(outcomes: Outcome[], classify: (label: string) => Direction | null): Rollup {
  const result: Rollup = { cut: 0, hold: 0, hike: 0 };
  for (const outcome of outcomes) {
    const direction = classify(outcome.label);
    if (direction) result[direction] += outcome.probability;
  }
  return result;
}

const DIRECTIONS: Direction[] = ['cut', 'hold', 'hike'];

/**
 * Divergence across sources for one meeting: for each direction, max minus min
 * across sources with status "ok"; max_gap is the largest of those; flagged at
 * >= DIVERGENCE_THRESHOLD. Needs at least 2 ok sources.
 */
export function computeDivergence(sources: Partial<Record<SourceName, SourceBlock>>): Divergence {
  const rollups = Object.values(sources)
    .filter((s): s is SourceBlock => s !== undefined && s.status === 'ok' && s.rollup !== undefined)
    .map((s) => s.rollup as Rollup);

  if (rollups.length < 2) return { flagged: false, max_gap: null, note: null };

  let maxGap = 0;
  let note: Direction = 'hold';
  for (const direction of DIRECTIONS) {
    const values = rollups.map((r) => r[direction]);
    const gap = Math.max(...values) - Math.min(...values);
    if (gap > maxGap) {
      maxGap = gap;
      note = direction;
    }
  }
  return { flagged: maxGap >= DIVERGENCE_THRESHOLD, max_gap: round4(maxGap), note };
}

/** Round to 4 decimal places for stable JSON output. */
export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
