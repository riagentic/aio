// A dropped delta must ask for a resync — every path, not just one.
//
// When the client refuses a patch frame, the server still believes it
// delivered it. From that moment the two disagree about the state and nothing
// puts them back on their own: every later patch applies to a base that is
// already wrong, so the UI renders confidently stale data with no error
// anywhere and no banner. It is the "looks like it works" failure in its
// purest form.
//
// Three paths reach that condition and only ONE of them used to ask for the
// fix: `applyPatches` throwing resynced, while a non-array `$patches` and a
// reserved path segment warned into the console and returned. One rule now,
// one decider (`_requestResync`).
import { assert, assertEquals } from "@std/assert";
import { handleMessage } from "../src/state/state-message.ts";
import { setTransport } from "../src/state-core.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

/** A transport that only records what the client asked the server for. */
function recorder() {
  const sent: string[] = [];
  setTransport(
    {
      send: (d: string) => sent.push(d),
      close: () => {},
    } as unknown as Parameters<typeof setTransport>[0],
  );
  return {
    sent,
    resyncs: () => sent.filter((s) => /"t":"resync"|resync/.test(s)),
  };
}

function seed() {
  // A full frame first: the client must have a base for a delta to be refused
  // ON, or the drop is just "no state yet".
  handleMessage({ counter: { n: 1 } });
}

Deno.test("delta: a non-array $patches is dropped AND resynced", () => {
  _resetAioRuntime();
  const t = recorder();
  seed();
  const r = handleMessage({ $patches: { op: "replace" } });
  assertEquals(r, "dropped");
  assert(
    t.resyncs().length === 1,
    `a refused delta leaves the client behind — it must ask for a full ` +
      `state. Sent: ${JSON.stringify(t.sent)}`,
  );
  _resetAioRuntime();
});

Deno.test("delta: a reserved path segment is refused AND resynced", () => {
  _resetAioRuntime();
  const t = recorder();
  seed();
  const r = handleMessage({
    $patches: [{ op: "replace", path: ["__proto__", "x"], value: 1 }],
  });
  assertEquals(r, "dropped");
  assert(
    t.resyncs().length === 1,
    `Sent: ${JSON.stringify(t.sent)}`,
  );
  _resetAioRuntime();
});

Deno.test("delta: an applier that throws still resyncs (the path that always did)", () => {
  _resetAioRuntime();
  const t = recorder();
  seed();
  // `replace` into a path whose parent does not exist — Immer throws.
  handleMessage({
    $patches: [{ op: "replace", path: ["nope", "deep", "deeper"], value: 1 }],
  });
  assert(
    t.resyncs().length >= 1,
    `Sent: ${JSON.stringify(t.sent)}`,
  );
  _resetAioRuntime();
});

Deno.test("delta: a GOOD patch applies and asks for nothing", () => {
  _resetAioRuntime();
  const t = recorder();
  seed();
  const r = handleMessage({
    $patches: [{ op: "replace", path: ["counter", "n"], value: 2 }],
  });
  assertEquals(r, "delta");
  assertEquals(
    t.resyncs().length,
    0,
    "a delta that APPLIED must not trigger a full-state round trip",
  );
  _resetAioRuntime();
});
