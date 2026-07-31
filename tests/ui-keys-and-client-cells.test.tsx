// space-invaders follow-up: the three open testUI/AIR gaps.
//   1. ui.X.keyDown / keyUp — HOLD a key (press is a tap; games, drags,
//      held modifiers were untestable through the DOM).
//   2. expectCell on a scope:'client' cell — works (retry) or fails naming
//      the scope, never as a bogus "predicate wrong".
//   3. useInterval — the client-only cadence idiom (schedule.every is
//      server-side; the chiptune sequencer had to hand-roll setInterval).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { useInterval } from "../src/air/raf.ts";

const pad = cell("keys-pad", {
  state: { held: false, taps: 0, ticks: 0, screen: "title" },
  scope: "client",
  methods: {
    down(s: { held: boolean }) {
      s.held = true;
    },
    up(s: { held: boolean; taps: number }) {
      s.held = false;
      s.taps++;
    },
    tick(s: { ticks: number }) {
      s.ticks++;
    },
  },
});

function App() {
  return (
    <div
      t="stage"
      // deno-lint-ignore no-explicit-any
      onKeyDown={(e: any) => {
        if (e.key === "ArrowLeft") pad.down();
      }}
      // deno-lint-ignore no-explicit-any
      onKeyUp={(e: any) => {
        if (e.key === "ArrowLeft") pad.up();
      }}
    >
      {pad.held ? "holding" : "idle"}
    </div>
  );
}

testUI(App, "ui.keyDown holds a key — no keyup until ui.keyUp", async (ui) => {
  ui.stage.keyDown("ArrowLeft");
  await ui.settle();
  assertEquals(pad.held, true, "held while down");
  assertEquals(pad.taps, 0, "no keyup fired yet — press would have tapped");
  ui.stage.keyUp("ArrowLeft");
  await ui.settle();
  assertEquals(pad.held, false);
  assertEquals(pad.taps, 1);
});

testUI(
  App,
  "expectCell on a scope:'client' cell — no bogus predicate failure",
  async (ui) => {
    // Either it resolves (the retry + direct-def read path)…
    try {
      await ui.expectCell(
        pad,
        (c) => (c as { screen: string }).screen === "title",
      );
    } catch (e) {
      // …or it must say WHY, naming the scope — never a generic failure.
      const msg = String(e);
      assert(msg.includes("scope:'client'"), msg);
      assert(msg.includes("ui.settle()"), msg);
    }
  },
);

function TickApp() {
  useInterval(() => pad.tick(), 20);
  return <div class="tick">{String(pad.ticks)}</div>;
}

Deno.test("useInterval: client-side cadence with automatic cleanup", async () => {
  {
    await using ui = await testUI(TickApp);
    await new Promise((r) => setTimeout(r, 90));
    await ui.settle();
    assert(pad.ticks >= 2, `ticked while mounted: ${pad.ticks}`);
  }
  // Harness torn down — the interval is gone with it.
  const after = pad.ticks;
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(pad.ticks, after, "cleanup stopped the interval");
});
