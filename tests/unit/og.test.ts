import { describe, expect, it } from 'vitest';
import { ogDescription, ogImageAlt, ogSummary, ogTitle } from '../../lib/og';
import type { Meeting, Rollup, Snapshot, SourceBlock } from '../../lib/snapshot';

function block(status: SourceBlock['status'], rollup?: Rollup): SourceBlock {
  return { status, rollup, url: 'https://example.com' };
}

function snapshot(meetings: Meeting[]): Snapshot {
  return {
    generated_at: '2026-07-25T20:22:36.016Z',
    current_rate: { value: 2.25, as_of: '2026-07-23', source: 'boc_valet', status: 'ok' },
    next_meeting: meetings[0]?.date ?? null,
    meetings,
    schedule: [],
  };
}

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    date: '2026-09-02',
    time_et: '09:45',
    sources: {
      kalshi: block('ok', { cut: 0.13, hold: 0.76, hike: 0.11 }),
      polymarket: block('ok', { cut: 0.04, hold: 0.82, hike: 0.14 }),
      bocodds: block('ok', { cut: 0, hold: 0.77, hike: 0.23 }),
    },
    divergence: { flagged: false, max_gap: 0.06, note: 'hold' },
    ...overrides,
  };
}

describe('ogSummary', () => {
  it('averages the rollup across sources and picks the leader', () => {
    const summary = ogSummary(snapshot([meeting()]));
    expect(summary).not.toBeNull();
    expect(summary!.rollup.hold).toBeCloseTo((0.76 + 0.82 + 0.77) / 3, 6);
    expect(summary!.leader).toBe('hold');
    expect(summary!.perSource.map((row) => row.source)).toEqual([
      'kalshi',
      'polymarket',
      'bocodds',
    ]);
  });

  it('includes stale sources but excludes degraded/disabled/unavailable', () => {
    const summary = ogSummary(
      snapshot([
        meeting({
          sources: {
            kalshi: block('stale', { cut: 0.2, hold: 0.8, hike: 0 }),
            polymarket: block('unavailable'),
            bocodds: block('degraded', { cut: 0, hold: 1, hike: 0 }),
          },
        }),
      ]),
    );
    expect(summary!.perSource.map((row) => row.source)).toEqual(['kalshi']);
    expect(summary!.rollup).toEqual({ cut: 0.2, hold: 0.8, hike: 0 });
  });

  it('returns null with no meetings or no usable sources', () => {
    expect(ogSummary(snapshot([]))).toBeNull();
    expect(
      ogSummary(snapshot([meeting({ sources: { kalshi: block('unavailable') } })])),
    ).toBeNull();
  });

  it('formats dates without ICU and derives a stable version', () => {
    const summary = ogSummary(snapshot([meeting()]));
    expect(summary!.shortDate).toBe('Sep 2');
    expect(summary!.longDate).toBe('September 2, 2026');
    expect(summary!.version).toBe('20260725202236016');
  });

  it('captures disagreement only when the divergence flag is up', () => {
    const flagged = ogSummary(
      snapshot([meeting({ divergence: { flagged: true, max_gap: 0.12, note: 'hold' } })]),
    );
    expect(flagged!.disagreement).toEqual({ direction: 'hold', low: 0.76, high: 0.82 });

    const calm = ogSummary(snapshot([meeting()]));
    expect(calm!.disagreement).toBeNull();
  });
});

describe('og text', () => {
  const summary = ogSummary(snapshot([meeting()]))!;

  it('title leads with the short date and the leading direction', () => {
    expect(ogTitle(summary)).toBe('BoC Rate Odds — Sep 2: 78% hold');
  });

  it('description lists all directions descending and the sources', () => {
    expect(ogDescription(summary)).toBe(
      'Market-implied odds for the September 2, 2026 Bank of Canada decision: ' +
        'hold 78%, hike 16%, cut 6% — from Kalshi, Polymarket and BankofCanadaOdds.com.',
    );
  });

  it('description appends the disagreement sentence when flagged', () => {
    const flagged = ogSummary(
      snapshot([meeting({ divergence: { flagged: true, max_gap: 0.12, note: 'hold' } })]),
    )!;
    expect(ogDescription(flagged)).toContain('Sources disagree on hold: 76% vs 82%.');
  });

  it('image alt mentions the date, averages, and sources', () => {
    const alt = ogImageAlt(summary);
    expect(alt).toContain('September 2, 2026');
    expect(alt).toContain('hold 78%');
    expect(alt).toContain('Kalshi');
  });
});
