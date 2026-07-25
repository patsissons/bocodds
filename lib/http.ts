// Shared upstream fetch helper: every upstream gets the same per-source
// timeout so one slow API cannot stall the whole snapshot refresh.

export const UPSTREAM_TIMEOUT_MS = 5000;

// Workers' fetch sends no User-Agent by default, and some upstream WAFs
// (Kalshi's included) reject datacenter traffic without one. Callers may
// override (the bocodds scraper sends its contact-email UA).
const DEFAULT_USER_AGENT = 'bocodds-aggregator/1.0 (+https://bocodds.com)';

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('User-Agent')) headers.set('User-Agent', DEFAULT_USER_AGENT);
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`GET ${url} responded ${response.status}`);
  }
  return response;
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<T> {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  return (await response.json()) as T;
}
