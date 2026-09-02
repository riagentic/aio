// The crash checkpoint is the ONE artifact that exists to explain a crash. It
// is best-effort by design — a crash handler must not die trying to write it —
// but "best effort" had been implemented as `catch {}`, so a failed emergency
// write and a process that never reached the handler left the SAME evidence:
// no file, no line, nothing to tell them apart.
//
// Two guarantees, both of which the async `write()` path already had and the
// sync crash path did not:
//   1. a write that cannot succeed says so (once per distinct cause), and
//   2. a directory that vanished under a live writer is re-created and retried,
//      so the emergency path is never weaker than the routine one it replaces.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { captureConsole } from "./console-capture.ts";
import {
  createCheckpoint,
  readCheckpoint,
} from "../src/diagnostics/checkpoint.ts";
import type { CheckpointData } from "../src/diagnostics/types.ts";

const data = (): CheckpointData => ({
  ts: Date.now(),
  state: { app: { n: 1 } },
  recentActions: [],
  cells: { app: { errors: 0, enabled: true } },
});

Deno.test("crash checkpoint: an impossible write is reported, not swallowed", async () => {
  const base = await Deno.makeTempDir({ prefix: "cp-loud-" });
  try {
    // A FILE where the checkpoint directory should be: mkdir cannot fix it and
    // the write cannot succeed — the unfixable case (a read-only mount, a full
    // disk) reduced to something a test can create.
    const blocker = `${base}/blocked`;
    await Deno.writeTextFile(blocker, "not a directory");
    const cp = createCheckpoint(`${blocker}/logs`, 0);

    const lines = captureConsole(() => cp.writeSync(data()));

    const failure = lines.find((l) => l.includes("[checkpoint] write failed"));
    assert(
      failure,
      `an unwritable crash checkpoint said nothing. lines:\n${
        lines.join("\n")
      }`,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("crash checkpoint: the same failure is not repeated per attempt", async () => {
  const base = await Deno.makeTempDir({ prefix: "cp-loud-" });
  try {
    const blocker = `${base}/blocked`;
    await Deno.writeTextFile(blocker, "not a directory");
    const cp = createCheckpoint(`${blocker}/logs`, 0);

    const lines = captureConsole(() => {
      cp.writeSync(data());
      cp.writeSync(data());
      cp.writeSync(data());
    });

    const failures = lines.filter((l) =>
      l.includes("[checkpoint] write failed")
    );
    assertEquals(
      failures.length,
      1,
      `three identical failures logged ${failures.length} lines — a log nobody reads`,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("crash checkpoint: a directory that vanished is re-created and the write lands", async () => {
  const base = await Deno.makeTempDir({ prefix: "cp-gone-" });
  const dir = `${base}/logs`;
  try {
    const cp = createCheckpoint(dir, 0);
    // First write creates the directory and latches `dirReady`.
    cp.writeSync(data());
    assert(readCheckpoint(dir), "the first crash checkpoint was not written");

    // Log rotation, an operator clearing logs, another app archiving the data
    // dir — the directory goes away while the process still holds `dirReady`.
    await Deno.remove(dir, { recursive: true });

    const lines = captureConsole(() => cp.writeSync(data()));

    const found = readCheckpoint(dir);
    assert(
      found,
      `the crash checkpoint was lost to a vanished directory. lines:\n${
        lines.join("\n")
      }`,
    );
    assertEquals(found.cells, { app: { errors: 0, enabled: true } });
    assertEquals(
      lines.filter((l) => l.includes("[checkpoint] write failed")).length,
      0,
      "a recovered write reported a failure it recovered from",
    );
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
});

Deno.test("crash checkpoint: owner-only permissions survive the retry", async () => {
  if (Deno.build.os === "windows") return;
  const base = await Deno.makeTempDir({ prefix: "cp-mode-" });
  const dir = `${base}/logs`;
  try {
    const cp = createCheckpoint(dir, 0);
    cp.writeSync(data());
    await Deno.remove(dir, { recursive: true });
    cp.writeSync(data());

    const st = await Deno.stat(`${dir}/checkpoint.json`);
    assertEquals(
      (st.mode ?? 0) & 0o777,
      0o600,
      "the checkpoint holds FULL state — the retry must not widen its mode",
    );
    const dirSt = await Deno.stat(dir);
    assertEquals((dirSt.mode ?? 0) & 0o777, 0o700);
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
});

Deno.test("crash checkpoint: writeSync never throws, whatever the disk says", async () => {
  const base = await Deno.makeTempDir({ prefix: "cp-throw-" });
  try {
    const blocker = `${base}/blocked`;
    await Deno.writeTextFile(blocker, "not a directory");
    const cp = createCheckpoint(`${blocker}/logs`, 0);
    // A crash handler calls this. If it throws, the crash report dies with it.
    captureConsole(() => cp.writeSync(data()));
    assertStringIncludes("ok", "ok");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
