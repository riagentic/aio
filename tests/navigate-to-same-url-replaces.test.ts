// A tray item or a notification click routes through `navigateTo`, which
// ALWAYS pushed a history entry — even for the page the user is already on.
// The router's own `navigate` replaces for a same-URL navigation (the HTML
// rule, and what a plain `<a>` does); this one did not, so clicking a tray
// "Library" item while on /library three times left three identical entries
// and Back looked dead twice. It now replaces for the same URL, still pushes
// for a different one, and fires `popstate` either way so the router syncs.
import { assertEquals } from "@std/assert";
import { navigateTo } from "../src/browser/desktop-notify.ts";

type G = Record<string, unknown>;
const g = globalThis as G;

Deno.test("navigateTo: the current URL replaces its entry, another URL pushes, popstate fires for both", () => {
  const calls: string[] = [];
  let pops = 0;
  const had = {
    history: g.history,
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
    dispatchEvent: g.dispatchEvent,
  };
  const loc = { href: "http://app.test/library" };
  const set = (u: string) => (loc.href = new URL(u, loc.href).href);
  g.history = {
    pushState: (_s: unknown, _t: string, url: string) => {
      calls.push(`push ${url}`);
      set(url);
    },
    replaceState: (_s: unknown, _t: string, url: string) => {
      calls.push(`replace ${url}`);
      set(url);
    },
  };
  Object.defineProperty(globalThis, "location", {
    value: loc,
    configurable: true,
    writable: true,
  });
  g.dispatchEvent = (e: Event) => (e.type === "popstate" && pops++, true);
  try {
    navigateTo("/library"); // already there
    navigateTo("/library");
    navigateTo("/settings");
    navigateTo("/settings?tab=2"); // a different query is a different URL
    assertEquals(calls, [
      "replace /library",
      "replace /library",
      "push /settings",
      "push /settings?tab=2",
    ]);
    assertEquals(pops, 4, "the router is told every time");
  } finally {
    g.history = had.history;
    g.dispatchEvent = had.dispatchEvent;
    if (had.location) {
      Object.defineProperty(globalThis, "location", had.location);
    } else delete g.location;
  }
});
