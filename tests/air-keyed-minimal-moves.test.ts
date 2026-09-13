// Keyed reorder moves ONLY the rows that are out of order.
//
// The keyed diff placed every child right after the previous one, which is
// correct but re-inserted every row in front of a displaced one: moving the
// first row to the end re-inserted the other N-1. A re-inserted node loses
// focus, selection and a running CSS transition — in real Chromium an input
// being typed into in a reordered list dropped the caret. The fix leaves the
// rows whose old order already agrees with the new order (a longest increasing
// subsequence) where they are.
//
// Randomized differential, two properties after EVERY step:
//   1. the incrementally diffed DOM equals a fresh mount of the same model;
//   2. the number of distinct surviving rows whose node was re-inserted is at
//      most `survivors − LIS(old positions)` — the optimum. The LIS here is an
//      independent O(n²) DP, not the renderer's.
// Rows are 1-node elements, 2-node fragments, and components rendering either
// (plus a tag swap), so multi-node spans are exercised; odd rounds interleave
// non-keyed siblings.

import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { Fragment, h } from "../src/air/vdom.ts";
import type { ComponentFn, VNode } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _longestIncreasing } from "../src/air/vdom-diff-children.ts";
import { signal } from "../src/state/signal.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0x1157ab1e) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 120, 1);
const STEPS = fuzzEnvInt("FUZZ_STEPS", 8, 1);

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

type Row = { k: number; shape: 0 | 1 | 2 | 3; v: number };

const Comp = (p: { r: Row }) =>
  p.r.shape === 2 ? h("p", { "data-k": p.r.k }, `c${p.r.k}.${p.r.v}`) : h(
    Fragment,
    null,
    h("b", { "data-k": p.r.k }, `f${p.r.k}`),
    h("i", { "data-k": p.r.k }, String(p.r.v)),
  );

function rowVNode(r: Row): VNode {
  switch (r.shape) {
    case 0:
      return h("li", { key: r.k, "data-k": r.k }, `e${r.k}.${r.v}`);
    case 1:
      return h(
        Fragment,
        { key: r.k },
        h("b", { "data-k": r.k }, `f${r.k}`),
        h("i", { "data-k": r.k }, String(r.v)),
      );
    default:
      return h(Comp as unknown as ComponentFn, { key: r.k, r });
  }
}

function lisLen(seq: number[]): number {
  const best = seq.map(() => 1);
  let max = 0;
  for (let i = 0; i < seq.length; i++) {
    for (let j = 0; j < i; j++) {
      if (seq[j]! < seq[i]! && best[j]! + 1 > best[i]!) best[i] = best[j]! + 1;
    }
    max = Math.max(max, best[i]!);
  }
  return max;
}

function mutate(rows: Row[], rand: () => number, nextKey: () => number): Row[] {
  let out = rows.map((r) => ({ ...r }));
  const op = Math.floor(rand() * 6);
  if (op === 0) { // shuffle
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
  } else if (op === 1 && out.length) { // move one
    const [x] = out.splice(Math.floor(rand() * out.length), 1);
    out.splice(Math.floor(rand() * (out.length + 1)), 0, x!);
  } else if (op === 2) { // reverse
    out.reverse();
  } else if (op === 3) { // swap two
    if (out.length > 1) {
      const a = Math.floor(rand() * out.length);
      const b = Math.floor(rand() * out.length);
      [out[a], out[b]] = [out[b]!, out[a]!];
    }
  }
  // inserts / removals / value + shape changes, on top of any op
  if (rand() < 0.5) {
    out = out.filter(() => rand() > 0.15);
  }
  const inserts = Math.floor(rand() * 3);
  for (let i = 0; i < inserts; i++) {
    out.splice(Math.floor(rand() * (out.length + 1)), 0, {
      k: nextKey(),
      shape: Math.floor(rand() * 4) as Row["shape"],
      v: 0,
    });
  }
  for (const r of out) {
    if (rand() < 0.2) r.v++;
    // A component switching between its element and fragment output.
    if (r.shape >= 2 && rand() < 0.1) r.shape = r.shape === 2 ? 3 : 2;
  }
  return out;
}

Deno.test("_longestIncreasing: returns a strictly increasing subsequence of maximal length", () => {
  const rand = rng(SEED ^ 0x55);
  for (let t = 0; t < 300; t++) {
    const seq = Array.from(
      { length: Math.floor(rand() * 12) },
      () => Math.floor(rand() * 14) - 2, // some -1/-2 entries are skipped
    );
    const picked = [..._longestIncreasing(seq)].sort((a, b) => a - b);
    for (const i of picked) assert(seq[i]! >= 0, `picked a skipped entry`);
    for (let i = 1; i < picked.length; i++) {
      assert(seq[picked[i - 1]!]! < seq[picked[i]!]!, `not increasing`);
    }
    assertEquals(
      picked.length,
      lisLen(seq.filter((v) => v >= 0)),
      JSON.stringify(seq),
    );
  }
});

Deno.test("keyed diff: DOM equals a fresh render, and only out-of-order rows are re-inserted", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const rand = rng(SEED);
  let key = 0;
  const nextKey = () => ++key;
  try {
    for (let round = 0; round < ROUNDS; round++) {
      let rows: Row[] = Array.from({ length: Math.floor(rand() * 8) }, () => ({
        k: nextKey(),
        shape: Math.floor(rand() * 4) as Row["shape"],
        v: 0,
      }));
      const model = signal(rows);
      // Odd rounds mix non-keyed siblings (text, an element) between the keyed
      // rows — positional matching runs through the same placement loop.
      const mixed = round % 2 === 1;
      const App = () =>
        h(
          "ul",
          null,
          ...(mixed
            ? [
              "head",
              ...model.value.flatMap((r, i) =>
                i % 3 === 1
                  ? [h("hr", null), String(r.v), rowVNode(r)]
                  : [rowVNode(r)]
              ),
              h("em", null, "tail"),
            ]
            : model.value.map(rowVNode)),
        );
      const root = doc.createElement("div");
      doc.body.appendChild(root);
      const hd = mount(root, App);
      const ul = root.firstChild as HTMLElement;

      const moved = new Set<string>();
      const origInsert = ul.insertBefore.bind(ul);
      const origAppend = ul.appendChild.bind(ul);
      const note = (n: Node) => {
        if (n.parentNode === ul && n.nodeType === 1) {
          moved.add((n as Element).getAttribute("data-k") ?? "?");
        }
      };
      // deno-lint-ignore no-explicit-any
      (ul as any).insertBefore = (n: Node, ref: Node | null) => {
        note(n);
        return origInsert(n, ref);
      };
      // deno-lint-ignore no-explicit-any
      (ul as any).appendChild = (n: Node) => {
        note(n);
        return origAppend(n);
      };

      for (let step = 0; step < STEPS; step++) {
        const before = rows;
        rows = mutate(rows, rand, nextKey);
        const oldPos = new Map(before.map((r, i) => [r.k, i]));
        // A survivor is a row whose key stays AND whose node is reused (a
        // component switching shape rebuilds, which is not a move).
        const beforeByKey = new Map(before.map((r) => [r.k, r]));
        const survivors = rows.filter((r) => {
          const b = beforeByKey.get(r.k);
          return b !== undefined && (b.shape < 2) === (r.shape < 2) &&
            (b.shape < 2 ? b.shape === r.shape : true);
        });
        const bound = survivors.length -
          lisLen(survivors.map((r) => oldPos.get(r.k)!));

        moved.clear();
        model.set(rows);
        hd._flush();

        const f = doc.createElement("div");
        const fh = mount(f, App);
        const fresh = f.innerHTML;
        _unmount(fh);
        const ctx = `seed=${SEED} round=${round} step=${step}\n  before=${
          JSON.stringify(before)
        }\n  after=${JSON.stringify(rows)}`;
        assertEquals(root.innerHTML, fresh, `DOM != fresh render — ${ctx}`);
        const survivorKeys = new Set(survivors.map((r) => String(r.k)));
        const movedSurvivors = [...moved].filter((k) => survivorKeys.has(k));
        assert(
          movedSurvivors.length <= bound,
          `re-inserted ${movedSurvivors.length} surviving rows (${movedSurvivors}), ` +
            `the optimum is ${bound} — ${ctx}`,
        );
      }
      _unmount(hd);
      root.remove();
    }
  } finally {
    await closeWindow(win);
  }
});

Deno.test("keyed diff: moving the first row to the end re-inserts that row only", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    const keys = signal(["a", "b", "c", "d"]);
    const App = () =>
      h(
        "ul",
        null,
        ...keys.value.map((k) => h("li", { key: k }, h("input", { name: k }))),
      );
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const hd = mount(root, App);
    const ul = root.firstChild as HTMLElement;
    const inserted: string[] = [];
    const orig = ul.insertBefore.bind(ul);
    // deno-lint-ignore no-explicit-any
    (ul as any).insertBefore = (n: Node, ref: Node | null) => {
      inserted.push((n as Element).querySelector?.("input")?.name ?? "?");
      return orig(n, ref);
    };
    keys.set(["b", "c", "d", "a"]);
    hd._flush();
    assertEquals(inserted, ["a"]);
    assertEquals(
      [...ul.querySelectorAll("input")].map((i) => i.name).join(""),
      "bcda",
    );
    _unmount(hd);
  } finally {
    await closeWindow(win);
  }
});
