// runCommand — run a command to its end and get its output, with a timeout
// that holds and the output written before it.
//
// The one-liner it replaces does neither when the command has a child of its
// own (`mtr` runs `mtr-packet`, every shell script runs something):
// `new Deno.Command(cmd, { signal: AbortSignal.timeout(500) }).output()` kills
// the command, then waits for the CHILD that still holds the pipe — measured
// (Deno 2.9, Linux): a 500 ms timeout on `sh -c "echo one; sleep 5"` resolved
// after 5 s.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { runCommand } from "../src/server-entry.ts";

const POSIX = Deno.build.os !== "windows";

Deno.test({
  name: "runCommand: stdout, stderr and the status of a command that ends",
  ignore: !POSIX,
  async fn() {
    const r = await runCommand("sh", {
      args: ["-c", "echo one; echo two >&2; echo three; exit 3"],
    });
    assertEquals(r.stdout, "one\nthree");
    assertEquals(r.stderr, "two");
    assertEquals([r.code, r.success, r.timedOut], [3, false, false]);
  },
});

Deno.test({
  name:
    "runCommand: the timeout kills the whole tree on time, and keeps what it wrote",
  ignore: !POSIX,
  async fn() {
    const lines: string[] = [];
    const t0 = Date.now();
    const r = await runCommand("sh", {
      args: ["-c", "echo one; echo two; sleep 5; echo three"],
      timeoutMs: 300,
      killGraceMs: 200,
      onLine: (l) => lines.push(l),
    });
    const took = Date.now() - t0;
    assert(took < 2500, `took ${took} ms — the sleep outlived the timeout`);
    assertEquals(r.stdout, "one\ntwo");
    assertEquals(lines, ["one", "two"], "onLine still sees every line");
    assertEquals([r.success, r.timedOut], [false, true]);
  },
});

Deno.test({
  name:
    "runCommand: a child that traps the kill and exits 0 after the timeout still timed out",
  ignore: !POSIX,
  async fn() {
    const r = await runCommand("sh", {
      args: [
        "-c",
        "trap 'echo bye; exit 0' TERM; echo hi; while :; do sleep 0.1; done",
      ],
      timeoutMs: 300,
      killGraceMs: 2000,
    });
    assertEquals(r.stdout, "hi\nbye");
    assertEquals([r.success, r.timedOut], [true, true]);
  },
});

Deno.test({
  name:
    "runCommand: an abort is not a timeout; a command that ends in time is not either",
  ignore: !POSIX,
  async fn() {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runCommand("sh", {
      args: ["-c", "echo started; sleep 5"],
      signal: ac.signal,
      timeoutMs: 10_000,
      killGraceMs: 200,
    });
    assertEquals([r.stdout, r.success, r.timedOut], ["started", false, false]);
    const quick = await runCommand("sh", {
      args: ["-c", "echo ok"],
      timeoutMs: 10_000,
    });
    assertEquals([quick.stdout, quick.success, quick.timedOut], [
      "ok",
      true,
      false,
    ]);
  },
});

Deno.test("runCommand: a timeout that is not a duration is refused before anything runs", async () => {
  for (const t of [-1, Number.NaN, Infinity]) {
    await assertRejects(
      () => runCommand("sh", { args: ["-c", "exit 0"], timeoutMs: t }),
      Error,
      "timeoutMs",
    );
  }
});
