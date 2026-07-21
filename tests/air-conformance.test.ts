// air-conformance.test.ts — systematic torture suite for the AIR renderer.
// AIR is feature-frozen: every browser edge case is ours to guarantee. This
// suite fuzzes the parts field apps lean on hardest — keyed reconciliation,
// conditional churn, the signal graph, prop/text edges, boundaries, portals.
//
// Seeded-random: prints its seed; replay a failure with SEED=<n> deno test.
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { ErrorBoundary, Fragment, h, Portal } from "../src/air/vdom.ts";
import { Show } from "../src/air/show.ts";
import {
  batch,
  computed,
  effect,
  signal,
  untrack,
} from "../src/state/signal.ts";
import { onCleanup, onMount } from "../src/air/renderer-lifecycle.ts";
import { testComponent } from "../src/testing/test-component.ts";

// ── Seeded PRNG (mulberry32) ────────────────────────────────────────

const SEED = Number(Deno.env.get("SEED") ?? (Date.now() >>> 4) % 2 ** 31);
console.log(`[air-conformance] SEED=${SEED} — replay: SEED=${SEED} deno test`);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rnd: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const a = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = a;
  }
}

// ── Harness helpers ─────────────────────────────────────────────────

function harness() {
  const win = new Window({ url: "https://localhost" });
  return { win, doc: win.document as unknown as Document };
}

const tick = () => new Promise((r) => setTimeout(r, 3));

// ── 1. Keyed list reconciliation fuzz ───────────────────────────────

Deno.test("conformance: keyed list — 50 random rounds keep DOM order, count, and node identity", async () => {
  const rnd = mulberry32(SEED);
  const { win, doc } = harness();
  const items = signal<number[]>([0, 1, 2, 3, 4, 5, 6, 7]);
  const App = () =>
    h(
      "ul",
      { id: "r" },
      items.value.map((k) => h("li", { key: k, "data-k": String(k) }, `i${k}`)),
    );
  const t = testComponent(App, { document: doc });
  const ul = (doc as any).querySelector("#r");
  let nextKey = 100;

  for (let round = 0; round < 50; round++) {
    const cur = [...items.peek()];
    const op = Math.floor(rnd() * 4);
    if (op === 0) {
      shuffle(cur, rnd);
    } else if (op === 1 && cur.length < 24) {
      cur.splice(Math.floor(rnd() * (cur.length + 1)), 0, nextKey++);
    } else if (op === 2 && cur.length > 2) {
      cur.splice(Math.floor(rnd() * cur.length), 1);
    } else {
      // combined: remove one, insert one, then shuffle
      if (cur.length > 2) cur.splice(Math.floor(rnd() * cur.length), 1);
      cur.splice(Math.floor(rnd() * (cur.length + 1)), 0, nextKey++);
      shuffle(cur, rnd);
    }

    // Tag current DOM nodes by key to assert identity after the patch.
    const before = new Map<string, unknown>();
    for (const li of Array.from(ul.children) as any[]) {
      before.set(li.getAttribute("data-k"), li);
    }

    items.set(cur);
    await tick();

    const ctx = `round ${round} op ${op} (SEED=${SEED})`;
    const domKeys = (Array.from(ul.children) as any[]).map((li) =>
      li.getAttribute("data-k")
    );
    assertEquals(domKeys, cur.map(String), `${ctx}: DOM order matches data`);
    assertEquals(ul.children.length, cur.length, `${ctx}: no orphan elements`);
    // No stray non-element nodes accumulate between keyed children.
    const strays = (Array.from(ul.childNodes) as any[])
      .filter((n) => n.nodeType !== 1);
    assertEquals(strays.length, 0, `${ctx}: no stray text/comment nodes`);
    // Element identity preserved for keys that survived the mutation.
    for (const li of Array.from(ul.children) as any[]) {
      const k = li.getAttribute("data-k");
      const prev = before.get(k);
      if (prev !== undefined) {
        assert(prev === li, `${ctx}: node for stable key ${k} was recreated`);
      }
      assertEquals(li.textContent, `i${k}`, `${ctx}: content follows key`);
    }
  }
  t.unmount();
  win.happyDOM.close();
});

Deno.test("conformance: keyed list — duplicate keys don't crash, count stays consistent", async () => {
  const { win, doc } = harness();
  // Duplicate keys are an app bug, but the renderer must degrade gracefully:
  // right element count, no orphans, no throw.
  const items = signal<number[]>([1, 1, 2]);
  const App = () =>
    h(
      "ul",
      { id: "r" },
      items.value.map((k, i) =>
        h("li", { key: k, "data-i": String(i) }, `${k}`)
      ),
    );
  const t = testComponent(App, { document: doc });
  const ul = (doc as any).querySelector("#r");
  assertEquals(ul.children.length, 3);
  items.set([2, 1, 1]);
  await tick();
  assertEquals(ul.children.length, 3, "count preserved with duplicate keys");
  assertEquals(ul.textContent, "211");
  items.set([3, 3, 3, 3]);
  await tick();
  assertEquals(ul.children.length, 4);
  assertEquals(ul.textContent, "3333");
  t.unmount();
  win.happyDOM.close();
});

// ── 2. Conditional structure churn — lifecycle pairing ──────────────

Deno.test("conformance: conditional churn — onMount/onCleanup balance over 100 random flips", async () => {
  const rnd = mulberry32(SEED ^ 0x5f3759df);
  const { win, doc } = harness();
  const a = signal(true);
  const b = signal(false);
  const c = signal(0);
  let mounts = 0;
  let cleanups = 0;

  const Leaf = (p: { id: string }) => {
    onMount(() => mounts++);
    onCleanup(() => cleanups++);
    return h("i", { "data-leaf": p.id }, p.id);
  };
  const Nest = (p: { id: string }) => {
    onMount(() => mounts++);
    onCleanup(() => cleanups++);
    return h("b", null, h(Leaf, { id: p.id + ".inner" }));
  };
  const App = () =>
    h(
      "div",
      { id: "r" },
      h(Show, { when: a.value, fallback: h("u", null, "off") }, [
        h(Nest, { id: "A" }),
      ]),
      b.value ? h(Leaf, { id: "B" }) : null,
      c.value % 3 === 0
        ? h(Nest, { id: "C" })
        : c.value % 3 === 1
        ? h(Leaf, { id: "C1" })
        : null,
    );
  const t = testComponent(App, { document: doc });
  await tick();

  const expectAlive = () =>
    (a.peek() ? 2 : 0) + (b.peek() ? 1 : 0) +
    (c.peek() % 3 === 0 ? 2 : c.peek() % 3 === 1 ? 1 : 0);

  for (let i = 0; i < 100; i++) {
    const pick = Math.floor(rnd() * 3);
    if (pick === 0) a.set(!a.peek());
    else if (pick === 1) b.set(!b.peek());
    else c.set(c.peek() + 1);
    await tick();
    assertEquals(
      mounts - cleanups,
      expectAlive(),
      `flip ${i}: alive component count drifted (SEED=${SEED})`,
    );
  }
  t.unmount();
  assertEquals(
    mounts,
    cleanups,
    "after unmount every onMount has its onCleanup",
  );
  win.happyDOM.close();
});

// ── 3. Deep signal graphs ───────────────────────────────────────────

Deno.test("conformance: computed chain 20 deep — correct value, one recompute per node per change", () => {
  const src = signal(0);
  const DEPTH = 20;
  const counts = new Array<number>(DEPTH).fill(0);
  const chain: { value: number }[] = [];
  for (let i = 0; i < DEPTH; i++) {
    const prev = (i === 0 ? src : chain[i - 1]) as { value: number };
    const idx = i;
    chain.push(computed(() => {
      counts[idx] = (counts[idx] ?? 0) + 1;
      return prev.value + 1;
    }));
  }
  const tail = chain[DEPTH - 1] as { value: number };
  assertEquals(tail.value, DEPTH, "initial pull");
  assertEquals(
    counts,
    new Array(DEPTH).fill(1),
    "one compute each on first read",
  );

  for (let n = 1; n <= 10; n++) {
    src.set(n);
    assertEquals(tail.value, n + DEPTH);
    assertEquals(
      counts,
      new Array(DEPTH).fill(n + 1),
      `change ${n}: each node recomputed exactly once`,
    );
    // A second read must be fully cached — zero recomputes.
    assertEquals(tail.value, n + DEPTH);
    assertEquals(counts, new Array(DEPTH).fill(n + 1), "cached re-read");
  }
});

Deno.test("conformance: diamond a→(b,c)→d is glitch-free — d never sees mixed b/c", () => {
  const a = signal(1);
  const b = computed(() => a.value * 2);
  const c = computed(() => a.value * 3);
  let dComputes = 0;
  const d = computed(() => {
    dComputes++;
    return b.value + c.value;
  });

  let effectRuns = 0;
  let inconsistent = 0;
  const dispose = effect(() => {
    effectRuns++;
    // Glitch would surface as d != 5*a (one leg stale).
    if (d.value !== a.peek() * 5) inconsistent++;
  });
  assertEquals(effectRuns, 1);
  assertEquals(dComputes, 1);

  for (let n = 2; n <= 20; n++) a.set(n);
  assertEquals(inconsistent, 0, "no glitched read ever observed");
  assertEquals(effectRuns, 20, "one effect run per change — never two");
  assertEquals(dComputes, 20, "d recomputed exactly once per change");
  assertEquals(d.value, 100);
  dispose();
});

Deno.test("conformance: two diamonds stacked (a→b,c→d→e,f→g) stay consistent", () => {
  const a = signal(1);
  const b = computed(() => a.value + 1);
  const c = computed(() => a.value + 2);
  const d = computed(() => b.value + c.value); // 2a+3
  const e = computed(() => d.value * 2);
  const f = computed(() => d.value * 3);
  const g = computed(() => e.value + f.value); // 5d = 10a+15
  let bad = 0;
  const dispose = effect(() => {
    if (g.value !== 10 * a.peek() + 15) bad++;
  });
  for (let n = 2; n <= 15; n++) a.set(n);
  assertEquals(bad, 0, "nested diamond stays glitch-free");
  dispose();
});

// ── 4. Effect ordering, batch(), untrack() ──────────────────────────

Deno.test("conformance: batch — effects observe only final values, run once", () => {
  const x = signal(0);
  const y = signal(0);
  const seen: Array<[number, number]> = [];
  const dispose = effect(() => {
    seen.push([x.value, y.value]);
  });
  assertEquals(seen, [[0, 0]]);

  batch(() => {
    x.set(1);
    y.set(1);
    x.set(2);
    y.set(2);
    x.set(3);
    // Inside the batch nothing has run yet.
    assertEquals(seen.length, 1, "no effect runs inside batch()");
  });
  assertEquals(seen, [[0, 0], [3, 2]], "one run, final values only");

  // Nested batches flush once at the outermost close.
  batch(() => {
    x.set(10);
    batch(() => y.set(10));
    assertEquals(seen.length, 2, "inner batch close does not flush");
  });
  assertEquals(seen, [[0, 0], [3, 2], [10, 10]]);
  dispose();
});

Deno.test("conformance: untrack — reads inside untrack() do not subscribe", () => {
  const tracked = signal(0);
  const ignored = signal(0);
  let runs = 0;
  let lastSum = -1;
  const dispose = effect(() => {
    runs++;
    lastSum = tracked.value + untrack(() => ignored.value);
  });
  assertEquals(runs, 1);
  ignored.set(5);
  assertEquals(runs, 1, "untracked dep must not re-run the effect");
  tracked.set(1);
  assertEquals(runs, 2);
  assertEquals(lastSum, 6, "re-run picks up the untracked signal's latest");
  dispose();
});

// ── 5. Text / attribute / property edge cases ───────────────────────

Deno.test("conformance: falsy children — null/undefined/false skipped, 0 and '' are text", async () => {
  const { win, doc } = harness();
  const App = () =>
    h("div", { id: "r" }, null, undefined, false, true, 0, "", "x");
  const t = testComponent(App, { document: doc });
  const r = (doc as any).querySelector("#r");
  assertEquals(r.textContent, "0x");
  t.unmount();
  win.happyDOM.close();
  await tick();
});

Deno.test("conformance: dynamic child flipping through 0/''/null/false keeps position", async () => {
  const { win, doc } = harness();
  const v = signal<unknown>("a");
  const App = () =>
    h("div", { id: "r" }, h("b", null, "L"), v.value as any, h("b", null, "R"));
  const t = testComponent(App, { document: doc });
  const r = (doc as any).querySelector("#r");
  const seq: Array<[unknown, string]> = [
    [0, "L0R"],
    ["", "LR"],
    ["mid", "LmidR"],
    [null, "LR"],
    ["z", "LzR"],
    [false, "LR"],
    [7, "L7R"],
  ];
  for (const [val, want] of seq) {
    v.set(val);
    await tick();
    assertEquals(r.textContent, want, `child value ${String(val)}`);
  }
  t.unmount();
  win.happyDOM.close();
});

Deno.test("conformance: attribute edges — null/false removal, 0 and '' kept, boolean props", async () => {
  const { win, doc } = harness();
  const title = signal<unknown>("t1");
  const dis = signal(true);
  const tab = signal<unknown>(0);
  const App = () =>
    h(
      "div",
      { id: "r" },
      h("button", {
        id: "b",
        title: title.value as any,
        disabled: dis.value,
        tabindex: tab.value as any,
      }, "go"),
    );
  const t = testComponent(App, { document: doc });
  const b = (doc as any).querySelector("#b");
  assertEquals(b.getAttribute("title"), "t1");
  assertEquals(b.disabled, true, "disabled is a DOM property");
  assertEquals(b.getAttribute("tabindex"), "0", "0 is a real attr value");

  title.set(null);
  dis.set(false);
  tab.set(false);
  await tick();
  assertEquals(b.hasAttribute("title"), false, "null removes attr");
  assertEquals(b.disabled, false, "disabled=false clears the property");
  assertEquals(b.hasAttribute("tabindex"), false, "false removes attr");

  title.set("");
  await tick();
  assertEquals(b.getAttribute("title"), "", "empty string is a real value");
  t.unmount();
  win.happyDOM.close();
});

Deno.test("conformance: style flips object→string→object without stale properties", async () => {
  const { win, doc } = harness();
  const mode = signal(0);
  const App = () =>
    h("div", {
      id: "r",
      style: mode.value === 0
        ? { color: "red", fontSize: "10px" }
        : mode.value === 1
        ? "color: blue"
        : { fontWeight: "bold" },
    }, "s");
  const t = testComponent(App, { document: doc });
  const r = (doc as any).querySelector("#r");
  assertEquals(r.style.color, "red");
  assertEquals(r.style.fontSize, "10px");

  mode.set(1); // object → string
  await tick();
  assertEquals(r.style.color, "blue");
  assertEquals(r.style.fontSize, "", "object props cleared on string flip");

  mode.set(2); // string → object
  await tick();
  assertEquals(r.style.fontWeight, "bold");
  assertEquals(r.style.color, "", "string styles cleared on object flip");
  t.unmount();
  win.happyDOM.close();
});

Deno.test("conformance: svg elements get the SVG namespace, children inherit it", () => {
  const { win, doc } = harness();
  const App = () =>
    h(
      "svg",
      { id: "s", viewBox: "0 0 10 10" },
      h("circle", { id: "c", cx: "5", cy: "5", r: "4" }),
    );
  const t = testComponent(App, { document: doc });
  const svg = (doc as any).querySelector("#s");
  const circle = (doc as any).querySelector("#c");
  assertEquals(svg.namespaceURI, "http://www.w3.org/2000/svg");
  assertEquals(circle.namespaceURI, "http://www.w3.org/2000/svg");
  assertEquals(svg.getAttribute("viewBox"), "0 0 10 10", "case preserved");
  assertEquals(circle.getAttribute("cx"), "5");
  t.unmount();
  win.happyDOM.close();
});

// ── 6. Error boundaries ─────────────────────────────────────────────

Deno.test("conformance: ErrorBoundary catches a throw during INITIAL render, siblings survive", () => {
  const { win, doc } = harness();
  const Bomb = () => {
    throw new Error("boom-initial");
  };
  const App = () =>
    h(
      "div",
      { id: "r" },
      h("span", null, "before"),
      h(
        ErrorBoundary,
        { fallback: (e: Error) => h("i", { id: "f" }, e.message) },
        h(Bomb, null),
      ),
      h("span", null, "after"),
    );
  const t = testComponent(App, { document: doc });
  const r = (doc as any).querySelector("#r");
  assertEquals((doc as any).querySelector("#f").textContent, "boom-initial");
  assertEquals(r.textContent, "beforeboom-initialafter", "siblings intact");
  t.unmount();
  win.happyDOM.close();
});

Deno.test("conformance: ErrorBoundary catches a throw during UPDATE (via parent re-render), then recovers", async () => {
  const { win, doc } = harness();
  const boom = signal(false);
  // Prop-driven child: the throw happens while the PARENT's update diffs
  // through the boundary — the path _diffErrorBoundary owns.
  const Volatile = (p: { boom: boolean }) => {
    if (p.boom) throw new Error("boom-update");
    return h("em", { id: "ok" }, "ok");
  };
  const App = () =>
    h(
      "div",
      { id: "r" },
      h(
        ErrorBoundary,
        { fallback: (e: Error) => h("i", { id: "f" }, e.message) },
        h(Volatile, { boom: boom.value }),
      ),
      h("span", { id: "sib" }, `sib:${boom.value}`),
    );
  const t = testComponent(App, { document: doc });
  assertEquals((doc as any).querySelector("#ok").textContent, "ok");

  boom.set(true);
  await tick();
  assertEquals(
    (doc as any).querySelector("#f").textContent,
    "boom-update",
    "fallback shown after update throw",
  );
  assertEquals((doc as any).querySelector("#ok"), null);
  assertEquals(
    (doc as any).querySelector("#sib").textContent,
    "sib:true",
    "sibling outside the boundary keeps updating",
  );

  // Recovery: stop throwing — children render fresh.
  boom.set(false);
  await tick();
  assertEquals((doc as any).querySelector("#f"), null, "fallback removed");
  assertEquals((doc as any).querySelector("#ok").textContent, "ok");
  t.unmount();
  win.happyDOM.close();
});

Deno.test("conformance: component-LOCAL re-render throw keeps old output, siblings survive (AIO-138 pin)", async () => {
  const { win, doc } = harness();
  // Pinned design: when a component's OWN signal-triggered re-render throws,
  // the renderer keeps the previous output (renderer-rerender.ts, AIO-138) —
  // it does NOT bubble to an ErrorBoundary above (that catches the diff path
  // exercised in the previous test). This pin documents the fork so any
  // future unification is a conscious change.
  const boom = signal(false);
  const n = signal(0);
  const Volatile = () => {
    if (boom.value) throw new Error("boom-local");
    return h("em", { id: "ok" }, "ok");
  };
  const App = () =>
    h(
      "div",
      { id: "r" },
      h(
        ErrorBoundary,
        { fallback: (e: Error) => h("i", { id: "f" }, e.message) },
        h(Volatile, null),
      ),
      h("span", { id: "sib" }, `sib${n.value}`),
    );
  const t = testComponent(App, { document: doc });
  assertEquals((doc as any).querySelector("#ok").textContent, "ok");

  boom.set(true); // only Volatile subscribes — component-local re-render
  await tick();
  assertEquals(
    (doc as any).querySelector("#ok").textContent,
    "ok",
    "old output retained on local re-render throw",
  );
  n.set(1);
  await tick();
  assertEquals(
    (doc as any).querySelector("#sib").textContent,
    "sib1",
    "sibling keeps updating after the contained throw",
  );
  t.unmount();
  win.happyDOM.close();
});

// ── 7. Fragment / Portal reconciliation ─────────────────────────────

Deno.test("conformance: keyed fragments — 25 random shuffles keep multi-node groups intact", async () => {
  const rnd = mulberry32(SEED ^ 0x9e3779b9);
  const { win, doc } = harness();
  const order = signal([0, 1, 2, 3, 4]);
  const App = () =>
    h(
      "div",
      { id: "r" },
      order.value.map((i) =>
        h(Fragment, { key: i }, h("b", null, `${i}a`), h("i", null, `${i}b`))
      ),
    );
  const t = testComponent(App, { document: doc });
  const r = (doc as any).querySelector("#r");
  for (let round = 0; round < 25; round++) {
    const cur = [...order.peek()];
    shuffle(cur, rnd);
    order.set([...cur]);
    await tick();
    assertEquals(
      r.textContent,
      cur.map((i) => `${i}a${i}b`).join(""),
      `round ${round}: fragment pairs stay adjacent + ordered (SEED=${SEED})`,
    );
    assertEquals(r.children.length, cur.length * 2, "2 nodes per fragment");
  }
  t.unmount();
  win.happyDOM.close();
});

Deno.test("conformance: Portal — keyed children reconcile in the target, cleanup empties it", async () => {
  const { win, doc } = harness();
  const target = (doc as any).createElement("div");
  (doc as any).body.appendChild(target);
  const items = signal([1, 2, 3]);
  const show = signal(true);
  const App = () =>
    h(
      "div",
      { id: "r" },
      h("span", null, "main"),
      show.value
        ? h(
          Portal,
          { target },
          items.value.map((k) => h("p", { key: k }, `p${k}`)),
        )
        : null,
    );
  const t = testComponent(App, { document: doc });
  assertEquals(target.textContent, "p1p2p3");

  items.set([3, 1]);
  await tick();
  assertEquals(target.textContent, "p3p1", "keyed reorder inside portal");
  assertEquals(target.querySelectorAll("p").length, 2, "no orphans in target");

  show.set(false);
  await tick();
  assertEquals(
    target.querySelectorAll("p").length,
    0,
    "conditional unmount clears target",
  );

  show.set(true);
  await tick();
  assertEquals(target.textContent, "p3p1", "remount re-populates target");

  t.unmount();
  assertEquals(target.querySelectorAll("p").length, 0, "unmount clears target");
  win.happyDOM.close();
});
