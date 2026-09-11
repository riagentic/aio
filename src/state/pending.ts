/**
 * @module
 * `cell.$pending("scan")` — reactive, so reading it in a component re-renders.
 *
 * The COUNT lives in `protocol/pending-calls.ts`, dependency-free, because
 * both the server executor and a client's ack registry feed it and `protocol`
 * is the folder both may import. This is the thin reactive wrapper: one signal
 * per key, created on first read, kept in step by one subscription.
 *
 * Lazy on purpose. An app that never asks pays for nothing — no signal, no
 * subscription — which matters because every async call bumps the counter
 * whether anyone is watching or not.
 */
import { signal } from "./signal.ts";
import {
  onPendingChange,
  pendingCount,
  pendingForCell,
} from "../protocol/pending-calls.ts";

type Sig = ReturnType<typeof signal<number>>;

const _sigs = new Map<string, Sig>();
let _unsub: (() => void) | null = null;

function ensureSubscribed(): void {
  if (_unsub) return;
  _unsub = onPendingChange((key, n) => {
    _sigs.get(key)?.set(n);
    // A cell-wide watcher (`cell.$pending()` with no method) has to move when
    // ANY of its methods does — the sum is not derivable from one key.
    const prefix = key.slice(0, key.indexOf(":"));
    _sigs.get(prefix)?.set(pendingForCell(prefix));
  });
}

/** The reactive in-flight count for `cell:method`, or for a whole cell when
 *  `method` is omitted. */
export function pendingSignal(prefix: string, method?: string): number {
  ensureSubscribed();
  const key = method === undefined ? prefix : `${prefix}:${method}`;
  let s = _sigs.get(key);
  if (!s) {
    s = signal(
      method === undefined ? pendingForCell(prefix) : pendingCount(key),
    );
    _sigs.set(key, s);
  }
  // The signal is the SUBSCRIPTION; the counter is the ANSWER.
  //
  // `signal.set` is scheduled, not immediate, so returning `s.value` reported
  // a count one update behind — two overlapping calls read as one, which is
  // the exact bug a count exists to avoid. Reading `.value` still registers
  // the dependency that re-renders a component; the number handed back is the
  // live one.
  void s.value;
  return method === undefined ? pendingForCell(prefix) : pendingCount(key);
}

/** Drop every signal and the subscription — teardown, and between tests. */
export function resetPendingSignals(): void {
  _unsub?.();
  _unsub = null;
  _sigs.clear();
}
