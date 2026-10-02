// A connection that has ended is garbage — on the peer-credential listener.
//
// The production listener (`node:net`, for the peer's pid) kept every
// connection its CLIENT ended, for the life of the process: the socket, its
// handle, and whatever hung off them — 1.5 KB of heap for a request answered
// and closed, 7.6 KB (and a 64 KB read buffer) for half a request head, and
// the same for a peer the gate REFUSED, so any process of the same user could
// grow the app. 18 000 connections: heap 18 → 140 MB, RSS 117 → 941 MB.
//
// The cause is the runtime's: a handle closed while its shutdown is in flight
// is never let go of. `local-listen.ts` no longer closes one then. What is
// pinned here is the effect, per way a connection can end: the accepted
// sockets are collected. Measured in a CHILD with a real `gc()`
// (tests/memory.test.ts explains why it cannot be this process).
import { assert, assertEquals } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const N = 60;

type Result = Record<string, { n: number; kept: number }>;

async function probe(): Promise<Result> {
  const dir = await tempDir("peer-conn-gc-");
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--v8-flags=--expose-gc",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        new URL("./fixtures/local-peer-conn-gc/probe.ts", import.meta.url)
          .pathname,
        String(N),
        dir,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    const line = text.split("\n").find((l) => l.startsWith("RESULT "));
    assert(
      out.success && line,
      `probe exited ${out.code}:\n` +
        new TextDecoder().decode(out.stderr).slice(-3000) + text.slice(-2000),
    );
    return JSON.parse(line.slice(7));
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "peer listener: an ended connection is collected, however it ended — by the client, the server, a refusal, a deadline, a failed write, or as a stream pair",
  ignore: Deno.build.os === "windows",
  async fn() {
    const r = await probe();
    const modes = Object.keys(r);
    // Every way the probe knows was run, on at least N connections…
    assertEquals(modes.length, 18, modes.join(" | "));
    assertEquals(
      modes.filter((m) => r[m]!.n < N),
      [],
      "a mode accepted fewer connections than it opened",
    );
    // …and none keeps its sockets. (The collector may hold on to the last
    // few it has seen; a leak keeps every one.)
    assertEquals(
      modes.filter((m) => r[m]!.kept > 5).map((m) => `${m}: ${r[m]!.kept}`),
      [],
      `sockets still held after gc(), of ${N} per mode`,
    );
  },
});
