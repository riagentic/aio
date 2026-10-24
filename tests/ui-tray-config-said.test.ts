// `ui.tray` is said at boot when the window will not do what it says.
//
// The tray lives in Electron's main process, which reads `ui.tray`
// leniently: a non-object is no tray at all, an item without a label is
// skipped, `closeToTray: "false"` is truthy (the window HIDES on close), and
// an item whose `method` is `"counter.reset"` (a dot, not `cell:method`)
// relays a click the page then drops. Every one of them booted in silence and
// surfaced only when someone opened the tray menu of the shipped app.
//
// Warned, never refused: each booted through 1.0.24 (the frozen surface).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetConfigConflicts,
  trayProblems,
  VALID_FEATURES_CONFIG_KEYS,
  validateConfig,
} from "../src/server/config.ts";

Deno.test("trayProblems: a good tray says nothing", () => {
  assertEquals(trayProblems(undefined), []);
  assertEquals(trayProblems(true), []);
  assertEquals(trayProblems(false), []);
  assertEquals(
    trayProblems({
      tooltip: "t",
      closeToTray: true,
      menu: [
        { label: "Reset", method: "counter:reset", args: [1] },
        "-",
        { label: "Settings", route: "/settings" },
      ],
    }),
    [],
  );
});

Deno.test("trayProblems: every lenient read is named", () => {
  assertStringIncludes(trayProblems("yes")[0]!, "NO tray is shown");
  assertStringIncludes(trayProblems([])[0]!, "NO tray is shown");
  const p = trayProblems({
    tooltp: "x",
    tooltip: 5,
    closeToTray: "false",
    menu: [
      { label: "A", method: "counter.reset" },
      { method: "c:m" },
      { label: "B", method: "c:m", args: "x", rout: "/" },
      { label: "C", route: 5 },
      7,
    ],
  }).join("\n");
  for (
    const s of [
      'ui.tray.tooltp is not a key aio reads (did you mean "tooltip"?)',
      "ui.tray.tooltip is 5",
      'ui.tray.closeToTray is "false"',
      'ui.tray.menu[0].method is "counter.reset"',
      "ui.tray.menu[1] has no label",
      'ui.tray.menu[2].args is "x"',
      'ui.tray.menu[2].rout is not a key aio reads (did you mean "route"?)',
      "ui.tray.menu[3].route is 5",
      "ui.tray.menu[4] is 7",
    ]
  ) assertStringIncludes(p, s);
  assertStringIncludes(trayProblems({ menu: "x" })[0]!, "not a list");
});

Deno.test("validateConfig: a broken ui.tray is WARNED once, and the app still boots", () => {
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
    const cfg = { ui: { tray: { closeToTray: "false" } } };
    // Twice, as aio.run() validates the config on the way in and through.
    validateConfig(cfg, VALID_FEATURES_CONFIG_KEYS, "CellsConfig", exit);
    validateConfig(cfg, VALID_FEATURES_CONFIG_KEYS, "CellsConfig", exit);
  } finally {
    Object.assign(console, orig);
    _resetConfigConflicts();
  }
  assertEquals(code, null, "warned, not refused");
  const said = lines.filter((l) => l.includes("ui.tray.closeToTray"));
  assertEquals(said.length, 1, lines.join("\n"));
  assert(said[0]!.includes("truthiness"), said[0]);
});
