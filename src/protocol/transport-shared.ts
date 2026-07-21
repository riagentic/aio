// transport-shared.ts — the small pieces every transport (browser WS, CLI WS,
// Electron UDS) must agree on. One authority instead of hand-copied snippets.

/** Reconnect backoff constants — shared by real code AND interpolated into
 *  generated client scripts (electron-uds), which can't import modules. */
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 8000;

/** Exponential reconnect delay with ±`jitter` randomization (default 20%).
 *  Jitter prevents a thundering herd when many clients lose one server. */
export function backoffDelay(retry: number, jitter = 0.2): number {
  const base = Math.min(BACKOFF_BASE_MS * Math.pow(2, retry), BACKOFF_MAX_MS);
  return base + base * jitter * (Math.random() * 2 - 1);
}
