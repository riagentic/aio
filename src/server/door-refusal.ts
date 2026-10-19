// The one refusal a client may re-send: a call refused at the shutdown door
// before it ran (aio-server `dispatchNetwork`). The WS and UDS acks forward
// `retryAfterMs` ONLY for an error marked here — a method that threw its own
// error carrying a `retryAfterMs` field has already run (and may have
// written), and a client that re-sent it applied it again, up to 8 times.

const marked = new WeakSet<object>();

/** Mark `err` as refused before it ran, with when to re-send. */
export function doorRefusal<T extends object>(err: T, retryAfterMs: number): T {
  marked.add(err);
  return Object.assign(err, { retryAfterMs });
}

/** The re-send delay of a door refusal; undefined for every other error. */
export function doorRetryAfterMs(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !marked.has(err)) {
    return undefined;
  }
  const r = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof r === "number" ? r : undefined;
}
