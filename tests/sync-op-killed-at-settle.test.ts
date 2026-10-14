// A sync op is reduced, its journal line written, and only then settled: an
// accepted op's row is marked, a refused op's row is deleted. This is the
// kill AT that statement — after the reduce is durable, before the row says
// what was decided (tests/sync-op-killed-before-settle.test.ts kills inside
// the method, before any of it).
//
// A `validate` refusal does not throw: the op is reduced (as a no-op), and
// the journal line of a listened op was written for it as for an accepted
// one. The next boot read that line as proof the server ACCEPTED the op, kept
// the row, and answered its author's resend with an ack — for an op that is
// in no state.
import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { cell } from "../mod.ts";
import { validateWorkerCells } from "../src/server/cell-worker-pool.ts";
import {
  hasRejectionFor,
  recordRejection,
  takeRejectionFor,
} from "../src/state/rejection-tracker.ts";

const APP = fromFileUrl(
  new URL("./fixtures/sync-op-kill-at-settle/app.js", import.meta.url),
);
const TREE = fromFileUrl(new URL("..", import.meta.url));

type Result = { answer?: string; items: string[]; n: number };

async function run(
  dir: string,
  phase: string,
  env: Record<string, string>,
): Promise<{ log: string; result?: Result }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(TREE, "deno.json"), APP],
    env: {
      ...env,
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      XDG_RUNTIME_DIR: dir,
      PHASE: phase,
      MOD: new URL(`file://${join(TREE, "mod.ts")}`).href,
      AIO_NO_OPEN: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const log = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  assert(out.code !== 3, `no kill, or no answer (${phase})\n${log}`);
  const line = /^RESULT (.*)$/m.exec(log)?.[1];
  assert(
    phase === "kill" || phase === "acked" || line,
    `this build did not boot (${phase})\n${log}`,
  );
  return { log, result: line ? JSON.parse(line) : undefined };
}

function sql(dir: string, q: string): void {
  const d = new DatabaseSync(join(dir, "data", "state.db"));
  try {
    d.exec(q);
  } finally {
    d.close();
  }
}

function rows(dir: string): { id: string; settled: number | null }[] {
  const d = new DatabaseSync(join(dir, "data", "state.db"));
  try {
    return d.prepare("SELECT id, settled FROM sync_ops ORDER BY server_ts")
      .all() as { id: string; settled: number | null }[];
  } finally {
    d.close();
  }
}

for (const journal of ["0", "1"]) {
  Deno.test(`sync op ACCEPTED, killed at its settled mark (journal ${journal}): the next boot holds it, marks it, and acks the resend — applied once`, async () => {
    const dir = await tempDir("aio-kill-at-settle-");
    const env = { JOURNAL: journal, ARG: "n2" };
    try {
      await run(dir, "kill", env);
      // Premise: reduced and (journal on) committed, the mark not written.
      assertEquals(rows(dir), [
        { id: "op-1", settled: 1 },
        { id: "op-2", settled: 0 },
      ]);
      if (journal === "1") {
        assertMatch(
          await Deno.readTextFile(join(dir, "data", "journal")),
          /"__aioSyncApplied"[^\n]*"id":"op-2"/,
        );
      }
      const boot = await run(dir, "read", env);
      assertEquals(boot.result!.items, ["n1", "n2"], boot.log);
      assertEquals(rows(dir), [
        { id: "op-1", settled: 1 },
        { id: "op-2", settled: 1 },
      ]);
      const again = await run(dir, "resend", env);
      assertEquals(again.result!.answer, "sync-ack", again.log);
      assertEquals(again.result!.items, ["n1", "n2"], again.log);
      // The listener's count is journalled with the op — one per op.
      if (journal === "1") assertEquals(again.result!.n, 2, again.log);
    } finally {
      await dropTempDir(dir);
    }
  });

  Deno.test(`sync op REFUSED by validate, killed at its delete (journal ${journal}): the next boot removes it, and the resend is refused — never acked`, async () => {
    const dir = await tempDir("aio-kill-at-settle-");
    const env = { JOURNAL: journal, ARG: "bad" };
    try {
      await run(dir, "kill", env);
      // Premise: the refused op's row is still there, unsettled, last.
      assertEquals(rows(dir), [
        { id: "op-1", settled: 1 },
        { id: "op-2", settled: 0 },
      ]);
      const boot = await run(dir, "read", env);
      assertEquals(boot.result!.items, ["n1"], boot.log);
      assertMatch(
        boot.log,
        /op op-2 was persisted but not yet (settled|committed)[^\n]*no bad[^\n]*removed from the op-log and not acknowledged/,
      );
      assert(!/ACCEPTED/.test(boot.log), boot.log);
      assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
      const again = await run(dir, "resend", env);
      assertEquals(again.result!.answer, "op-rejected", again.log);
      assertEquals(again.result!.items, ["n1"], again.log);
      assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
      if (journal === "1") assertEquals(again.result!.n, 1, again.log);
    } finally {
      await dropTempDir(dir);
    }
  });
}

// The commit mark asks before the handler takes: the question must leave the
// answer in place, and be about the op's OWN cell — a listener's refusal of
// its reaction does not make the op a refused one.
Deno.test("hasRejectionFor reads without taking, and only the named cell's refusal", () => {
  const action = { type: "notes:add" };
  assertEquals(hasRejectionFor(action, "notes"), false);
  recordRejection(action, { cell: "tally", reason: "listener" });
  assertEquals(hasRejectionFor(action, "notes"), false);
  recordRejection(action, { cell: "notes", reason: "no bad" });
  assertEquals(hasRejectionFor(action, "notes"), true);
  assertEquals(hasRejectionFor(action, "notes"), true);
  assertEquals(takeRejectionFor(action, "notes")?.reason, "no bad");
  assertEquals(hasRejectionFor(action, "notes"), false);
  assertEquals(hasRejectionFor(null, "notes"), false);
});

// An op in the log that this build's `validate` refuses folds as a no-op, and
// the boot says so. "ACCEPTED" is said only where the row's mark or the
// journal's commit proves it; of a row with neither — an older build's, which
// marked nothing — only that it was kept.
for (
  const [name, journal, mark, word] of [
    ["its settled mark", "0", "1", "ACCEPTED"],
    ["its journal commit (the mark a kill took)", "1", "0", "ACCEPTED"],
    ["nothing (no mark, no commit)", "0", "NULL", "kept"],
  ] as const
) {
  Deno.test(`an op this build's validate now refuses, proven accepted by ${name}: the boot says the server ${word} it`, async () => {
    const dir = await tempDir("aio-kill-at-settle-");
    const env = { JOURNAL: journal, ARG: "n2" };
    try {
      await run(dir, "acked", env);
      assertEquals(rows(dir).at(-1), { id: "op-2", settled: 1 });
      sql(dir, `UPDATE sync_ops SET settled = ${mark} WHERE id = 'op-2'`);
      const boot = await run(dir, "read", { ...env, REFUSE: "n2" });
      assertEquals(boot.result!.items, ["n1"], boot.log);
      assertMatch(
        boot.log,
        word === "ACCEPTED"
          ? /"notes": 1 op in the op-log that the server ACCEPTED is refused by this build[^\n]*first: op op-2 \(notes:add\): no bad/
          : /"notes": 1 op in the op-log that the server kept — nothing records that it accepted it \(no settled mark, no journal commit\) — is refused by this build[^\n]*first: op op-2 \(notes:add\): no bad/,
      );
      assertEquals(/server ACCEPTED/.test(boot.log), word === "ACCEPTED");
      // Folded as a no-op either way: the row stays.
      assertEquals(rows(dir).length, 2);
    } finally {
      await dropTempDir(dir);
    }
  });
}

// The commit mark reads the refusal in the isolate that reduced the op. A
// real `worker: true` cell reduces elsewhere and reports its refusal later
// (cell-worker.ts, at `done`) — and can be neither side of a listened sync
// op: not the op's cell, not its listener. Both are refused at boot, so the
// reduce the mark sits in is always the one that recorded the refusal.
Deno.test("a worker cell is never a sync op's cell or its listener: both are refused by name", () => {
  const methods = {
    add(s: { n: number }) {
      s.n++;
    },
  };
  const src = cell("kasSrc", { sync: true, state: { n: 0 }, methods });
  const worker = (id: string, extra: Record<string, unknown>) =>
    // deno-lint-ignore no-explicit-any
    cell(id, { worker: true, state: { n: 0 }, methods, ...extra } as any);
  assertThrows(
    () => validateWorkerCells([worker("kasSyncWorker", { sync: true })]),
    Error,
    "has worker: true but also has sync: true",
  );
  assertThrows(
    () =>
      validateWorkerCells([
        worker("kasListenWorker", { listensTo: { add: src.add } }),
      ]),
    Error,
    "has worker: true but uses listensTo",
  );
});
