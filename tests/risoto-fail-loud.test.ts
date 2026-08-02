// a field report field-report regressions (2026-07-16e/f, 2026-07-17b) — three
// "fail loud, never silent" guarantees:
// 1. a dispatch to a cell the server never booted WARNS (it used to vanish —
//    green tests, dead feature),
// 2. a render-time error names the component it escaped from (blank-screen
//    overlays used to force a manual bisect),
// 3. dispatch-after-close warns once per action type (shutdown used to spam
//    hundreds of identical lines).
import { assert, assertEquals, assertThrows } from "@std/assert";
import { Window } from "happy-dom";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import { createDispatch } from "../src/state/dispatch.ts";
import { h } from "../src/air/vdom.ts";
import { _componentChainOf } from "../src/air/vdom-create.ts";
import { _render } from "../src/air/vdom-render.ts";
import type { Msg } from "../src/state/cell-types.ts";

const counter = cell("flc-counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
  },
});

function captureLogs(fn: () => void): string[] {
  // log.warn without an active file logger falls back to printConsole →
  // console.log; capture that.
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

// ── 1. unregistered-cell dispatch warns ──────────────────────

Deno.test("fail-loud: dispatch to unregistered cell warns loudly", () => {
  const composed = composeCells([counter]);
  const lines = captureLogs(() => {
    composed.reduce(composed.initialState, {
      type: "theme:set",
      payload: { args: ["dark"] },
    } as Msg);
  });
  assert(
    lines.some((l) =>
      l.includes("unregistered cell 'theme'") && l.includes("cells")
    ),
    `expected loud warning, got: ${lines.join("\n")}`,
  );
});

Deno.test("fail-loud: unregistered-cell warning fires once per cell", () => {
  const composed = composeCells([counter]);
  const lines = captureLogs(() => {
    for (let i = 0; i < 5; i++) {
      composed.reduce(composed.initialState, {
        type: "theme:set",
        payload: {},
      } as Msg);
    }
    composed.reduce(composed.initialState, {
      type: "profiles:add",
      payload: {},
    } as Msg);
  });
  const themeWarns = lines.filter((l) => l.includes("'theme'"));
  const profileWarns = lines.filter((l) => l.includes("'profiles'"));
  assertEquals(themeWarns.length, 1, "theme warned exactly once");
  assertEquals(profileWarns.length, 1, "each unknown cell warns separately");
});

Deno.test("fail-loud: registered and internal actions never warn", () => {
  const composed = composeCells([counter]);
  const lines = captureLogs(() => {
    composed.reduce(composed.initialState, {
      type: "flc-counter:increment",
      payload: { args: [1] },
    } as Msg);
    composed.reduce(composed.initialState, {
      type: "__sync:tick",
      payload: {},
    } as Msg);
    composed.reduce(composed.initialState, { type: "no-colon" } as Msg);
  });
  assertEquals(
    lines.filter((l) => l.includes("unregistered")).length,
    0,
    `no false positives, got: ${lines.join("\n")}`,
  );
});

Deno.test("fail-loud: foreign-action listeners do not warn", () => {
  const listener = cell("flc-listener", {
    state: { seen: 0 },
    listensTo: ["external:event"],
    methods: {
      bump(s) {
        s.seen += 1;
      },
    },
  });
  const composed = composeCells([listener]);
  const lines = captureLogs(() => {
    composed.reduce(composed.initialState, {
      type: "external:event",
      payload: {},
    } as Msg);
  });
  assertEquals(
    lines.filter((l) => l.includes("unregistered")).length,
    0,
    "a listened-to foreign type is handled, not unregistered",
  );
});

// ── 2. render errors name the component ──────────────────────

Deno.test("fail-loud: render error names the failing component", () => {
  // deno-lint-ignore no-explicit-any
  const document = new Window().document as any;
  const host = document.createElement("div");
  const NetworkPanel = () => {
    const edition = undefined as unknown as { label: string };
    return h("div", null, edition.label);
  };
  const App = () => h("div", null, h(NetworkPanel, null));
  const err = assertThrows(
    () => _render(host, h(App, null), null, { doc: document }),
    Error,
  );
  assertEquals(
    _componentChainOf(err),
    ["NetworkPanel", "App"],
    "chain names the failing component, innermost first",
  );
  assert(
    !err.message.includes("<NetworkPanel>"),
    "e.message is untouched — ErrorBoundary fallbacks render it to users",
  );
});

// ── 3. dispatch-after-close warns once per type ──────────────

Deno.test("fail-loud: dispatch after close() warns once per action type", () => {
  const warns: string[] = [];
  const dispatch = createDispatch<
    { n: number },
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({ state: s, effects: [] }),
    execute: () => {},
    getState: () => ({ n: 0 }),
    setState: () => {},
    onDone: () => {},
    log: {
      debug: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    },
    debug: false,
  });
  dispatch.close();
  for (let i = 0; i < 200; i++) {
    dispatch({ type: "sync:tick" }).catch(() => {});
  }
  dispatch({ type: "other:op" }).catch(() => {});
  assertEquals(
    warns.filter((m) => m.includes("'sync:tick'")).length,
    1,
    "200 drops of one type → one warning",
  );
  assertEquals(
    warns.filter((m) => m.includes("'other:op'")).length,
    1,
    "a different type still gets its own warning",
  );
  assert(
    warns.some((m) => m.includes("suppressed")),
    "warning says further drops are suppressed",
  );
});
