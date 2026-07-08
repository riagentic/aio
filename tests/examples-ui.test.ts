// UI functional tests for the examples' actual UIs — the real App.tsx files
// mounted with the AIR renderer (happy-dom), driven like a user would:
// click buttons, type into inputs, submit forms, observe rendered output.
// Cells run on the real standalone dispatch loop (the android runtime path).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _reset, ensureConnected } from "../src/standalone-air.ts";

// Mock localStorage (same pattern as standalone-air.test.ts) — the standalone
// loop persists through it.
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storage.set(k, v);
    },
    removeItem: (k: string) => {
      storage.delete(k);
    },
  },
  configurable: true,
});

function createDOM(): {
  win: Window;
  root: HTMLElement;
  cleanup: () => Promise<void>;
} {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win, root, cleanup: () => win.happyDOM.close() };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function ev(
  win: Window,
  name: string,
  opts: { bubbles?: boolean; cancelable?: boolean } = {},
): Event {
  return new win.Event(name, opts) as unknown as Event;
}

// Types like a user: set value, fire input, let the re-render commit before
// the next interaction (submit in the same tick would see a stale closure).
async function type(
  win: Window,
  input: HTMLInputElement,
  text: string,
): Promise<void> {
  input.value = text;
  input.dispatchEvent(ev(win, "input", { bubbles: true }));
  await tick(10);
}

// ── Counter apps: click +, rendered count updates ─────────────────────

type CounterModule = { default: () => unknown };

async function smokeCounterUI(
  label: string,
  appPath: string,
): Promise<void> {
  _reset();
  storage.clear();
  const { default: App } = await import(appPath) as CounterModule;
  ensureConnected(); // boots the standalone loop from the cell registry
  const { win, root, cleanup } = createDOM();
  try {
    // deno-lint-ignore no-explicit-any
    const handle = mount(root, App as any);
    assertStringIncludes(root.innerHTML, ">0<", `${label}: initial count 0`);
    const buttons = Array.from(root.querySelectorAll("button"));
    const plus = buttons.find((b) => b.textContent === "+")!;
    const minus = buttons.find((b) => b.textContent === "−")!;
    const reset = buttons.find((b) => b.textContent?.match(/reset/i))!;

    plus.click();
    plus.click();
    await tick();
    assertStringIncludes(root.innerHTML, ">2<", `${label}: count after 2×+`);

    minus.click();
    await tick();
    assertStringIncludes(root.innerHTML, ">1<", `${label}: count after −`);

    reset.click();
    await tick();
    assertStringIncludes(root.innerHTML, ">0<", `${label}: count after reset`);
    _unmount(handle);
  } finally {
    await cleanup();
    _reset();
  }
}

const COUNTER_UIS: [string, string][] = [
  ["counter", "../examples/counter/App.tsx"],
  ["targets/browser", "../examples/targets/browser/src/App.tsx"],
  ["targets/browser-remote", "../examples/targets/browser-remote/src/App.tsx"],
  ["targets/electron", "../examples/targets/electron/src/App.tsx"],
  ["targets/android", "../examples/targets/android/src/App.tsx"],
];

for (const [label, path] of COUNTER_UIS) {
  Deno.test({
    name: `example UI ${label}: user clicks drive the rendered counter`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: () => smokeCounterUI(label, path),
  });
}

// ── Todo app: add, toggle, filter — full user flow ────────────────────

Deno.test({
  name: "example UI todo: add via form, toggle via checkbox, footer counts",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _reset();
    storage.clear();
    const { default: App } = await import(
      "../examples/todo/App.tsx"
    ) as CounterModule;
    ensureConnected();
    const { win, root, cleanup } = createDOM();
    try {
      // deno-lint-ignore no-explicit-any
      const handle = mount(root, App as any);

      // Add two todos like a user: type + submit
      const input = root.querySelector("input")! as HTMLInputElement;
      const form = root.querySelector("form")!;
      await type(win, input, "buy milk");
      form.dispatchEvent(
        ev(win, "submit", { bubbles: true, cancelable: true }),
      );
      await tick();
      const input2 = root.querySelector("input")! as HTMLInputElement;
      await type(win, input2, "write tests");
      root.querySelector("form")!.dispatchEvent(
        ev(win, "submit", { bubbles: true, cancelable: true }),
      );
      await tick();

      assertStringIncludes(root.innerHTML, "buy milk");
      assertStringIncludes(root.innerHTML, "write tests");
      assertStringIncludes(root.innerHTML, "2 items left");

      // Toggle the first todo done
      const checkbox = root.querySelector('input[type="checkbox"]')!;
      (checkbox as HTMLElement).dispatchEvent(
        ev(win, "input", { bubbles: true }),
      );
      await tick();
      assertStringIncludes(root.innerHTML, "1 item left");

      // Filter to done — only the toggled item remains visible
      const doneBtn = Array.from(root.querySelectorAll("button")).find(
        (b) => b.textContent === "done",
      )!;
      doneBtn.click();
      await tick();
      assertStringIncludes(root.innerHTML, "buy milk");
      assert(
        !root.innerHTML.includes("write tests"),
        "active item hidden under 'done' filter",
      );
      _unmount(handle);
    } finally {
      await cleanup();
      _reset();
    }
  },
});

// ── Connect page (thin android client): typed URL is navigated to ─────

Deno.test({
  name: "example UI android-remote: connect page navigates to typed server",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _reset();
    const { default: App } = await import(
      "../examples/targets/android-remote/src/App.tsx"
    ) as CounterModule;
    const { win, root, cleanup } = createDOM();
    const fakeWindow = { location: { href: "" } };
    // deno-lint-ignore no-explicit-any
    const g = globalThis as any;
    const hadWindow = "window" in g;
    const origWindow = g.window;
    g.window = fakeWindow;
    try {
      // deno-lint-ignore no-explicit-any
      const handle = mount(root, App as any);
      const input = root.querySelector("input")! as HTMLInputElement;
      await type(win, input, "http://server:8000");
      Array.from(root.querySelectorAll("button")).find(
        (b) => b.textContent === "Connect",
      )!.click();
      assertEquals(fakeWindow.location.href, "http://server:8000");
      _unmount(handle);
    } finally {
      if (hadWindow) g.window = origWindow;
      else delete g.window;
      await cleanup();
      _reset();
    }
  },
});
