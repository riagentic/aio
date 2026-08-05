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

/** Carry a transport's capability symbols (ARMS_ACK_TIMER, SETTLES_CALLS, …)
 *  onto a function that WRAPS it, and hand the wrapper back.
 *
 *  A capability is declared as a symbol property on the send function
 *  (`send[ARMS_ACK_TIMER] = true`), so it is a property of one function
 *  OBJECT — and every wrapper is a different object. `ensureConnected` wraps
 *  the client send in a fresh arrow to route sync-cell actions through the
 *  CRDT engine; that arrow carried no symbols, so the layer above concluded
 *  "this transport does not arm ack clocks" and armed the 15s clock at
 *  DISPATCH time. An action queued offline for 20s was then rejected at 15s
 *  while still sitting in the queue, and delivered on reconnect anyway — the
 *  exact defect the deferred-timer design exists to prevent, reintroduced by
 *  a wrapper.
 *
 *  Wrapping a transport must therefore go through here, never through a bare
 *  arrow: the capability belongs to the transport, and a wrapper IS the
 *  transport as far as every caller above it is concerned. */
export function wrapTransport<
  // deno-lint-ignore ban-types
  W extends Function,
>(
  // deno-lint-ignore ban-types
  inner: Function,
  wrapper: W,
): W {
  for (const s of Object.getOwnPropertySymbols(inner)) {
    (wrapper as unknown as Record<symbol, unknown>)[s] =
      (inner as unknown as Record<symbol, unknown>)[s];
  }
  return wrapper;
}
