import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseValetResponse } from '../../lib/boc';

// Live Valet response captured 2026-07-25.
const fixture = JSON.parse(readFileSync('tests/fixtures/boc-valet.json', 'utf8'));

describe('parseValetResponse', () => {
  it('extracts the current policy rate from the live fixture', () => {
    expect(parseValetResponse(fixture)).toEqual({ value: 2.25, asOf: '2026-07-23' });
  });

  it('fails loudly when the series is not the overnight rate target', () => {
    const tampered = {
      ...fixture,
      seriesDetail: { V39079: { description: 'Some other series' } },
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
