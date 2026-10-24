// An UNKEYED list that changes length shifts the hand-written siblings after
// it by position: `{errors.map((e) => <p>{e}</p>)}<input/>` re-creates the
// input when the first error appears — focus, caret and typed text gone. One
// or two rows sit below the missing-keys count, so dev said nothing. It now
// says so when it happens, and stays quiet for the shapes no key would help.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn, VNode } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const N = signal(0);

async function run(view: (n: number) => VNode): Promise<string[]> {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const warns: string[] = [];
  const ow = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  setDevMode(false); // re-arms the once-per-site dedup
  setDevMode(true);
  N.set(0);
  try {
    const App: ComponentFn = () => view(N.value);
    const hd = mount(doc.body, App);
    hd._flush();
    for (const n of [1, 2, 0]) {
      N.set(n);
      hd._flush();
    }
    _unmount(hd);
  } finally {
    console.warn = ow;
    setDevMode(false);
    await closeWindow(win);
  }
  return warns.filter((w) => /unkeyed list changed length/.test(w));
}
const rows = (n: number, keyed = false) =>
  Array.from(
    { length: n },
    (_, i) => h("p", keyed ? { key: i } : null, "e" + i),
  );

Deno.test("an unkeyed list growing before an <input> says the input is re-created", async () => {
  const w = await run((n) =>
    h("form", { class: "f" }, h("h2", null, "T"), rows(n), h("input", null))
  );
  assertEquals(w.length, 1, "once per site");
  assert(w[0]!.includes("key={item.id}"), w[0]);
  assert(w[0]!.includes("<form.f>"), w[0]);
});

Deno.test("quiet: keyed rows, a list after the siblings, a list swapped for a placeholder", async () => {
  assertEquals(
    await run((n) => h("div", null, rows(n, true), h("input", null))),
    [],
  );
  assertEquals(
    await run((n) => h("div", null, h("input", null), rows(n))),
    [],
  );
  assertEquals(
    await run((n) =>
      h("div", null, n ? rows(1) : h("i", null, "none"), h("b", null))
    ),
    [],
    "the list REPLACED by a node — no key would keep it",
  );
});
