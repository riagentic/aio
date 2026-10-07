// Mount-level lifecycle differential: the REAL renderer (mount / hydrate, with
// components that re-render on their own signals) against a fresh mount of the
// same model — and, beside the document, the state a document cannot show.
//
// `renderer-differential.test.ts` drives `_diff` directly, so it never meets
// an OUT-OF-BAND re-render: a component re-rendering on its own signal hands
// the SAME `children` vnodes to a new output. That is where a whole class
// lived that no markup oracle sees at the moment it happens — a component
// unmounted (its `onUnmount` run, its effects dead) while it stays on screen, a
// signal child frozen, a portal region left behind in its target, bare text
// left on the page after its region was removed, a sibling added past the
// region's end because an ancestor trusted a stale copy of its first node.
//
// Oracles, after EVERY step:
//   · the host and every portal target equal a fresh mount of the same model
//     and the same signal state;
//   · the live component instances (onMount minus onUnmount, per instance)
//     are exactly the components the model says are mounted — none twice,
//     none missing;
//   · so are the instances that HOLD something (body ran, onUnmount has not):
//     an instance thrown away before it mounted is released, not leaked;
//   · each instance's hooks come in order — onMount at most once, onUnmount
//     exactly once and last, no afterRender for an instance already gone;
//   · no dev desync tripwire fired;
// and after unmount: no instance, no portal content, no signal subscriber.
//
//     for s in 1 2 3 4 5; do FUZZ_SEED=$s deno test -A \
//       tests/air-lifecycle-differential.test.ts; done
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  ErrorBoundary,
  Fragment,
  h,
  Portal,
  renderToString,
} from "../src/air/vdom.ts";
import type { ComponentFn, VNode } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  afterRender,
  mount,
  onMount,
  onUnmount,
  setDevMode,
  useRef,
} from "../src/air/aio-renderer.ts";
import { hydrate } from "../src/air/renderer-hydrate.ts";
import { type Signal, signal } from "../src/state/signal.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

// Fixed by default — a red CI run must be reproducible from its own commit.
const SEED = fuzzEnvInt("FUZZ_SEED", 0x1ec7c1e) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 200, 1);
const STEPS = fuzzEnvInt("FUZZ_STEPS", 10, 1);

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

type Spec =
  | { k: "t"; id: number; v: string }
  | { k: "g"; id: number; si: number } // a signal child
  | { k: "e"; id: number; tag: string; km: boolean; kids: Spec[] }
  | { k: "c"; id: number; km: boolean; kids: Spec[] } // a self-rerendering C
  | { k: "f"; id: number; km: boolean; kids: Spec[] }
  | { k: "b"; id: number; km: boolean; kids: Spec[] } // ErrorBoundary
  | { k: "p"; id: number; kids: Spec[] }; // Portal, own target per id
type Container = Extract<Spec, { kids: Spec[] }>;

const GS: Signal<unknown>[] = [signal("g0"), signal("g1")];
const SIG = new Map<number, Signal<number>>();
const sig = (id: number) => {
  let s = SIG.get(id);
  if (!s) {
    s = signal(0);
    SIG.set(id, s);
  }
  return s;
};

/** Live instances of the WORLD under test (the reference mount records none).
 *  Keyed by instance, labelled with the spec id it currently renders — a
 *  component instance is positional, so it may be re-labelled by a diff. */
type Inst = { sid: number; mounted: boolean; gone: boolean };
const LIVE = new Set<Inst>();
/** Body ran, `onUnmount` has not: what `useRef(queue.take(id))` would hold.
 *  An instance may leave this set without ever entering LIVE — a hydration
 *  that fell back threw it away before any commit, and `onUnmount` is the
 *  release that still runs (docs/ui/air-lifecycle.md). */
const HELD = new Set<Inst>();
/** Hooks out of order, as `<spec id>: <what>`. */
const BROKEN: string[] = [];
let TRACK = true;

// deno-lint-ignore no-explicit-any
type P = any;
/** The shapes a component's OWN signal switches between — each one hands the
 *  same `children` to a different place: an element, a fragment, nowhere
 *  (two ways), and one level deeper inside an element. */
const C: ComponentFn = (p: P) => {
  const track = TRACK;
  const id = p.sid as number;
  const me = useRef<Inst>({ sid: 0, mounted: false, gone: false }).current;
  me.sid = id;
  if (track) {
    if (me.gone) BROKEN.push(id + ": rendered after onUnmount");
    else HELD.add(me);
  }
  onMount(() => {
    if (!track) return;
    if (me.gone) BROKEN.push(id + ": onMount after onUnmount");
    if (me.mounted) BROKEN.push(id + ": onMount twice");
    me.mounted = true;
    LIVE.add(me);
  });
  onUnmount(() => {
    if (!track) return;
    if (me.gone) BROKEN.push(id + ": onUnmount twice");
    me.gone = true;
    LIVE.delete(me);
    HELD.delete(me);
  });
  afterRender(() => {
    if (track && me.gone) BROKEN.push(id + ": afterRender after onUnmount");
  });
  const kids = (p.children ?? []) as VNode[];
  switch (sig(id).value % 5) {
    case 0:
      return h("div", { class: "c" + id }, ...kids);
    case 1:
      return h(Fragment, null, ...kids);
    case 2:
      return h("span", null, "t" + id);
    case 3:
      return null;
    default:
      return h(Fragment, null, "x", h("em", null, ...kids));
  }
};
const rendersKids = (id: number) => [0, 1, 4].includes(sig(id).value % 5);

/** Every boundary's LAST child: throws while the boundary's own signal is
 *  odd. Last, so every sibling before it has run by then — the boundary
 *  discards them all, at mount (never committed) or on an update (live). What
 *  a discarded instance may still be handed is the per-instance order oracle
 *  in `C`; the thrower's own `afterRender` has no commit to run after.
 *
 *  Told by a PROP, read by nobody: a component that throws on its OWN
 *  re-render is contained in place (its siblings stay, AIO-138), which a
 *  fresh mount of the same model cannot show. The model re-renders instead. */
const X: ComponentFn = (p: P) => {
  const track = TRACK;
  const id = p.sid as number;
  if (!p.boom) return null;
  afterRender(() => {
    if (track) BROKEN.push(id + ": afterRender of a body that threw");
  });
  throw new Error("x" + id);
};
const caught = (id: number) => sig(id).peek() % 2 === 1;

type World = { doc: Document; targets: Map<number, Element> };
let W: World;
const targetOf = (id: number) => {
  let t = W.targets.get(id);
  if (!t) {
    t = W.doc.createElement("aside") as unknown as Element;
    W.targets.set(id, t);
  }
  return t;
};
const snapTargets = (m: Map<number, Element>) =>
  [...m].filter(([, t]) => t.innerHTML !== "").sort((a, b) => a[0] - b[0])
    .map(([k, t]) => `${k}:${t.innerHTML}`).join(" | ");

function build(s: Spec, key?: string): VNode | string {
  const kp = key !== undefined ? { key } : {};
  const kids = "kids" in s
    ? s.kids.map((c) =>
      build(c, "km" in s && s.km ? "k" + c.id : undefined) as VNode
    )
    : [];
  switch (s.k) {
    case "t":
      return s.v;
    case "g":
      return GS[s.si] as unknown as VNode;
    case "e":
      return h(s.tag, kp, ...kids);
    case "c":
      return h(C, { ...kp, sid: s.id }, ...kids);
    case "f":
      return h(Fragment, key !== undefined ? kp : null, ...kids);
    case "b":
      return h(
        ErrorBoundary as never,
        { ...kp, fallback: () => "!" },
        ...kids,
        h(X, { sid: s.id, boom: caught(s.id) }),
      );
    case "p":
      return h(Portal as never, { ...kp, target: targetOf(s.id) }, ...kids);
  }
}

/** Which components the model says are mounted, by spec id. */
function expectedLive(s: Spec, on = true, out = new Map<number, number>()) {
  if (s.k === "c" && on) out.set(s.id, 1);
  if ("kids" in s) {
    const childOn = on && (s.k !== "c" || rendersKids(s.id)) &&
      !(s.k === "b" && caught(s.id));
    for (const k of s.kids) expectedLive(k, childOn, out);
  }
  return out;
}
const liveMap = (set = LIVE) => {
  const m = new Map<number, number>();
  for (const x of set) m.set(x.sid, (m.get(x.sid) ?? 0) + 1);
  return m;
};
const sorted = (m: Map<number, number>) =>
  JSON.stringify([...m].sort((a, b) => a[0] - b[0]));

const all = (s: Spec, out: Spec[] = []): Spec[] => {
  out.push(s);
  if ("kids" in s) { for (const k of s.kids) all(k, out); }
  return out;
};
const clone = (s: Spec): Spec =>
  ("kids" in s ? { ...s, kids: s.kids.map(clone) } : { ...s }) as Spec;

/** `data-component` is an opt-in dev stamp (`setDevMode(true)`), written on
 *  mount and not on a self re-render's new root — a debugging aid, not part of
 *  the document either world is asked to agree on. */
const strip = (s: string) => s.replace(/ data-component="[^"]*"/g, "");
const TRIPWIRE =
  /desync|aio bug|holds the wrong node|ran out of DOM|diffed against|stay on the page/;

async function run(mode: "mount" | "hydrate") {
  const rand = rng(SEED + (mode === "hydrate" ? 1 : 0));
  const pick = (n: number) => Math.floor(rand() * n);
  let nextId = 1;
  const gen = (d: number): Spec => {
    const r = pick(10);
    if (d <= 0 || r < 3) {
      return rand() < 0.3
        ? { k: "g", id: nextId++, si: pick(GS.length) }
        : { k: "t", id: nextId++, v: ["a", "b", " "][pick(3)]! };
    }
    const kids = Array.from({ length: pick(4) }, () => gen(d - 1));
    if (r < 6) return { k: "c", id: nextId++, km: rand() < 0.4, kids };
    if (r < 7) return { k: "f", id: nextId++, km: rand() < 0.4, kids };
    if (r < 8) return { k: "b", id: nextId++, km: rand() < 0.4, kids };
    if (r < 9) return { k: "p", id: nextId++, kids };
    // `section`, not `p`: a `<p>` is CLOSED by a `<div>` or `<p>` inside it
    // when the SSR string is parsed (in a browser, and in happy-dom since 20;
    // 17 kept the nesting), so those models are markup no DOM can hold — a
    // hydrate mismatch by construction, pinned on its own in
    // tests/hydrate-parser-restructured.test.ts.
    const tag = ["section", "i"][pick(2)]!;
    return { k: "e", id: nextId++, tag, km: rand() < 0.4, kids };
  };
  const mutate = (root: Spec) => {
    const cs = all(root).filter((s) => "kids" in s) as Container[];
    const c = cs[pick(cs.length)]!;
    switch (pick(8)) {
      case 0: // swap two siblings
        if (c.kids.length > 1) {
          const i = pick(c.kids.length), j = pick(c.kids.length);
          [c.kids[i], c.kids[j]] = [c.kids[j]!, c.kids[i]!];
        }
        break;
      case 1: // insert
        c.kids.splice(pick(c.kids.length + 1), 0, gen(2));
        break;
      case 2: // remove
        if (c.kids.length) c.kids.splice(pick(c.kids.length), 1);
        break;
      case 3: // re-key
        if ("km" in c) c.km = !c.km;
        break;
      case 4: // wrap a child in a component
        if (c.kids.length) {
          const i = pick(c.kids.length);
          c.kids[i] = { k: "c", id: nextId++, km: false, kids: [c.kids[i]!] };
        }
        break;
      case 5: // reverse
        c.kids.reverse();
        break;
      case 6: // wrap a child in a fragment
        if (c.kids.length) {
          const i = pick(c.kids.length);
          c.kids[i] = { k: "f", id: nextId++, km: false, kids: [c.kids[i]!] };
        }
        break;
      default: // empty it
        c.kids = [];
    }
  };

  const MODEL = signal<Spec | null>(null);
  const App: ComponentFn = () =>
    h(
      "main",
      null,
      h("header", null, "h"),
      MODEL.value ? build(MODEL.value) : null,
      h("footer", null, "f"),
    );

  const warns: string[] = [];
  const origWarn = console.warn, origErr = console.error;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  let checks = 0, selfRenders = 0, hydrated = 0, broken = 0;
  setDevMode(true);
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const win = new Window({ url: "http://localhost/" });
      const doc = win.document as unknown as Document;
      _setDocument(doc as never);
      doc.body.innerHTML = `<div id="a"></div><div id="b"></div>`;
      W = { doc, targets: new Map() };
      LIVE.clear();
      HELD.clear();
      BROKEN.length = 0;
      SIG.clear();
      GS.forEach((g, i) => g.set("g" + i));
      warns.length = 0;
      nextId = 1;
      let spec: Spec = {
        k: "f",
        id: nextId++,
        km: false,
        kids: [gen(3), gen(3), gen(2)],
      };
      const history: unknown[] = [clone(spec)];
      MODEL.set(clone(spec));
      const host = doc.getElementById("a")!;
      let hA: ReturnType<typeof mount>;
      if (mode === "hydrate") {
        for (const x of all(spec)) {
          if (x.k === "c" && rand() < 0.5) sig(x.id).set(pick(5));
          if (x.k === "b" && rand() < 0.3) sig(x.id).set(1);
        }
        TRACK = false;
        host.innerHTML = renderToString(h(App, null));
        TRACK = true;
        // One round in four hydrates against markup that is NOT the model's:
        // an element anywhere in it becomes a `<u>`, a tag no model writes.
        // Every component before it in document order has run by the time the
        // walk gets there, so the fallback discards anything from none of
        // them (`<main>`) to all of them (`<footer>`).
        const breakIt = rand() < 0.25;
        if (breakIt) {
          const els = [...host.querySelectorAll("*")];
          els[pick(els.length)]!.replaceWith(doc.createElement("u"));
          broken++;
        }
        // By identity, not by the dev warning: `_devWarn` says it once a
        // process, so the warning counted every round after the first as
        // hydrated.
        const server = host.firstChild;
        hA = hydrate(host, App);
        const adopted = host.firstChild === server;
        assertEquals(
          adopted,
          !breakIt,
          `FUZZ_SEED=${SEED} round ${round}: ` +
            (breakIt
              ? "markup that does not match was adopted"
              : "the model's own markup was discarded") +
            `\n  model: ${JSON.stringify(history[0])}`,
        );
        if (adopted) hydrated++;
      } else {
        hA = mount(host, App);
      }
      hA._flush();
      const repro = (step: number, why: string) =>
        `FUZZ_SEED=${SEED} (${mode}) round ${round} step ${step}: ${why}\n` +
        `  history: ${JSON.stringify(history)}`;
      try {
        for (let step = 0; step < STEPS; step++) {
          const roll = rand();
          if (roll < 0.5) {
            spec = clone(spec);
            mutate(spec);
            history.push(clone(spec));
            MODEL.set(clone(spec));
          } else if (roll < 0.65) {
            const g = GS[pick(GS.length)]!;
            g.set(["", "q", "g" + pick(9)][pick(3)]);
            history.push(`gs=${GS.map((x) => x.value)}`);
          } else {
            const cs = all(spec).filter((s) => s.k === "c" || s.k === "b");
            if (cs.length) {
              const c = cs[pick(cs.length)]!;
              const s = sig(c.id);
              s.set(s.value + 1 + pick(4));
              if (c.k === "b") MODEL.set(clone(spec)); // see `X`
              selfRenders++;
              history.push(
                `sigs=${[...SIG].map(([k, v]) => k + ":" + v.value)}`,
              );
            }
          }
          hA._flush();
          await Promise.resolve();
          hA._flush();

          const got = strip(host.innerHTML + " || " + snapTargets(W.targets));
          // The reference: a fresh mount of the same model + signal state,
          // with its own portal targets, recording no instances.
          const liveTargets = W.targets;
          W = { doc, targets: new Map() };
          TRACK = false;
          const bEl = doc.getElementById("b")!;
          const hB = mount(bEl, App);
          hB._flush();
          const want = strip(bEl.innerHTML + " || " + snapTargets(W.targets));
          _unmount(hB);
          const refLeft = snapTargets(W.targets);
          W = { doc, targets: liveTargets };
          TRACK = true;

          assertEquals(
            got,
            want,
            repro(step, "incremental world ≠ fresh mount"),
          );
          assertEquals(
            refLeft,
            "",
            repro(step, "a fresh mount left portal content after unmount"),
          );
          assertEquals(
            sorted(liveMap()),
            sorted(expectedLive(spec)),
            repro(
              step,
              "the live component instances are not the model's mounted " +
                "components — one was unmounted while on screen, or never " +
                "unmounted when it left",
            ),
          );
          assertEquals(
            sorted(liveMap(HELD)),
            sorted(expectedLive(spec)),
            repro(
              step,
              "an instance that is not on the page was never released " +
                "(its body ran; its onUnmount did not)",
            ),
          );
          assertEquals(
            BROKEN,
            [],
            repro(step, "an instance's hooks ran out of order"),
          );
          assertEquals(
            warns.filter((w) => TRIPWIRE.test(w)),
            [],
            repro(step, "a dev tripwire fired on a correct render"),
          );
          checks++;
        }
      } finally {
        _unmount(hA);
      }
      assertEquals(
        sorted(liveMap()) + sorted(liveMap(HELD)),
        "[][]",
        repro(99, "instances outlived unmount"),
      );
      assertEquals(BROKEN, [], repro(99, "hooks out of order at unmount"));
      assertEquals(
        snapTargets(W.targets),
        "",
        repro(99, "portal content outlived unmount"),
      );
      assertEquals(
        GS.map((g) =>
          (g as unknown as { _subscribers: Set<unknown> })._subscribers.size
        ),
        [0, 0],
        repro(99, "a signal child's subscription outlived unmount"),
      );
      await closeWindow(win);
    }
  } finally {
    console.warn = origWarn;
    console.error = origErr;
    setDevMode(false);
  }
  return { checks, selfRenders, hydrated, broken };
}

Deno.test("lifecycle differential: mount + self re-renders keep the document, the instances and the subscriptions true", async () => {
  const r = await run("mount");
  assertEquals(r.checks, ROUNDS * STEPS, "a step was skipped");
  assert(
    r.selfRenders > ROUNDS,
    `only ${r.selfRenders} self re-renders — the out-of-band path is not exercised`,
  );
});

Deno.test("lifecycle differential: the same through SSR + hydrate", async () => {
  const r = await run("hydrate");
  assertEquals(r.checks, ROUNDS * STEPS, "a step was skipped");
  assertEquals(r.hydrated + r.broken, ROUNDS);
  assert(
    r.broken >= ROUNDS / 8 && r.hydrated > ROUNDS / 2,
    `${r.hydrated} adopted, ${r.broken} fell back of ${ROUNDS} — one of the ` +
      `two hydrate paths is not exercised`,
  );
});
