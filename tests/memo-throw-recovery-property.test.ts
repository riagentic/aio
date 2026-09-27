// A memo that threw must not leave its reader deaf or holding another input's
// answer. `computed` has its own fuzz (signal-graph-recovery); this is every
// OTHER memo shape a component or effect can put a throwing derivation
// behind — `trackedMemo` (read from an effect and from a component),
// `useMemo`, `createSelector`, `useContextSelector` — driven by one random
// sequence of writes that crosses the throw boundary both ways. After every
// write each reader's last observation must equal the reference: the
// derivation of the input NOW, or "throw" when that throws.
//
//     FUZZ_SEED=7 deno test -A tests/memo-throw-recovery-property.test.ts
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  createContext,
  mount,
  useContextSelector,
} from "../src/air/aio-renderer.ts";
import { useMemo } from "../src/air/compat.ts";
import { effect, signal, trackedMemo } from "../src/state/signal.ts";
import { createSelector } from "../src/selector.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0x3e30) & 0x7fffffff;
const STEPS = fuzzEnvInt("FUZZ_STEPS", 400, 1);

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

/** The derivation every memo wraps: throws below zero. */
const f = (x: number): number => {
  if (x < 0) throw new Error("not ready");
  return x * 2;
};
const ref = (x: number): string => x < 0 ? "throw" : String(x * 2);
const attempt = (fn: () => number): string => {
  try {
    return String(fn());
  } catch {
    return "throw";
  }
};

Deno.test("memo throw recovery: every memo shape's reader equals the reference after every write", async () => {
  const rand = rng(SEED);
  const s = signal(1);
  const seen: Record<string, string> = {};

  // trackedMemo, read from an effect — the effect reads ONLY through it.
  const tm = trackedMemo((k: number) => f(s.value) + k * 0);
  const stopEffect = effect(() => {
    seen.tmEffect = attempt(() => tm(0));
  });

  // createSelector over a state object whose `a` is the input.
  const sel = createSelector((st: { a: number }) => st.a, (a: number) => f(a));

  // Components: trackedMemo (read only through the memo), useMemo keyed on
  // the input, useContextSelector over a provided value.
  const tmC = trackedMemo((k: number) => f(s.value) + k * 0);
  const TmC = () => h("b", null, attempt(() => tmC(0)));
  const UseMemoC = () => {
    const x = s.value;
    return h("i", null, attempt(() => useMemo(() => f(x), [x])));
  };
  const Ctx = createContext({ n: 1 });
  const SelC = () =>
    h("u", null, attempt(() => useContextSelector(Ctx, (v) => f(v.n))));
  const App = () =>
    h(
      "div",
      null,
      h(TmC, null),
      h(UseMemoC, null),
      h(Ctx.Provider, { value: { n: s.value } }, h(SelC, null)),
    );

  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc as never);
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const origErr = console.error;
  console.error = () => {}; // a throwing selector's effect logs; not the oracle
  const handle = mount(host, App);
  const bad: string[] = [];
  const history: number[] = [];
  try {
    for (let step = 0; step < STEPS && bad.length < 4; step++) {
      const x = [-2, -1, 0, 1, 2, 3][Math.floor(rand() * 6)]!;
      history.push(x);
      s.set(x);
      handle._flush();
      await Promise.resolve();
      handle._flush();
      const want = ref(x);
      const got = {
        tmEffect: seen.tmEffect,
        selector: attempt(() => sel({ a: x })),
        tmComponent: host.querySelector("b")?.textContent,
        useMemo: host.querySelector("i")?.textContent,
        contextSelector: host.querySelector("u")?.textContent,
      };
      for (const [k, v] of Object.entries(got)) {
        if (v !== want) {
          bad.push(
            `FUZZ_SEED=${SEED} step ${step}: ${k}="${v}" want "${want}" (writes ${
              history.slice(-6)
            })`,
          );
        }
      }
    }
  } finally {
    console.error = origErr;
    stopEffect();
    _unmount(handle);
    await closeWindow(win);
  }
  assertEquals(bad, []);
});
