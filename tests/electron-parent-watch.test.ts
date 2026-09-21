// An Electron window dies with the aio server that launched it.
//
// Electron is a plain child: when the server is SIGKILLed, OOM-killed or
// crashes, the window stayed up — "reconnecting" forever — and when the app
// was started again the OLD window reconnected to the NEW server while the
// new server opened its own. Two windows, one app. Both generated main scripts
// now watch the launcher's pid (handed over as AIO_PARENT_PID) and quit when
// it is gone; the launcher passes it. Pinned here on the generated source, so
// no window has to open on anybody's desktop to prove it.
import { assert, assertEquals } from "@std/assert";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronChildEnv } from "../src/electron/electron-spawn.ts";
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

Deno.test("electron: the launcher hands its pid to the window", () => {
  // This used to grep electron-spawn.ts for the literal
  // `AIO_PARENT_PID: String(Deno.pid)`, which broke the moment the child's
  // environment moved into a function — while the behaviour it cares about
  // was unchanged. A source grep pins the SPELLING, not the fact. The fact is
  // now a pure function, so ask it: whatever else the environment carries, the
  // parent pid is in it, or the watch above is armed with nothing.
  const { env } = electronChildEnv(31337, () => undefined);
  assertEquals(env.AIO_PARENT_PID, "31337");
  // …and it survives beside the variables that DO get stripped.
  const hijacked = electronChildEnv(
    31337,
    (k) => k === "ELECTRON_RUN_AS_NODE" ? "1" : undefined,
  );
  assertEquals(hijacked.env.AIO_PARENT_PID, "31337");
});
