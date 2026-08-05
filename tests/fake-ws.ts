// A WebSocket the test drives by hand, plus the small helpers that go with it.
//
// Transport bugs live in the SEQUENCING — what was written before the close,
// what the queue still holds, when the clock started. A real socket cannot be
// asked those questions at an exact instant, so the sequencing is faked and
// the client code under test is real.
import { dec } from "../src/protocol/envelope.ts";

export class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static live: FakeWS[] = [];

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWS.live.push(this);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a closed socket");
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  // — test controls —
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(line: string): void {
    this.onmessage?.({ data: line });
  }
  /** Every action frame this socket carried, decoded. */
  actions(): { type: string; cid?: string }[] {
    return this.sent
      .map((l) => dec(l))
      .filter((f) => f?.t === "action")
      .map((f) => f!.d as { type: string; cid?: string });
  }
}

/** Swap the global WebSocket for the fake; returns the restore. */
export function installFakeWS(): () => void {
  const orig = globalThis.WebSocket;
  FakeWS.live = [];
  // deno-lint-ignore no-explicit-any
  (globalThis as any).WebSocket = FakeWS;
  return () => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).WebSocket = orig;
    FakeWS.live = [];
  };
}

/** Shrink the reconnect backoff so a test does not spend seconds waiting for
 *  a retry it is about to drive anyway. */
export function fastBackoff(): () => void {
  const orig = globalThis.setTimeout;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setTimeout = (fn: never, ms?: number, ...a: never[]) =>
    orig(fn, ms !== undefined && ms >= 200 ? 5 : ms, ...a);
  // deno-lint-ignore no-explicit-any
  return () => ((globalThis as any).setTimeout = orig);
}

export const tick = (ms = 5): Promise<unknown> =>
  new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  fn: () => T | null | undefined | false,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== null && v !== undefined && v !== false) return v as T;
    await tick(5);
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** Settled state of a promise, observable without awaiting it. */
export type Tracked = {
  done: boolean;
  ok: boolean;
  value: unknown;
  at: number;
};
export function track<T>(
  p: Promise<T>,
  clock: () => number = () => 0,
): Tracked {
  const st: Tracked = { done: false, ok: false, value: undefined, at: -1 };
  p.then(
    (v) => {
      st.done = true;
      st.ok = true;
      st.value = v;
      st.at = clock();
    },
    (e) => {
      st.done = true;
      st.ok = false;
      st.value = e;
      st.at = clock();
    },
  );
  return st;
}
