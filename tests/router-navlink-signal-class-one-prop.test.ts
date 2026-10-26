// `<Link>`/`<NavLink>` with a SIGNAL `class`/`className` emitted two class
// props (the spread `class: sig` plus `className: cls`). The later
// `className` won, so a bound `class` vanished, and an ACTIVE bound
// `className` was string-joined: `class="[object Function] active"`.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { type ComponentFn, h } from "../src/air/vdom.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _setRouterBoot, NavLink } from "../src/air/router.ts";
import { routePath } from "../src/air/router-core.ts";
import { signal } from "../src/state/signal.ts";
import { closeWindow } from "../src/testing/close-window.ts";

const N = NavLink as ComponentFn;

function quiet<T>(fn: () => T): { out: T; said: string[] } {
  const said: string[] = [];
  const w = console.warn, e = console.error;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  console.error = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    return { out: fn(), said };
  } finally {
    console.warn = w;
    console.error = e;
  }
}

for (const key of ["class", "className"]) {
  for (const [route, want] of [["/a", "nav active"], ["/b", "nav"]]) {
    Deno.test(`NavLink signal ${key} at ${route} renders "${want}", one class prop`, () => {
      const s = signal("nav");
      const { out, said } = quiet(() =>
        renderToString(h(N, { to: "/a", [key]: s }, "A"), { route })
      );
      assertEquals(out, `<a href="/a" class="${want}">A</a>`);
      assertEquals(said.filter((m) => m.includes("BOTH")), []);
    });
  }
}

Deno.test("an active NavLink keeps a signal class live, with the active class joined", async () => {
  _setRouterBoot(() => {});
  const g = globalThis as Record<string, unknown>;
  const prevLoc = g.location;
  const href = "https://localhost/a";
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL(href),
  });
  const win = new Window({ url: href });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const host = doc.createElement("main");
  doc.body.appendChild(host);
  routePath.set("/a");
  const s = signal("red");
  const handle = mount(host, () => h(N, { to: "/a", class: s }, "A"));
  try {
    const a = host.querySelector("a")!;
    assertEquals(a.getAttribute("class"), "red active");
    s.set("blue");
    assertEquals(a.getAttribute("class"), "blue active");
  } finally {
    _unmount(handle);
    host.remove();
    routePath.set("/");
    _setRouterBoot(null);
    if (prevLoc === undefined) delete g.location;
    else {
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: prevLoc,
      });
    }
    await closeWindow(win);
  }
});
