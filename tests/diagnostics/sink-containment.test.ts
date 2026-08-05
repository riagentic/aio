// The two diagnostic writers that did not honour their own contract.
//
// CHECKPOINT. Dev turns it on by default and it writes FULL application state
// — every value the journal and the action log are careful not to keep. It was
// written at the process umask, so a sweep with `redactActions: ["vault:*"]`
// came back: journal `mode=600 clean`, actions.jsonl `clean`, checkpoint
// `mode=664 LEAK`. `docs/persistence/where-files-live.md` promises a redacted
// action's payload "and the before/after values it wrote" are kept nowhere; the
// timeline already redacts diff values for exactly this reason ("redacting the
// payload alone would have been theatre"). The one artifact holding the most
// was the one holding it in the open.
//
// ACTION LOG. `max` was enforced nowhere while the app ran — `truncateIfNeeded`
// was reachable only through `flush()`, called once at `onStop`. A SIGKILLed
// process never truncated, and even a clean shutdown only halved the FILE
// (100 lines with `max: 10` became 50).

import { assert, assertEquals } from "@std/assert";
import {
  _redactCheckpointState,
  createCheckpoint,
  readCheckpoint,
} from "../../src/diagnostics/checkpoint.ts";
import { createActionLog } from "../../src/diagnostics/action-log.ts";
import {
  makeRedactor,
  noRedaction,
  REDACTED,
} from "../../src/diagnostics/redact.ts";

const SECRET = "correct-horse-battery-staple";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "aio-sink-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const modeOf = async (p: string) => (await Deno.stat(p)).mode! & 0o777;

// ─── Checkpoint: permissions ────────────────────────────────────────────────

Deno.test("checkpoint: is owner-only, like the journal beside it", async () => {
  if (Deno.build.os === "windows") return;
  await withDir(async (dir) => {
    const cp = createCheckpoint(dir, 0);
    cp.schedule({
      ts: 1,
      state: { a: { n: 1 } },
      recentActions: [],
      cells: {},
    });
    await cp.flush();
    assertEquals(
      await modeOf(`${dir}/checkpoint.json`),
      0o600,
      "full application state must not be group/world readable",
    );
  });
});

Deno.test("checkpoint: an existing lax file is not left lax by the next write", async () => {
  if (Deno.build.os === "windows") return;
  await withDir(async (dir) => {
    // A checkpoint left by an older build, or by a laxer umask.
    await Deno.writeTextFile(`${dir}/checkpoint.json`, "{}", { mode: 0o664 });
    await Deno.writeTextFile(`${dir}/checkpoint.json.tmp`, "{}", {
      mode: 0o664,
    });
    const cp = createCheckpoint(dir, 0);
    cp.schedule({
      ts: 2,
      state: { a: { n: 1 } },
      recentActions: [],
      cells: {},
    });
    await cp.flush();
    assertEquals(await modeOf(`${dir}/checkpoint.json`), 0o600);
  });
});

Deno.test("checkpoint: the crash-path sync write is owner-only too", async () => {
  if (Deno.build.os === "windows") return;
  await withDir(async (dir) => {
    const cp = createCheckpoint(dir, 5000);
    cp.writeSync({
      ts: 3,
      state: { a: { n: 1 } },
      recentActions: [],
      cells: {},
    });
    assertEquals(await modeOf(`${dir}/checkpoint.json`), 0o600);
  });
});

// ─── Checkpoint: redaction ──────────────────────────────────────────────────

Deno.test("checkpoint: a redacted cell's state is withheld, not written", async () => {
  await withDir(async (dir) => {
    const cp = createCheckpoint(dir, 0, makeRedactor(["vault:*"]));
    cp.schedule({
      ts: 1,
      state: {
        vault: { open: true, key: SECRET },
        notes: { items: ["groceries"] },
      },
      recentActions: ["vault:unlockWith"],
      cells: {},
    });
    await cp.flush();

    const raw = await Deno.readTextFile(`${dir}/checkpoint.json`);
    assert(
      !raw.includes(SECRET),
      `the passphrase reached logs/checkpoint.json:\n${raw}`,
    );
    const data = readCheckpoint(dir)!;
    assertEquals(data.state.vault, REDACTED, "withheld, and SAID to be");
    // A redaction that swallowed everything would be indistinguishable from a
    // broken writer.
    assertEquals(data.state.notes, { items: ["groceries"] });
  });
});

Deno.test("checkpoint: an EXACT pattern still names the cell it protects", () => {
  // `redactActions: ["vault:unlockWith"]` asks for one method's values to be
  // kept nowhere. Those values are IN the vault slice; the checkpoint has no
  // action attached and cannot tell which field came from which call.
  const r = makeRedactor(["vault:unlockWith"]);
  assertEquals([...r.cells], ["vault"]);
  assertEquals(
    _redactCheckpointState({ vault: { key: SECRET }, notes: {} }, r),
    { vault: REDACTED, notes: {} },
  );
});

Deno.test("checkpoint: with no redaction configured, state is untouched", () => {
  const state = { a: { n: 1 } };
  assertEquals(_redactCheckpointState(state, noRedaction), state);
  assertEquals(noRedaction.cells.size, 0);
});

// ─── Action log: the bound is real ──────────────────────────────────────────

const linesOn = async (p: string) =>
  (await Deno.readTextFile(p)).trim().split("\n").filter((l) => l.length > 0);

Deno.test("action log: max is enforced while the app RUNS, not at shutdown", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/actions.jsonl`;
    const alog = createActionLog(path, 10);
    for (let i = 0; i < 100; i++) await alog.append(`c:a${i}`, { i });

    const lines = await linesOn(path);
    assert(
      lines.length <= 10,
      `a "rolling" log with max: 10 held ${lines.length} lines on a running ` +
        `app — truncation was reachable only through flush(), at onStop, and ` +
        `a SIGKILLed process never got there`,
    );
    // The newest are what survive — a log that keeps the oldest 5 of 100 is
    // not a rolling log.
    const last = JSON.parse(lines[lines.length - 1]!);
    assertEquals(last.type, "c:a99");
  });
});

Deno.test("action log: truncating a pre-existing oversized file restores the bound", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/actions.jsonl`;
    // A file left by an earlier run (or an earlier, unbounded build).
    await Deno.writeTextFile(
      path,
      Array.from({ length: 100 }, (_, i) => `{"type":"old:${i}"}`).join("\n") +
        "\n",
    );
    const alog = createActionLog(path, 10);
    await alog.flush();
    const lines = await linesOn(path);
    assert(
      lines.length <= 10,
      `shutdown left ${lines.length} lines with max: 10 — the old rule kept ` +
        `half the FILE (50), not half of max`,
    );
  });
});

Deno.test("action log: a log under its max is never rewritten", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/actions.jsonl`;
    const alog = createActionLog(path, 50);
    for (let i = 0; i < 20; i++) await alog.append(`c:a${i}`, { i });
    await alog.flush();
    assertEquals((await linesOn(path)).length, 20);
  });
});
