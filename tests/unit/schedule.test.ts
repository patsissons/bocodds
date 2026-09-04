import { describe, expect, it } from 'vitest';
import { MEETINGS, lastMeeting, meetingForYearMonth, remainingMeetings } from '../../lib/schedule';

describe('schedule', () => {
  it('has the official 2026 and 2027 dates at 09:45 ET', () => {
    expect(MEETINGS).toHaveLength(16);
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
      '2027-01-27',
      '2027-03-03',
      '2027-04-28',
      '2027-06-02',
      '2027-07-21',
      '2027-09-08',
      '2027-10-27',
      '2027-12-08',
    ]);
  });

  it('filters to remaining meetings including today', () => {
    expect(remainingMeetings('2026-07-25').map((m) => m.date)).toEqual([
      '2026-09-02',
      '2026-10-28',
      '2026-12-09',
      '2027-01-27',
      '2027-03-03',
      '2027-04-28',
      '2027-06-02',
      '2027-07-21',
      '2027-09-08',
      '2027-10-27',
      '2027-12-08',
    ]);
    expect(remainingMeetings('2026-09-02').map((m) => m.date)).toContain('2026-09-02');
    expect(remainingMeetings('2027-01-01')).toHaveLength(8);
    expect(remainingMeetings('2028-01-01')).toEqual([]);
  });

  it('returns the most recent meeting strictly before today', () => {
    expect(lastMeeting('2026-01-01')).toBeUndefined();
    // On a decision day the announcement hasn't landed yet — still the prior one.
    expect(lastMeeting('2026-09-02')?.date).toBe('2026-07-15');
    expect(lastMeeting('2026-09-03')?.date).toBe('2026-09-02');
    expect(lastMeeting('2027-01-01')?.date).toBe('2026-12-09');
    expect(lastMeeting('2028-01-01')?.date).toBe('2027-12-08');
  });

  it('finds a meeting by year and month', () => {
    expect(meetingForYearMonth(2026, 9)?.date).toBe('2026-09-02');
    expect(meetingForYearMonth(2027, 1)?.date).toBe('2027-01-27');
    expect(meetingForYearMonth(2026, 2)).toBeUndefined();
    expect(meetingForYearMonth(2025, 9)).toBeUndefined();
  });
});
