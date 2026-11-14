// React-compat hooks keep two React guarantees AIR broke until 1.0.28:
// a no-deps useEffect runs AFTER the commit (it ran during render, reading
// `ref.current` as undefined), and the useState setter is the same function
// on every render (a fresh one per render was a changed dep per render).
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h, useEffect, useRef, useState } from "../src/air.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { closeWindow } from "../src/testing/close-window.ts";

Deno.test("no-deps useEffect sees the committed DOM (mount and re-render)", async () => {
  const win = new Window({ url: "https://localhost" });
  _setDocument(win.document);
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  const log: string[] = [];
  let bump!: () => void;
  function App() {
    const box = useRef<HTMLElement | null>(null);
    const [n, setN] = useState(0);
    bump = () => setN(n + 1);
    useEffect(() => {
      log.push(`${box.current?.tagName}:${box.current?.textContent}`);
    });
    return h("section", { ref: box }, String(n));
  }
  const hd = mount(root, App);
  await new Promise((r) => setTimeout(r, 10));
  bump();
  await new Promise((r) => setTimeout(r, 10));
  _unmount(hd);
  await closeWindow(win);
  // React 19: ["SECTION:0", "SECTION:1"]
  assertEquals(log, ["SECTION:0", "SECTION:1"]);
});
const tick = () => new Promise((r) => setTimeout(r, 5));

Deno.test("useState setter is identity-stable across renders", async () => {
  const win = new Window({ url: "https://localhost" });
  _setDocument(win.document);
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  const setters: unknown[] = [];
  let bump!: () => void;
  function App() {
    const [n, setN] = useState(0);
    setters.push(setN);
    bump = () => setN(n + 1);
    return h("b", null, String(n));
  }
  const hd = mount(root, App);
  await tick();
  bump();
  await tick();
  _unmount(hd);
  await closeWindow(win);
  assert(setters.length >= 2);
  assertStrictEquals(setters[1], setters[0]);
});

Deno.test("fetch-on-mount keyed on the setter runs once, not forever", async () => {
  const win = new Window({ url: "https://localhost" });
  _setDocument(win.document);
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  let loads = 0;
  const load = () => {
    loads++;
    return Promise.resolve([1, 2, 3]); // a fresh array, as JSON from a fetch is
  };
  function App() {
    const [rows, setRows] = useState<number[]>([]);
    useEffect(() => {
      load().then(setRows);
    }, [setRows]);
    return h("b", null, String(rows.length));
  }
  const hd = mount(root, App);
  for (let i = 0; i < 20; i++) await tick();
  _unmount(hd);
  await closeWindow(win);
  // React 19: 1 load.
  assertStrictEquals(loads, 1);
});
