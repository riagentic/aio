// `<h2/>{items.map((i) => <li key={i}/>)}<input/>` — a heading, a keyed list,
// an input — warned "Mixed keyed and unkeyed children — all siblings should
// have keys or none" on every render. It is the docs' own list layout, and the
// warning was wrong about it: `diffKeyed` matches unkeyed children
// positionally among the UNKEYED ones, so the heading and the input keep
// their nodes however the keyed rows move. A warning that fires on correct,
// idiomatic code teaches readers to ignore the channel.
//
// Pinned both ways: no warning, AND the DOM really is right — same heading and
// input NODES (an input that is re-created loses what the user typed) through
// insert, reorder and remove.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { setDevMode } from "../src/air/vdom-types.ts";

type Step = { texts: string; h2Kept: boolean; inputKept: boolean };

async function run(): Promise<
  { warns: string[]; steps: Step[]; typed: string }
> {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  setDevMode(false);
  setDevMode(true);
  const items = signal(["a", "b", "c"]);
  const App = () => (
    <div>
      <h2>Todos</h2>
      {items.value.map((i) => <p key={i}>{i}</p>)}
      <input />
    </div>
  );
  // deno-lint-ignore no-explicit-any
  const handle = mount(root, App as any);
  const steps: Step[] = [];
  let typed = "";
  try {
    const box = root.firstChild;
    const h2 = box.querySelector("h2");
    const input = box.querySelector("input");
    input.value = "typed";
    for (const next of STEPS) {
      items.set(next);
      handle._flush();
      steps.push({
        texts: [...box.childNodes]
          .map((n: { nodeName: string; textContent: string }) =>
            n.nodeName === "P" ? n.textContent : n.nodeName
          )
          .filter((t: string) => t !== "#comment")
          .join(","),
        h2Kept: box.querySelector("h2") === h2,
        inputKept: box.querySelector("input") === input,
      });
    }
    typed = box.querySelector("input").value;
  } finally {
    _unmount(handle);
    setDevMode(false);
    console.warn = orig;
    _setDocument(null as never);
    await closeWindow(win);
  }
  return { warns, steps, typed };
}

const STEPS = [["a", "b", "c", "d"], ["d", "c", "b", "a"], ["c", "a"], [], [
  "x",
  "a",
]];

Deno.test("keys: literal unkeyed siblings around a keyed .map list do not warn 'mixed'", async () => {
  const { warns } = await run();
  assertEquals(
    warns.filter((w) => w.includes("Mixed keyed")),
    [],
    JSON.stringify(warns),
  );
});

Deno.test("keys: …and those siblings keep their nodes through insert, reorder, empty and refill", async () => {
  const { steps, typed } = await run();
  STEPS.forEach((next, i) => {
    const s = steps[i]!;
    const at = JSON.stringify(next);
    assertEquals(s.texts, ["H2", ...next, "INPUT"].join(","), at);
    assert(s.h2Kept, `heading node kept at ${at}`);
    // The list emptying out used to take the positional path, which lined
    // the input up against a departed row and re-created it.
    assert(s.inputKept, `input node kept at ${at}`);
  });
  assertEquals(typed, "typed", "what the user typed survives");
});
