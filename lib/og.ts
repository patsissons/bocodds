// Open Graph content derived from the latest snapshot: the dynamic
// <title>/description strings and the data behind the social-card image.
// Pure functions so they unit-test in node — the workers-only pieces
// (HTMLRewriter, PNG rendering) live under functions/.

import type { Direction, Rollup, Snapshot, SourceName } from './snapshot';

const SOURCE_ORDER: SourceName[] = ['kalshi', 'polymarket', 'bocodds'];
const SOURCE_LABELS: Record<SourceName, string> = {
  kalshi: 'Kalshi',
  polymarket: 'Polymarket',
  bocodds: 'BankofCanadaOdds.com',
};
const DIRECTIONS: Direction[] = ['cut', 'hold', 'hike'];

// Explicit month tables: deterministic in every runtime, no ICU involved.
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface OgSourceRow {
  source: SourceName;
  label: string;
  rollup: Rollup;
}

export interface OgSummary {
  /** Next meeting date, ISO (e.g. "2026-09-02"). */
  date: string;
  /** "Sep 2" — for the <title>. */
  shortDate: string;
  /** "September 2, 2026" — for descriptions. */
  longDate: string;
  /** Average cut/hold/hike across the included sources. */
  rollup: Rollup;
  /** Direction with the highest average probability. */
  leader: Direction;
  /** Sources with usable numbers (ok or stale), in display order. */
  perSource: OgSourceRow[];
  /** Set when the next meeting's divergence flag is up. */
  disagreement: { direction: Direction; low: number; high: number } | null;
  /** Cache-buster for the og:image URL; changes with each snapshot. */
  version: string;
}

function pctText(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

function shortDateOf(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${MONTHS_SHORT[Number(month) - 1]} ${Number(day)}`;
}

function longDateOf(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${MONTHS_LONG[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/**
 * Distill the snapshot into what link previews need: the next meeting and
 * the averaged odds across sources that have numbers. Returns null when
 * there is nothing worth showing (no upcoming meeting, or no source with a
 * rollup) — callers then fall back to the static meta/image.
 */
export function ogSummary(snapshot: Snapshot): OgSummary | null {
  const meeting = snapshot.meetings[0];
  if (!meeting) return null;

  const perSource: OgSourceRow[] = [];
  for (const source of SOURCE_ORDER) {
    const block = meeting.sources[source];
    if (block?.rollup && (block.status === 'ok' || block.status === 'stale')) {
      perSource.push({ source, label: SOURCE_LABELS[source], rollup: block.rollup });
    }
  }
  if (perSource.length === 0) return null;

  const rollup: Rollup = { cut: 0, hold: 0, hike: 0 };
  for (const row of perSource) {
    for (const direction of DIRECTIONS) rollup[direction] += row.rollup[direction];
  }
  for (const direction of DIRECTIONS) rollup[direction] /= perSource.length;

  let leader: Direction = 'hold';
  for (const direction of DIRECTIONS) {
    if (rollup[direction] > rollup[leader]) leader = direction;
  }

  let disagreement: OgSummary['disagreement'] = null;
  const flaggedDirection = meeting.divergence.flagged ? meeting.divergence.note : null;
  if (flaggedDirection) {
    // Mirror the divergence rule: gaps are measured across ok sources only.
    const values = perSource
      .filter((row) => meeting.sources[row.source]?.status === 'ok')
      .map((row) => row.rollup[flaggedDirection]);
    if (values.length >= 2) {
      disagreement = {
        direction: flaggedDirection,
        low: Math.min(...values),
        high: Math.max(...values),
      };
    }
  }

  return {
    date: meeting.date,
    shortDate: shortDateOf(meeting.date),
    longDate: longDateOf(meeting.date),
    rollup,
    leader,
    perSource,
    disagreement,
    version: snapshot.generated_at.replace(/\D/g, ''),
  };
}

/** "BoC Rate Odds — Sep 2: 74% hold" */
export function ogTitle(summary: OgSummary): string {
  return `BoC Rate Odds — ${summary.shortDate}: ${pctText(summary.rollup[summary.leader])} ${summary.leader}`;
}

function directionList(rollup: Rollup): string {
  return [...DIRECTIONS]
    .sort((a, b) => rollup[b] - rollup[a])
    .map((direction) => `${direction} ${pctText(rollup[direction])}`)
    .join(', ');
}

function sourceList(perSource: OgSourceRow[]): string {
  const labels = perSource.map((row) => row.label);
  if (labels.length === 1) return labels[0] as string;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * "Market-implied odds for the September 2, 2026 Bank of Canada decision:
 * hold 74%, cut 15%, hike 11% — from Kalshi, Polymarket and
 * BankofCanadaOdds.com. Sources disagree on hold: 68% vs 82%."
 */
export function ogDescription(summary: OgSummary): string {
  let text =
    `Market-implied odds for the ${summary.longDate} Bank of Canada decision: ` +
    `${directionList(summary.rollup)} — from ${sourceList(summary.perSource)}.`;
  if (summary.disagreement) {
    const { direction, low, high } = summary.disagreement;
    text += ` Sources disagree on ${direction}: ${pctText(low)} vs ${pctText(high)}.`;
  }
  return text;
}

/** Alt text for the social-card image, with the real numbers. */
export function ogImageAlt(summary: OgSummary): string {
  return (
    `Probability bars for the ${summary.longDate} Bank of Canada decision — ` +
    `${directionList(summary.rollup)} on average across ${sourceList(summary.perSource)}.`
  );
}
