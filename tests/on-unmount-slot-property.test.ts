// `onUnmount` takes a state slot (matched by CALL ORDER) so a body that
// renders N times registers once. A slot is therefore a thing one call site
// can take from another: a conditional `onUnmount`, or one whose neighbour
// is conditional, lands on a slot another call site filled. The property:
// for a random body of `onUnmount` / `useRef` call sites, each maybe behind a
// condition, over a random sequence of re-renders, EITHER every hold taken is
// released exactly once at unmount and every ref reads back its own value,
// OR the renderer said so (a throw, or a message naming the cause). Silent
// theft — a hold never released, released twice, or released as another
// site's — is the one outcome that may not happen.
//
//     FUZZ_SEED=7 deno test -A tests/on-unmount-slot-property.test.ts
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { onUnmount, useRef } from "../src/air/renderer-lifecycle.ts";
import { signal } from "../src/state/signal.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0x51077) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 300, 1);

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

/** A call site: an `onUnmount` or a `useRef`, called when `bit` of the
 *  render's value is set (`bit` -1: always). */
type Site = { k: "u" | "r"; bit: number };

/** One distinct SOURCE LOCATION per call site, as in a real body: `U[i]` is
 *  the `onUnmount(…)` written on line i. (A loop over one line is one site,
 *  and a loop whose length changes moves the hook count — that tripwire's
 *  case, not this one's.) */
const U: ((fn: () => void) => void)[] = [
  (fn) => onUnmount(fn),
  (fn) => onUnmount(fn),
  (fn) => onUnmount(fn),
  (fn) => onUnmount(fn),
  (fn) => onUnmount(fn),
];

const LOUD = /onUnmount|state hooks|another hook/;

Deno.test("onUnmount slots: a hold is released exactly once, as its own site — or the renderer says why not", async () => {
  const rand = rng(SEED);
  const pick = (n: number) => Math.floor(rand() * n);
  const logs: string[] = [];
  const origWarn = console.warn, origErr = console.error;
  console.warn = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  setDevMode(true);
  let silent = 0, clean = 0;
  const bad: string[] = [];
  try {
    for (let round = 0; round < ROUNDS && bad.length < 4; round++) {
      const sites: Site[] = Array.from(
        { length: 2 + pick(4) },
        () => ({
          k: rand() < 0.6 ? "u" : "r",
          bit: rand() < 0.5 ? -1 : pick(3),
        }),
      );
      const values = Array.from({ length: 1 + pick(5) }, () => pick(8));
      const v = signal(values[0]!);
      const held = new Set<number>();
      const released: number[] = [];
      let wrongRef = false;
      let threw = false;
      const Body = () => {
        const x = v.value;
        sites.forEach((s, i) => {
          if (s.bit >= 0 && !(x >> s.bit & 1)) return;
          if (s.k === "u") {
            held.add(i);
            U[i]!(() => released.push(i));
          } else {
            const r = useRef<string>("r" + i);
            if (r.current !== "r" + i) wrongRef = true;
          }
        });
        return h("i", null, String(x));
      };
      const win = new Window({ url: "http://localhost/" });
      const doc = win.document as unknown as Document;
      _setDocument(doc as never);
      const host = doc.createElement("div");
      doc.body.appendChild(host);
      logs.length = 0;
      const handle = mount(host, Body);
      try {
        handle._flush();
        for (const x of values.slice(1)) {
          v.set(x);
          try {
            handle._flush();
          } catch {
            threw = true;
          }
          await Promise.resolve();
        }
      } finally {
        try {
          _unmount(handle);
        } catch {
          threw = true;
        }
        await closeWindow(win);
      }
      const want = [...held].sort((a, b) => a - b);
      const got = [...released].sort((a, b) => a - b);
      const ok = !wrongRef && JSON.stringify(want) === JSON.stringify(got);
      if (ok) {
        clean++;
        continue;
      }
      if (threw || logs.some((l) => LOUD.test(l))) continue;
      silent++;
      bad.push(
        `FUZZ_SEED=${SEED} round ${round}: sites=${
          JSON.stringify(sites)
        } values=${values} held=${want} released=${got} wrongRef=${wrongRef}`,
      );
    }
  } finally {
    console.warn = origWarn;
    console.error = origErr;
    setDevMode(false);
  }
  assertEquals(bad, [], `${silent} silent slot thefts`);
  if (clean < ROUNDS / 4) throw new Error(`only ${clean} clean rounds`);
});
