// Windows files a notification under the AppUserModelID of the process that
// raised it. An aio window set none, so Windows derived one from the program
// — Electron's — and EVERY aio app's toasts were recorded under
// `electron.app.Electron` (measured on Windows 11, Electron 44: the toast
// shows; its source is that id). With the id set to the app's title the toast
// is filed under the title, shortcut or no shortcut.
import { assert, assertEquals } from "@std/assert";
import { mainScriptAumid } from "../src/electron/electron-spawn.ts";

Deno.test("AppUserModelID: the window's main script sets it to the app's title, on Windows only", () => {
  const line = mainScriptAumid("My Notes");
  assertEquals(
    line,
    `if (process.platform === 'win32') require('electron').app.setAppUserModelId("My Notes");\n`,
  );
  // It is JavaScript, and the title is data in it — whatever it holds.
  for (
    const title of [`a"b`, "a'b\\c", "x\ny", "${process.exit(1)}", "</script>"]
  ) {
    const l = mainScriptAumid(title);
    let got: string | undefined;
    const fake = { app: { setAppUserModelId: (id: string) => got = id } };
    new Function("process", "require", l)({ platform: "win32" }, () => fake);
    assertEquals(got, title.replace("\n", " "), title);
    // …and nothing runs elsewhere.
    got = undefined;
    new Function("process", "require", l)({ platform: "linux" }, () => {
      throw new Error("required on a platform that takes no id");
    });
    assertEquals(got, undefined);
  }
});

Deno.test("AppUserModelID: no title, no line; a long title is cut to what Windows accepts", () => {
  assertEquals(mainScriptAumid(undefined), "");
  assertEquals(mainScriptAumid("  \n "), "");
  const long = mainScriptAumid("x".repeat(400));
  assert(long.includes(`"${"x".repeat(128)}"`), "not cut at 128");
});

// The helper is only worth its test if the spawn uses it.
Deno.test("AppUserModelID: every app window is launched with it", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/electron/electron-spawn.ts", import.meta.url),
  );
  assert(
    src.includes(
      "MAIN_SCRIPT_SELF_REMOVE + mainScriptAumid(opts.title) + script",
    ),
  );
  assert(src.includes("title: meta?.title ?? uds?.title,"));
});
