// transport-shared.ts — the small pieces every transport (browser WS, CLI WS,
// Electron UDS) must agree on. These lived as 4-5 hand-copied snippets with a
// latent skew (the `__ack` parse used indexOf in one transport and lastIndexOf
// in another — divergent the day a cid ever contains a colon). One authority.

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

/** Parse a per-action ack frame `__ack:<cid>:<ok>` (ok = "1" | "0").
 *  Returns null when the frame isn't an ack. The cid is everything between
 *  the prefix and the LAST colon — the one parse both transports now share. */
export function parseAck(raw: string): { cid: string; ok: boolean } | null {
  if (!raw.startsWith("__ack:")) return null;
  const rest = raw.slice(6);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  return { cid: rest.slice(0, sep), ok: rest.slice(sep + 1) === "1" };
}
