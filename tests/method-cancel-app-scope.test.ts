// alpha70: the cancellation registry is keyed by APP IDENTITY, not by cell
// name alone. Two apps in one process cannot share a cell def, but each may
// hold its own `cell("ledger", …)` — a factory, a client binding a remote
// cell — and by name alone app A's `cart.clear` aborted app B's running
// `ledger.place`, and A's shutdown counted, waited on and aborted B's calls.
//
// `""` is the wildcard ("app unknown"): a caller not yet threaded an identity
// behaves exactly as before, so the threading can land runtime by runtime.
import { assert, assertEquals } from "@std/assert";
import {
  _cancelTriggerCount,
  _resetMethodCancel,
  abortAllInflight,
  endShutdownAbort,
  notifyMethodCancel,
  registerCancelOn,
  settlePending,
  trackCall,
  trackPending,
  unregisterCancelOn,
} from "../src/state/method-cancel.ts";

Deno.test("method-cancel: two apps, one cell name — cancelling in one never cancels the other", () => {
  _resetMethodCancel();
  try {
    // Both apps compose a `ledger` whose `place` is cancelled by `cart:clear`.
    registerCancelOn("ledger", "place", ["cart:clear"], "appA");
    registerCancelOn("ledger", "place", ["cart:clear"], "appB");
    const a = new AbortController();
    const b = new AbortController();
    trackCall("ledger", "place", a, "appA");
    trackCall("ledger", "place", b, "appB");

    // App A's user clears the cart.
    notifyMethodCancel("cart:clear", "appA");
    assert(a.signal.aborted, "app A's place() is cancelled");
    assert(!b.signal.aborted, "app B's place() is NOT — it is another app");

    // …and B's own trigger still works for B.
    notifyMethodCancel("cart:clear", "appB");
    assert(b.signal.aborted, "app B's own trigger still cancels app B");
  } finally {
    _resetMethodCancel();
  }
});

Deno.test("method-cancel: the wildcard scope keeps the un-threaded runtime whole", () => {
  _resetMethodCancel();
  try {
    // A runtime that has not been threaded an app id registers and notifies
    // under "" — exactly the name-keyed behaviour every existing app relies on.
    registerCancelOn("ledger", "place", "self");
    const older = new AbortController();
    trackCall("ledger", "place", older);
    notifyMethodCancel("ledger:place");
    assert(older.signal.aborted, "self: newest call wins, older aborts");

    // Mixed: a scoped trigger vs an unscoped notify (or the reverse) still
    // fires — unknown means "any app", never "no app". cancelOn can not go
    // silently inert half-way through the threading.
    const c1 = new AbortController();
    trackCall("ledger", "place", c1, "appA");
    notifyMethodCancel("ledger:place");
    assert(c1.signal.aborted, "unscoped notify reaches a scoped call");
    const c2 = new AbortController();
    trackCall("ledger", "place", c2);
    notifyMethodCancel("ledger:place", "appA");
    assert(c2.signal.aborted, "scoped notify reaches an unscoped call");
  } finally {
    _resetMethodCancel();
  }
});

Deno.test("method-cancel: shutdown of one app aborts, waits on and pre-aborts only its own calls", async () => {
  _resetMethodCancel();
  try {
    const a = new AbortController();
    const b = new AbortController();
    trackCall("ledger", "place", a, "appA");
    trackCall("ledger", "place", b, "appB");
    trackPending(new Promise<void>(() => {}), "ledger", "appB");
    // settlePending(0) answers "how many are still running" without waiting.
    assertEquals(await settlePending(0, new Set(["ledger"]), "appA"), 0);
    assertEquals(await settlePending(0, new Set(["ledger"]), "appB"), 1);
    assertEquals(await settlePending(0, undefined, "appB"), 1);
    assertEquals(await settlePending(0), 1, "the wildcard is the process view");

    assertEquals(abortAllInflight(new Set(["ledger"]), "appA"), 1);
    assert(a.signal.aborted);
    assert(!b.signal.aborted, "same cell name, other app: untouched");
    // A late starter (serialize queue) in A is born aborted; B's is not.
    const lateA = new AbortController();
    const lateB = new AbortController();
    trackCall("ledger", "place", lateA, "appA");
    trackCall("ledger", "place", lateB, "appB");
    assert(lateA.signal.aborted, "app A is shutting down");
    assert(!lateB.signal.aborted, "app B is not");
    // A's wait does not sit on B's still-running call.
    const t0 = Date.now();
    assertEquals(await settlePending(500, new Set(["ledger"]), "appA"), 0);
    assert(Date.now() - t0 < 400, "A must not wait for B's call");
    // The window closes per app.
    endShutdownAbort(new Set(["ledger"]), "appA");
    const fresh = new AbortController();
    trackCall("ledger", "place", fresh, "appA");
    assert(!fresh.signal.aborted, "after A's drain the name is live again");
  } finally {
    _resetMethodCancel();
  }
});

Deno.test("method-cancel: releasing one app's cell keeps the other app's triggers", () => {
  _resetMethodCancel();
  try {
    registerCancelOn("ledger", "place", ["cart:clear"], "appA");
    registerCancelOn("ledger", "place", ["cart:clear"], "appB");
    assertEquals(_cancelTriggerCount(), 2);
    unregisterCancelOn("ledger", "appA");
    assertEquals(_cancelTriggerCount(), 1, "only app A's edge is gone");
    const b = new AbortController();
    trackCall("ledger", "place", b, "appB");
    notifyMethodCancel("cart:clear", "appB");
    assert(b.signal.aborted, "app B still cancels after app A released");
    // Re-registering is idempotent — a re-compose adds no second edge.
    registerCancelOn("ledger", "place", ["cart:clear"], "appB");
    assertEquals(_cancelTriggerCount(), 1);
  } finally {
    _resetMethodCancel();
  }
});
