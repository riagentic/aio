// Client logs go to ONE place — including in prod.
//
// `initClientLog(getLogDir())` used to sit inside `if (!prod)`, but the UDS
// transport writes client log frames regardless (uds.ts). So a prod Electron
// app kept the module default — `".aio/log"`, a CWD-RELATIVE path — and its
// renderer logs landed wherever it happened to be launched from: a fourth
// location, wiped by no policy, and not the one `am log --client` reads
// (`~/.<appId>/logs/client.log`).
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { setFallbackLogDir } from "../src/diagnostics/logger-api.ts";
import {
  _pendingWrites,
  disposeClientLog,
  flushClientLog,
  initClientLog,
  writeClientLog,
} from "../src/server/client-log.ts";
import { permissiveUmask } from "./permissive-umask.ts";

const SRC = join(dirname(fromFileUrl(import.meta.url)), "..", "src");

Deno.test("client log: writes land in the directory it was initialised with", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-clientlog-" });
  try {
    initClientLog(dir);
    writeClientLog(
      0,
      {
        ts: Date.now(),
        level: "info",
        msg: "hello from the renderer",
      } as Parameters<typeof writeClientLog>[1],
    );
    // The append is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 100));
    const text = await Deno.readTextFile(join(dir, "client.log"));
    assert(
      text.includes("hello from the renderer"),
      `client.log did not receive the entry: ${text}`,
    );
  } finally {
    disposeClientLog(); // the rate-limit reset timer is the module's, not the app's
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("client log: with no HTTP server booted, writes follow the logger's directory", async () => {
  // A prod Electron app on a named pipe skips the HTTP server, so
  // `initClientLog` never runs. The module default was cwd-relative, and an
  // installed Windows app logged "write failed for .aio/log/client.log" for
  // every renderer line (real Windows 11, 2026-09-17).
  const dir = await Deno.makeTempDir({ prefix: "aio-clientlog-" });
  const cwd = await Deno.makeTempDir({ prefix: "aio-clientlog-cwd-" });
  const was = Deno.cwd();
  try {
    disposeClientLog(); // no initClientLog in this process's history
    setFallbackLogDir(dir);
    Deno.chdir(cwd); // a cwd with no .aio/ — where the old default failed
    writeClientLog(
      0,
      {
        ts: Date.now(),
        level: "info",
        msg: "renderer over the pipe",
      } as Parameters<typeof writeClientLog>[1],
    );
    await flushClientLog();
    const text = await Deno.readTextFile(join(dir, "client.log"));
    assert(text.includes("renderer over the pipe"), text);
  } finally {
    Deno.chdir(was);
    setFallbackLogDir(null);
    disposeClientLog();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    await Deno.remove(cwd, { recursive: true }).catch(() => {});
  }
});

Deno.test("client log: the directory is set on EVERY boot, not only in dev", async () => {
  // A guard on the wiring, because the failure is invisible from inside the
  // module: it happily writes to a relative path and reports success.
  const src = await Deno.readTextFile(join(SRC, "server", "server.ts"));
  const call = src.indexOf("initClientLog(getLogDir())");
  assert(call > 0, "server.ts no longer initialises the client log dir");
  // The 200 characters before the call must not open a prod gate around it.
  const before = src.slice(Math.max(0, call - 200), call);
  assert(
    !/if\s*\(\s*!prod\s*\)\s*\{[^}]*$/.test(before),
    "initClientLog must not sit behind `if (!prod)` — the UDS transport " +
      "writes client frames in prod too, and the default path is cwd-relative",
  );
});

Deno.test("client log: nothing else invents a client.log location", async () => {
  // `am` used to carry its own literal "log/client.log". One writer, one
  // reader, one path.
  const offenders: string[] = [];
  const walk = async function* (dir: string): AsyncGenerator<string> {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory) yield* walk(p);
      else if (e.name.endsWith(".ts")) yield p;
    }
  };
  for await (const path of walk(SRC)) {
    const rel = path.slice(SRC.length + 1);
    if (rel.endsWith(join("server", "client-log.ts"))) continue;
    // Code only: these files DISCUSS the old literal in their comments, which
    // is exactly the history worth keeping written down.
    const code = (await Deno.readTextFile(path))
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    // A hardcoded directory joined onto client.log — the shape that drifts.
    if (/["'][^"']*log\/client\.log["']/.test(code)) offenders.push(rel);
  }
  assertEquals(
    offenders,
    [],
    "these hardcode a client.log path instead of asking the logger",
  );
});

// `writeClientLog` is fire-and-forget on purpose — a renderer's line must never
// wait on disk — so NOTHING could tell whether the last lines landed, or
// whether the 0600 mode fix that rides with the first write ran. The op
// sanitizer said so first, under load: "An async operation to change the
// permissions of a file was started in this test, but never completed."
// Detached from the write's chain, that chmod could also lose a race with
// process exit, leaving the file at the mode the code exists to correct.
Deno.test("client log: the write and its mode fix are drainable", () =>
  permissiveUmask(async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-clientflush-" });
    try {
      initClientLog(dir);
      const entry = (msg: string) =>
        ({ ts: Date.now(), level: "info", msg }) as Parameters<
          typeof writeClientLog
        >[1];
      writeClientLog(0, entry("first line"));
      writeClientLog(0, entry("second line"));
      // The tracking must EXIST — asserting only after the flush would pass even
      // if flushClientLog() drained nothing, because the write usually lands
      // first. (Measured: the mutation that stopped tracking left this test
      // green until this line was added.)
      assertEquals(
        _pendingWrites(),
        2,
        "both writes are in flight and tracked",
      );

      // The whole point: one await, and everything issued so far is on disk.
      await flushClientLog();
      assertEquals(_pendingWrites(), 0, "and the flush drained them");

      const path = join(dir, "client.log");
      const text = await Deno.readTextFile(path);
      assert(text.includes("first line"), text);
      assert(text.includes("second line"), text);

      if (Deno.build.os !== "windows") {
        const mode = (await Deno.stat(path)).mode! & 0o777;
        assertEquals(
          mode,
          0o600,
          "the mode fix rides with the write, so draining the write drains it",
        );
      }
      // …and a flush with nothing pending returns rather than hanging.
      await flushClientLog();
    } finally {
      disposeClientLog();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  }));
