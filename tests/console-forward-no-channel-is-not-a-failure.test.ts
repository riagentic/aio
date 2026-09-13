// A console line written before the client HAS a channel is not a failed
// write, and must not escalate `client:log-forward` to degraded.
//
// Measured: a clean `testUI` test that called `console.warn` five times printed
//
//   [aio] client:log-forward: degraded — 5 consecutive failures, last: the
//   transport refused the write — this log line was lost.
//
// The browser transport installs the console intercept at import, and with no
// socket yet `_sendRaw` answers `false` — the same answer as a socket that
// refused a write. Every line was counted as a transport failure. The page had
// nothing wrong with it; it simply had not connected (or never will: a test).
// A socket that IS connected and refuses writes still escalates — that is the
// case the tracker exists for (tests/client-transport-refusals.test.ts).
import { assert, assertEquals } from "@std/assert";
import {
  installConsoleIntercept,
  uninstallConsoleIntercept,
} from "../src/browser/console-intercept.ts";
import { _resetDegraded, degradedReport } from "../src/diagnostics/degraded.ts";

async function forward40(
  send: () => boolean,
  hasChannel: () => boolean,
): Promise<string[]> {
  _resetDegraded();
  const origErr = console.error;
  const origLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    installConsoleIntercept(send, hasChannel);
    for (let i = 0; i < 40; i++) console.warn(`line ${i}`);
    await new Promise((r) => setTimeout(r, 20));
    return degradedReport().map((r) => r.name);
  } finally {
    uninstallConsoleIntercept();
    console.error = origErr;
    console.log = origLog;
    _resetDegraded();
  }
}

Deno.test("console forward: no channel yet — lines are not counted as failures", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const names = await forward40(() => false, () => false);
    assertEquals(
      names.includes("client:log-forward"),
      false,
      "a client with no channel has nothing to fail at",
    );
  } finally {
    console.warn = origWarn;
  }
});

Deno.test("console forward: a CONNECTED channel refusing writes still escalates", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const names = await forward40(() => false, () => true);
    assert(
      names.includes("client:log-forward"),
      `a connected channel dropping every line is the real failure: ${names}`,
    );
  } finally {
    console.warn = origWarn;
  }
});

Deno.test("the browser transport's intercept does not escalate before it connects", async () => {
  // The product wiring: importing the transport installs the intercept, as it
  // does under testUI and in every app bundle. Nothing here connects it.
  await import("../src/browser/browser-air-transport.ts");
  _resetDegraded();
  try {
    for (let i = 0; i < 10; i++) console.warn(`[probe] unconnected line ${i}`);
    await new Promise((r) => setTimeout(r, 20));
    const names = degradedReport().map((r) => r.name);
    assertEquals(names.includes("client:log-forward"), false, String(names));
  } finally {
    uninstallConsoleIntercept();
    _resetDegraded();
  }
});
