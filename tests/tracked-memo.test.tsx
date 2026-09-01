// The memo that silently unsubscribes.
//
// Field report (a wallet, ~1000 accounts): reactivity is per CELL — one cell is
// one signal — so any write to any field wakes every component that read
// anything from that cell. At list scale that is the difference between a frame
// and a freeze, so the app memoizes. And that is the trap: a component
// re-renders only for signals it touched WHILE RENDERING, so a cache that
// returns a hit without touching the cell subscribes to nothing.
//
// The symptom is not "stale". It is per-component-instance and permanent: the
// instance that got the MISS works forever, the one that got the HIT is dead
// forever, from the same cache, in the same frame. Live: entering demo mode
// added 1000 accounts, the client held all of them, and the panel stayed at one
// row — right data, stale DOM, and no error anywhere.
//
// The docs state the rule (docs/ui/reactivity-tracking.md, "a read is tracked
// when it happens during the synchronous execution of a component body") and
// stop one shape short of this one: an app-level cache SHARED across components
// whose hit path returns before touching the cell.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import {
  _trackEnd,
  _trackStart,
  signal,
  trackedMemo,
} from "../src/state/signal.ts";
import { testUI } from "../src/testing/ui-test.ts";

/** The read set a computation actually produced — the only way to assert
 *  "this really did subscribe", and the reason the field report had to reach
 *  into underscore-private internals to write its own regression test. */
function readsOf(fn: () => unknown): Set<unknown> {
  const deps = _trackStart();
  try {
    fn();
  } finally {
    _trackEnd(deps);
  }
  return deps;
}

Deno.test("the bug: a plain cache HIT subscribes to nothing", () => {
  const s = signal(1, "plain");
  const cache = new Map<string, number>();
  const memoized = (k: string) => {
    const hit = cache.get(k);
    if (hit !== undefined) return hit; // ← returns before touching the signal
    const v = s.value * 10;
    cache.set(k, v);
    return v;
  };

  // First caller: a miss. It reads, so it subscribes.
  assertEquals(readsOf(() => memoized("a")).size, 1);
  // Second caller, same frame: a hit. It subscribes to NOTHING — and nothing
  // anywhere reports it, because a component that subscribes to nothing
  // renders fine, once.
  assertEquals(
    readsOf(() => memoized("a")).size,
    0,
    "pinned as the reason trackedMemo exists — if this ever becomes 1, the " +
      "tracking model changed and this whole file should be re-read",
  );
});

Deno.test("trackedMemo: a HIT replays the read set the miss recorded", () => {
  const s = signal(1, "tracked");
  let computes = 0;
  const memoized = trackedMemo((k: string) => {
    computes++;
    return `${k}:${s.value}`;
  });

  const miss = readsOf(() => memoized("a"));
  const hit = readsOf(() => memoized("a"));
  assertEquals(computes, 1, "the second call is a real cache hit");
  assertEquals(miss.size, 1);
  assertEquals(
    [...hit],
    [...miss],
    "a hit must subscribe to exactly what computing the value would have read",
  );
});

Deno.test("trackedMemo: a hit whose dependencies moved recomputes", () => {
  const s = signal(1);
  let computes = 0;
  const memoized = trackedMemo((_k: string) => {
    computes++;
    return s.value * 2;
  });

  assertEquals(memoized("a"), 2);
  assertEquals(memoized("a"), 2);
  assertEquals(computes, 1);
  s.set(5);
  // No dependency array — the reads ARE the dependencies, so the same recorded
  // set that makes a hit subscribe is what makes it recompute.
  assertEquals(memoized("a"), 10);
  assertEquals(computes, 2);
});

Deno.test("trackedMemo: `key` maps the argument, `max` bounds the cache", () => {
  let computes = 0;
  const byId = trackedMemo(
    (o: { id: number; label: string }) => {
      computes++;
      return o.label;
    },
    { key: (o) => o.id },
  );
  assertEquals(byId({ id: 1, label: "one" }), "one");
  // A DIFFERENT object, same id — a raw Map key would have missed here, which
  // is how an app-level cache quietly never hits at all.
  assertEquals(byId({ id: 1, label: "changed" }), "one");
  assertEquals(computes, 1);

  // Unbounded is the other way an app cache goes wrong: a memo keyed on a
  // filter string grows once per keystroke, forever.
  let n = 0;
  const bounded = trackedMemo((k: number) => {
    n++;
    return k;
  }, { max: 2 });
  bounded(1);
  bounded(2);
  bounded(3); // evicts 1 (least recently used)
  assertEquals(n, 3);
  bounded(3);
  bounded(2);
  assertEquals(n, 3, "the two most recent are still cached");
  bounded(1);
  assertEquals(n, 4, "…and the evicted one recomputes");
});

// ── the symptom, end to end ─────────────────────────────────────────
//
// Two instances of ONE component, sharing ONE module-level cache. The first
// renders a miss and the second a hit — the exact frame the field report hit —
// and then the cell changes. With a plain cache the second panel is frozen;
// with trackedMemo both update.

const accounts = cell("tm-accounts", {
  state: { names: ["a"] as string[] },
  methods: {
    add(s: { names: string[] }, n: string) {
      s.names = [...s.names, n];
    },
  },
});

const plainCache = new Map<string, number>();
function plainCount(k: string): number {
  const hit = plainCache.get(k);
  if (hit !== undefined) return hit;
  const v = accounts.names.length;
  plainCache.set(k, v);
  return v;
}
const trackedCount = trackedMemo((_k: string) => accounts.names.length);

function Panels({ read }: { read: (k: string) => number }) {
  return (
    <div>
      <span t="first">{String(read("all"))}</span>
      <span t="second">{String(read("all"))}</span>
      <button t="add" onClick={() => accounts.add("x")}>+</button>
    </div>
  );
}

const PlainPanels = () => <Panels read={plainCount} />;
const TrackedPanels = () => <Panels read={trackedCount} />;

testUI(
  PlainPanels,
  "a plain cache: the hit path renders once and dies",
  async (ui) => {
    assertEquals(ui.first.text, "1");
    assertEquals(ui.second.text, "1");
    await ui.add.click();
    // Both spans live in ONE component, so this is not yet the two-instance
    // case — what it pins is the cache half: the cell moved, the cache did not,
    // and the DOM shows the stale value with no error anywhere.
    assertEquals(
      ui.first.text,
      "1",
      "right data in the cell, stale DOM — the failure with no symptom",
    );
  },
);

testUI(TrackedPanels, "trackedMemo: both reads stay live", async (ui) => {
  assertEquals(ui.first.text, "1");
  assertEquals(ui.second.text, "1");
  await ui.add.click();
  assertEquals(ui.first.text, "2");
  assertEquals(ui.second.text, "2", "the HIT is subscribed too — the point");
});

Deno.test("trackedMemo: a throwing compute leaves no scope behind", () => {
  // The tracking stack is a global; a memo that leaked a frame on the throw
  // path would make the NEXT component's reads land in a dead scope — one
  // component silently subscribing on another's behalf.
  const boom = trackedMemo((_k: string) => {
    throw new Error("nope");
  });
  const s = signal(1);
  let threw = false;
  try {
    boom("a");
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(readsOf(() => s.value).size, 1);
});

// ── the dev warning ─────────────────────────────────────────────────
//
// The existing zero-dep warning cannot see this bug: it fires on the RE-render
// path, and the dead instance never re-renders — that IS the symptom. A plain
// "0 deps on first render" warning would be noise (a static component
// legitimately reads nothing). What is not ambiguous is the SAME component
// function rendering with deps in one instance and none in another.

const rowCache = new Map<string, number>();
function cachedLen(k: string): number {
  const hit = rowCache.get(k);
  if (hit !== undefined) return hit;
  const v = accounts.names.length;
  rowCache.set(k, v);
  return v;
}

function Row({ id }: { id: string }) {
  return <span t={id}>{String(cachedLen("shared"))}</span>;
}
const TwoRows = () => (
  <div>
    <Row id="r1" />
    <Row id="r2" />
  </div>
);

// A static component reads zero signals in EVERY instance — the case that must
// stay silent, or the warning is noise and gets tuned away.
function Static({ id }: { id: string }) {
  return <span t={id}>static</span>;
}
const TwoStatics = () => (
  <div>
    <Static id="s1" />
    <Static id="s2" />
  </div>
);

/** Capture console.warn for the duration of `fn`. */
async function warnsDuring(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    seen.push(a.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return seen;
}

Deno.test("dev: the instance that lost its subscription is NAMED", async () => {
  const warns = await warnsDuring(async () => {
    await using ui = await testUI(TwoRows);
    assertEquals(ui.r1.text, "1");
    assertEquals(ui.r2.text, "1");
  });
  const hit = warns.find((w) => w.includes("<Row>"));
  assert(
    hit,
    `the cache-hit instance must be reported; got:\n${warns.join("\n")}`,
  );
  // Names the rule AND the fix, like every other error worth having.
  assert(hit.includes("never re-render"), hit);
  assert(hit.includes("trackedMemo"), hit);
});

Deno.test("dev: a component that reads nothing ANYWHERE stays silent", async () => {
  const warns = await warnsDuring(async () => {
    await using ui = await testUI(TwoStatics);
    assertEquals(ui.s1.text, "static");
  });
  assertEquals(
    warns.filter((w) => w.includes("<Static>")),
    [],
    "a static component is not a lost subscription — warning on it would be " +
      "noise, and noise is how a real warning gets skimmed past",
  );
});
