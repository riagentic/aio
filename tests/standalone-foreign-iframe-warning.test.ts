// A standalone APK's `AioNativeStore` bridge reaches EVERY frame of the
// WebView (`addJavascriptInterface`), while the shell's removal on navigation
// (`onPageStarted`) watches the main frame only — so a third-party <iframe> the
// app embeds can read and overwrite the app's saved state (todo.md). The native
// fix is design-sized; until then the page says so, once per origin, the
// moment such a frame appears.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { _reset, initStandalone } from "../src/standalone-air.ts";

function withGlobals<T>(g: Record<string, unknown>, fn: () => T): T {
  const prev = Object.keys(g).map((k) =>
    [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const
  );
  for (const [k, v] of Object.entries(g)) {
    Object.defineProperty(globalThis, k, {
      value: v,
      writable: true,
      configurable: true,
    });
  }
  try {
    return fn();
  } finally {
    for (const [k, d] of prev) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  }
}

const bridge = {
  get: () => null,
  has: () => false,
  set: () => true,
  describe: () => "/data/x/aio-store",
};

async function boot(native: unknown, add: (d: Document) => void) {
  const win = new Window({
    url: "https://appassets.androidplatform.net/",
    // A fake page: never fetch the frames it is handed.
    settings: { disableIframePageLoading: true },
  });
  const doc = win.document as unknown as Document;
  const errors: string[] = [];
  const realError = console.error;
  const realInfo = console.info;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  console.info = () => {};
  try {
    await withGlobals(
      {
        AioNativeStore: native,
        document: doc,
        MutationObserver: win.MutationObserver,
      },
      async () => {
        _reset();
        initStandalone<{ n: number }, { type: string }, never>({ n: 0 }, {
          reduce: (s) => ({ state: s, effects: [] }),
          execute: () => {},
          persist: false,
        });
        add(doc);
        await new Promise((r) => setTimeout(r, 0));
        _reset();
      },
    );
  } finally {
    console.error = realError;
    console.info = realInfo;
    await closeWindow(win);
  }
  return errors.filter((e) => e.includes("security:"));
}

const frame = (d: Document, src: string) => {
  const f = d.createElement("iframe");
  f.setAttribute("src", src);
  d.body.appendChild(f);
};

Deno.test("foreign iframe: a third-party frame in a standalone APK is named, once", async () => {
  const said = await boot(bridge, (d) => {
    frame(d, "https://tracker.example/embed");
    frame(d, "https://tracker.example/other"); // same origin: said once
  });
  assertEquals(said.length, 1, JSON.stringify(said));
  assert(said[0]!.includes("https://tracker.example"));
  assert(said[0]!.includes("AioNativeStore"));
});

Deno.test("foreign iframe: own-origin / srcdoc frames, or no native bridge, are silent", async () => {
  assertEquals(
    await boot(bridge, (d) => {
      frame(d, "/assets/help.html");
      frame(d, "about:blank");
    }),
    [],
  );
  // A browser preview has no bridge to expose.
  assertEquals(
    await boot(undefined, (d) => frame(d, "https://tracker.example/")),
    [],
  );
});
