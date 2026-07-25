// ============================================================================
// HARDCODED MEETING SCHEDULE — UPDATE ANNUALLY.
//
// The Bank of Canada publishes next year's schedule each August at
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
].map((date) => ({ date, time_et: TIME_ET }));

/** Meetings on or after `todayIso` (an ISO date like "2026-07-25"). */
export function remainingMeetings(todayIso: string): ScheduledMeeting[] {
  return MEETINGS.filter((m) => m.date >= todayIso);
}

/** Find the scheduled meeting in a given year and month (1-12), if any. */
export function meetingForYearMonth(year: number, month: number): ScheduledMeeting | undefined {
  return MEETINGS.find((m) => {
    const [y, mo] = m.date.split('-');
    return Number(y) === year && Number(mo) === month;
  });
}
