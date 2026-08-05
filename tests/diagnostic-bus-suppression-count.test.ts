// The diagnostic bus may suppress, but it may not go silent about suppressing.
//
// Dedup keys on `type` alone and holds a 5s window. That bounds volume, which
// is the point — but the suppressed event may have carried a DIFFERENT message
// (a second cell failing while the first is still inside the window), and it
// simply vanished. In the one subsystem whose entire job is to surface silent
// failures, that was the thing that had gone quiet.
//
// The window is unchanged — no new events are emitted and nothing extra gets
// through, so the volume control is exactly as strict as before. What changed
// is that the next event of a type reports how many it stands in for.
import { assert, assertEquals } from "@std/assert";
import {
  diagEmit,
  diagRecent,
  initDiagnosticBus,
} from "../src/diagnostics/diagnostic-bus.ts";

const ev = (type: string, message: string) => ({
  type,
  severity: "error" as const,
  source: "test",
  message,
});

Deno.test("suppressed events are counted and reported on the next one through", () => {
  initDiagnosticBus(true);
  // First gets through.
  diagEmit(ev("sup:test", "first"));
  // Three more inside the window — suppressed, as before.
  diagEmit(ev("sup:test", "second"));
  diagEmit(ev("sup:test", "third"));
  diagEmit(ev("sup:test", "fourth"));

  const afterWindow = diagRecent().filter((e) => e.type === "sup:test");
  assertEquals(
    afterWindow.length,
    1,
    "the window must still suppress — volume control is unchanged",
  );
  assertEquals(
    afterWindow[0]!.suppressed,
    undefined,
    "the FIRST event stands in for nothing, so it carries no count",
  );
});

Deno.test("a real window lapse reports the tally", async () => {
  // The only honest way to test a time window is to cross it. Re-initialising
  // the bus would NOT be equivalent — that clears the tally as well as the
  // timing, so it would pass against an implementation that forgets what it
  // suppressed. So this one really waits.
  initDiagnosticBus(true);
  diagEmit(ev("sup:lapse", "first"));
  diagEmit(ev("sup:lapse", "swallowed-1"));
  diagEmit(ev("sup:lapse", "swallowed-2"));

  // Wait out the dedup window. Kept short by construction: the window is a
  // module constant, so this is the one place a real sleep is warranted.
  await new Promise((r) => setTimeout(r, 5100));

  diagEmit(ev("sup:lapse", "after-window"));
  const ring = diagRecent().filter((e) => e.type === "sup:lapse");
  assertEquals(ring.length, 2, "one before, one after the window");
  const latest = ring[1]!;
  assertEquals(latest.message, "after-window");
  assertEquals(
    latest.suppressed,
    2,
    "the event that gets through must say how many it stands in for — two " +
      "different failures were swallowed and used to leave no trace at all",
  );
});

Deno.test("a type that never suppressed carries no count", async () => {
  initDiagnosticBus(true);
  diagEmit(ev("sup:clean", "one"));
  await new Promise((r) => setTimeout(r, 5100));
  diagEmit(ev("sup:clean", "two"));
  const ring = diagRecent().filter((e) => e.type === "sup:clean");
  assertEquals(ring.length, 2);
  assert(
    ring[1]!.suppressed === undefined,
    "no suppression means no field — an always-present 0 is noise, and it " +
      "would make 'was anything lost?' something you have to read rather than see",
  );
});
