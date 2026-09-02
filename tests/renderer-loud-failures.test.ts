// The renderer's quiet corners, made loud. Every case here used to fail
// silently or with an error that named the wrong thing.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  onCleanup,
  onMount,
  setDevMode,
  useRef,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { memo } from "../src/air/memo.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win, doc, root };
}

function captured<T>(
  stream: "warn" | "error",
  fn: () => T,
): { out: string[]; result: T } {
  const out: string[] = [];
  const orig = console[stream];
  console[stream] = (...a: unknown[]) => out.push(a.map(String).join(" "));
  try {
    return { out, result: fn() };
  } finally {
    console[stream] = orig;
  }
}

// A component returning a LIST (React allows it, AIR does not) died eleven
// frames deeper on `Cannot use 'in' operator to search for 'onInput' in
// undefined`, naming nothing at all.
Deno.test({
  name: "a component returning an array says so, and names the fix",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const Bad = () =>
      // deno-lint-ignore no-explicit-any
      [h("i", null, "a"), h("b", null, "c")] as any;
    let msg = "";
    try {
      mount(root, () => h("div", null, h(Bad, null)));
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "returned an array of 2");
    assertStringIncludes(msg, "Wrap the list in a fragment");
    await win.happyDOM.close();
  },
});

// `onMount`/`onCleanup` outside a render were dropped in SILENCE, while
// `afterRender`, `useRef` and `useSignal` all say so for the same mistake.
Deno.test("onMount/onCleanup outside a render are reported, not swallowed", () => {
  setDevMode(true);
  try {
    const { out } = captured("warn", () => {
      onMount(() => {});
      onCleanup(() => {});
    });
    assertEquals(out.length, 2, JSON.stringify(out));
    assertStringIncludes(
      out[0]!,
      "onMount() called outside a component render",
    );
    assertStringIncludes(out[1]!, "onCleanup() called outside a component");
  } finally {
    setDevMode(false);
  }
});

// useRef/useSignal/useId are matched across renders BY CALL ORDER, so a
// CONDITIONAL one silently swaps ref identities — while the page documenting
// them opened with "Unlike React, you can call them conditionally or in loops".
Deno.test({
  name: "a conditional useRef is reported in dev (hook order moved)",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    setDevMode(true);
    const extra = signal(false);
    try {
      const App = () => {
        const a = useRef("a");
        if (extra.value) useRef("b"); // the bug shape
        return h("div", null, String(a.current));
      };
      const { out } = captured("error", () => {
        const handle = mount(root, App);
        extra.set(true);
        handle._flush();
        _unmount(handle);
      });
      assertEquals(
        out.some((e) => e.includes("state hooks this render but")),
        true,
        `expected a hook-order report, got ${JSON.stringify(out)}`,
      );
    } finally {
      setDevMode(false);
      await win.happyDOM.close();
    }
  },
});

// memo(C, compare): React code passes a comparator precisely when shallow
// equality is the wrong rule. AIR has no hook to swap that rule, and dropping
// it silently meant the component re-rendered on a rule the author had
// explicitly replaced.
Deno.test("memo(C, compare) reports that the comparator is ignored", () => {
  const g = globalThis as Record<string, unknown>;
  const prev = g.__aioDev;
  g.__aioDev = true;
  try {
    const C = function Widget() {
      return null;
    };
    const { out } = captured("warn", () => memo(C, () => true));
    assertEquals(out.length, 1, JSON.stringify(out));
    assertStringIncludes(out[0]!, "memo(Widget, compare)");
    assertStringIncludes(out[0]!, "IGNORED");
    // ...and a plain memo() stays a silent no-op.
    const { out: quiet } = captured("warn", () => memo(C));
    assertEquals(quiet.length, 0);
  } finally {
    g.__aioDev = prev;
  }
});

// ── An undefined component rendered <undefined></undefined> ──────────────────
// `h()` never looked at `tag`. A typo'd import, a missing export, or — the case
// no type-checker can catch — a circular import whose binding is still
// undefined while the module evaluates, all produced a VNode with
// `tag: undefined`, which SSR wrote as "<undefined></undefined>" and the
// browser created as an <undefined> element. No error, no warning: the
// developer sees a blank area and has nothing to search for.
//
// Dev throws (server-html-gen.ts's blank-screen guard turns a render throw into
// an in-page overlay AND a terminal report). Prod reports once and renders
// NOTHING — the documented category (b) split, deliberate here because one
// component broken by a circular import must not take a whole production page
// down when the old behaviour merely rendered it invisibly.

Deno.test("h(): an undefined tag throws in dev and names the likely causes", async () => {
  const { renderToString } = await import("../src/air/vdom-ssr.ts");
  const prevDev = (globalThis as Record<string, unknown>).__aioDev;
  (globalThis as Record<string, unknown>).__aioDev = true;
  try {
    const missing = ({} as Record<string, unknown>).Card;
    let msg = "";
    try {
      renderToString(h(missing as never, { title: "hi" }));
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "JSX tag is undefined");
    assertStringIncludes(msg, "circular import");
    // The props are the only handle on WHICH call site it was — the identifier
    // is gone by the time `h` sees it.
    assertStringIncludes(msg, "title");
  } finally {
    (globalThis as Record<string, unknown>).__aioDev = prevDev;
  }
});

Deno.test("h(): in prod an undefined tag renders nothing, and says so once", async () => {
  const { renderToString } = await import("../src/air/vdom-ssr.ts");
  const { _badTagMessage } = await import("../src/air/vdom-create.ts");
  const prevDev = (globalThis as Record<string, unknown>).__aioDev;
  delete (globalThis as Record<string, unknown>).__aioDev;
  const seen: string[] = [];
  const prevErr = console.error;
  console.error = (...a: unknown[]) => void seen.push(String(a[0]));
  try {
    const missing = ({} as Record<string, unknown>).Card;
    // Nothing, not "<undefined></undefined>" — the whole point.
    const out = renderToString(h(missing as never, { uniqueProp: 1 }));
    assertEquals(out.includes("undefined"), false, out);
    // …and re-rendering the same broken component does not spam the log.
    renderToString(h(missing as never, { uniqueProp: 1 }));
    assertEquals(seen.length, 1, seen.join("\n"));
    assertStringIncludes(seen[0]!, "JSX tag is undefined");
  } finally {
    console.error = prevErr;
    (globalThis as Record<string, unknown>).__aioDev = prevDev;
  }
  // The message is one function, so dev and prod cannot drift apart.
  assertStringIncludes(_badTagMessage(undefined, {}), "JSX tag is undefined");
});
