// A controlled control whose handler stores nothing keeps the user's text on
// screen — the renderer never rewrites it outside a render (a debounced store
// and a plain-variable draft are real apps) — but dev SAYS so, once per
// element, when the screen still differs from state a second later
// (air/control-drift.ts). Prod says nothing.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, Portal } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import { bumpPending } from "../src/protocol/pending-calls.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withDom(
  dev: boolean,
  app: () => unknown,
  fn: (
    root: HTMLElement,
    type: (sel: string, ch: string) => void,
  ) => Promise<void>,
): Promise<string[]> {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  _setDocument(doc);
  // deno-lint-ignore no-explicit-any
  const W = win as any;
  // A key typed at the END of what the field shows, as a user types.
  const type = (sel: string, ch: string) => {
    const el = root.querySelector(sel) as HTMLInputElement;
    el.value += ch;
    el.dispatchEvent(new W.InputEvent("input", { bubbles: true }));
  };
  const warns: string[] = [];
  const keep = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  setDevModeOverride(dev);
  // deno-lint-ignore no-explicit-any
  const handle = mount(root, app as any);
  try {
    await fn(root, type);
  } finally {
    _unmount(handle);
    setDevModeOverride(null);
    console.warn = keep;
    await closeWindow(win);
  }
  return warns.filter((w) => w.includes("did not store the typed value"));
}

Deno.test("controlled drift: a debounced store keeps every key and does not warn", async () => {
  const q = signal("");
  let t: ReturnType<typeof setTimeout> | undefined;
  const warns = await withDom(
    true,
    () =>
      h("input", {
        id: "q",
        value: q.value,
        onInput: (e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          clearTimeout(t);
          t = setTimeout(() => q.set(v), 300);
        },
      }),
    async (root, type) => {
      type("#q", "a");
      await sleep(50);
      type("#q", "b");
      await sleep(1_400);
      assertEquals((root.querySelector("#q") as HTMLInputElement).value, "ab");
      assertEquals(q.peek(), "ab");
    },
  );
  assertEquals(warns, []);
});

Deno.test("controlled drift: a static value with a plain-variable store keeps the text", async () => {
  let draft = "";
  await withDom(
    true,
    () =>
      h("input", {
        id: "d",
        value: "",
        onInput: (e: Event) => {
          draft = (e.target as HTMLInputElement).value;
        },
      }),
    async (root, type) => {
      type("#d", "h");
      type("#d", "i");
      await sleep(1_200);
      assertEquals((root.querySelector("#d") as HTMLInputElement).value, "hi");
      assertEquals(draft, "hi");
    },
  );
});

Deno.test("controlled drift: a refused key warns once per element, naming it; a call in flight and prod stay quiet", async () => {
  const v = signal("ab");
  const cap = (e: Event) => {
    const t = (e.target as HTMLInputElement).value;
    if (t.length <= 2) v.set(t);
  };
  const App = () =>
    h(
      "div",
      null,
      h("input", { name: "code", value: v.value, onInput: cap }),
      h("input", {
        id: "srv",
        value: v.value,
        // What a server-cell call does synchronously: the ack registry counts
        // it in flight. Its answer decides, not the renderer.
        onInput: () => bumpPending("probe:set", 1),
      }),
    );
  const warns = await withDom(true, App, async (root, type) => {
    type("input[name=code]", "c");
    await sleep(300);
    type("input[name=code]", "d");
    await sleep(1_200);
    type("input[name=code]", "e");
    type("#srv", "x");
    await sleep(1_200);
    bumpPending("probe:set", -1);
    // Observe-only: the refused text stays.
    assertEquals(
      (root.querySelector("input[name=code]") as HTMLInputElement).value,
      "abcde",
    );
  });
  assertEquals(warns.length, 1, warns.join("\n"));
  assert(warns[0]!.includes('<input name="code">'), warns[0]);
  assert(warns[0]!.includes("drop `value`"), warns[0]);

  const prod = await withDom(false, App, async (_root, type) => {
    type("input[name=code]", "z");
    await sleep(1_200);
  });
  assertEquals(prod, []);
});

Deno.test("controlled drift: an unmount cancels a pending re-check — no timer outlives the app", async () => {
  // The default op sanitizer is the assertion: a re-check armed on a refused
  // key and left running past the unmount fails this test as a leaked timer.
  const v = signal("ab");
  const warns = await withDom(
    true,
    () => h("input", { id: "code", value: v.value, onInput: () => {} }),
    async (_root, type) => {
      type("#code", "x");
      await sleep(10);
    },
  );
  assertEquals(warns, []);
});

Deno.test("controlled drift: an unmount cancels the re-checks of a portal's control and of one an earlier render removed", async () => {
  // Neither lives under the root when the app unmounts — the portal's content
  // is outside it, the removed control is detached — and neither can warn any
  // more, so a timer left running only outlives the app (the op sanitizer).
  const show = signal(true);
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  const host = doc.createElement("div");
  doc.body.append(root, host);
  _setDocument(doc);
  // deno-lint-ignore no-explicit-any
  const W = win as any;
  const type = (sel: string) => {
    const el = doc.querySelector(sel) as HTMLInputElement;
    el.value += "x";
    el.dispatchEvent(new W.InputEvent("input", { bubbles: true }));
  };
  setDevModeOverride(true);
  const handle = mount(root, () =>
    h(
      "div",
      null,
      show.value
        ? h("input", { id: "gone", value: "", onInput: () => {} })
        : null,
      h(
        Portal,
        { target: host },
        h("input", { id: "p", value: "", onInput: () => {} }),
      ),
    ));
  try {
    type("#gone");
    type("#p");
    await sleep(10);
    show.set(false);
    await sleep(10);
    assertEquals(doc.querySelector("#gone"), null);
  } finally {
    _unmount(handle);
    setDevModeOverride(null);
    await closeWindow(win);
  }
});
