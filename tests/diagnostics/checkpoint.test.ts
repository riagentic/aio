import { assertEquals, assertExists } from "@std/assert";
import {
  createCheckpoint,
  readCheckpoint,
} from "../../src/diagnostics/checkpoint.ts";

const TEST_DIR = await Deno.makeTempDir();

Deno.test("checkpoint: write and read round-trip", async () => {
  const dir = `${TEST_DIR}/cp1`;
  await Deno.mkdir(dir, { recursive: true });
  const cp = createCheckpoint(dir, 0);
  await cp.write({
    ts: Date.now(),
    state: { counter: { count: 5 } },
    recentActions: ["counter:increment"],
    cells: { counter: { errors: 0, enabled: true } },
  });
  const data = readCheckpoint(dir);
  assertExists(data);
  assertEquals(data!.state, { counter: { count: 5 } });
  assertEquals(data!.recentActions, ["counter:increment"]);
});

Deno.test("checkpoint: missing file returns null", () => {
  const data = readCheckpoint(`${TEST_DIR}/nonexistent`);
  assertEquals(data, null);
});

Deno.test("checkpoint: corrupt file returns null", async () => {
  const dir = `${TEST_DIR}/cp-corrupt`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/checkpoint.json`, "{invalid json!!!}");
  const data = readCheckpoint(dir);
  assertEquals(data, null);
});

Deno.test("checkpoint: atomic write leaves no .tmp on success", async () => {
  const dir = `${TEST_DIR}/cp-atomic`;
  await Deno.mkdir(dir, { recursive: true });
  const cp = createCheckpoint(dir, 0);
  await cp.write({
    ts: Date.now(),
    state: { x: 1 },
    recentActions: [],
    cells: {},
  });
  let tmpExists = true;
  try {
    await Deno.stat(`${dir}/checkpoint.json.tmp`);
  } catch {
    tmpExists = false;
  }
  assertEquals(tmpExists, false);
});

Deno.test("checkpoint: writeSync for emergency", async () => {
  const dir = `${TEST_DIR}/cp-sync`;
  await Deno.mkdir(dir, { recursive: true });
  const cp = createCheckpoint(dir, 0);
  cp.writeSync({
    ts: Date.now(),
    state: { emergency: true },
    recentActions: ["crash:boom"],
    cells: {},
  });
  const data = readCheckpoint(dir);
  assertExists(data);
  assertEquals(data!.state, { emergency: true });
});

Deno.test("checkpoint: BigInt state degrades the snapshot, it does not fail the write", async () => {
  // The circular-ref fallback replacer re-threw on a BigInt — the same throw
  // the first attempt failed with — so flush() rejected instead of writing.
  const dir = `${TEST_DIR}/cp-bigint`;
  await Deno.mkdir(dir, { recursive: true });
  const cp = createCheckpoint(dir, 0);
  const state: Record<string, unknown> = { wallet: { balance: 7n } };
  state.self = state; // …and a cycle, so both fallbacks run at once
  await cp.write({
    ts: Date.now(),
    state,
    recentActions: ["wallet:credit"],
    cells: { wallet: { errors: 0, enabled: true } },
  });
  const data = readCheckpoint(dir);
  assertExists(data);
  assertEquals(
    (data.state.wallet as { balance: unknown }).balance,
    "7n",
    "the BigInt is recorded, readably",
  );
});

// ── The directory is the writer's own responsibility ─────────────────────────
// `logger-core.ts` mkdirs the log dir; the checkpoint writer shares that path
// but only ever USED it. So an app that enables checkpoints while the log
// directory does not exist yet got a dead feature AND one
// "[checkpoint] write failed: NotFound" per write, forever — the framework
// reporting its own failure on a loop instead of doing the one syscall that
// fixes it. Observed in `deno task bench`, which writes into a fresh temp dir.
//
// Every other test in this file mkdirs first, which is exactly why nothing
// caught it.

Deno.test("checkpoint: writes into a directory that does not exist yet", async () => {
  const dir = `${TEST_DIR}/cp-missing/nested`;
  const cp = createCheckpoint(dir, 0);
  await cp.write({
    ts: Date.now(),
    state: { n: { v: 1 } },
    recentActions: ["n:set"],
    cells: { n: { errors: 0, enabled: true } },
  });
  const read = readCheckpoint(dir);
  assertExists(read, "the checkpoint was never written");
  assertEquals((read.state as { n: { v: number } }).n.v, 1);
});

Deno.test("checkpoint: the emergency sync write creates its directory too", () => {
  const dir = `${TEST_DIR}/cp-missing-sync/nested`;
  const cp = createCheckpoint(dir, 0);
  cp.writeSync({
    ts: Date.now(),
    state: { n: { v: 2 } },
    recentActions: ["n:set"],
    cells: { n: { errors: 0, enabled: true } },
  });
  const read = readCheckpoint(dir);
  assertExists(read, "the crash-handler checkpoint was never written");
  assertEquals((read.state as { n: { v: number } }).n.v, 2);
});

Deno.test("checkpoint: survives its directory disappearing under it", async () => {
  // This is what `deno task bench` was hitting: several apps boot into ONE
  // data dir in sequence, and a later boot archives the log directory out from
  // under a writer that had already written into it. Nine identical
  // "[checkpoint] write failed: NotFound" lines per run, and every checkpoint
  // after the first one lost — the framework reporting its own failure on a
  // loop rather than doing the one idempotent syscall that fixes it.
  const dir = `${TEST_DIR}/cp-vanishing`;
  const cp = createCheckpoint(dir, 0);
  const data = (n: number) => ({
    ts: Date.now(),
    state: { n: { v: n } },
    recentActions: ["n:set"],
    cells: { n: { errors: 0, enabled: true } },
  });
  await cp.write(data(1));
  assertExists(readCheckpoint(dir));

  // …and now it is gone, exactly as a log archive leaves it.
  await Deno.remove(dir, { recursive: true });
  await cp.write(data(2));
  const after = readCheckpoint(dir);
  assertExists(after, "the write after the directory vanished was lost");
  assertEquals((after.state as { n: { v: number } }).n.v, 2);
});
