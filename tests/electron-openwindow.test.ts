// risoto openWindow — the electron child-window capability, gated + hardened.
// Electron main-process code can't run in CI, so we test the GENERATED script:
// the gate reflects config.childWindows, the handler + guardrails are present,
// and sandbox defaults ON. (The maintainer decision, made concrete.)
import { assert, assertStringIncludes } from "@std/assert";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { udsPreloadScript } from "../src/electron/electron-shared.ts";

const gen = (childWindows: boolean) =>
  electronMainScriptUDS("http://127.0.0.1:8000", "/tmp/x.sock", {
    baseDir: "/app",
    title: "t",
    meta: { childWindows },
  });

Deno.test("openWindow: gate reflects config.childWindows", () => {
  assertStringIncludes(gen(true), "const CHILD_WINDOWS = true");
  assertStringIncludes(gen(false), "const CHILD_WINDOWS = false");
});

Deno.test("openWindow: handler + guardrails present in the generated main", () => {
  const s = gen(true);
  assertStringIncludes(s, "__aio:openWindow");
  assertStringIncludes(s, "openWindow denied"); // gated when off
  assertStringIncludes(s, "http:"); // http/https only
  assertStringIncludes(s, "realpathSync"); // symlink-escape check
  assertStringIncludes(s, "sandbox DISABLED by app request"); // loud opt-out
  // sandbox defaults ON: only false when explicitly requested.
  assertStringIncludes(s, "payload.sandbox === false ? false : true");
});

Deno.test("openWindow: preload bridge exposes openWindow → IPC", () => {
  const p = udsPreloadScript();
  assertStringIncludes(p, "openWindow");
  assert(
    p.includes("__aio:openWindow"),
    "preload forwards to the main handler",
  );
});
