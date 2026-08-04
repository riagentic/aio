// space follow-up: the three open testUI/AIR gaps.
//   1. ui.X.keyDown / keyUp — HOLD a key (press is a tap; games, drags,
//      held modifiers were untestable through the DOM).
//   2. expectCell on a scope:'client' cell — works (retry) or fails naming
//      the scope, never as a bogus "predicate wrong".
//   3. useInterval — the client-only cadence idiom (schedule.every is
//      server-side; the chiptune sequencer had to hand-roll setInterval).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { useInterval, useRaf } from "../src/air/raf.ts";

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

// ── `active` is LIVE, not a mount-time snapshot ──────────────────────────
//
// `useInterval`'s own documented example is `active={game.screen ===
// "playing"}` — a flag over live cell state. It was read inside `onMount`,
// which fires exactly ONCE per instance, so the flag froze at whatever it was
// when the component mounted: a sequencer that mounted on the title screen
// could never start, and one that mounted playing could never be paused. The
// hook silently did the opposite of what its docs promised. Same for `useRaf`.
const seq = cell("seq-pad", {
  state: { playing: false, beats: 0 },
  scope: "client",
  methods: {
    play(s: { playing: boolean }) {
      s.playing = true;
    },
    pause(s: { playing: boolean }) {
      s.playing = false;
    },
    beat(s: { beats: number }) {
      s.beats++;
    },
  },
});

function Sequencer() {
  useInterval(() => seq.beat(), 15, seq.playing);
  return <div class="beats">{String(seq.beats)}</div>;
}

Deno.test("useInterval: active starts and stops the timer as state changes", async () => {
  await using ui = await testUI(Sequencer);

  // Mounted INACTIVE — nothing may tick.
  await new Promise((r) => setTimeout(r, 60));
  await ui.settle();
  assertEquals(seq.beats, 0, "inactive at mount ⇒ no ticks");

  // …and it can still start afterwards. (The bug: onMount already ran.)
  seq.play();
  await ui.settle();
  await new Promise((r) => setTimeout(r, 80));
  await ui.settle();
  const running = seq.beats;
  assert(running >= 2, `started when active flipped true: ${running}`);

  // Pausing must CLEAR the interval, not just skip a callback.
  seq.pause();
  await ui.settle();
  const atPause = seq.beats;
  await new Promise((r) => setTimeout(r, 80));
  await ui.settle();
  assertEquals(seq.beats, atPause, "paused ⇒ the timer is really stopped");

  // And it can start again — the stop/start pair is reusable, not one-shot.
  seq.play();
  await ui.settle();
  await new Promise((r) => setTimeout(r, 80));
  await ui.settle();
  assert(seq.beats > atPause, "resumes after a pause");
});

// The SAME live-active contract for useRaf — both hooks share useActiveLoop,
// but a useRaf-only regression (say, reverting just its wiring to onMount)
// must not hide behind the interval test.
const rot = cell("rot-pad", {
  state: { spinning: false, frames: 0 },
  scope: "client",
  methods: {
    play(s: { spinning: boolean }) {
      s.spinning = true;
    },
    pause(s: { spinning: boolean }) {
      s.spinning = false;
    },
    frame(s: { frames: number }) {
      s.frames++;
    },
  },
});

function Spinner() {
  useRaf(() => rot.frame(), rot.spinning);
  return <div class="frames">{String(rot.frames)}</div>;
}

Deno.test("useRaf: active starts and stops the loop as state changes", async () => {
  // Controllable rAF queue — restore EXACTLY what was there before.
  const g = globalThis as Record<string, unknown>;
  const hadReq = "requestAnimationFrame" in g;
  const hadCancel = "cancelAnimationFrame" in g;
  const prevReq = g.requestAnimationFrame;
  const prevCancel = g.cancelAnimationFrame;
  const cbs = new Map<number, FrameRequestCallback>();
  let next = 1;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = next++;
    cbs.set(id, cb);
    return id;
  };
  g.cancelAnimationFrame = (id: number) => cbs.delete(id);
  const tick = (t: number) => {
    const due = [...cbs.values()];
    cbs.clear();
    for (const cb of due) cb(t);
  };
  try {
    await using ui = await testUI(Spinner);
    tick(0);
    await ui.settle();
    assertEquals(rot.frames, 0, "inactive at mount ⇒ no frames");
    assertEquals(cbs.size, 0, "no rAF queued while inactive");

    rot.play();
    await ui.settle();
    tick(16);
    await ui.settle();
    tick(32);
    await ui.settle();
    assert(rot.frames >= 2, `started when active flipped true: ${rot.frames}`);

    rot.pause();
    await ui.settle();
    const atPause = rot.frames;
    // The queued frame must have been CANCELLED by the pause (cancelAnimation-
    // Frame removes it from `cbs`) — if the hook merely skipped its callback,
    // this tick would still fire it and the count would move.
    tick(48);
    await ui.settle();
    assertEquals(rot.frames, atPause, "paused ⇒ the loop is really cancelled");

    rot.play();
    await ui.settle();
    tick(64);
    await ui.settle();
    assert(rot.frames > atPause, "resumes after a pause");
  } finally {
    if (hadReq) g.requestAnimationFrame = prevReq;
    else delete g.requestAnimationFrame;
    if (hadCancel) g.cancelAnimationFrame = prevCancel;
    else delete g.cancelAnimationFrame;
  }
});
