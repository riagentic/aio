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

// The `__exec` marker is noise; the `__set` WRITE-SET is not.
//
// This test used to assert the opposite — that `counter:__set:foo` is dropped
// like `__exec` — which pinned the bug as the contract. An async or
// transactional method commits nothing in its `cell:method` action (that fires
// at CALL time); everything it writes is published as one `cell:__setMethod`,
// so dropping it left `actions.jsonl` with the call and no record of the
// writes, long after the journal, the timeline and time travel were fixed to
// keep it. One decider now: `src/diagnostics/action-kind.ts`.
Deno.test("action-log: skips the __exec marker, keeps the write-set", async () => {
  const path = `${TEST_DIR}/actions-skip.jsonl`;
  const alog = createActionLog(path, 100);
  await alog.append("counter:__exec", { _method: "bump" });
  await alog.append("counter:__setBump", {
    mutations: [{ path: ["n"], value: 7 }],
    _origin: "bump",
  });
  await alog.append("counter:increment", {});
  const lines = await readLines(path);
  assertEquals(
    lines.map((l) => JSON.parse(l).type),
    ["counter:__setBump", "counter:increment"],
  );
  assertEquals(
    JSON.parse(lines[0]!).payload.mutations[0].value,
    7,
    "the line has to carry WHAT was written",
  );
  await alog.flush();
});

Deno.test("action-log: actions.jsonl is 0600 — payloads are user data, like every other retaining sink", async () => {
  if (Deno.build.os === "windows") return;
  const path = `${TEST_DIR}/actions-mode.jsonl`;
  // Pre-existing world-readable file (what every install before the fix has) —
  // the first append tightens it, matching the journal/checkpoint contract.
  await Deno.writeTextFile(path, "", { mode: 0o644 });
  const alog = createActionLog(path, 100);
  await alog.append("notes:add", { text: "private" });
  const mode = (await Deno.stat(path)).mode! & 0o777;
  assertEquals(mode, 0o600, "action payloads must not be group/world readable");
  await alog.flush();
});
