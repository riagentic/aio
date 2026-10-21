// What each aio app can decide about its desktop windows (one table in
// docs/build/targets.md): every option has a default that is today's
// behaviour, and a typo or a wrong value fails loud by name.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  electronDownloadWindowRefusal,
  electronShowRefusal,
  VALID_ELECTRON_KEYS,
} from "../src/server/config.ts";
import { identityDialogColors } from "../src/build/app-theme.ts";
import {
  tmplShowWhenPainted,
  tmplWindowShape,
  WINDOW_SHOW_CAP_MS,
} from "../src/electron/electron-shared.ts";
import {
  MAC_PROGRESS_JXA,
  WINDOWS_PROGRESS_PS,
  zenityProgressArgs,
} from "../src/electron/runtime-dialog.ts";

Deno.test("options: electron.showWhenPainted — true, false or { capMs } (100..60000); anything else refused by name", () => {
  assert(VALID_ELECTRON_KEYS.has("showWhenPainted"));
  for (const ok of [undefined, true, false, { capMs: 800 }]) {
    assertEquals(electronShowRefusal(ok), null, JSON.stringify(ok));
  }
  for (
    const [bad, says] of [
      ["yes", "true, false or { capMs }"],
      [{ capMs: 50 }, "100 to 60000"],
      [{ capMs: 1.5 }, "100 to 60000"],
      [{ cap: 800 }, '"cap" is not a key'],
    ] as const
  ) {
    assertStringIncludes(electronShowRefusal(bad)!, says);
  }
});

Deno.test("options: electron.downloadWindow — its texts, the splash's colour keys, cancel; a typo or a wrong value refused by name", () => {
  assert(VALID_ELECTRON_KEYS.has("downloadWindow"));
  assertEquals(
    electronDownloadWindowRefusal({
      heading: "Setting up {title}",
      text: "{got} of {total} MB",
      question: "{reason}",
      background: "#000000",
      color: "#ffffff",
      bar: { color: "#14f195", track: "#202020" },
      cancel: false,
    }),
    null,
  );
  assertEquals(electronDownloadWindowRefusal(undefined), null);
  for (
    const [bad, says] of [
      ["x", "must be an object"],
      [{ heading: "" }, "heading must be a non-empty string"],
      [{ colour: "#fff" }, '"colour" is not a key'],
      [{ color: "white" }, 'color must be "#rrggbb"'],
      [{ bar: { colour: "#000000" } }, 'bar: "colour" is not a key'],
      [{ bar: { color: "#00f" } }, 'bar.color must be "#rrggbb"'],
      [{ cancel: "no" }, "cancel must be true or false"],
    ] as const
  ) {
    assertStringIncludes(electronDownloadWindowRefusal(bad)!, says);
  }
});

Deno.test("options: a downloadWindow colour the app set is used in both modes; the rest stay the identity's", () => {
  const id = identityDialogColors("com.example.notes");
  const set = identityDialogColors("com.example.notes", {
    background: "#000000",
    bar: { color: "#14f195" },
  });
  for (const m of ["light", "dark"] as const) {
    assertEquals(set[m], {
      ...id[m],
      background: "#000000",
      bar: "#14f195",
    });
  }
});

/** The show code, run against a fake window. */
function show(opt?: boolean | { capMs: number }) {
  const calls: string[] = [];
  const timers: number[] = [];
  const handlers: Record<string, () => void> = {};
  new Function(
    "win",
    "__aioRestoreMax",
    "__aioBgNow",
    "setTimeout",
    "clearTimeout",
    "console",
    "require",
    "process",
    "__aioPlaced",
    tmplShowWhenPainted(opt),
  )(
    {
      isDestroyed: () => false,
      show: () => calls.push("show"),
      getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
      once: (e: string, f: () => void) => (handlers[e] = f),
      on: () => {},
    },
    false,
    () => null,
    (_f: () => void, ms: number) => timers.push(ms),
    () => {},
    { warn() {} },
    () => ({ screen: {} }),
    { platform: "linux", stderr: { write() {} } },
    null,
  );
  return { calls, timers, handlers };
}

Deno.test("options: showWhenPainted false shows the window the moment it is made; { capMs } is the cap; the default is today's (5000 ms, at its paint)", () => {
  const def = show();
  assertEquals(def.calls, [], "hidden until painted");
  assertEquals(def.timers, [WINDOW_SHOW_CAP_MS]);
  const cap = show({ capMs: 800 });
  assertEquals(cap.timers, [800]);
  const now = show(false);
  assertEquals(now.calls, ["show"], "shown at once");
  assertEquals(now.timers, [], "no cap");
  assertStringIncludes(
    tmplWindowShape({ showWhenPainted: false }),
    "b.show = true;",
  );
  assertStringIncludes(tmplWindowShape({}), "b.show = false;");
});

Deno.test("options: downloadWindow.cancel false — no Cancel button on any OS (the close still cancels)", () => {
  assertStringIncludes(
    WINDOWS_PROGRESS_PS,
    "$c.Visible = $env:AIO_DLG_CANCEL -ne '0'",
  );
  assertStringIncludes(MAC_PROGRESS_JXA, "const withCancel = argv[9] !== '0';");
  assertStringIncludes(MAC_PROGRESS_JXA, "cancel.hidden = !withCancel;");
  const yad = (c: boolean) =>
    zenityProgressArgs("yad", "N", "H", c).filter((a) => a.includes("button"));
  assertEquals(yad(true), ["--button=Cancel:1"]);
  assertEquals(yad(false), ["--no-buttons"]);
});
