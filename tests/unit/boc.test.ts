import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseValetResponse } from '../../lib/boc';

// Live Valet response captured 2026-07-25; seriesDetail re-captured 2026-09-03
// after the BoC moved the series name from description into label (the
// observation is kept at 2026-07-23 — other suites pin dates to it).
const fixture = JSON.parse(readFileSync('tests/fixtures/boc-valet.json', 'utf8'));

describe('parseValetResponse', () => {
  it('extracts the current policy rate from the live fixture', () => {
    expect(parseValetResponse(fixture)).toEqual({ value: 2.25, asOf: '2026-07-23' });
  });

  it('accepts the pre-2026-07 shape where only the description names the series', () => {
    const legacy = {
      ...fixture,
      seriesDetail: { V39079: { label: 'V39079', description: 'Target for the overnight rate' } },
    };
    expect(parseValetResponse(legacy)).toEqual({ value: 2.25, asOf: '2026-07-23' });
  });

  it('fails loudly when neither label nor description names the overnight rate', () => {
    const tampered = {
      ...fixture,
      seriesDetail: { V39079: { label: 'V12345', description: 'Some other series' } },
    };
    expect(() => parseValetResponse(tampered)).toThrow(/overnight rate/);
  });

  it('fails when observations are missing or malformed', () => {
    expect(() => parseValetResponse({ ...fixture, observations: [] })).toThrow(/observations/);
    expect(() => parseValetResponse({ ...fixture, observations: [{ d: '2026-07-23' }] })).toThrow(
      /missing/,
    );
  });
});
