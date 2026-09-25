// `<Browser>` — an embedded page, with the two traps closed.
//
// Electron's `<webview>` is how an aio app shows somebody else's page inside
// its own, and every author meets the same two problems in hour one (report 5
// §2):
//
//  1. A REACTIVE `src` IS AN INFINITE NAVIGATION LOOP. Setting `src` navigates;
//     navigating fires `did-navigate`; an app writes that to state; state
//     re-renders; the render sets `src` again. The page flickers and never
//     settles, and nothing in the stack says why.
//  2. UNMOUNTING DESTROYS THE GUEST — its scroll, its forms and its LOGIN — so
//     a tab switch silently signs the user out of the page they were reading.
//
// The guest is Electron's, so these drive the RULES against a stand-in that
// behaves the way the tag does: `src` is what it reads before it is ready,
// `loadURL` is what it takes afterwards, and `getURL` is where it is now.
import { assert, assertEquals } from "@std/assert";
import { Browser, navigate } from "../src/ui/browser.ts";

type Fake = {
  src: string;
  loads: string[];
  loadURL(url: string): Promise<void>;
  getURL(): string;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  attrs: Record<string, string>;
};

const fake = (src = ""): Fake => {
  const f: Fake = {
    src,
    loads: [],
    attrs: {},
    loadURL(url: string) {
      f.loads.push(url);
      f.src = url;
      return Promise.resolve();
    },
    getURL: () => f.src,
    setAttribute: (k, v) => {
      f.attrs[k] = v;
    },
    getAttribute: (k) => f.attrs[k] ?? null,
  };
  return f;
};

// deno-lint-ignore no-explicit-any
const nav = (f: Fake, url: string) => navigate(f as any, url);

Deno.test("the SAME url twice navigates once — this is the loop, broken", () => {
  const f = fake("https://a.test/");
  nav(f, "https://b.test/");
  assertEquals(f.loads, ["https://b.test/"]);
  // Every subsequent render passes the same `src`. If any of these navigated,
  // the page would never settle.
  for (let i = 0; i < 20; i++) nav(f, "https://b.test/");
  assertEquals(f.loads, ["https://b.test/"], "a re-render is not a navigation");
});

Deno.test("a REAL change navigates", () => {
  const f = fake("https://a.test/");
  nav(f, "https://b.test/");
  nav(f, "https://c.test/");
  assertEquals(f.loads, ["https://b.test/", "https://c.test/"]);
});

Deno.test("before the guest is ready it is `src`, after it is `loadURL`", () => {
  // The tag reads `src` on first paint and cannot be `loadURL`'d yet; once it
  // has a URL, `loadURL` is the API that actually navigates it.
  const fresh = fake("");
  nav(fresh, "https://first.test/");
  assertEquals(fresh.loads, [], "nothing to loadURL before it is attached");
  assertEquals(fresh.attrs.src, "https://first.test/");
  nav(fresh, "https://second.test/");
  assertEquals(fresh.loads, ["https://second.test/"], "…and loadURL after");
});

Deno.test("an empty src does nothing at all", () => {
  const f = fake("https://a.test/");
  nav(f, "");
  assertEquals(f.loads, []);
});

Deno.test("a guest that refuses a navigation does not take the page with it", () => {
  // An offline host or a blocked scheme is the guest's business and shows in
  // its own error page; a rejected promise here must not reach the app.
  const f = fake("https://a.test/");
  // deno-lint-ignore no-explicit-any
  (f as any).loadURL = () => Promise.reject(new Error("ERR_NAME_NOT_RESOLVED"));
  nav(f, "https://nope.test/");
  // Reached without throwing, and the URL is remembered so the next render
  // does not retry it in a loop.
  assertEquals(f.getURL(), "https://a.test/");
});

Deno.test("it renders a plain <webview>, so Electron's own API stays reachable", () => {
  const v = Browser({ src: "https://a.test/", partition: "persist:reader" });
  assertEquals(v.tag, "webview");
  assertEquals(v.props.partition, "persist:reader");
  // The URL is NOT a prop: an attribute is re-applied by the renderer on every
  // pass, and re-applying `src` is the loop this component exists to close.
  assertEquals(
    v.props.src,
    undefined,
    "`src` as an attribute would be applied on every render",
  );
  assertEquals(typeof v.props.use, "function", "it is applied imperatively");
});

// ── Mounted, through the real renderer ──────────────────────────────────────
// The rules above hold for one call; these hold for a component that
// RE-RENDERS, which every app's does. The mount used to be a closure written
// inside `Browser`, so each render handed the renderer a new action and it
// ran the teardown and the mount again: with `keepAlive` a guest was torn
// down on the first re-render — the docstring's own `onNavigate` → state →
// re-render example.

import { h } from "../src/air/vdom.ts";
import { signal } from "../src/air/aio-renderer.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { _clearKept } from "../src/ui/browser.ts";

async function mountedBrowser() {
  const url = signal("https://a.test/");
  const show = signal(true);
  const tick = signal(0);
  const navs: string[] = [];
  const refs: (Element | null)[] = [];
  const ui = await testUI(() =>
    h(
      "div",
      { id: "host" },
      `tick ${tick.value}`,
      show.value
        ? h(Browser, {
          src: url.value,
          keepAlive: "reader",
          onNavigate: (u: string) => navs.push(u),
          ref: (el: Element | null) => refs.push(el),
        })
        : null,
      // After the guest, so a removal that throws leaves it stale.
      h("span", { id: "after" }, `after ${tick.value}`),
    )
  );
  const guests = () => [...ui.document.querySelectorAll("webview")];
  const parent = (el: Element) => el.parentElement?.id;
  return { ui, url, show, tick, guests, parent, refs };
}

Deno.test("keepAlive: a re-render leaves the guest on the page, and a src change navigates it", async () => {
  const { ui, url, tick, guests, parent, refs } = await mountedBrowser();
  try {
    await ui.settle();
    const first = guests();
    assertEquals(first.length, 1);
    assertEquals(parent(first[0]!), "host");
    tick.set(1);
    await ui.settle();
    assertEquals(guests().length, 1);
    assertEquals(
      parent(guests()[0]!),
      "host",
      "an unrelated re-render must not park the guest",
    );
    url.set("https://b.test/");
    await ui.settle();
    assertEquals(guests()[0], first[0], "the same guest, not a new one");
    assertEquals(parent(guests()[0]!), "host");
    assertEquals(guests()[0]!.getAttribute("src"), "https://b.test/");
    // Mounted ONCE: a re-render that tore the guest down and mounted it again
    // tells `ref` null and then the element, every time.
    assertEquals(refs, [first[0]]);
  } finally {
    await ui.dispose();
    _clearKept();
  }
});

// `keepAlive` used to MOVE the guest into a display:none holder and back.
// Electron destroys a `<webview>` on any move (real Electron:
// tests/electron-browser-keepalive-e2e.test.ts), so every restore showed a
// dead, blank element. It now keeps where the guest WAS, and the next mount
// under the id opens there.
async function remountable(keepAlive: string | undefined) {
  const url = signal("https://a.test/");
  const show = signal(true);
  const tick = signal(0);
  const ui = await testUI(() =>
    h(
      "div",
      { id: "host", "data-tick": tick.value },
      show.value ? h(Browser, { src: url.value, keepAlive }) : null,
    )
  );
  const guests = () => [...ui.document.querySelectorAll("webview")];
  return { ui, url, show, tick, guests };
}

/** The guest browsed away from `src` on its own (a link click). */
const browse = (el: Element, to: string) =>
  Object.assign(el, { getURL: () => to });

Deno.test("keepAlive: a remount opens the page the last guest was on, and nothing is moved or hidden", async () => {
  const { ui, show, tick, guests } = await remountable("reader");
  try {
    await ui.settle();
    assertEquals(guests().length, 1);
    browse(guests()[0]!, "https://a.test/page2");
    show.set(false);
    await ui.settle();
    assertEquals(guests().length, 0, "the element leaves with its render");
    show.set(true);
    await ui.settle();
    assertEquals(guests().length, 1);
    assertEquals(guests()[0]!.parentElement?.id, "host");
    assertEquals(guests()[0]!.getAttribute("src"), "https://a.test/page2");
    // The unchanged prop on the next render does not send it back to `src`.
    tick.set(1);
    await ui.settle();
    assertEquals(guests()[0]!.getAttribute("src"), "https://a.test/page2");
  } finally {
    await ui.dispose();
    _clearKept();
  }
});

Deno.test("keepAlive: a src changed while unmounted wins over the kept page", async () => {
  const { ui, url, show, guests } = await remountable("reader");
  try {
    await ui.settle();
    browse(guests()[0]!, "https://a.test/page2");
    show.set(false);
    await ui.settle();
    url.set("https://b.test/");
    show.set(true);
    await ui.settle();
    assertEquals(guests()[0]!.getAttribute("src"), "https://b.test/");
  } finally {
    await ui.dispose();
    _clearKept();
  }
});

Deno.test("without keepAlive a remount starts over at src", async () => {
  const { ui, show, guests } = await remountable(undefined);
  try {
    await ui.settle();
    browse(guests()[0]!, "https://a.test/page2");
    show.set(false);
    await ui.settle();
    show.set(true);
    await ui.settle();
    assertEquals(guests()[0]!.getAttribute("src"), "https://a.test/");
  } finally {
    await ui.dispose();
    _clearKept();
  }
});
