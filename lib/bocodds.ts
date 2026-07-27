// bankofcanadaodds.com: no API — a server-rendered homepage with one
// "Target Rate Probabilities for Sep. 2, 2026 BoC Meeting" section per
// upcoming meeting (target rate level vs probability), plus the current
// policy rate and a "Last updated" timestamp.
//
// Fetching is gated by ENABLE_BOCODDS (off in production until permission is
// confirmed) and always sends a descriptive User-Agent with a contact email.
// The site has shipped visibly broken values (e.g. "10,000.0%"), so
// validation is mandatory: rows outside [0, 100] are discarded, and a meeting
// whose surviving rows don't sum to 90-110 is marked degraded with no numbers.

import { fetchWithTimeout } from './http';
import { rollup, round4, type Direction, type Outcome, type SourceBlock } from './snapshot';

export const BOCODDS_URL = 'https://bankofcanadaodds.com/';

const MONTH_ABBREVIATIONS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export interface BocOddsMeetingTable {
  /** ISO meeting date parsed from the heading. */
  date: string;
  /** Validated rows; empty when the table failed validation. */
  outcomes: Outcome[];
  degraded: boolean;
}

export interface BocOddsPage {
  lastUpdatedText: string | null;
  /** The page's own "Current rate is X%" statement. */
  currentRate: number | null;
  meetings: BocOddsMeetingTable[];
}

/** "Sep. 2, 2026" (any whitespace) -> "2026-09-02". */
function parseHeadingDate(text: string): string | null {
  const match = /([A-Za-z]{3})\.?\s+(\d{1,2}),\s+(\d{4})/.exec(text);
  if (!match) return null;
  const month = MONTH_ABBREVIATIONS[(match[1] as string).toLowerCase()];
  if (!month) return null;
  const day = String(match[2]).padStart(2, '0');
  return `${match[3]}-${String(month).padStart(2, '0')}-${day}`;
}

function parsePercent(cell: string): number | null {
  const cleaned = cell.replace(/[%,\s]/g, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse the homepage HTML with a regex pass (the markup is server-rendered
 * and stable; no DOM libraries per spec). Duplicate meeting sections (the
 * page repeats itself inside <noscript>) are deduplicated by date.
 */
export function parseBocOddsHtml(html: string): BocOddsPage {
  const lastUpdatedMatch = /Last updated:\s*([^<]+)</i.exec(html);
  const currentRateMatch = /Current rate is\s*([\d.]+)%/i.exec(html);

  const meetings = new Map<string, BocOddsMeetingTable>();
  const sectionPattern =
    /<h3>\s*(Target Rate Probabilities[^<]*)<\/h3>([\s\S]*?)(?:<\/table>|(?=<h3>))/gi;
  for (const section of html.matchAll(sectionPattern)) {
    const date = parseHeadingDate(section[1] ?? '');
    if (!date || meetings.has(date)) continue;

    const rows: Outcome[] = [];
    let discarded = 0;
    const rowPattern = /<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/gi;
    for (const row of (section[2] ?? '').matchAll(rowPattern)) {
      const label = (row[1] ?? '').trim();
      const percent = parsePercent(row[2] ?? '');
      if (!label || percent === null) continue;
      if (percent < 0 || percent > 100) {
        discarded += 1;
        continue;
      }
      rows.push({ label, probability: percent / 100 });
    }
    if (rows.length === 0) {
      if (discarded > 0) meetings.set(date, { date, outcomes: [], degraded: true });
      continue;
    }

    const total = rows.reduce((sum, row) => sum + row.probability, 0) * 100;
    if (total < 90 || total > 110) {
      meetings.set(date, { date, outcomes: [], degraded: true });
      continue;
    }
    const normalized = rows.map((row) => ({
      ...row,
      probability: round4(row.probability / (total / 100)),
    }));
    meetings.set(date, { date, outcomes: normalized, degraded: false });
  }

  return {
    lastUpdatedText: lastUpdatedMatch ? (lastUpdatedMatch[1] as string).trim() : null,
    currentRate: currentRateMatch ? Number(currentRateMatch[1]) : null,
    meetings: [...meetings.values()],
  };
}

/** Numeric value of a target-rate label ("2.50%" -> 2.5). */
function parseTargetRate(label: string): number | null {
  const value = Number(label.replace(/[%\s]/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** Classify a target-rate level ("2.50%") against the current policy rate. */
export function classifyTargetRate(label: string, currentRate: number): Direction | null {
  const value = parseTargetRate(label);
  if (value === null) return null;
  const epsilon = 0.001;
  if (value < currentRate - epsilon) return 'cut';
  if (value > currentRate + epsilon) return 'hike';
  return 'hold';
}

/**
 * Turn a parsed page into per-meeting source blocks. `officialRate` (from the
 * BoC Valet API) is preferred for the direction rollup; the page's own stated
 * rate is the fallback. With neither, outcomes are shown without a rollup.
 */
export function buildBocOddsBlocks(
  page: BocOddsPage,
  officialRate: number | null,
): Map<string, SourceBlock> {
  const referenceRate = officialRate ?? page.currentRate;
  const blocks = new Map<string, SourceBlock>();
  for (const meeting of page.meetings) {
    if (meeting.degraded) {
      blocks.set(meeting.date, {
        status: 'degraded',
        last_updated_text: page.lastUpdatedText ?? undefined,
        url: BOCODDS_URL,
        note: 'This source published numbers that failed validation, so they are not shown.',
      });
      continue;
    }
    let outcomes = meeting.outcomes;
    if (referenceRate !== null) {
      outcomes = outcomes.map((outcome) => {
        const value = parseTargetRate(outcome.label);
        if (value === null) return outcome;
        return { ...outcome, change_bps: Math.round((value - referenceRate) * 100) };
      });
    }
    const block: SourceBlock = {
      status: 'ok',
      last_updated_text: page.lastUpdatedText ?? undefined,
      outcomes,
      url: BOCODDS_URL,
    };
    if (referenceRate !== null) {
      const directions = rollup(meeting.outcomes, (label) =>
        classifyTargetRate(label, referenceRate),
      );
      block.rollup = {
        cut: round4(directions.cut),
        hold: round4(directions.hold),
        hike: round4(directions.hike),
      };
    }
    blocks.set(meeting.date, block);
  }
  return blocks;
}

/**
 * Fetch and parse the homepage (blocks are built separately so this can run
 * in parallel with the Valet rate fetch). `contactEmail` goes into the
 * User-Agent per the site's attribution etiquette. `baseUrlOverride`
 * (env BOCODDS_BASE_URL) points tests at a fixture server.
 */
export async function fetchBocOddsPage(
  contactEmail: string,
  baseUrlOverride?: string,
): Promise<BocOddsPage> {
  const url = baseUrlOverride ? `${baseUrlOverride}/` : BOCODDS_URL;
  const response = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': `bocodds-aggregator/1.0 (rate odds dashboard; contact: ${contactEmail})`,
    },
  });
  return parseBocOddsHtml(await response.text());
}
