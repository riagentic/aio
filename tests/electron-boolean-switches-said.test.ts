// The Electron security switches say so when they are not booleans.
//
// `electronMetaPolicy` reads them for truthiness (`!!cfg.webviewTag`) and
// `strictPin` for `=== true`, and nothing checked the type: so
// `electron: { unsandboxedChildWindows: "false" }` turned the sandbox opt-out
// ON, `webviewTag: "false"` enabled `<webview>`, and `strictPin: "true"` left
// the pin OFF — an app that believes it is protected and is not, in silence.
//
// Warned, never refused: each booted through 1.0.24 (the frozen surface).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetConfigConflicts,
  electronBooleanProblems,
  VALID_FEATURES_CONFIG_KEYS,
  validateConfig,
} from "../src/server/config.ts";
import { electronMetaPolicy } from "../src/electron/electron-shared.ts";

Deno.test("electronBooleanProblems: booleans and absent say nothing", () => {
  assertEquals(
    electronBooleanProblems({
      requireSandbox: true,
      unsandboxedChildWindows: false,
      webviewTag: false,
      strictPin: true,
    }),
    [],
  );
  assertEquals(electronBooleanProblems({}), []);
});

Deno.test("electronBooleanProblems: each says what the window will really do", () => {
  const cfg = {
    unsandboxedChildWindows: "false",
    webviewTag: 0,
    strictPin: "true",
  };
  const p = electronBooleanProblems(cfg);
  assertEquals(p.length, 3, p.join("\n"));
  // …and what it says is what the reader does.
  const meta = electronMetaPolicy(cfg as never);
  assertStringIncludes(p[0]!, "electron.unsandboxedChildWindows");
  assertStringIncludes(p[0]!, meta.unsandboxedChildWindows ? "ON" : "OFF");
  assertStringIncludes(p[1]!, meta.webviewTag ? "ON" : "OFF");
  assertStringIncludes(p[2]!, "electron.strictPin");
  assertStringIncludes(p[2]!, meta.strictPin ? "ON" : "OFF");
});

Deno.test("validateConfig: a string security switch is WARNED once, and the app still boots", () => {
  _resetConfigConflicts();
  const lines: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  for (const k of ["error", "warn", "log"] as const) {
    console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  }
  let code: number | null = null;
  const exit = ((c: number) => {
    code = c;
    throw new Error("exit");
  }) as (c: number) => never;
  try {
    const cfg = { electron: { unsandboxedChildWindows: "false" } };
    validateConfig(cfg, VALID_FEATURES_CONFIG_KEYS, "CellsConfig", exit);
    validateConfig(cfg, VALID_FEATURES_CONFIG_KEYS, "CellsConfig", exit);
  } finally {
    Object.assign(console, orig);
    _resetConfigConflicts();
  }
  assertEquals(code, null, "warned, not refused");
  const said = lines.filter((l) =>
    l.includes("electron.unsandboxedChildWindows")
  );
  assertEquals(said.length, 1, lines.join("\n"));
  assert(said[0]!.includes("read as ON"), said[0]);
});
