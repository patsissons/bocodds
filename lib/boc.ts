// Bank of Canada Valet API (official, free, no auth): current policy rate.
// Series V39079 is the target for the overnight rate; the series label in
// the response is verified so a silently re-purposed series fails loudly.

import { fetchJson } from './http';
import type { CurrentRate } from './snapshot';

const VALET_BASE = 'https://www.bankofcanada.ca';
const OBSERVATIONS_PATH = '/valet/observations/V39079/json?recent=1';

export const BOC_KEY_RATE_URL =
  'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/';

interface ValetResponse {
  seriesDetail?: Record<string, { description?: string }>;
  observations?: Array<Record<string, { v?: string } | string>>;
}

/** Extract and verify the current policy rate. Pure; exported for tests. */
export function parseValetResponse(body: ValetResponse): { value: number; asOf: string } {
  const description = body.seriesDetail?.['V39079']?.description ?? '';
  if (!/overnight rate/i.test(description)) {
    throw new Error(
      `Valet series V39079 is not labelled as the overnight rate target (got "${description}")`,
    );
  }
  const observation = body.observations?.[0];
  if (!observation) throw new Error('Valet response has no observations');
  const cell = observation['V39079'];
  const value = Number(typeof cell === 'object' ? cell?.v : cell);
  const asOf = observation['d'];
  if (!Number.isFinite(value) || typeof asOf !== 'string') {
    throw new Error('Valet observation is missing the rate value or date');
  }
  return { value, asOf };
}

/**
 * Fetch the current policy rate. `baseUrlOverride` (env BOC_VALET_BASE_URL)
 * points tests at a fixture server.
 */
export async function fetchCurrentRate(baseUrlOverride?: string): Promise<CurrentRate> {
  const base = baseUrlOverride ?? VALET_BASE;
  const body = await fetchJson<ValetResponse>(`${base}${OBSERVATIONS_PATH}`);
  const { value, asOf } = parseValetResponse(body);
  return { value, as_of: asOf, source: 'boc_valet', status: 'ok' };
}
