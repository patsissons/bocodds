import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBocOddsBlocks, classifyTargetRate, parseBocOddsHtml } from '../../lib/bocodds';

// Trimmed copy of the live homepage captured 2026-07-25 (markup verbatim).
const homepage = readFileSync('tests/fixtures/bocodds-homepage.html', 'utf8');

describe('parseBocOddsHtml (live fixture)', () => {
  const page = parseBocOddsHtml(homepage);

  it('extracts all upcoming meeting tables', () => {
    expect(page.meetings.map((m) => m.date)).toEqual(['2026-09-02', '2026-10-28', '2026-12-09']);
    expect(page.meetings.every((m) => !m.degraded)).toBe(true);
  });

  it('captures the current rate and last-updated text', () => {
    expect(page.currentRate).toBe(2.25);
    expect(page.lastUpdatedText).toBe('July 25, 2026 8:56 am');
  });

  it('normalizes each meeting to probabilities summing to 1.0 ± 0.001', () => {
    for (const meeting of page.meetings) {
      const sum = meeting.outcomes.reduce((s, o) => s + o.probability, 0);
      expect(sum).toBeCloseTo(1.0, 3);
    }
  });

  it('keeps native target-rate labels', () => {
    const september = page.meetings[0]!;
    expect(september.outcomes.map((o) => o.label)).toContain('2.50%');
  });
});

describe('validation rules', () => {
  function tableHtml(rows: [string, string][]): string {
    const body = rows.map(([rate, prob]) => `<tr><td>${rate}</td><td>${prob}</td></tr>`).join('\n');
    return `<h3>Target Rate Probabilities for Sep. 2, 2026 BoC Meeting</h3>
      <table><tbody>${body}</tbody></table>`;
  }

  it('discards a broken "10,000.0%" row and renormalizes the rest', () => {
    const page = parseBocOddsHtml(
      tableHtml([
        ['2.50%', '10,000.0%'],
        ['2.25%', '77%'],
        ['2.00%', '23%'],
      ]),
    );
    const meeting = page.meetings[0]!;
    expect(meeting.degraded).toBe(false);
    expect(meeting.outcomes.map((o) => o.label)).toEqual(['2.25%', '2.00%']);
    expect(meeting.outcomes.reduce((s, o) => s + o.probability, 0)).toBeCloseTo(1.0, 3);
  });

  it('marks the meeting degraded when surviving rows sum outside 90-110', () => {
    const page = parseBocOddsHtml(
      tableHtml([
        ['2.50%', '10,000.0%'],
        ['2.25%', '40%'],
      ]),
    );
    expect(page.meetings[0]!.degraded).toBe(true);
    expect(page.meetings[0]!.outcomes).toEqual([]);
  });

  it('renormalizes a 90-110 sum to exactly 100', () => {
    const page = parseBocOddsHtml(
      tableHtml([
        ['2.25%', '72%'],
        ['2.50%', '23%'],
      ]),
    );
    const meeting = page.meetings[0]!;
    expect(meeting.degraded).toBe(false);
    expect(meeting.outcomes.reduce((s, o) => s + o.probability, 0)).toBeCloseTo(1.0, 3);
  });
});

describe('classifyTargetRate', () => {
  it('compares target levels to the current policy rate', () => {
    expect(classifyTargetRate('2.00%', 2.25)).toBe('cut');
    expect(classifyTargetRate('2.25%', 2.25)).toBe('hold');
    expect(classifyTargetRate('2.50%', 2.25)).toBe('hike');
    expect(classifyTargetRate('junk', 2.25)).toBeNull();
  });
});

describe('buildBocOddsBlocks', () => {
  const page = parseBocOddsHtml(homepage);

  it('builds ok blocks with rollups from the official rate', () => {
    const blocks = buildBocOddsBlocks(page, 2.25);
    const september = blocks.get('2026-09-02')!;
    expect(september.status).toBe('ok');
    expect(september.last_updated_text).toBe('July 25, 2026 8:56 am');
    const { cut, hold, hike } = september.rollup!;
    expect(cut + hold + hike).toBeCloseTo(1.0, 3);
    expect(hike).toBeCloseTo(0.23, 2);
  });

  it('falls back to the page-stated rate when the official rate is missing', () => {
    const blocks = buildBocOddsBlocks(page, null);
    expect(blocks.get('2026-09-02')!.rollup).toBeDefined();
  });

  it('annotates each outcome with its bps change vs the reference rate', () => {
    const blocks = buildBocOddsBlocks(page, 2.25);
    const outcomes = blocks.get('2026-09-02')!.outcomes!;
    const byLabel = new Map(outcomes.map((o) => [o.label, o.change_bps]));
    expect(byLabel.get('2.50%')).toBe(25);
    expect(byLabel.get('2.25%')).toBe(0);
    expect(byLabel.get('2.00%')).toBe(-25);
  });

  it('omits change_bps when no reference rate is available', () => {
    const blocks = buildBocOddsBlocks({ ...page, currentRate: null }, null);
    const outcomes = blocks.get('2026-09-02')!.outcomes!;
    expect(outcomes.every((o) => o.change_bps === undefined)).toBe(true);
  });

  it('emits a degraded block with a note and no numbers for invalid tables', () => {
    const degradedPage = {
      lastUpdatedText: 'July 25, 2026 8:56 am',
      currentRate: 2.25,
      meetings: [{ date: '2026-09-02', outcomes: [], degraded: true }],
    };
    const blocks = buildBocOddsBlocks(degradedPage, 2.25);
    const block = blocks.get('2026-09-02')!;
    expect(block.status).toBe('degraded');
    expect(block.outcomes).toBeUndefined();
    expect(block.note).toMatch(/validation/i);
  });
});
