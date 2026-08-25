// ack-registry.ts — THE pending-ack registry, as a factory.
//
// One implementation, two lifetimes. The browser has exactly one page and one
// transport, so it keeps a module-level singleton (browser-ack.ts wraps this
// and its public names are unchanged). A CLI client does NOT: `connectCli` can
// be called several times in one process (a test that runs a relay and a
// client, a tool talking to two servers), and D2 says one instance's lifecycle
// must never touch another's — a disconnect that rejected every pending call
// in the process would settle promises belonging to a connection that is
// perfectly healthy. So each connection gets its own registry.
//
// Before this existed the CLI client had a fourth, DIFFERENT copy of ack
// handling: `Map<string, () => void>` — no value, no reject, no timer. It
// resolved on refusal, dropped return values, and could wait forever. That is
// the drift this file exists to make impossible.

/** One pending call: the shared promise, its settlers, and its deadline. */
type PendingEntry = {
  promise: Promise<unknown>;
  resolve: (value?: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Ceiling for THIS call (ms; 0 = wait indefinitely). Kept on the entry so a
   *  deferred arm (offline queue → replay) uses the call's own budget. */
  ceilingMs: number;
  /** `"warn"`: at the ceiling report ONCE and keep waiting — never reject.
   *  The server-side twin is `perfBudget.methods[key].timeout: "warn"`. */
  mode: "reject" | "warn";
  methodKey: string | undefined;
  /** True once the frame carrying this call has actually been WRITTEN to a
   *  transport. False while it sits in an offline queue.
   *
   *  This is the difference between "the server may or may not have applied
   *  it" and "it has not been sent at all", and it decides who a disconnect is
   *  allowed to settle: a queue that survives the close and flushes on the
   *  next open must NOT have its calls rejected, or one user intent produces
   *  one rejection AND one application. */
  written: boolean;
};

/** A pending-ack registry scoped to one transport/connection. */
export type AckRegistry = {
  /** Register a pending ack; returns the promise the caller awaits.
   *
   *  Idempotent per cid: an action passes through several layers that each
   *  register (cell binding, transport send), and re-registering the same cid
   *  MUST return the SAME promise — otherwise the first caller's promise is
   *  orphaned and times out even though the server acked. */
  register(
    cid: string,
    opts?: { methodKey?: string; deferTimer?: boolean },
  ): Promise<unknown>;
  /** The frame for `cid` is now ON THE WIRE: mark it in-flight and start its
   *  clock. Called by every transport at the moment it writes — both on the
   *  direct send and when draining the offline queue. No-op if already armed
   *  or already settled. */
  armTimer(cid: string): void;
  /** True when `cid` is registered and its frame has been written (in flight).
   *  Tests and transports use it to tell "queued" from "sent". */
  isWritten(cid: string): boolean;
  /** Settle with the method's transported return value (undefined for void). */
  resolve(cid: string, value?: unknown): boolean;
  /** Settle as a failure — the server refused, or the transport gave up. */
  reject(cid: string, err: Error): boolean;
  /** Reject everything still outstanding — for a teardown that also THROWS
   *  THE QUEUE AWAY (close(), protocol mismatch). */
  rejectAll(err: Error): number;
  /** Reject only the calls whose frame is already on the wire — for a
   *  disconnect whose offline queue SURVIVES and will flush on reconnect.
   *  A still-queued call keeps its promise: it has not been sent, nothing can
   *  have applied it, and rejecting it would be a lie the queue then goes on
   *  to contradict. */
  rejectInFlight(err: Error): number;
  /** How many calls are outstanding — tests and diagnostics. */
  size(): number;
};

/** A resolved per-call ceiling: a number of ms (0 = wait indefinitely), or
 *  `{ warnAfterMs }` — warn once at that point and keep waiting. */
export type AckCeiling = number | { warnAfterMs: number };

/** Build a registry.
 *
 *  `ceilingFor` resolves the per-call deadline from the method key
 *  ("cell:method"): ms (0 = wait indefinitely) or `{ warnAfterMs }`. It is injected because
 *  the answer has a different source per environment: the browser reads the
 *  server-bridged `__aioConfig.callTimeouts`, a CLI client has no page shell
 *  and uses its own constant. The registry itself stays environment-free. */
export function createAckRegistry(
  ceilingFor: (methodKey: string | undefined) => AckCeiling,
  /** Where a `timeout: "warn"` report goes — the caller's levelled sink
   *  (browser console, CLI log.warn); protocol code owns no console. */
  warn: (msg: string) => void,
): AckRegistry {
  const pending = new Map<string, PendingEntry>();

  const arm = (cid: string, entry: PendingEntry): void => {
    if (entry.timer !== undefined || entry.ceilingMs <= 0) return;
    if (entry.mode === "warn") {
      // Same contract as the server's registerCall in warn mode: one report,
      // the entry stays pending, the timer is spent (nothing re-arms it).
      entry.timer = setTimeout(() => {
        if (!pending.has(cid)) return;
        warn(
          `[aio] ${
            entry.methodKey ?? "cell:method"
          }: still running after ${entry.ceilingMs}ms (timeout: "warn") — ` +
            `the caller keeps waiting; no response has reached this client ` +
            `yet.`,
        );
      }, entry.ceilingMs);
      return;
    }
    entry.timer = setTimeout(() => {
      pending.delete(cid);
      const what = entry.methodKey ? `'${entry.methodKey}'` : "the method";
      entry.reject(
        new Error(
          `no response for ${what} after ${entry.ceilingMs}ms — the server ` +
            `never confirmed the call: it may still be running (its writes can ` +
            `commit later) or the connection dropped. The server bounds methods ` +
            `via effectTimeoutMs / perfBudget.methods["${
              entry.methodKey ?? "cell:method"
            }"].timeout (0 = wait indefinitely).`,
        ),
      );
    }, entry.ceilingMs);
  };

  return {
    register(cid, opts) {
      const existing = pending.get(cid);
      if (existing) return existing.promise;

      let resolve!: (value?: unknown) => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const ceiling = ceilingFor(opts?.methodKey);
      const entry: PendingEntry = {
        promise,
        resolve,
        reject,
        timer: undefined,
        ceilingMs: typeof ceiling === "number" ? ceiling : ceiling.warnAfterMs,
        mode: typeof ceiling === "number" ? "reject" : "warn",
        methodKey: opts?.methodKey,
        // A caller that does NOT defer is telling us it has no queue to track
        // — the frame is gone as far as it knows, so the call counts as
        // in-flight and a disconnect settles it (the historic behaviour).
        written: !opts?.deferTimer,
      };
      pending.set(cid, entry);
      if (!opts?.deferTimer) arm(cid, entry);
      return promise;
    },
    armTimer(cid) {
      const entry = pending.get(cid);
      if (!entry) return;
      entry.written = true;
      arm(cid, entry);
    },
    isWritten(cid) {
      return pending.get(cid)?.written === true;
    },
    resolve(cid, value) {
      const entry = pending.get(cid);
      if (!entry) return false;
      pending.delete(cid);
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(value);
      return true;
    },
    reject(cid, err) {
      const entry = pending.get(cid);
      if (!entry) return false;
      pending.delete(cid);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
      return true;
    },
    rejectAll(err) {
      const count = pending.size;
      for (const [cid, entry] of pending) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(err);
        pending.delete(cid);
      }
      return count;
    },
    rejectInFlight(err) {
      let count = 0;
      for (const [cid, entry] of pending) {
        if (!entry.written) continue;
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(err);
        pending.delete(cid);
        count++;
      }
      return count;
    },
    size: () => pending.size,
  };
}

/** Marks a dispatcher that SETTLES its own calls — i.e. the promise it returns
 *  is the call's real outcome, carried back by an ack from wherever the method
 *  actually ran.
 *
 *  `bindCell`'s async branch normally returns a LOCAL pending-call promise
 *  (`registerCall`), because in-process the executor that runs the method also
 *  settles that promise. A REMOTE dispatcher (`connectCli`) has no local
 *  executor: nothing in this process ever resolves it, so every async bound
 *  method — success or failure — hung until the call ceiling and then rejected
 *  with "stopped waiting", 30 seconds after a method that had already
 *  succeeded. Marking the dispatcher tells the binding to hand back the
 *  dispatcher's own promise instead.
 *
 *  Mirrors ARMS_ACK_TIMER: a capability the transport declares about itself,
 *  rather than a type the binding has to know about. */
export const SETTLES_CALLS = Symbol.for("aio.settlesCalls");

/** True when `fn` is a dispatcher whose returned promise IS the call outcome. */
// deno-lint-ignore ban-types
export function settlesCalls(fn: Function | undefined): boolean {
  return !!fn &&
    (fn as unknown as Record<symbol, boolean>)[SETTLES_CALLS] === true;
}

/** The per-method budget key ("cell:method") for an action — same derivation
 *  as the server executor's methodBudgetKey: async methods all travel as
 *  `<cell>:__exec` with the real name in the payload.
 *
 *  It lives beside the registry that consumes it because BOTH the cell binding
 *  and the transport need it. It used to exist only in the transport, so the
 *  binding registered without it and the entry's methodKey stayed undefined. */
export function ackMethodKey(
  action: { type: string; payload?: unknown },
): string {
  if (action.type.endsWith(":__exec")) {
    const m = (action.payload as { _method?: unknown } | undefined)?._method;
    if (typeof m === "string") {
      return `${action.type.slice(0, -":__exec".length)}:${m}`;
    }
  }
  return action.type;
}
