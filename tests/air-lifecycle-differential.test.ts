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
//     none missing, no instance unmounted twice;
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
type Inst = { sid: number; n: number };
const LIVE = new Set<Inst>();
const DOUBLE: number[] = [];
let TRACK = true;

// deno-lint-ignore no-explicit-any
type P = any;
/** The shapes a component's OWN signal switches between — each one hands the
 *  same `children` to a different place: an element, a fragment, nowhere
 *  (two ways), and one level deeper inside an element. */
const C: ComponentFn = (p: P) => {
  const track = TRACK;
  const id = p.sid as number;
  const r = useRef<Inst>({ sid: 0, n: 0 });
  r.current.sid = id;
  onMount(() => {
    if (!track) return;
    r.current.n++;
    LIVE.add(r.current);
  });
  onUnmount(() => {
    if (!track) return;
    if (--r.current.n < 0) DOUBLE.push(id);
    LIVE.delete(r.current);
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
      return h(ErrorBoundary as never, { ...kp, fallback: () => "!" }, ...kids);
    case "p":
      return h(Portal as never, { ...kp, target: targetOf(s.id) }, ...kids);
  }
}

/** Which components the model says are mounted, by spec id. */
function expectedLive(s: Spec, on = true, out = new Map<number, number>()) {
  if (s.k === "c" && on) out.set(s.id, 1);
  if ("kids" in s) {
    const childOn = on && (s.k !== "c" || rendersKids(s.id));
    for (const k of s.kids) expectedLive(k, childOn, out);
  }
  return out;
}
const liveMap = () => {
  const m = new Map<number, number>();
  for (const x of LIVE) m.set(x.sid, (m.get(x.sid) ?? 0) + 1);
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
    const tag = ["p", "i"][pick(2)]!;
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
  let checks = 0, selfRenders = 0, hydrated = 0;
  setDevMode(true);
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const win = new Window({ url: "http://localhost/" });
      const doc = win.document as unknown as Document;
      _setDocument(doc as never);
      doc.body.innerHTML = `<div id="a"></div><div id="b"></div>`;
      W = { doc, targets: new Map() };
      LIVE.clear();
      DOUBLE.length = 0;
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
        }
        TRACK = false;
        host.innerHTML = renderToString(h(App, null));
        TRACK = true;
        hA = hydrate(host, App);
        if (!warns.some((w) => /hydrate\(\) found DOM/.test(w))) hydrated++;
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
            const cs = all(spec).filter((s) => s.k === "c");
            if (cs.length) {
              const s = sig(cs[pick(cs.length)]!.id);
              s.set(s.value + 1 + pick(4));
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
            DOUBLE,
            [],
            repro(step, "an instance was unmounted twice"),
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
        sorted(liveMap()),
        "[]",
        repro(99, "instances outlived unmount"),
      );
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
  return { checks, selfRenders, hydrated };
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
  assert(
    r.hydrated > ROUNDS * 0.8,
    `only ${r.hydrated}/${ROUNDS} rounds hydrated without falling back`,
  );
});
