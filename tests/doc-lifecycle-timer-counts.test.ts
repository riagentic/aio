// `docs/ui/air-lifecycle.md`'s `Timer` example showed "0s" forever, with
// nothing logged. It created its counter with `signal(0)` in the component
// body: the first tick wrote the FIRST render's signal, the component
// re-rendered, the body made a brand-new `signal(0)` and rendered that, and
// every later tick wrote a signal nobody was subscribed to any more.
//
// The doc now uses `useSignal(0)` — one signal per component instance, matched
// across renders by call order. Both shapes are pinned here: the doc's, which
// must count, and the old one, so the test proves it can tell them apart.
import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import {
  onCleanup,
  onMount,
  useSignal,
} from "../src/air/renderer-lifecycle.ts";

async function run(Timer: () => unknown): Promise<string[]> {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const seen: string[] = [];
  const time = new FakeTime();
  try {
    const handle = mount(root, Timer as never);
    for (let i = 0; i < 3; i++) {
      time.tick(1000);
      handle._flush();
      seen.push(root.textContent);
    }
    _unmount(handle);
  } finally {
    time.restore();
    _setDocument(null as never);
    await closeWindow(win);
  }
  return seen;
}

Deno.test("air-lifecycle Timer: the documented example counts", async () => {
  // The doc must still show THIS body — a test of a snippet the doc no longer
  // contains would stay green while the page regressed.
  const md = Deno.readTextFileSync(
    new URL("../docs/ui/air-lifecycle.md", import.meta.url),
  );
  const block = md.slice(md.indexOf("const Timer = () => {"));
  assertEquals(
    block.slice(0, block.indexOf("return")).includes(
      "const elapsed = useSignal(0);",
    ),
    true,
    "the doc's Timer must create its counter with useSignal(0)",
  );
  // Verbatim from the doc, minus JSX.
  const Timer = () => {
    const elapsed = useSignal(0);

    onMount(() => {
      const id = setInterval(() => elapsed.set(elapsed.peek() + 1), 1000);
      onCleanup(() => clearInterval(id));
    });

    return h("span", null, [`${elapsed.value}s`]);
  };
  assertEquals(await run(Timer), ["1s", "2s", "3s"]);
});

Deno.test("air-lifecycle Timer: the old body-signal() shape is the one that stuck", async () => {
  const Timer = () => {
    const elapsed = signal(0);

    onMount(() => {
      const id = setInterval(() => elapsed.set(elapsed.peek() + 1), 1000);
      onCleanup(() => clearInterval(id));
    });

    return h("span", null, [`${elapsed.value}s`]);
  };
  assertEquals(await run(Timer), ["0s", "0s", "0s"]);
});
