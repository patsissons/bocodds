// Shared upstream fetch helper: every upstream gets the same per-source
// timeout so one slow API cannot stall the whole snapshot refresh.

export const UPSTREAM_TIMEOUT_MS = 5000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
