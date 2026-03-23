import { assertEquals } from "@std/assert";
import { createActionLog } from "../../src/diagnostics/action-log.ts";

const TEST_DIR = await Deno.makeTempDir();

async function readLines(path: string): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(path);
    return text.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

Deno.test("action-log: appends actions as JSONL", async () => {
  const path = `${TEST_DIR}/actions1.jsonl`;
  const alog = createActionLog(path, 100);
  await alog.append("counter:increment", { amount: 5 });
  await alog.append("counter:decrement", { amount: 1 });
  const lines = await readLines(path);
  assertEquals(lines.length, 2);
  const parsed = JSON.parse(lines[0]!);
  assertEquals(parsed.type, "counter:increment");
  assertEquals(parsed.payload.amount, 5);
  assertEquals(typeof parsed.ts, "number");
  await alog.flush();
});

Deno.test("action-log: truncates when exceeding max", async () => {
  const path = `${TEST_DIR}/actions-trunc.jsonl`;
  const alog = createActionLog(path, 10);
  for (let i = 0; i < 15; i++) {
    await alog.append(`action:${i}`, {});
  }
  await alog.truncateIfNeeded();
  const lines = await readLines(path);
  assertEquals(lines.length <= 10, true);
  assertEquals(lines.length >= 5, true);
  await alog.flush();
});

Deno.test("action-log: skips internal actions", async () => {
  const path = `${TEST_DIR}/actions-skip.jsonl`;
  const alog = createActionLog(path, 100);
  await alog.append("counter:__FlowState", {});
  await alog.append("counter:__exec", {});
  await alog.append("counter:__set:foo", {});
  await alog.append("counter:increment", {});
  const lines = await readLines(path);
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]!).type, "counter:increment");
  await alog.flush();
});
