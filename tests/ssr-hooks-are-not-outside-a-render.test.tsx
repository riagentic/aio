/** @jsxImportSource aio */
// A SERVER RENDER IS NOT "OUTSIDE A COMPONENT RENDER".
//
// `renderToString` / `renderToStream` call component functions directly, so
// there is no component INSTANCE to hang a ref or a mount callback on. Five
// hooks read that as the author's mistake and said so, in dev, on every server
// render of every component:
//
//   [aio-dev] useRef() called outside a component render. The ref will not
//             persist across re-renders.
//   [aio-dev] onMount() called outside a component render — there is no
//             component to attach it to, so the callback was DROPPED. It only
//             works in a component body …
//
// — for code that is in a component body, written exactly as the docs show.
// Measured: ONE ordinary component (`useRef` + `useSignal` + `useId` +
// `onMount` + `onCleanup` + `onWindowEvent` + `afterRender`) produced SEVEN of
// them per render, and the dev SERVER sets `__aioDev` (src/server/aio-boot.ts),
// so an app that server-renders in `deno task dev` buries its real log under
// one wall of false accusations per request. `useHead` had this exact bug and
// it was fixed for `useHead` alone; `useId` is the one hook that already knew —
// it takes an SSR branch and says nothing.
//
// The warnings are not deleted, they are asked the right question: they fire
// wherever there is genuinely no render (a timer, a promise continuation, an
// event handler), on the server exactly as in the browser.
import { assertEquals } from "@std/assert";
import {
  afterRender,
  h,
  onMount,
  renderToStream,
  renderToString,
  useId,
  useRef,
  useSignal,
} from "../src/air.ts";
import { onCleanup, onWindowEvent } from "../src/air/renderer-lifecycle.ts";
import { _armTestStrict } from "../src/testing/test-strict.ts";

_armTestStrict();

/** Every warning `fn` printed. */
async function warnings(fn: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const prev = console.warn;
  console.warn = (...a: unknown[]) => lines.push(String(a[0]));
  try {
    await fn();
  } finally {
    console.warn = prev;
  }
  return lines;
}

const OUTSIDE = /outside a (component )?render/;

/** One ordinary component: every hook an app puts in a body, as the docs
 *  spell them. */
function Widget() {
  const box = useRef<string>("box");
  const open = useSignal(false);
  const id = useId();
  onMount(() => {});
  onCleanup(() => {});
  onWindowEvent("resize", () => {});
  afterRender(() => {});
  return h("div", { id }, `${open.value}:${box.current}`);
}

Deno.test("SSR: renderToString does not accuse a component body of calling hooks outside a render", async () => {
  const lines = await warnings(() => {
    renderToString(h(Widget, null));
  });
  assertEquals(
    lines.filter((l) => OUTSIDE.test(l)),
    [],
    "a server render has no instance BY DESIGN — that is not the author's mistake",
  );
});

Deno.test("SSR: renderToStream does not accuse a component body either", async () => {
  const lines = await warnings(async () => {
    for await (const _ of renderToStream(h(Widget, null))) { /* drain */ }
  });
  assertEquals(lines.filter((l) => OUTSIDE.test(l)), []);
});

Deno.test("SSR: a hook called where there really is no render still says so", async () => {
  // Not inside any render — on the server exactly as in the browser, this IS
  // the mistake the warning exists for, and silencing it would trade one
  // wrong answer for another.
  const lines = await warnings(() => {
    useRef("x");
    useSignal(0);
    onMount(() => {});
    onCleanup(() => {});
    afterRender(() => {});
  });
  assertEquals(
    lines.filter((l) => OUTSIDE.test(l)).length,
    5,
    lines.join("\n"),
  );
});

Deno.test("SSR: the render still produces the markup the hooks describe", async () => {
  const html = renderToString(h(Widget, null));
  assertEquals(html, '<div id=":r0:">false:box</div>');
});
