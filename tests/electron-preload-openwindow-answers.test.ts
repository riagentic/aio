// The renderer half of "every refusal SAYS which guardrail fired".
//
// The main process writes an excellent openWindow refusal — it names the
// config key to add — and then `ipcRenderer.send` threw it away: `send` is
// one-way, so the caller got `undefined` back and the reason was audible only
// to whoever was reading the MAIN process console. The app author, who is the
// only person who can act on it, is in the renderer.
//
// A field report measured what that costs. Their caller was
// `openWindow(url, opts).catch(fallBackToSystemBrowser)`. `undefined` has no
// `.catch`, so the TypeError took the fallback branch and the page opened in
// the user's system browser — forever, silently, for a rule nobody was told
// about. Two independent silent paths to the same wrong outcome.
//
// This RUNS the generated preload against a fake `electron` rather than
// grepping it for "invoke": the whole bug was a value that never arrived, and
// only calling it can show that it does now.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { udsPreloadScript } from "../src/electron/electron-shared.ts";

type Bridge = {
  openWindow: (url: string, opts?: unknown) => unknown;
  openExternal: (url: string) => unknown;
};

/** Evaluate the preload with a fake `electron`, and hand back what it exposed
 *  plus what it asked the main process for. */
function loadPreload(
  onInvoke: (channel: string, arg: unknown) => Promise<unknown>,
): { api: Bridge; sends: string[] } {
  let api: Bridge | undefined;
  const sends: string[] = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, value: unknown) {
        if (name === "__aioIPC") api = value as Bridge;
      },
    },
    ipcRenderer: {
      send: (ch: string) => void sends.push(ch),
      on: () => {},
      invoke: onInvoke,
    },
  };
  // The script's tail (the shell bridge) touches the DOM at load. It is not
  // what this test is about, so it gets a tolerant stub: anything read off it
  // is a callable that returns another one. Deliberately permissive — a
  // stricter fake would fail on the shell bridge's own business and tell us
  // nothing about openWindow. The `electron` fake above is the strict one,
  // and it is the one the assertions read.
  const dom = (): unknown =>
    new Proxy(function () {} as unknown as object, {
      get: (_t, k) => (k === "readyState" ? "complete" : dom()),
      apply: () => dom(),
      has: () => true,
    });

  new Function("require", "document", "window", udsPreloadScript())(
    (m: string) => {
      if (m !== "electron") throw new Error("unexpected require: " + m);
      return electron;
    },
    dom(),
    dom(),
  );
  assert(api, "the preload must expose __aioIPC");
  return { api, sends };
}

Deno.test("openWindow ANSWERS the renderer: a refusal arrives as a rejection", async () => {
  const { api } = loadPreload((_ch, _arg) =>
    Promise.reject(
      new Error(
        "openWindow refused — sandbox: false — this app has not opted in. " +
          "add aio.run({ electron: { unsandboxedChildWindows: true } })",
      ),
    )
  );

  const returned = api.openWindow("https://x.test/", { sandbox: false });
  // The bug in one assertion: this used to be `undefined`, which is why a
  // `.catch(...)` caller threw a TypeError and fell back instead.
  assert(
    typeof (returned as Promise<unknown>)?.catch === "function",
    "openWindow must return a thenable, or a .catch() caller falls back",
  );

  let rejected = false;
  let message = "";
  await (returned as Promise<unknown>).catch((e: Error) => {
    rejected = true;
    message = String(e.message);
  });
  assert(rejected, "a refused openWindow must REJECT, not resolve");
  // The reason reaches the only person who can act on it — including the
  // exact key to add, which the main process already took the trouble to name.
  assertStringIncludes(message, "unsandboxedChildWindows");
});

Deno.test("openWindow forwards the url and options it was given", async () => {
  const seen: { ch: string; arg: unknown }[] = [];
  const { api } = loadPreload((ch, arg) => {
    seen.push({ ch, arg });
    return Promise.resolve({ ok: true, url: "https://x.test/" });
  });

  const r = await api.openWindow("https://x.test/", { preload: "/app/b.js" });
  assertEquals(seen.length, 1);
  assertEquals(seen[0]!.ch, "__aio:openWindow");
  assertEquals(seen[0]!.arg, {
    url: "https://x.test/",
    preload: "/app/b.js",
  });
  assertEquals(r, { ok: true, url: "https://x.test/" });
});

Deno.test("a call with no options still carries a well-formed payload", async () => {
  // `{ url, ...(opts || {}) }` — a missing opts must not spread `undefined`
  // into the frame, which would make the main process's own guards read a
  // shape they never validated.
  const seen: unknown[] = [];
  const { api } = loadPreload((_ch, arg) => {
    seen.push(arg);
    return Promise.resolve({ ok: true });
  });
  await api.openWindow("https://x.test/");
  assertEquals(seen[0], { url: "https://x.test/" });
});

Deno.test("the one-way calls stay one-way", () => {
  // Not everything should answer. `openExternal` hands the URL to the OS and
  // there is nothing to wait for — turning it into an invoke would add a
  // promise every caller would then be expected to await.
  const invoked: string[] = [];
  const { api, sends } = loadPreload((ch) => {
    invoked.push(ch);
    return Promise.resolve(null);
  });
  // Measure the DELTA: the shell bridge does its own sends at load, and this
  // test is about openExternal, not about how many frames the preload opens
  // with. Asserting the whole array would make it fail whenever something
  // unrelated is added — a test that breaks for the wrong reason gets
  // "fixed" by loosening it, and then it guards nothing.
  const before = sends.length;
  api.openExternal("https://x.test/");
  assertEquals(sends.slice(before), ["__aio:openExternal"]);
  assertEquals(invoked, [], "openExternal must not wait for an answer");
});
