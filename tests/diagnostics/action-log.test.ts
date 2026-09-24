import { assert, assertEquals } from "@std/assert";
import { createActionLog } from "../../src/diagnostics/action-log.ts";
import { permissiveUmask } from "../permissive-umask.ts";

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

Deno.test("action-log: actions.jsonl is 0600 — payloads are user data, like every other retaining sink", () =>
  permissiveUmask(async () => {
    if (Deno.build.os === "windows") return;
    const path = `${TEST_DIR}/actions-mode.jsonl`;
    // Pre-existing world-readable file (what every install before the fix has) —
    // the first append tightens it, matching the journal/checkpoint contract.
    await Deno.writeTextFile(path, "", { mode: 0o644 });
    const alog = createActionLog(path, 100);
    await alog.append("notes:add", { text: "private" });
    const mode = (await Deno.stat(path)).mode! & 0o777;
    assertEquals(
      mode,
      0o600,
      "action payloads must not be group/world readable",
    );
    await alog.flush();
  }));

Deno.test("action-log: a burst is written in batches, waits for at most `max` lines, and says once what it dropped", async () => {
  const path = `${TEST_DIR}/actions-burst.jsonl`;
  const max = 100;
  const alog = createActionLog(path, max);
  // Count the file writes, and what the log says.
  const write = Deno.writeTextFile;
  let writes = 0;
  (Deno as { writeTextFile: typeof write }).writeTextFile = (p, d, o) => {
    if (String(p) === path) writes++;
    return write(p, d, o);
  };
  const said: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...a: unknown[]) => void said.push(a.map(String).join(" "));
  Object.assign(console, { log: grab, warn: grab, error: grab });
  try {
    const n = 20_000;
    // Two bursts, so two rounds of dropping: said once, not per round.
    const rounds: [number, number][] = [[0, n / 2], [n / 2, n]];
    for (const [from, to] of rounds) {
      const all: Promise<void>[] = [];
      for (let i = from; i < to; i++) {
        all.push(alog.append(`burst:${i}`, { i }));
      }
      await Promise.all(all);
    }
    await alog.flush();
    // One write carries every line that arrived meanwhile: a handful, not n.
    assert(writes <= 20, `${writes} writes for ${n} appends`);
    const lines = await readLines(path);
    assert(lines.length <= max, `${lines.length} lines, max ${max}`);
    assertEquals(JSON.parse(lines.at(-1)!).type, `burst:${n - 1}`);
    // In order, with no hole inside what was kept.
    const kept = lines.map((l) => JSON.parse(l).payload.i as number);
    kept.forEach((v, k) => k > 0 && assertEquals(v, kept[k - 1]! + 1));
    const drops = said.filter((s) => s.includes("were dropped, oldest first"));
    assertEquals(drops.length, 1, said.join("\n"));
  } finally {
    Object.assign(console, orig);
    (Deno as { writeTextFile: typeof write }).writeTextFile = write;
  }
});
