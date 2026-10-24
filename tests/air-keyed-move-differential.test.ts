// Mount-level differential for what a keyed MOVE must keep — the state a
// document cannot show and the other differentials do not read:
//   · the FOCUS and the caret of a control inside a moved row (insertBefore of
//     a connected node is remove + insert, and the remove blurs — measured in
//     Chromium: typing into a row of a list that reorders lost the focus);
//   · the row's DOM nodes and its component instance (useRef) — a move, not a
//     re-create;
//   · its listeners: a click on a moved row reaches THAT row's handler, and a
//     removed row's button fires nothing.
// Rows take every multi-node shape a keyed child can have (element, fragment,
// component → element, component → fragment), between null/false holes and
// bare text. After every step the host must also equal a fresh mount of the
// same model, with no dev tripwire. Run twice: the DOM without `moveBefore`
// (happy-dom, Safari) and with it (Chromium).
//
//     for s in 1 2 3 4 5; do FUZZ_SEED=$s deno test -A \
//       tests/air-keyed-move-differential.test.ts; done
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, Fragment, h } from "../src/air/vdom.ts";
import type { ComponentFn, VNode } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
  useRef,
} from "../src/air/aio-renderer.ts";
import type { MountHandle } from "../src/air/renderer-types.ts";
import { signal } from "../src/state/signal.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { mulberry32 } from "./sync/properties/_prop.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0x6d0e) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 120, 1);
const STEPS = fuzzEnvInt("FUZZ_STEPS", 10, 1);

/** A row: `sh` = shape, `hole` = a `false`/null sibling rendered before it. */
type Row = { id: number; sh: number; hole: number };
const MODEL = signal<Row[]>([]);
const CLICKED: number[] = [];
let TOKEN = 0;

const SIG = signal("s");
const body = (id: number) => [
  h(id % 2 ? "input" : "textarea", { "data-r": String(id) }),
  SIG as unknown as VNode,
  h("button", { onClick: () => CLICKED.push(id) }, "b" + id),
];
// deno-lint-ignore no-explicit-any
type P = any;
const AsEl: ComponentFn = (p: P) => {
  const t = useRef(++TOKEN).current;
  return h("li", { "data-t": String(t) }, ...body(p.id));
};
const AsFrag: ComponentFn = (p: P) => {
  const t = useRef(++TOKEN).current;
  return h(
    Fragment,
    null,
    "x",
    h("li", { "data-t": String(t) }, ...body(p.id)),
  );
};
function row(r: Row): VNode {
  const key = "k" + r.id;
  switch (r.sh) {
    case 0:
      return h("li", { key }, ...body(r.id));
    case 1:
      return h(Fragment, { key }, h("li", null, ...body(r.id)), "t");
    case 2:
      return h(AsEl, { key, id: r.id });
    case 4:
      return h(
        ErrorBoundary as never,
        { key, fallback: () => h("b", null, "!") },
        h("li", null, ...body(r.id)),
      );
    default:
      return h(AsFrag, { key, id: r.id });
  }
}
const App: ComponentFn = () =>
  h(
    "ul",
    null,
    "head",
    ...MODEL.value.flatMap((r) =>
      r.hole === 1
        ? [false as never, row(r)]
        : r.hole === 2
        ? [null as never, row(r)]
        : [row(r)]
    ),
    "tail",
  );

// Tokens are per-instance, so the reference mount numbers its own: strip them.
const norm = (s: string) => s.replace(/ data-t="\d+"/g, "");
const inputOf = (host: Element, id: number) =>
  host.querySelector(`[data-r="${id}"]`) as unknown as HTMLInputElement;
const tokenOf = (host: Element, id: number) =>
  inputOf(host, id)?.parentElement?.getAttribute("data-t") ?? null;

function mutate(rows: Row[], pick: (n: number) => number, next: () => number) {
  const op = pick(7);
  const i = pick(rows.length || 1), j = pick(rows.length || 1);
  if (op === 0 && rows.length) rows.splice(j, 0, rows.splice(i, 1)[0]!); // move one
  else if (op === 1) rows.reverse();
  else if (op === 2) rows.sort(() => pick(3) - 1); // shuffle-ish
  else if (op === 3) {
    rows.splice(i, 0, { id: next(), sh: pick(5), hole: pick(3) });
  } else if (op === 4 && rows.length > 1) rows.splice(i, 1);
  else if (op === 5 && rows.length) rows[i]!.hole = pick(3);
  else if (rows.length) rows[i]!.sh = pick(5); // a re-create, same key
}

async function run(withMoveBefore: boolean): Promise<number> {
  const rnd = mulberry32(SEED ^ (withMoveBefore ? 0x3b : 0));
  const pick = (n: number) => Math.floor(rnd() * n);
  const warns: string[] = [];
  const ow = console.warn, oe = console.error;
  console.warn = console.error = (...a: unknown[]) =>
    warns.push(a.map(String).join(" "));
  setDevMode(true);
  let moved = 0, kept = 0;
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const win = new Window({ url: "http://localhost/" });
      const doc = win.document as unknown as Document;
      _setDocument(doc);
      if (withMoveBefore) {
        // Chromium's atomic move: no blur. happy-dom has none, so this one
        // re-focuses what a plain insert would have blurred.
        // deno-lint-ignore no-explicit-any
        (win as any).Element.prototype.moveBefore = function (
          this: Element,
          n: Node,
          a: Node | null,
        ) {
          moved++;
          const f = doc.activeElement as HTMLElement | null;
          this.insertBefore(n, a);
          if (f && n.contains(f)) f.focus();
        };
      }
      doc.body.innerHTML = `<div id="a"></div><div id="b"></div>`;
      const a = doc.getElementById("a")!, b = doc.getElementById("b")!;
      let id = 0;
      const rows: Row[] = Array.from(
        { length: 2 + pick(5) },
        () => ({ id: ++id, sh: pick(5), hole: pick(3) }),
      );
      MODEL.set(rows.map((r) => ({ ...r })));
      const hd: MountHandle = mount(a, App);
      hd._flush();
      for (let step = 0; step < STEPS; step++) {
        const before = JSON.stringify(rows);
        // focus a row's input, caret mid-text
        const f = rows[pick(rows.length)]!;
        const fin = inputOf(a, f.id);
        fin.value = "hello";
        fin.focus();
        fin.setSelectionRange(1, 3);
        const prev = new Map(rows.map((r) => [r.id, { ...r }]));
        const nodes = new Map(rows.map((r) => [r.id, inputOf(a, r.id)]));
        const tokens = new Map(rows.map((r) => [r.id, tokenOf(a, r.id)]));
        const buttons = [...a.querySelectorAll("button")];
        mutate(rows, pick, () => ++id);
        SIG.set("s" + step);
        MODEL.set(rows.map((r) => ({ ...r })));
        hd._flush();
        const at = `${
          withMoveBefore ? "moveBefore" : "insertBefore"
        } SEED=${SEED} round=${round} step=${step}\n  before=${before}\n  after=${
          JSON.stringify(rows)
        }`;
        // 1. the document
        const ref = mount(b, App);
        ref._flush();
        assertEquals(norm(a.innerHTML), norm(b.innerHTML), at);
        _unmount(ref);
        // 2. survivors keep node, instance and (the focused one) focus + caret
        for (const r of rows) {
          const p = prev.get(r.id);
          if (!p || p.sh !== r.sh) continue;
          kept++;
          assert(
            inputOf(a, r.id) === nodes.get(r.id),
            `row ${r.id} re-created — ${at}`,
          );
          assertEquals(
            tokenOf(a, r.id),
            tokens.get(r.id),
            `row ${r.id} instance — ${at}`,
          );
          if (r.id === f.id) {
            assert(
              doc.activeElement === fin,
              `focus lost on row ${r.id} — ${at}`,
            );
            assertEquals([fin.selectionStart, fin.selectionEnd], [1, 3], at);
          }
        }
        // 3. listeners follow their row; a removed row's button fires nothing
        CLICKED.length = 0;
        for (const btn of buttons) (btn as unknown as HTMLElement).click();
        const want = buttons.filter((x) => a.contains(x)).map((x) =>
          Number(x.textContent!.slice(1))
        );
        assertEquals(CLICKED, want, `clicks — ${at}`);
        CLICKED.length = 0;
        for (const btn of a.querySelectorAll("button")) {
          (btn as unknown as HTMLElement).click();
        }
        assertEquals(CLICKED, rows.map((r) => r.id), `clicks in order — ${at}`);
      }
      const all = [...a.querySelectorAll("button")];
      _unmount(hd);
      assertEquals(a.innerHTML, "", "left after unmount");
      CLICKED.length = 0;
      for (const btn of all) (btn as unknown as HTMLElement).click();
      assertEquals(CLICKED, [], "a handler outlived its unmount");
      const bad = warns.filter((w) =>
        /desync|aio bug|wrong (node|slot)|ran out of DOM|diffed against|leftover|no position/i
          .test(w)
      );
      assertEquals(bad, [], `dev tripwire — SEED=${SEED} round=${round}`);
      await closeWindow(win);
    }
  } finally {
    setDevMode(false);
    console.warn = ow;
    console.error = oe;
  }
  if (withMoveBefore) assert(moved > 0, "moveBefore never used");
  return kept;
}

Deno.test("keyed move differential: focus, caret, nodes, instances and listeners survive a reorder", async () => {
  assert(await run(false) > ROUNDS);
});

Deno.test("keyed move differential: the same where the DOM has moveBefore", async () => {
  assert(await run(true) > ROUNDS);
});
