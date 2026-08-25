// The local-transport decision as a TABLE: os × electron × expose × flag →
// transport, and os × kind → socket path. `os` is a parameter of both
// functions, so the windows rows run on Linux CI.

import { assert, assertEquals } from "@std/assert";
import {
  isPipePath,
  resolveSocketPath,
  resolveTransport,
} from "../src/server/paths.ts";
import { heldLockKey } from "../src/server/single-instance-lock.ts";

type OS = typeof Deno.build.os;
const OSES: OS[] = ["linux", "darwin", "windows", "freebsd"];
const FLAGS = [undefined, "auto", "uds", "ws"] as const;

Deno.test("resolveTransport: decision table", () => {
  const rows: Array<
    [OS, boolean, boolean, (typeof FLAGS)[number], "uds" | "ws"]
  > = [];
  for (const os of OSES) {
    for (const electron of [true, false]) {
      for (const expose of [true, false]) {
        for (const flag of FLAGS) {
          const expected = flag === "ws"
            ? "ws"
            : flag === "uds"
            ? "uds"
            : electron && !expose &&
                (os === "linux" || os === "darwin" || os === "windows")
            ? "uds"
            : "ws";
          rows.push([os, electron, expose, flag, expected]);
        }
      }
    }
  }
  assertEquals(rows.length, 4 * 2 * 2 * 4);
  for (const [os, electron, expose, flag, expected] of rows) {
    assertEquals(
      resolveTransport(flag, electron, expose, os),
      expected,
      `${os} electron=${electron} expose=${expose} flag=${flag}`,
    );
  }
});

Deno.test("resolveTransport: windows is a local-socket OS now — a local electron app gets uds (the pipe)", () => {
  assertEquals(resolveTransport("auto", true, false, "windows"), "uds");
  assertEquals(resolveTransport(undefined, true, false, "windows"), "uds");
  // …and the three ways out are the same as on unix.
  assertEquals(resolveTransport("ws", true, false, "windows"), "ws");
  assertEquals(resolveTransport("auto", true, true, "windows"), "ws");
  assertEquals(resolveTransport("auto", false, false, "windows"), "ws");
  // An OS with no local-socket backend stays WS.
  assertEquals(resolveTransport("auto", true, false, "freebsd"), "ws");
});

Deno.test("resolveTransport: default `os` is the running one", () => {
  assertEquals(
    resolveTransport("auto", true, false),
    resolveTransport("auto", true, false, Deno.build.os),
  );
});

Deno.test("resolveSocketPath: windows → \\\\.\\pipe\\aio-<lockKey>[-http], never a file", () => {
  const key = heldLockKey("some-app");
  const ndjson = resolveSocketPath("some-app", undefined, "windows");
  const http = resolveSocketPath("some-app", "http", "windows");
  assertEquals(ndjson, `\\\\.\\pipe\\aio-${key}`);
  assertEquals(http, `\\\\.\\pipe\\aio-${key}-http`);
  assert(isPipePath(ndjson) && isPipePath(http));
  assert(ndjson !== http, "two listeners, two names");
  assert(!ndjson.includes("/") && !ndjson.includes(".sock"));
});

Deno.test("resolveSocketPath: the >100-char /tmp fallback never applies to a pipe name", () => {
  const long = "a".repeat(150);
  const p = resolveSocketPath(long, "http", "windows");
  assert(isPipePath(p), p);
  assert(p.includes(long), "a pipe name has no length ceiling");
  assert(!p.startsWith("/tmp"), p);
  // The unix branch still falls back.
  const u = resolveSocketPath(long, "http", "linux");
  assert(!isPipePath(u));
});

Deno.test("resolveSocketPath: unix rows are files under the lock dir, and unchanged by the os parameter", () => {
  for (const os of ["linux", "darwin"] as const) {
    const p = resolveSocketPath("some-app", undefined, os);
    const h = resolveSocketPath("some-app", "http", os);
    assert(!isPipePath(p));
    assert(p.endsWith("some-app.sock"), p);
    assert(h.endsWith("some-app.http.sock"), h);
  }
  assertEquals(
    resolveSocketPath("some-app"),
    resolveSocketPath("some-app", undefined, Deno.build.os),
  );
});
