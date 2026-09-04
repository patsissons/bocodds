// ============================================================================
// HARDCODED MEETING SCHEDULE — UPDATE ANNUALLY.
//
// The Bank of Canada publishes next year's schedule each summer at
// bankofcanada.ca (press release "schedule for policy interest rate
// announcements"). When the new schedule is announced, add the new year's
// dates here. All announcements are at 09:45 ET.
// ============================================================================

export interface ScheduledMeeting {
  /** ISO date, e.g. "2026-09-02" */
  date: string;
  /** Announcement time in Eastern Time, e.g. "09:45" */
  time_et: string;
}

const TIME_ET = '09:45';

export const MEETINGS: ScheduledMeeting[] = [
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
].map((date) => ({ date, time_et: TIME_ET }));

/** Meetings on or after `todayIso` (an ISO date like "2026-07-25"). */
export function remainingMeetings(todayIso: string): ScheduledMeeting[] {
  return MEETINGS.filter((m) => m.date >= todayIso);
}

/**
 * The most recent meeting strictly before `todayIso`, if any. On a decision
 * day itself this is still the *previous* meeting: the announcement (09:45 ET)
 * and Valet's next observation both land after any refresh that morning, so
 * the prior decision is the one a fetched rate can reflect.
 */
export function lastMeeting(todayIso: string): ScheduledMeeting | undefined {
  return MEETINGS.filter((m) => m.date < todayIso).at(-1);
}

/** Find the scheduled meeting in a given year and month (1-12), if any. */
export function meetingForYearMonth(year: number, month: number): ScheduledMeeting | undefined {
  return MEETINGS.find((m) => {
    const [y, mo] = m.date.split('-');
    return Number(y) === year && Number(mo) === month;
  });
}
