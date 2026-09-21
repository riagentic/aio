// Where does "server origin" STOP? (the other half of access-server-origin)
//
// `access:` bypasses for server code, and that origin is a continuation-local
// scope the framework opens around a method body (call-origin.ts). A scope
// that survives `await` also survives every other continuation started inside
// it — and the framework starts one there that runs CLIENT code: a live-proxy
// write inside an async method commits synchronously, the commit flushes the
// signal graph, and the renderer queues its batched re-render from inside that
// flush. The queued microtask inherited the store, so the COMPONENT BODY ran
// as "the server" — and a `<div>` calling a sealed cell straight from a render
// (or from a debounce timer it starts there) was ALLOWED what the identical
// call from a click handler is refused.
//
// That is the exact failure the feature exists to prevent, arriving through
// the back door, and it is worse than a plain hole: it depends on whether a
// render happened to be scheduled inside an async body, so a suite is green
// or red at a distance. A sync method did NOT leak, which made it a sync/async
// parity break as well.
//
// The rule pinned here: notifying a signal's subscribers is not the writer's
// continuation. `_flush` (signal.ts) runs subscriber effects OUTSIDE the
// scope, so everything downstream of a commit — the renderer, the component
// body, whatever that body schedules — is client code again.
//
// The second half is the other direction: `own.set`'s factory and disposer are
// the app's own server code (they acquire the cell's OS resources), and they
// were NOT marked, so a factory that called a sealed cell was refused.
import { assert, assertEquals } from "@std/assert";
import { cell, own } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { isServerOrigin } from "../src/state/call-origin.ts";

// ── The sealed cell: no client may CALL it, ever. ────────────────────
const sealed = cell("ob-sealed", {
  state: { n: 0 },
  access: () => false,
  methods: {
    bump(s: { n: number }) {
      s.n += 1;
      return s.n;
    },
  },
});
type Sealed = { bump: () => Promise<number>; n: number };
const S = sealed as unknown as Sealed;

/** "ALLOWED" | "DENIED" — what the gate answered this caller. */
async function callSealed(): Promise<string> {
  try {
    await S.bump();
    return "ALLOWED";
  } catch {
    return "DENIED";
  }
}

const open = cell("ob-open", {
  state: { n: 0 },
  methods: {
    // The shape that leaked: a live-proxy write AFTER an await, so the commit
    // (and the render flush it drives) happens inside the method's scope.
    async touchAsync(s: { n: number }) {
      await Promise.resolve();
      s.n += 1;
    },
    // The same thing synchronously — the parity half.
    touchSync(s: { n: number }) {
      s.n += 1;
    },
    // Still in flight while the next UI action is driven.
    async slow(s: { n: number }) {
      await new Promise((r) => setTimeout(r, 40));
      s.n += 1;
    },
  },
});
type Open = {
  touchAsync: () => Promise<void>;
  touchSync: () => Promise<void>;
  slow: () => Promise<void>;
};
const O = open as unknown as Open;

// Sampled by the component on every render.
let renderOrigins: boolean[] = [];
let renderVerdicts: string[] = [];
let timerOrigins: boolean[] = [];
let timerVerdicts: string[] = [];
let clickVerdict = "";

function App() {
  // A component body is CLIENT code in every runtime. So is anything it
  // schedules from there (a debounce timer is the everyday shape).
  renderOrigins.push(isServerOrigin());
  void callSealed().then((v) => renderVerdicts.push(v));
  setTimeout(() => {
    timerOrigins.push(isServerOrigin());
    void callSealed().then((v) => timerVerdicts.push(v));
  }, 0);
  return (
    <div>
      <div class="button" onClick={() => void O.touchAsync()}>Async</div>
      <div class="button" onClick={() => void O.touchSync()}>Sync</div>
      <div class="button" onClick={() => void O.slow()}>Slow</div>
      <div
        class="button"
        onClick={() => void callSealed().then((v) => clickVerdict = v)}
      >
        Direct
      </div>
      <span class="out">{open.n}</span>
    </div>
  );
}

function reset() {
  renderOrigins = [];
  renderVerdicts = [];
  timerOrigins = [];
  timerVerdicts = [];
}

/** Boot, click, let the renders and their timers run — and read the sealed
 *  cell's counter from INSIDE the harness, before and after, because teardown
 *  resets cell state and a reading taken outside would compare two runs. */
async function drive(which: "Async" | "Sync") {
  reset();
  await using ui = await testUI(App, { cells: [sealed, open], user: null });
  const before = S.n;
  (which === "Async" ? ui.AsyncButton : ui.SyncButton).click();
  await ui.settle().catch(() => {});
  await new Promise((r) => setTimeout(r, 60));
  return { before, after: S.n };
}

Deno.test("access origin: a render driven by an ASYNC method body is client code", async () => {
  const { before, after } = await drive("Async");
  assert(renderOrigins.length >= 2, "the click must have re-rendered");
  assertEquals(
    renderOrigins.filter((o) => o),
    [],
    "no component render may run as server origin",
  );
  assertEquals(
    renderVerdicts.filter((v) => v !== "DENIED"),
    [],
    "a sealed cell called from a render must be refused, every render",
  );
  assertEquals(after, before, "a refused call must change nothing");
});

Deno.test("access origin: a timer a render starts is client code too", async () => {
  await drive("Async");
  assert(timerOrigins.length >= 2, "the render's timers must have fired");
  assertEquals(
    timerOrigins.filter((o) => o),
    [],
    "a timer started from a render may not inherit server origin",
  );
  assertEquals(timerVerdicts.filter((v) => v !== "DENIED"), []);
});

Deno.test("access origin: sync and async method bodies stop the scope alike", async () => {
  const a = await drive("Async");
  const asyncOrigins = [...renderOrigins];
  const s = await drive("Sync");
  const syncOrigins = [...renderOrigins];
  assertEquals(
    asyncOrigins.some((o) => o),
    syncOrigins.some((o) => o),
    "a leak that only an async body produces is a parity break",
  );
  assertEquals(a.after, a.before);
  assertEquals(s.after, s.before);
});

Deno.test("access origin: a click driven while a method is still awaiting is a client", async () => {
  // The UI queue runs the next action while the previous method is still in
  // flight — its scope is open somewhere in the process. Ambient must mean
  // "this continuation", never "some continuation".
  reset();
  clickVerdict = "";
  await using ui = await testUI(App, { cells: [sealed, open], user: null });
  ui.SlowButton.click();
  ui.DirectButton.click();
  await ui.settle().catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(clickVerdict, "DENIED");
});

// ── The other direction: server code that was NOT marked ─────────────

const ownCaller = cell("ob-own", {
  state: { n: 0 },
  methods: {
    acquire(s: { n: number; $do: (e: never) => void }) {
      s.$do(
        own.set("ob-own-slot", () => {
          // A cell's own resource factory IS the app's server code — the
          // reason `own` exists is that the cell owns the resource. It may
          // use the app's internal cells exactly as a method body may.
          ownFactoryOrigin = isServerOrigin();
          void callSealed().then((v) => ownFactoryVerdict = v);
          return () => {
            ownDisposerOrigin = isServerOrigin();
          };
        }) as never,
      );
      s.n += 1;
    },
  },
});
let ownFactoryOrigin = false;
let ownFactoryVerdict = "";
let ownDisposerOrigin = false;

function OwnApp() {
  return (
    <div>
      <div
        class="button"
        onClick={() =>
          void (ownCaller as unknown as { acquire: () => Promise<void> })
            .acquire()}
      >
        Acquire
      </div>
      <span class="out">{ownCaller.n}</span>
    </div>
  );
}

Deno.test("access origin: an own.set factory is server code, not a client", async () => {
  ownFactoryOrigin = false;
  ownFactoryVerdict = "";
  ownDisposerOrigin = false;
  let sealedAfter = -1;
  {
    await using ui = await testUI(OwnApp, {
      cells: [sealed, ownCaller],
      user: null,
    });
    ui.AcquireButton.click();
    await ui.settle().catch(() => {});
    await new Promise((r) => setTimeout(r, 40));
    sealedAfter = S.n; // inside the harness — teardown resets cell state
  }
  assert(ownFactoryOrigin, "own.set's factory must run as server origin");
  assertEquals(
    ownFactoryVerdict,
    "ALLOWED",
    "a factory calling an internal cell must not be refused",
  );
  assertEquals(sealedAfter, 1, "and the call must actually have run");
  assert(ownDisposerOrigin, "own's disposer must run as server origin too");
});

// ── Two harnesses at once ────────────────────────────────────────────
//
// The scope is ONE object for the process behind a use count (ui-test.ts),
// because an install-per-gate with a "restore to null" teardown had the first
// `testUI` to finish strip the marker out from under a second one still
// running — every cell→cell call in it refused, at a distance, decided by
// which test happened to end first. That was fixed without a test; this is
// the test.

const pairCaller = cell("ob-pair", {
  state: { n: 0 },
  methods: {
    async useSealed(s: { n: number }) {
      await Promise.resolve();
      pairVerdict = await callSealed();
      s.n += 1;
    },
  },
});
let pairVerdict = "";

function PairApp() {
  return (
    <div>
      <div
        class="button"
        onClick={() =>
          void (pairCaller as unknown as { useSealed: () => Promise<void> })
            .useSealed()}
      >
        Use
      </div>
      <span class="out">{pairCaller.n}</span>
    </div>
  );
}

Deno.test("access origin: an outer testUI keeps the scope after an inner one is torn down", async () => {
  pairVerdict = "";
  const outer = await testUI(PairApp, {
    cells: [sealed, pairCaller],
    user: null,
  });
  try {
    // A second harness opens and closes entirely inside the first one's life.
    const inner = await testUI(PairApp, {
      cells: [sealed, pairCaller],
      user: null,
    });
    await inner.dispose();
    // The outer harness is still live: its cell→cell call must still bypass.
    outer.UseButton.click();
    await outer.settle().catch(() => {});
    assertEquals(
      pairVerdict,
      "ALLOWED",
      "the inner teardown must not strip the outer harness's scope",
    );
  } finally {
    await outer.dispose();
  }
});
