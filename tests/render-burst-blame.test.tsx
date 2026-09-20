/** @jsxImportSource aio */
// The render-burst tripwire must blame what ACTUALLY wrote, and name what
// fired the renders.
//
// A field report: `X re-rendered 50 times in under a second — a render is
// WRITING state that the same render READS` printed while the renders were
// driven entirely from OUTSIDE (a stub server streaming a reply fast) and
// neither component wrote during render. The author went looking for a
// write-in-render that does not exist, in two components, twice.
//
// The cause was the test the tripwire used: `_instanceStack.length > 0`, i.e.
// "some component, anywhere, is rendering" — true for the whole flush of a
// subtree, including every moment when no render BODY is executing: an
// `onCleanup`, a commit-time action, a socket frame landing mid-pass. Only a
// running body is a render, and `_currentCollector` says so exactly.
//
// Worth knowing while reading these: a render CANNOT loop itself directly. A
// component's subscriptions are torn down at the start of its own render and
// rebuilt after it, so a write inside its body reaches no subscriber of its
// own — the real shape is always a render writing what ANOTHER component
// reads (block C), or a lifecycle callback writing after the render (block A).
import { assert, assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { signal } from "../src/state/signal.ts";
import { afterRender, useSignal } from "../src/air.ts";

const WARNS: string[] = [];
// Forwarded, never restored: a real warning from anywhere else in this file
// stays visible in the run's output, and there is no teardown step that could
// be skipped on a failure and silence the rest of the process.
const _realWarn = console.warn;
console.warn = (...a: unknown[]) => {
  WARNS.push(a.map(String).join(" "));
  _realWarn(...a);
};
// Never cleared: the wrapper form of `testUI` mounts and settles BEFORE the
// test body runs, so a loop that finishes during the mount has already warned
// by then — clearing at the top of the body wiped the very line under test.
// Each block uses a component name of its own instead.
const burstFor = (name: string) =>
  WARNS.find((w) => w.includes(`${name} re-rendered 50 times`));

// ── A. an afterRender write is not a render write ─────────────────────

function Ticker() {
  const n = useSignal(0);
  afterRender(() => {
    if (n.value < 60) n.set(n.value + 1);
  });
  return <span t="N">{n.value}</span>;
}

testUI(
  Ticker as never,
  "burst: an afterRender write is blamed on afterRender, not on the render",
  async (ui) => {
    await ui.waitFor(() => ui.N.text === "60");
    const hit = burstFor("Ticker");
    assert(hit, `no tripwire fired:\n${WARNS.join("\n")}`);
    assert(
      hit.includes("its afterRender callback is WRITING"),
      `the hook that wrote must be named: ${hit}`,
    );
    assertEquals(
      hit.includes("a render is WRITING"),
      false,
      `a callback that runs AFTER the render is not the render: ${hit}`,
    );
  },
);

// ── B. renders driven from outside name what fired them ───────────────

const stream = signal("", "stream");
const Reader = () => <p t="Out">{stream.value}</p>;

testUI(
  Reader as never,
  "burst: outside-driven renders name the dependency that fired them",
  async (ui) => {
    for (let i = 0; i < 60; i++) {
      stream.set(`chunk ${i}`);
      await ui.settle();
    }
    const hit = burstFor("Reader");
    assert(hit, `no tripwire fired:\n${WARNS.join("\n")}`);
    assert(
      hit.includes("The renders were fired by: stream."),
      `the message must name the dependency: ${hit}`,
    );
    assertEquals(
      hit.includes("WRITING"),
      false,
      `nothing wrote during a render — the message must not claim one did: ${hit}`,
    );
  },
);

// ── C. a real render write, blamed on the render that made it ─────────

const tick = signal(0, "tick");
const mirror = signal(0, "mirror");

function Writer() {
  const t = tick.value;
  mirror.set(t); // a render, writing — the genuine article
  return <i>{t}</i>;
}
const Mirror = () => <b t="M">{mirror.value}</b>;
const Pair = () => (
  <div>
    <Writer />
    <Mirror />
  </div>
);

testUI(
  Pair as never,
  "burst: a render that writes what another reads names the writer",
  async (ui) => {
    for (let i = 1; i <= 60; i++) {
      tick.set(i);
      await ui.settle();
    }
    const hit = burstFor("Mirror");
    assert(hit, `no tripwire fired:\n${WARNS.join("\n")}`);
    assert(
      hit.includes("<Writer>'s render is WRITING state that this render READS"),
      `the writing render must be named, not "the same render": ${hit}`,
    );
    assert(
      hit.includes("The renders were fired by: mirror."),
      `the message must name the dependency: ${hit}`,
    );
    // …and the component that is merely driven from outside gets the other
    // message, in the same run: one tripwire, two honest answers.
    const outside = burstFor("Writer");
    assert(outside, `no tripwire for the outside-driven component`);
    assert(
      outside.includes("outside any render") &&
        outside.includes("fired by: tick."),
      outside,
    );
  },
);

// ── D. "fired by" is the burst's WINDOW, not the instance's history ────
//
// `_triggerSignals` is the DevTools feed and is emptied only while a DevTools
// handle is attached, so with nobody looking it is every dependency that ever
// fired this instance. Read as "the dependencies that fired THESE renders" it
// named a value that fired once at boot beside the stream that is actually
// looping — the reader bisects a dependency that had nothing to do with it,
// which is the same class of lie the rest of this file fixes.

const earlyOnce = signal(0, "earlyOnce");
const fastStream = signal(0, "fastStream");
const Mixed = () => <p t="Out">{earlyOnce.value}-{fastStream.value}</p>;

testUI(
  Mixed as never,
  "burst: names the deps that fired the COUNTED renders, not every dep ever",
  async (ui) => {
    earlyOnce.set(1);
    await ui.settle();
    // Well outside the tripwire's one-second window.
    await new Promise((r) => setTimeout(r, 1300));
    for (let i = 0; i < 60; i++) {
      fastStream.set(i + 1);
      await ui.settle();
    }
    const hit = burstFor("Mixed");
    assert(hit, `no tripwire fired:\n${WARNS.join("\n")}`);
    assert(hit.includes("fastStream"), `must name the real driver: ${hit}`);
    assertEquals(
      hit.includes("earlyOnce"),
      false,
      `names a dependency that did NOT fire these renders: ${hit}`,
    );
  },
);
