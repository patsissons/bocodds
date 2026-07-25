import { describe, expect, it } from 'vitest';
import { MEETINGS, meetingForYearMonth, remainingMeetings } from '../../lib/schedule';

describe('schedule', () => {
  it('has the eight official 2026 dates at 09:45 ET', () => {
    expect(MEETINGS).toHaveLength(8);
    expect(MEETINGS.every((m) => m.time_et === '09:45')).toBe(true);
    expect(MEETINGS.map((m) => m.date)).toEqual([
      '2026-01-28',
      '2026-03-18',
      '2026-04-29',
      '2026-06-10',
      '2026-07-15',
      '2026-09-02',
      '2026-10-28',
      '2026-12-09',
    ]);
  });

  it('filters to remaining meetings including today', () => {
    expect(remainingMeetings('2026-07-25').map((m) => m.date)).toEqual([
      '2026-09-02',
      '2026-10-28',
      '2026-12-09',
    ]);
    expect(remainingMeetings('2026-09-02').map((m) => m.date)).toContain('2026-09-02');
    expect(remainingMeetings('2027-01-01')).toEqual([]);
  });

  it('finds a meeting by year and month', () => {
    expect(meetingForYearMonth(2026, 9)?.date).toBe('2026-09-02');
    expect(meetingForYearMonth(2026, 2)).toBeUndefined();
    expect(meetingForYearMonth(2025, 9)).toBeUndefined();
  });
});
