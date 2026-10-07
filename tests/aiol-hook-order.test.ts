// aiol: a state hook behind a condition, in a loop, or after an early return.
//
// State hooks are matched across renders by call order. A field report
// shipped a component that returned early BEFORE its hooks: the first render
// took the return, the next one did not, and the dev console said `called 1
// state hooks this render but 0 last render` — on a path no test walked. The
// shape is in the source, so the linter says it before anything runs.
//
// Three things are pinned here:
//
//   1. WHICH hooks. Not a hand-kept list: every hook-named export of the
//      public entries is mounted and the slots it takes are COUNTED, and the
//      rule's list must be exactly the ones that take any.
//   2. The shapes, multiplied instead of listed: what is written in the body
//      × how the function around it is spelled. Every generated file is
//      type-checked once, so the scanner is judged on code a compiler
//      accepts, and its answer is compared with what the generator knows.
//   3. What a name IS: aio's hook under any spelling is one; the same name
//      from anywhere else is not.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Window } from "happy-dom";
import { buildContext } from "../aiol/context.ts";
import {
  checkHookOrder,
  hookOrderFindings,
  SLOT_HOOKS,
} from "../aiol/checks.ts";
import { closeWindow } from "../src/testing/close-window.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _currentCollector } from "../src/air/renderer-state.ts";
import { createContext } from "../src/air/renderer-context.ts";
import * as adapter from "../src/adapters/air.ts";
import { signal } from "../src/state/signal.ts";

const REPO = new URL("../", import.meta.url).href;

// ── 1. The list is the renderer's, measured ──────────────────────────

/** Arguments a hook needs to get as far as its first slot. */
const ctx = createContext(1);
const ARGS: Record<string, unknown[]> = {
  useFieldArray: [[]],
  useRoute: [],
  onChange: [signal(1), () => {}],
  onGlobalKey: ["k", () => {}],
  onWindowEvent: ["resize", () => {}],
  useCallback: [() => 1, []],
  useContext: [ctx],
  useContextSelector: [ctx, (v: number) => v],
  useEffect: [() => {}],
  useForm: [{ name: { initial: "" } }],
  useHead: [{ title: "t" }],
  useInterval: [() => {}, 1000],
  useMemo: [() => 1, []],
  useOptimistic: [1, (a: number) => a],
  useProjection: [() => 1],
  useResource: [{ key: () => "k", open: () => ({}), close: () => {} }],
  useVirtualList: [{ items: [], itemHeight: 10, height: 100 }],
};
const fn = () => {};

Deno.test({
  name:
    "aiol hook order: SLOT_HOOKS is exactly the public hooks that take a state slot",
  // `aio/air` is the browser client: importing it arms its transport.
  sanitizeOps: false, // aio-ok: the client transport `aio/air` arms on import
  sanitizeResources: false, // aio-ok: same — its socket outlives the test
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    const quiet = { warn: console.warn, error: console.error };
    console.warn = console.error = () => {};
    const taken = new Map<string, number>();
    const unmeasured: string[] = [];
    try {
      for (
        const entry of [
          "mod.ts",
          "src/air.ts",
          "src/air-compat.ts",
          "src/ui/mod.ts",
        ]
      ) {
        const mod = await import(REPO + entry) as Record<string, unknown>;
        for (const name of Object.keys(mod)) {
          if (!/^(?:use|on)[A-Z]|^afterRender$/.test(name)) continue;
          // The browser `useAio`/`useConnected` open the connection first,
          // which a test page cannot; what they then call is the adapter's.
          const hook = name === "useAio" || name === "useConnected"
            ? adapter[name]
            : mod[name];
          if (typeof hook !== "function") continue;
          let slots = -1;
          let threw: unknown;
          // Twice at most: a hook that boots the client runtime throws on a
          // page with no server, once — the second call is the hook itself.
          for (let attempt = 0; attempt < 2 && slots <= 0; attempt++) {
            threw = undefined;
            const root = doc.createElement("div");
            doc.body.appendChild(root);
            const handle = mount(root, () => {
              const c = _currentCollector as { refIndex?: number };
              const before = c.refIndex ?? 0;
              try {
                hook(...(ARGS[name] ?? [fn]));
              } catch (e) {
                threw = e;
              }
              slots = (c.refIndex ?? 0) - before;
              return h("div", null);
            });
            _unmount(handle);
            if (threw === undefined) break;
          }
          // A hook that threw before its first slot was not measured.
          if (threw !== undefined && slots === 0) {
            unmeasured.push(`${name}: ${threw}`);
          }
          taken.set(name, Math.max(slots, taken.get(name) ?? 0));
        }
      }
    } finally {
      Object.assign(console, quiet);
      await closeWindow(win);
    }
    assertEquals(unmeasured, [], "give these hooks arguments in ARGS");
    assert(taken.size > 25, `only ${taken.size} hooks found — the walk broke`);
    assertEquals(
      [...taken].filter(([, n]) => n > 0).map(([name]) => name).sort(),
      [...SLOT_HOOKS].sort(),
      "aiol's SLOT_HOOKS must be the hooks the renderer gives a slot to — " +
        `measured: ${JSON.stringify(Object.fromEntries(taken))}`,
    );
  },
});

// ── 2. Shapes × wrappers ─────────────────────────────────────────────

type Why = "return" | "condition" | "loop";
type Shape = readonly [
  body: readonly string[],
  expect: readonly (readonly [string, Why])[],
];

const R = ["useRef", "return"] as const;
const C = ["useRef", "condition"] as const;
const L = ["useRef", "loop"] as const;
const TITLE = `title={String(useRef(0).current)}`;

/** Bodies the renderer's rule forbids, and what must be said of each. */
const FLAG: readonly Shape[] = [
  // ── after an early return ──
  [["if (!props.ok) return null;", "const r = useRef(0);", "log(r);"], [R]],
  [[
    "if (!props.ok) {",
    "  return null;",
    "}",
    "const r = useRef(0);",
    "log(r);",
  ], [R]],
  [["if (!props.ok)", "  return null", "const r = useRef(0)", "log(r)"], [R]],
  [
    [
      "const a = useRef(0);",
      "if (props.ok) return <p>{a.current}</p>;",
      "const s = useSignal(1);",
      "log(s);",
    ],
    [["useSignal", "return"]],
  ],
  [[
    "switch (props.kind) {",
    '  case "a":',
    "    return null;",
    "}",
    "const r = useRef(0);",
    "log(r);",
  ], [R]],
  [
    [
      "try {",
      "  if (props.ok) return null;",
      "} catch { /* */ }",
      "useRef(0);",
    ],
    [R],
  ],
  [[
    "for (const it of props.items) {",
    "  if (it) return null;",
    "}",
    "const r = useRef(0);",
    "log(r);",
  ], [R]],
  [[
    "if (props.n > 1) log(1);",
    "else if (props.ok) return null;",
    "useRef(0);",
  ], [R]],
  [[
    "if (props.n > 1) {",
    "  log(1);",
    "} else if (props.ok) {",
    "  return null;",
    "}",
    "useRef(0);",
  ], [R]],
  [
    [
      "if (!props.ok) return null;",
      "const r = useRef<HTMLElement | null>(null);",
      "const cb = useRef<() => void>(() => {});",
      "log(r, cb);",
    ],
    [R, R],
  ],
  [["if (!props.ok) return null;", "useEffect(() => {}, []);"], [[
    "useEffect",
    "return",
  ]]],
  [["if (!props.ok) return null;", "const v = { a: useRef(0) };", "log(v);"], [
    R,
  ]],
  [
    [
      "if (!props.ok) return null;",
      "const a = useRef(0);",
      "const b = useSignal(0);",
      "log(a, b);",
    ],
    [R, ["useSignal", "return"]],
  ],
  [[
    "if (!props.ok) return null;",
    "// then the state",
    "/* and */ const r = useRef(0);",
    "log(r);",
  ], [R]],
  // ── behind a condition ──
  [["if (props.ok) {", "  useRef(0);", "}"], [C]],
  [["if (props.ok) useRef(0);"], [C]],
  [["if (props.ok)", "  useRef(0)"], [C]],
  [["if (props.ok) {", "  log(1);", "} else {", "  useRef(0);", "}"], [C]],
  [["if (props.ok) log(1);", "else useRef(0);"], [C]],
  [["if (props.ok) log(1);", "else if (props.n) useRef(0);"], [C]],
  [["const r = props.ok ? useRef(0) : null;", "log(r);"], [C]],
  [["const r = props.ok ? null : useRef(0);", "log(r);"], [C]],
  [["const r = props.ok", "  ? useRef(0)", "  : null", "log(r)"], [C]],
  [["const r = props.ok && useRef(0);", "log(r);"], [C]],
  [["const r = props.ok &&", "  useRef(0);", "log(r);"], [C]],
  [["const r = props.fallback ?? useRef(0);", "log(r);"], [C]],
  [["const r = props.fallback || useRef(0);", "log(r);"], [C]],
  [["let r = props.fallback;", "r ??= useRef(0);", "log(r);"], [C]],
  [["try {", "  useRef(0);", "} catch { /* */ }"], [C]],
  [["switch (props.kind) {", '  case "a":', "    useRef(0);", "}"], [C]],
  [[`return <div>{props.ok && <p ${TITLE} />}</div>;`], [C]],
  [[`return props.ok ? <p ${TITLE} /> : null;`], [C]],
  [["if (props.ok) onUnmount(() => {});"], [["onUnmount", "condition"]]],
  [["const r = log(props.ok && useRef(0));", "log(r);"], [C]],
  // ── in a loop ──
  [["for (const it of props.items) {", "  useRef(it);", "}"], [L]],
  [["for (const it of props.items) useRef(it);"], [L]],
  [["let n = props.n;", "while (n-- > 0) useRef(0);"], [L]],
  [["let n = props.n;", "do {", "  useRef(0);", "} while (n-- > 0);"], [L]],
  [["props.items.forEach(() => {", "  useRef(0);", "});"], [L]],
  [["const refs = props.items.map((it) => useRef(it));", "log(refs);"], [L]],
  [[
    "const refs = props.items.map(function (it) {",
    "  return useRef(it);",
    "});",
    "log(refs);",
  ], [L]],
];

/** Bodies that are correct as written: nothing may be said. */
const QUIET: readonly (readonly string[])[] = [
  // the return comes AFTER every hook
  [
    "const r = useRef(0);",
    "if (!props.ok) return null;",
    "return <p>{r.current}</p>;",
  ],
  [
    "const r = useRef(0);",
    "if (props.ok) {",
    "  r.current = 1;",
    "} else {",
    "  return null;",
    "}",
  ],
  // the condition is inside the value, or after the hook
  ["const r = useRef(props.ok ? 1 : 2);", "log(r);"],
  ["const r = useRef(props.ok && 1);", "log(r);"],
  ["const r = useRef(0);", "const v = props.ok && r.current;", "log(v);"],
  [
    "const r = useRef(0)",
    "const t = props.ok && r.current",
    "const s = useSignal(t)",
    "log(s)",
  ],
  ["const t = props.ok ? 1 : 2;", "const r = useRef(t);", "log(r);"],
  ["const t = props.ok ? 1 : 2", "const r = useRef(t)", "log(r)"],
  ["const t = props.ok", "  ? 1", "  : 2", "const r = useRef(t)", "log(r)"],
  [
    "const n = props.fallback?.current ?? 0;",
    "const r = useRef(n);",
    "log(r);",
  ],
  ["const n = props.fallback?.current ?? 0", "const r = useRef(n)", "log(r)"],
  [
    "const big = props.n >= 2 || props.n <= 0;",
    "const r = useRef(big);",
    "log(r);",
  ],
  [
    "const view = props.ok ? <b>a</b> : <i>b</i>;",
    "const r = useRef(0);",
    "log(view, r);",
  ],
  ["const o = { a: props.ok ? 1 : 2, b: useRef(0) };", "log(o);"],
  ["const v = log(props.ok && 1, useRef(0));", "log(v);"],
  ["const [a, b] = [props.ok ? 1 : 2, useRef(0)];", "log(a, b);"],
  ["if (useRef(0).current) {", "  log(1);", "}"],
  // a condition or a loop that does not hold the hook
  ["if (props.ok) {", "  log(1);", "}", "const r = useRef(0);", "log(r);"],
  ["if (props.ok) log(1);", "else log(2);", "const r = useRef(0);", "log(r);"],
  [
    "for (const it of props.items) {",
    "  log(it);",
    "}",
    "const r = useRef(0);",
    "log(r);",
  ],
  [
    "let n = props.n;",
    "do {",
    "  log(n);",
    "} while (n-- > 0);",
    "const r = useRef(0);",
    "log(r);",
  ],
  ["if (!props.ok) throw new Error('no');", "const r = useRef(0);", "log(r);"],
  ["{", "  const r = useRef(0);", "  log(r);", "}"],
  [
    "if (props.ok) {",
    "  log(1);",
    "} else if (props.n) {",
    "  log(2);",
    "} else {",
    "  log(3);",
    "}",
    "const r = useRef(0);",
    "log(r);",
  ],
  [
    "try {",
    "  log(1);",
    "} catch {",
    "  log(2);",
    "} finally {",
    "  log(3);",
    "}",
    "const r = useRef(0);",
    "log(r);",
  ],
  [
    "switch (props.kind) {",
    '  case "a":',
    "    log(1);",
    "    break;",
    "  default:",
    "    log(2);",
    "}",
    "const r = useRef(0);",
    "log(r);",
  ],
  // hooks that take no slot may be called conditionally
  ["if (props.ok) onMount(() => {});", "if (props.ok) onCleanup(() => {});"],
  ["if (!props.ok) return null;", "onMount(() => {});", "onCleanup(() => {});"],
  // inside onMount, onUnmount takes no slot
  [
    "onMount(() => {",
    "  if (!props.ok) return;",
    "  onUnmount(() => {});",
    "});",
  ],
  ["if (props.ok) onMount(() => onUnmount(() => {}));"],
  // an early return in ANOTHER function is not this one's
  [
    "const onKey = (e: KeyboardEvent) => {",
    "  if (e.key !== 'a') return;",
    "  log(e);",
    "};",
    "const r = useRef(0);",
    "log(onKey, r);",
  ],
  [
    "function inner() {",
    "  if (!props.ok) return 1;",
    "  return 2;",
    "}",
    "const r = useRef(0);",
    "log(inner, r);",
  ],
  [
    "function size(): { w: number } {",
    "  if (props.ok) return { w: 1 };",
    "  return { w: 2 };",
    "}",
    "const r = useRef(0);",
    "log(size, r);",
  ],
  [
    "function pick<T>(a: T, b: T): T {",
    "  if (props.ok) return a;",
    "  return b;",
    "}",
    "const r = useRef(0);",
    "log(pick, r);",
  ],
  [
    "const load = async (): Promise<number> => {",
    "  if (!props.ok) return 0;",
    "  return 1;",
    "};",
    "const r = useRef(0);",
    "log(load, r);",
  ],
  [
    "const mk = (a: number) => (b: number) => {",
    "  if (a) return b;",
    "  return a;",
    "};",
    "const r = useRef(0);",
    "log(mk, r);",
  ],
  [
    "const handlers = {",
    "  key(e: KeyboardEvent): void {",
    "    if (!e.key) return;",
    "    log(e);",
    "  },",
    "  get on(): (() => void) | null {",
    "    if (props.ok) return null;",
    "    return () => {};",
    "  },",
    "};",
    "const r = useRef(0);",
    "log(handlers, r);",
  ],
  [
    "const xs = props.items.map((it) => {",
    "  if (!it) return null;",
    "  return it;",
    "});",
    "const r = useRef(0);",
    "log(xs, r);",
  ],
  [
    "useEffect(() => {",
    "  if (!props.ok) return;",
    "  log(1);",
    "}, []);",
    "const r = useRef(0);",
    "log(r);",
  ],
  [
    "const r = useRef(0);",
    "return <div onClick={() => {",
    "  if (!props.ok) return;",
    "  r.current++;",
    "}}>{props.ok && <b />}</div>;",
  ],
  [
    "(() => {",
    "  if (!props.ok) return;",
    "  log(1);",
    "})();",
    "const r = useRef(0);",
    "log(r);",
  ],
  [
    "const done = function (a = () => {}) {",
    "  if (!props.ok) return;",
    "  a();",
    "};",
    "const r = useRef(done);",
    "log(r);",
  ],
  [
    "const api = {",
    "  a: () => {",
    "    if (props.ok) return 1;",
    "    return 2;",
    "  },",
    "  b: (v: number) => v ? 1 : 2",
    "}",
    "const r = useRef(api)",
    "log(r)",
  ],
  // types that spell `?`, `:` and `=>`
  [
    "const m = new Map<string, () => void>();",
    "const r = useRef(m);",
    "log(r);",
  ],
  [
    "const m = new Map<string, (a?: number) => void>()",
    "const r = useRef(m)",
    "log(r)",
  ],
  ["const cb = log as unknown as () => void", "const r = useRef(cb)", "log(r)"],
  [
    "interface Api {",
    "  get(id: string): { ok: boolean } | null;",
    "  on?(e: Event): void;",
    "}",
    "const r = useRef<Api | null>(null);",
    "log(r);",
  ],
  ["const cb: () => void = () => {};", "const r = useRef(cb);", "log(r);"],
  [
    "const cb: () => void = () => {}",
    "const v = props.ok ? 1 : 2",
    "const r = useRef(v)",
    "log(cb, r)",
  ],
  [
    "const cfg: { on: () => void; n?: number } = { on: () => {} };",
    "const r = useRef(cfg);",
    "log(r);",
  ],
  ["const f = (a?: number) => a;", "const r = useRef(f);", "log(r);"],
  [
    "type T = P extends object ? number : never;",
    "const r = useRef<T | null>(null);",
    "log(r);",
  ],
  [
    "const r: P extends object ? { current: number } : never = useRef(0);",
    "log(r);",
  ],
  // text that only LOOKS like the shape
  ["// if (!props.ok) return null;", "const r = useRef(0);", "log(r);"],
  ["/* if (x) { return; } */", "const r = useRef(0);", "log(r);"],
  [
    "const s = 'if (a) return; b && useRef()';",
    "const r = useRef(0);",
    "log(s, r);",
  ],
  [
    "const s = `if (${props.ok ? 1 : 2}) return`;",
    "const r = useRef(0);",
    "log(s, r);",
  ],
  ["const re = /a?b:c||d/;", "const r = useRef(re);", "log(r);"],
  [
    "const r = useRef(0);",
    "return <p>if (x) return; ok && useRef() {r.current}</p>;",
  ],
  // a function of the file that takes no slot is not a state hook
  ["if (props.ok) useTheme();", "const r = useRef(0);", "log(r);"],
];

const HEAD = `import {
  onCleanup,
  onMount,
  onUnmount,
  useEffect,
  useRef,
  useSignal,
} from "aio/air";
type P = {
  ok: boolean;
  kind: string;
  items: number[];
  n: number;
  fallback?: { current: number };
};
const log = (...a: unknown[]): unknown => a;
const memo = <T,>(c: T): T => c;
function useTheme() {
  return "dark";
}
export const used = [onCleanup, onMount, onUnmount, useEffect, useSignal, memo, useTheme];
`;

/** How the function around the body is spelled. `@` is the body. */
const WRAPPERS: Record<string, string> = {
  "function": `export function V(props: P) {\n@\n  return <div />;\n}\n`,
  "typed function":
    `export function V(props: P): unknown {\n@\n  return <div />;\n}\n`,
  "arrow": `export const V = (props: P) => {\n@\n  return <div />;\n};\n`,
  "typed arrow":
    `export const V = (props: P): unknown => {\n@\n  return <div />;\n};\n`,
  "export default":
    `export default function V(props: P) {\n@\n  return <div />;\n}\n`,
  "anonymous default":
    `export default function (props: P) {\n@\n  return <div />;\n}\n`,
  "memo(function)":
    `export const V = memo(function V(props: P) {\n@\n  return <div />;\n});\n`,
  "memo(arrow)":
    `export const V = memo((props: P) => {\n@\n  return <div />;\n});\n`,
  "memo(memo(arrow))":
    `export const V = memo(memo((props: P): unknown => {\n@\n  return <div />;\n}));\n`,
  "custom hook":
    `export function useThing(props: P) {\n@\n  return <div />;\n}\n`,
  "method":
    `export const views = {\n  V(props: P): unknown {\n@\n    return <div />;\n  },\n};\n`,
  "nested component":
    `export function Outer(outer: P) {\n  if (!outer.ok) log(outer);\n  const V = (props: P) => {\n@\n    return <div />;\n  };\n  return <V {...outer} />;\n}\n`,
};

type Case = { src: string; expect: readonly (readonly [string, Why])[] };
const CASES: Record<string, Case> = {};
Object.entries(WRAPPERS).forEach(([, wrapper], w) => {
  const file = (body: readonly string[]) =>
    HEAD + wrapper.replace("@", body.map((l) => `  ${l}`).join("\n"));
  FLAG.forEach(([body, expect], i) => {
    CASES[`src/flag${i}-${w}.tsx`] = { src: file(body), expect };
  });
  QUIET.forEach((body, i) => {
    CASES[`src/quiet${i}-${w}.tsx`] = { src: file(body), expect: [] };
  });
});

Deno.test("aiol hook order: every shape × wrapper gets exactly the findings it must", () => {
  const wrong: string[] = [];
  for (const [name, c] of Object.entries(CASES)) {
    const got = hookOrderFindings(c.src).map((f) => [f.hook, f.why]);
    if (JSON.stringify(got) !== JSON.stringify(c.expect)) {
      wrong.push(
        `${name}: expected ${JSON.stringify(c.expect)}, got ${
          JSON.stringify(got)
        }\n${c.src.slice(HEAD.length)}`,
      );
    }
  }
  assert(Object.keys(CASES).length > 900, "the matrix collapsed");
  assertEquals(wrong.length, 0, `\n${wrong.slice(0, 12).join("\n")}`);
});

Deno.test("aiol hook order: an early return is named by its own line", () => {
  const src = HEAD + WRAPPERS["function"]!.replace(
    "@",
    "  if (!props.ok) return null;\n  const r = useRef(0);\n  log(r);",
  );
  const [f] = hookOrderFindings(src);
  const line = (at: number) => src.slice(0, at).split("\n").length;
  const first = HEAD.split("\n").length + 1;
  assertEquals([line(f!.returnAt!), line(f!.at), f!.fn], [
    first,
    first + 1,
    "V",
  ]);
});

Deno.test("aiol hook order: the generated shapes are code a compiler accepts", async () => {
  const dir = await tempDir("aiol-hook-order-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: {
          lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
          jsx: "react-jsx",
          jsxImportSource: "aio",
        },
        imports: {
          "aio": `${REPO}mod.ts`,
          "aio/air": `${REPO}src/air.ts`,
          "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
        },
      }),
    );
    // One wrapper is enough to prove the BODIES; the wrappers are proven by
    // one body each. (Every file × every wrapper is ~1000 modules to check.)
    const files = Object.keys(CASES).filter((f) =>
      /-0\.tsx$/.test(f) || /^src\/(?:flag|quiet)0-/.test(f)
    );
    for (const f of files) {
      await Deno.writeTextFile(join(dir, f), CASES[f]!.src);
    }
    const check = await new Deno.Command(Deno.execPath(), {
      args: ["check", ...files],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(check.stderr)
      .replace(/\x1b\[[0-9;]*m/g, "");
    assertEquals(
      check.code,
      0,
      stderr.replace(/^Check .*\n/gm, "").slice(0, 4000),
    );
  } finally {
    await dropTempDir(dir);
  }
});

// ── 3. What a name is ────────────────────────────────────────────────

const BODY = `export function V(props: { ok: boolean }) {
  if (!props.ok) return null;
  const r = useRef(0);
  return <p>{r.current}</p>;
}
`;
const found = (src: string) =>
  hookOrderFindings(src).map((f) => `${f.hook}:${f.why}`);

Deno.test("aiol hook order: aio's hook under any spelling is one", () => {
  for (
    const spec of [
      "aio/air",
      "aio",
      "aio/air/compat",
      "@riagentic/aio/air",
      "jsr:@riagentic/aio@1.0.18-beta/air",
    ]
  ) {
    assertEquals(
      found(`import { useRef } from "${spec}";\n${BODY}`),
      ["useRef:return"],
      spec,
    );
  }
  assertEquals(
    found(
      `import {\n  onMount, // first\n  useRef as ref,\n} from "aio/air";\n` +
        BODY.replace("useRef(0)", "ref(0)"),
    ),
    ["ref:return"],
  );
  assertEquals(
    found(
      `import * as air from "aio/air";\n` +
        BODY.replace("useRef(0)", "air.useRef(0)"),
    ),
    ["air.useRef:return"],
  );
});

Deno.test("aiol hook order: the same name from anywhere else is not", () => {
  const quiet = [
    // another library's
    `import { useRef } from "react";\n${BODY}`,
    `import { useRef } from "./hooks.ts";\n${BODY}`,
    // the file's own
    `function useRef(n: number) {\n  return { current: n };\n}\n${BODY}`,
    `const useRef = (n: number) => ({ current: n });\n${BODY}`,
    // only the TYPE came from aio
    `import type { useRef } from "aio/air";\n${BODY}`,
    // a member of something that is not aio's namespace
    `import { h } from "aio/air";\nconst air = { useRef: (n: number) => ({ current: n }) };\n` +
    BODY.replace("useRef(0)", "air.useRef(0)") + "export { h };\n",
    // imported, and never called where the rule forbids
    `import { useRef } from "aio/air";\nexport const hooks = { useRef };\n` +
    `export function V(props: { ok: boolean }) {\n  if (!props.ok) return null;\n  return <p />;\n}\n`,
    // module level is not a render
    `import { useRef } from "aio/air";\nexport const r = Math.random() > 2 ? useRef(0) : null;\n`,
  ];
  for (const src of quiet) assertEquals(found(src), [], src);
});

Deno.test("aiol hook order: a custom hook of the file takes its hooks' slots with it", () => {
  const hook = `import { useRef, useSignal } from "aio/air";
function useCounter() {
  const n = useSignal(0);
  const last = useRef(0);
  return { n, last };
}
const useTwice = () => [useCounter(), useCounter()];
`;
  // Called unconditionally, with an unconditional body: correct.
  assertEquals(
    found(
      hook +
        `export function V(props: { ok: boolean }) {\n  const c = useCounter();\n  if (!props.ok) return null;\n  return <p>{c.n.value}</p>;\n}\n`,
    ),
    [],
  );
  // …and behind the return, it is the same mistake one call deeper —
  // through two levels of the file's own hooks.
  assertEquals(
    found(
      hook +
        `export function V(props: { ok: boolean }) {\n  if (!props.ok) return null;\n  const c = useTwice();\n  return <p>{c.length}</p>;\n}\n`,
    ),
    ["useTwice:return"],
  );
  // A wrapped binding is not the function: `memo(() => …)` is a component.
  assertEquals(
    found(
      `import { useRef } from "aio/air";\nconst wrap = <T,>(f: T): T => f;\n` +
        `const useBox = wrap(() => useRef(0));\n` +
        `export function V(props: { ok: boolean }) {\n  if (!props.ok) return null;\n  return <p>{String(useBox)}</p>;\n}\n`,
    ),
    [],
  );
});

// ── The rule, through the linter ─────────────────────────────────────

async function issues(files: Record<string, string>) {
  const dir = await tempDir("aiol-hook-order-rule-");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.mkdir(join(dir, "tests"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await checkHookOrder(ctx);
    return report;
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("aiol hook order: the report's shape — hooks after an early return", async () => {
  const report = await issues({
    "src/JobsPanel.tsx": `import { useLocal } from "aio/air";
import { jobs } from "./cell.ts";

export function JobsPanel() {
  if (jobs.list.length === 0) return null;
  const [open, setOpen] = useLocal(false);
  return <button onClick={() => setOpen(!open)}>{jobs.list.length}</button>;
}
`,
  });
  assertEquals(report.issues.length, 1, JSON.stringify(report.issues, null, 2));
  const i = report.issues[0]!;
  assertEquals([i.severity, i.area, i.file, i.line], [
    "warn",
    "ui",
    "src/JobsPanel.tsx",
    6,
  ]);
  for (
    const said of [
      "`useLocal()`",
      "early `return` on line 5",
      "`JobsPanel`",
      "CALL ORDER",
      "before any `return`",
    ]
  ) assert(i.message.includes(said), `${said} — ${i.message}`);
});

Deno.test("aiol hook order: a marker silences one site; a test file is not app code; a clean app passes", async () => {
  const bad = `import { useRef } from "aio/air";
export function V(props: { ok: boolean }) {
  if (!props.ok) return null;
  // aio-ok: \`ok\` is fixed for the life of the instance
  const r = useRef(0);
  const s = useRef(1);
  return <p>{r.current}{s.current}</p>;
}
`;
  const report = await issues({
    "src/V.tsx": bad,
    "tests/v.test.tsx": bad,
  });
  assertEquals(report.issues.map((i) => `${i.file}:${i.line}`), [
    "src/V.tsx:6",
  ]);

  const clean = await issues({
    "src/V.tsx": bad.replace("  if (!props.ok) return null;\n", ""),
  });
  assertEquals(clean.issues, []);
  assert(
    clean.passed.some((p) => p.includes("state hook")),
    JSON.stringify(clean.passed),
  );
});
