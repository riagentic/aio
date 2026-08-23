// An Electron window dies with the aio server that launched it.
//
// Electron is a plain child: when the server is SIGKILLed, OOM-killed or
// crashes, the window stayed up — "reconnecting" forever — and when the app
// was started again the OLD window reconnected to the NEW server while the
// new server opened its own. Two windows, one app. Both generated main scripts
// now watch the launcher's pid (handed over as AIO_PARENT_PID) and quit when
// it is gone; the launcher passes it. Pinned here on the generated source, so
// no window has to open on anybody's desktop to prove it.
import { assert, assertStringIncludes } from "@std/assert";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";

const WATCH =
  /process\.env\.AIO_PARENT_PID[\s\S]*process\.kill\(__aioParent, 0\)[\s\S]*app\.quit\(\)/;

Deno.test("electron: the WS shell watches its parent and quits when it is gone", () => {
  const src = electronMainScript("http://127.0.0.1:1/", { title: "t" });
  assert(WATCH.test(src), "parent watch missing from the WS main script");
  // The watch must come AFTER the crash guard defines __aioQuitting, which it sets.
  assert(
    src.indexOf("let __aioQuitting") <
      src.indexOf("process.env.AIO_PARENT_PID"),
    "watch must follow the crash guard (it sets __aioQuitting)",
  );
});

Deno.test("electron: the UDS shell watches its parent and quits when it is gone", () => {
  const src = electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {
    meta: { title: "t" },
  });
  assert(WATCH.test(src), "parent watch missing from the UDS main script");
});

Deno.test("electron: the launcher hands its pid to the window", async () => {
  // A source gate, like the other window-hygiene gates: the spawn site must
  // set AIO_PARENT_PID, or the watch above is armed with nothing.
  const src = await Deno.readTextFile(
    new URL("../src/electron/electron-spawn.ts", import.meta.url),
  );
  assertStringIncludes(src, "AIO_PARENT_PID: String(Deno.pid)");
});
