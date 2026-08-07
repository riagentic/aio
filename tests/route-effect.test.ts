// routeEffect — ONE exhaustive classifier for all three effect runtimes.
//
// server/aio-dispatch.ts, standalone-air.ts and server/cell-worker-host.ts
// each used to hand-write the schedule → own → app classifier chain; a new
// framework effect kind compiled clean and fell through to "app effect" in
// whichever runtime nobody updated. `state/route-effect.ts` centralizes the
// classification and makes the gap a COMPILE error: `FrameworkEffects` is a
// required-key registry, so a new kind demands a guard in ROUTES and a
// handler at every call site before the tree type-checks again.
//
// This file pins the runtime half: classification agrees with the canonical
// guards, exactly one handler fires, and all three runtimes actually route
// through the shared module (no residual hand-written chains).
import { assert, assertEquals } from "@std/assert";
import { routeEffect } from "../src/state/route-effect.ts";
import { schedule } from "../src/state/schedule.ts";
import { own } from "../src/state/own.ts";

function record() {
  const calls: string[] = [];
  return {
    calls,
    handlers: {
      schedule: (_e: unknown) => calls.push("schedule"),
      own: (_e: unknown) => calls.push("own"),
      app: (_e: unknown) => calls.push("app"),
      // deno-lint-ignore no-explicit-any
    } as any,
  };
}

Deno.test("routeEffect: a schedule effect goes to the schedule handler only", () => {
  const r = record();
  routeEffect(schedule.after("t1", 100, { type: "x:tick" }), r.handlers);
  assertEquals(r.calls, ["schedule"]);
});

Deno.test("routeEffect: an own effect goes to the own handler only", () => {
  const r = record();
  routeEffect(own.set("res-1", () => ({ dispose: () => {} })), r.handlers);
  assertEquals(r.calls, ["own"]);
});

Deno.test("routeEffect: anything else is an app effect", () => {
  const r = record();
  routeEffect({ type: "cart:persist", payload: { n: 1 } }, r.handlers);
  routeEffect({ type: "cart:__exec" }, r.handlers);
  assertEquals(r.calls, ["app", "app"]);
});

Deno.test("routeEffect: exactly one handler fires per effect", () => {
  const r = record();
  routeEffect(schedule.cancel("t1"), r.handlers);
  routeEffect(own.dispose("res-1"), r.handlers);
  routeEffect({ type: "a:b" }, r.handlers);
  assertEquals(r.calls.length, 3, "one classification per effect, never two");
});

// ── all three runtimes use THE router ────────────────────────────────
// A hand-written classifier chain sneaking back into a runtime is the exact
// regression this module exists to prevent — so its absence is gated, not
// assumed. (The compile-time exhaustiveness cannot be tested at runtime; this
// pins that the call sites exist at all.)

const RUNTIMES = [
  "src/server/aio-dispatch.ts",
  "src/standalone-air.ts",
  "src/server/cell-worker-host.ts",
];

Deno.test("routeEffect: every effect runtime routes through the shared module", async () => {
  for (const file of RUNTIMES) {
    const text = await Deno.readTextFile(
      new URL(`../${file}`, import.meta.url),
    );
    assert(
      text.includes("routeEffect"),
      `${file} no longer calls routeEffect — a hand-written classifier ` +
        `chain reintroduces the silent-fallthrough bug for new effect kinds`,
    );
    assert(
      !/isScheduleEffect\s*\(/.test(text) && !/isOwnEffect\s*\(/.test(text),
      `${file} calls the raw guards beside routeEffect — classification must ` +
        `have ONE decider`,
    );
  }
});
