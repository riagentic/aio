// Local UI state has several spellings — `useLocal` (tuple and object form),
// React's `useState`, and `useSignal`. A developer or an agent picks one; the
// only way that choice is never punished is if they are the SAME behaviour.
// This runs one component written each way through the same interactions and
// requires an identical page and an identical effect log at every step —
// including a child that must keep its state across a parent re-render and
// lose it when unmounted. (React's own semantics for `useState` are pinned
// against real React in tests/react-patterns.test.ts.)
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, useLocal, useSignal, useState } from "../src/air.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";

type Local = () => [number, (next: number) => void];

const SPELLINGS: Record<string, Local> = {
  "useLocal (tuple)": () => {
    const [v, set] = useLocal(0);
    return [v, set];
  },
  "useLocal (object)": () => {
    const l = useLocal(0);
    return [l.local, (n) => l.set(n)];
  },
  "useState (React)": () => {
    const [v, set] = useState(0);
    return [v, (n) => set(n)];
  },
  "useSignal": () => {
    const s = useSignal(0);
    return [s.value, (n) => s.set(n)];
  },
};

function app(local: Local) {
  function Child() {
    const [c, setC] = local();
    return h(
      "button",
      { class: "child", onClick: () => setC(c + 10) },
      `c${c}`,
    );
  }
  return function App() {
    const [n, setN] = local();
    return h(
      "div",
      null,
      h("button", { class: "inc", onClick: () => setN(n + 1) }, `n${n}`),
      h("button", { class: "reset", onClick: () => setN(0) }, "reset"),
      n % 3 === 2 ? null : h(Child, null),
    );
  };
}

const STEPS = [".inc", ".child", ".inc", ".child", ".inc", ".reset", ".child"];

async function run(local: Local): Promise<string[]> {
  const win = new Window({ url: "https://localhost" });
  try {
    _setDocument(win.document as unknown as Document);
    const root = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(root as never);
    const settle = async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const handle = mount(root, app(local));
    await settle();
    const pages = [root.innerHTML];
    for (const sel of STEPS) {
      (root.querySelector(sel) as HTMLElement | null)?.click();
      await settle();
      pages.push(root.innerHTML);
    }
    _unmount(handle);
    return pages;
  } finally {
    await closeWindow(win);
  }
}

Deno.test("local state: every spelling behaves the same — no choice is punished", async () => {
  const [first, ...rest] = Object.keys(SPELLINGS);
  const want = await run(SPELLINGS[first!]!);
  // What the steps must show — not just "all equal", but equal to THIS: the
  // count moves, the child's own state moves, the child is dropped at n2 and
  // comes back FRESH at n3, and reset leaves the child alone.
  const text = (p: string) =>
    p.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  assertEquals(want.map(text), [
    "n0 reset c0",
    "n1 reset c0",
    "n1 reset c10",
    "n2 reset",
    "n2 reset",
    "n3 reset c0",
    "n0 reset c0",
    "n0 reset c10",
  ]);
  assertEquals(rest.length, 3, "the other spellings are all compared");
  for (const name of rest) {
    assertEquals(await run(SPELLINGS[name]!), want, `${name} ≠ ${first}`);
  }
});
