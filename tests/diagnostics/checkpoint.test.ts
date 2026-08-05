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
