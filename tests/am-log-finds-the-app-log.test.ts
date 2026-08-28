// `am log`'s help says "Tail app log". It read `logs/stdout.log`, which is a
// capture `am start` makes when it launches an app detached — an app run the
// ordinary way (`deno task dev`, `deno run src/app.ts`) prints to its terminal
// and never produces one.
//
// So for the DEFAULT developer workflow the command answered
//
//     no log file at ~/.<appId>/logs/stdout.log
//
// about a running, logging app — while `app.log`, written by the framework
// logger for every app however it started, sat unread in the directory that
// message had just named. Found by starting a scaffolded app and asking it for
// its logs.
//
// The same shape is already recorded one comment above the fix: `am log
// --client` read "a relative path no aio version has ever written", so it
// answered "(no client log yet)" for every app that has ever existed.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { logPathFor } from "../src/am/am-cmd-inspect.ts";
import { _resetAppDirs, appDirs } from "../src/server/app-dirs.ts";

/** Run `fn` with a throwaway apps root, so nothing reads the real one. */
async function withApps(
  fn: (logs: string) => void | Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "aio-amlog-" });
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", root);
  _resetAppDirs();
  try {
    const logs = appDirs("logprobe").logs;
    Deno.mkdirSync(logs, { recursive: true });
    await fn(logs);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    _resetAppDirs();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

Deno.test("am log: finds app.log when the app was not started by `am`", () =>
  withApps((logs) => {
    // Exactly what a `deno task dev` app leaves behind: a framework log, and
    // no stdout capture because stdout went to the developer's terminal.
    Deno.writeTextFileSync(join(logs, "app.log"), "hello\n");
    assertStringIncludes(logPathFor({ app: "logprobe" } as never), "app.log");
  }));

Deno.test("am log: stdout.log still wins when `am start` captured one", () =>
  withApps((logs) => {
    // It is the richer file — raw stdout AND stderr, so anything the app
    // printed itself is in it and not in app.log.
    Deno.writeTextFileSync(join(logs, "app.log"), "framework\n");
    Deno.writeTextFileSync(join(logs, "stdout.log"), "raw\n");
    const p = logPathFor({ app: "logprobe" } as never);
    assertStringIncludes(p, "stdout.log");
  }));

Deno.test("am log: with neither file, the path named is the current one", () =>
  withApps(() => {
    // The error a caller prints has to name where a running app WOULD put it,
    // not a legacy location nobody writes any more.
    assertStringIncludes(
      logPathFor({ app: "logprobe" } as never),
      "stdout.log",
    );
  }));

Deno.test("am log --client is unaffected by the fallback", () =>
  withApps((logs) => {
    // The client log is a different file with a different meaning; app.log
    // must never stand in for it, or `--client` would silently show server
    // output and look like it worked.
    Deno.writeTextFileSync(join(logs, "app.log"), "framework\n");
    const p = logPathFor({ app: "logprobe", client: 0 } as never);
    assertEquals(p.endsWith("client.log"), true, p);
  }));
