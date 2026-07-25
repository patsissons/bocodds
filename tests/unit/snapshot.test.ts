import { describe, expect, it } from 'vitest';
import {
  computeDivergence,
  normalizeOutcomes,
  rollup,
  type Direction,
  type Rollup,
  type SourceBlock,
} from '../../lib/snapshot';

function block(status: SourceBlock['status'], r?: Rollup): SourceBlock {
  return { status, rollup: r, url: 'https://example.com' };
}

describe('normalizeOutcomes', () => {
  it('scales probabilities to sum to 1.0 within 0.001', () => {
    const normalized = normalizeOutcomes([
      { label: 'a', probability: 0.78 },
      { label: 'b', probability: 0.2 },
      { label: 'c', probability: 0.05 },
    ]);
    const sum = normalized.reduce((s, o) => s + o.probability, 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });

  it('drops invalid probabilities and keeps other fields', () => {
    const normalized = normalizeOutcomes([
      { label: 'good', probability: 0.5, volume: 100 },
      { label: 'nan', probability: NaN },
      { label: 'negative', probability: -0.1 },
    ]);
    expect(normalized).toEqual([{ label: 'good', probability: 1, volume: 100 }]);
  });

  it('returns [] when nothing valid remains', () => {
    expect(normalizeOutcomes([])).toEqual([]);
    expect(normalizeOutcomes([{ label: 'zero', probability: 0 }])).toEqual([]);
  });
});

describe('rollup', () => {
  const classify = (label: string): Direction | null =>
    label.includes('cut') ? 'cut' : label.includes('hold') ? 'hold' : 'hike';

  it('sums cut+hold+hike to 1.0 within 0.001 for normalized outcomes', () => {
    const outcomes = normalizeOutcomes([
      { label: 'cut 25', probability: 0.03 },
      { label: 'hold', probability: 0.81 },
      { label: 'hike 25', probability: 0.18 },
    ]);
    const r = rollup(outcomes, classify);
    expect(r.cut + r.hold + r.hike).toBeCloseTo(1.0, 3);
  });

  it('accumulates multiple outcomes per direction', () => {
    const r = rollup(
      [
        { label: 'cut 25', probability: 0.1 },
        { label: 'cut 50', probability: 0.05 },
        { label: 'hold', probability: 0.85 },
      ],
      classify,
    );
    expect(r.cut).toBeCloseTo(0.15, 6);
    expect(r.hold).toBeCloseTo(0.85, 6);
    expect(r.hike).toBe(0);
  });
});

describe('computeDivergence', () => {
  it('flags a 12-point hold gap', () => {
    const divergence = computeDivergence({
      kalshi: block('ok', { cut: 0.1, hold: 0.78, hike: 0.12 }),
      polymarket: block('ok', { cut: 0.05, hold: 0.9, hike: 0.05 }),
    });
    expect(divergence.flagged).toBe(true);
    expect(divergence.max_gap).toBeCloseTo(0.12, 3);
    expect(divergence.note).toBe('hold');
  });

  it('does not flag a 5-point gap', () => {
    const divergence = computeDivergence({
      kalshi: block('ok', { cut: 0.05, hold: 0.85, hike: 0.1 }),
      polymarket: block('ok', { cut: 0.05, hold: 0.9, hike: 0.05 }),
    });
    expect(divergence.flagged).toBe(false);
    expect(divergence.max_gap).toBeCloseTo(0.05, 3);
  });

  it('requires at least two ok sources', () => {
    const divergence = computeDivergence({
      kalshi: block('ok', { cut: 0.05, hold: 0.78, hike: 0.17 }),
      polymarket: block('stale', { cut: 0.05, hold: 0.95, hike: 0 }),
      bocodds: block('degraded'),
    });
    expect(divergence).toEqual({ flagged: false, max_gap: null, note: null });
  });

  it('ignores non-ok sources when measuring gaps', () => {
    const divergence = computeDivergence({
      kalshi: block('ok', { cut: 0, hold: 0.9, hike: 0.1 }),
      polymarket: block('ok', { cut: 0, hold: 0.88, hike: 0.12 }),
      bocodds: block('stale', { cut: 0.5, hold: 0.5, hike: 0 }),
    });
    expect(divergence.flagged).toBe(false);
    expect(divergence.max_gap).toBeCloseTo(0.02, 3);
  });
});
