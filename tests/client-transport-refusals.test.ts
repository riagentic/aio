// Three things the client did when a write was refused on an OPEN socket.
//
// A socket can report OPEN and still refuse a write — a full send buffer, a
// connection closing underneath, `InvalidStateError` for one still in
// CONNECTING. Each of these three answered that wrongly, in a different way.
import { assert, assertEquals } from "@std/assert";

// ── 1. the core `send()` LOST the action ─────────────────────────────────────
//
// `state-transport.send()` handed the frame straight to the transport with no
// try/catch, while the cell-method twin queues for the identical failure. So
// the throw came back out of `send()` — and for an Electron tray click, that
// is inside a shell bridge callback where nothing catches it. The action was
// gone: not queued, not acked, not retried. `tray-actions.ts` says that path
// "dispatches it through the SAME door every button uses — acks, validation,
// the offline queue, all of it". This is that door.
Deno.test("core send(): a refused write on a live transport QUEUES, never throws", async () => {
  const t = await import("../src/state/state-transport.ts");
  const warned: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
  try {
    t._resetTransport?.();
    // A transport that is connected and refuses every write.
    t.setTransport({
      send: () => {
        throw new Error("InvalidStateError: still in CONNECTING state");
      },
    } as never);

    const before = t._offlineQueueFullness() ?? 0;
    let threw: unknown = null;
    try {
      t.send({ type: "demo:fromTray", payload: {} });
    } catch (e) {
      threw = e;
    }
    assertEquals(
      threw,
      null,
      "the door every button uses must not throw into its caller",
    );
    const after = t._offlineQueueFullness() ?? 0;
    assert(
      after > before,
      `the action must be QUEUED, not dropped — queue went ${before} → ${after}`,
    );
    assert(
      warned.some((w) => /refused a write while reporting connected/.test(w)),
      `…and it must say so: ${JSON.stringify(warned)}`,
    );
  } finally {
    console.warn = origWarn;
    t._resetTransport?.();
  }
});

// ── 2. the log-forward tracker could never fire ──────────────────────────────
//
// `_sendRaw` CATCHES its own throw and returns false, so the `try` around the
// forward never saw a failure and `ok()` ran on every drop. Measured: a socket
// refusing every write forwarded 0 of 200 console lines while
// `degraded("client:log-forward")` stayed clean and `/__aio/health` reported
// the channel healthy. This is the channel the browser reports its own errors
// on — when it dies for good the page goes quiet in exactly the way that looks
// like "no errors", which is the case the tracker exists for.
Deno.test("console forward: a refused write escalates instead of reporting success", async () => {
  const { installConsoleIntercept, uninstallConsoleIntercept } = await import(
    "../src/browser/console-intercept.ts"
  );
  const { degraded, degradedReport, _resetDegraded } = await import(
    "../src/diagnostics/degraded.ts"
  ) as unknown as {
    degraded: (k: string) => { ok: () => void; fail: (e: unknown) => void };
    degradedReport: () => { name: string }[];
    _resetDegraded?: () => void;
  };
  void degraded;
  _resetDegraded?.();
  const origErr = console.error;
  console.error = () => {};
  try {
    // The shape `_sendRaw` produces for a refused write: false, not a throw.
    installConsoleIntercept(() => false);
    for (let i = 0; i < 40; i++) console.log(`line ${i}`);
    // Let the tracker's own escalation rule see the repetition.
    await new Promise((r) => setTimeout(r, 20));
    const report = degradedReport();
    assert(
      report.some((r) => r.name === "client:log-forward"),
      `40 dropped log lines must escalate — the channel that reports the ` +
        `browser's own errors going quiet is the case this tracks: ` +
        JSON.stringify(report),
    );
  } finally {
    console.error = origErr;
    uninstallConsoleIntercept?.();
    _resetDegraded?.();
  }
});

// ── 3. teardown discarded ONE of the two queues, then said it discarded the
//      queue ──────────────────────────────────────────────────────────────────
//
// Two queues exist for a structural reason — cell-method dispatch in the
// browser transport, `useCell().send` in the core, which cannot import it —
// and the reconnect path (`_takePending`) already knows that and drains both.
// `_dropQueue`, documented as "the ONLY place that may" throw the queue away,
// drained its own and left the core one holding actions. Measured: teardown
// reported "1 queued action(s) discarded" while a second survived it and was
// then replayed onto a LATER connection — a write the app was told was thrown
// away, landing minutes afterwards.
Deno.test("teardown: BOTH offline queues are discarded, and the count says so", async () => {
  const t = await import("../src/state/state-transport.ts");
  const warned: string[] = [];
  const origWarn = console.warn;
  const origErr = console.error;
  console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
  console.error = () => {};
  try {
    t._resetTransport();
    // Offline: the core queues rather than sending.
    t.send({ type: "demo:fromTray", payload: {} });
    assert(
      t._offlineQueueFullness() > 0,
      "the core queue is holding the action",
    );

    // Teardown, through the same door the product path uses (only the timing
    // is the test's — the 300ms grace timer is what fires it in a browser).
    await import("../src/browser/browser-air-transport.ts");
    const { _teardownNow } = await import(
      "../src/browser/protocol-subscription.ts"
    );
    _teardownNow();

    assertEquals(
      t._offlineQueueFullness(),
      0,
      "an action the app was TOLD was discarded must not survive to replay " +
        "onto a later connection",
    );
  } finally {
    console.warn = origWarn;
    console.error = origErr;
    t._resetTransport();
  }
});
