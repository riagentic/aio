// A refused op has no reactions and no place in the op-log — live AND at the
// boot that reduces an op a crash caught between its persist and its commit
// (journal.ts J4).
//
// Live: the composed reducer ran the owner's listeners even after the owner
// refused (validate) — a tally counted an add the op-log then deleted and
// the origin was told was rejected. At boot: the in-flight op was reduced
// without asking whether it was refused, so it stayed in the log, was
// marked, and its resend was acked as a known op — while the state never
// held it (reviewer repros v1–v3).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = new URL("./fixtures/val-probe/app.js", import.meta.url).pathname;
const TREE = new URL("..", import.meta.url).pathname;

type Report = { frames: string[]; notes: string[]; tally: number };

async function run(
  dir: string,
  phase: string,
  env: Record<string, string> = {},
  tree = TREE,
): Promise<{ log: string; report: Report }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(tree, "deno.json"), APP],
    env: {
      ...env,
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      XDG_RUNTIME_DIR: dir,
      PHASE: phase,
      MOD: new URL(`file://${join(tree, "mod.ts")}`).href,
      AIO_NO_OPEN: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const log = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  const report = JSON.parse(
    await Deno.readTextFile(join(dir, "report.json")).catch(() => {
      throw new Error(`no report\n${log}`);
    }),
  );
  return { log, report };
}

/** The op's intent line, then its row — what `persistOp` wrote before the
 *  kill took its reduce. */
function inFlight(dir: string, id: string, text: string): void {
  const d = new DatabaseSync(join(dir, "data", "state.db"));
  try {
    const { m } = d.prepare(
      "SELECT MAX(v) AS m FROM (SELECT MAX(server_ts) AS v FROM sync_ops " +
        "UNION ALL SELECT MAX(compacted_ts) FROM sync_meta)",
    ).get() as { m: number };
    const path = join(dir, "data", "journal");
    let seq = 0;
    try {
      for (const x of Deno.readTextFileSync(path).matchAll(/"seq":(\d+)/g)) {
        seq = Math.max(seq, Number(x[1]));
      }
    } catch { /* compacted away */ }
    try {
      const b = JSON.parse(Deno.readTextFileSync(path + ".base"));
      seq = Math.max(seq, b.wm, ...Object.values(b.cells as object));
    } catch { /* no base */ }
    Deno.writeTextFileSync(
      path,
      JSON.stringify({
        seq: seq + 1,
        fmt: 2,
        type: "__aioSyncIntent",
        payload: { cell: "notes", id, ts: m + 1 },
        ts: Date.now(),
        only: ["notes"],
      }) + "\n",
      { append: true, mode: 0o600 },
    );
    d.prepare(
      `INSERT INTO sync_ops (id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node, server_ts, version)
         VALUES (?, 'notes', 'add', ?, ?, 0, 'c1', ?, 1)`,
    ).run(id, JSON.stringify({ args: [text] }), m + 1, m + 1);
  } finally {
    d.close();
  }
}

const rows = (dir: string, id: string): number => {
  const d = new DatabaseSync(join(dir, "data", "state.db"));
  try {
    return (d.prepare("SELECT COUNT(*) AS n FROM sync_ops WHERE id = ?").get(
      id,
    ) as { n: number }).n;
  } finally {
    d.close();
  }
};

Deno.test("a refused op has no reactions — live, and at the boot that reduces an op a crash caught in flight", async () => {
  const dir = await tempDir("aio-refused-at-boot-");
  try {
    const seed = await run(dir, "seed");
    assertEquals(seed.report.frames.sort(), [
      "op-rejected:op-live-bad",
      "sync-ack:op-1",
    ]);
    assertEquals(seed.report.notes, ["ok1"]);
    assertEquals(seed.report.tally, 1, `live: no reaction\n${seed.log}`);

    inFlight(dir, "op-inj", "bad");
    const boot = await run(dir, "resend");
    assert(
      /op-inj was persisted but not yet committed[^\n]*refused[^\n]*not acknowledged/
        .test(boot.log),
      boot.log,
    );
    // The resend is decided again — refused, never acked as "known".
    assertEquals(boot.report.frames, ["op-rejected:op-inj"], boot.log);
    assertEquals(boot.report.notes, ["ok1"]);
    assertEquals(boot.report.tally, 1, boot.log);
    assertEquals(rows(dir, "op-inj"), 0);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("an op a crash caught in flight is resolved by a boot with the journal OFF (or no store) too — refused: removed; accepted: reduced once, with its reactions", async () => {
  // Before: such a boot folded the op-log without the journal's op records,
  // and the refused op threw inside the fold — dev refused to boot, prod
  // quarantined the cell. Now the journal's intent decides, as with the
  // journal on; then (store on) the journal is moved aside.
  const offs: Record<string, string>[] = [
    { JOURNAL: "0" },
    { JOURNAL: "0", PERSIST: "0" },
  ];
  for (const off of offs) {
    const what = JSON.stringify(off);
    const dir = await tempDir("aio-refused-journal-off-");
    try {
      await run(dir, "seed");
      inFlight(dir, "op-bad", "bad");
      const refused = await run(dir, "read", off);
      assert(
        /op-bad was persisted but not yet committed[^\n]*refused/.test(
          refused.log,
        ),
        `${what}\n${refused.log}`,
      );
      assert(!/refusing to boot|QUARANTINED/.test(refused.log), refused.log);
      assertEquals(refused.report.notes, ["ok1"], refused.log);
      // No store: the listener starts from its default; no reaction either.
      assertEquals(
        refused.report.tally,
        off.PERSIST === "0" ? 0 : 1,
        refused.log,
      );
      assertEquals(rows(dir, "op-bad"), 0);
      const aside = [...Deno.readDirSync(join(dir, "data"))]
        .some((e) => e.name.startsWith("journal.unreplayed-"));
      assertEquals(aside, off.PERSIST !== "0", `${what}: moved aside`);
    } finally {
      await dropTempDir(dir);
    }
  }
  // Accepted: reduced once, its store listener's reaction applied (the store
  // had not saved since the intent) and SAVED — the journal holding nothing
  // of it any more.
  const dir = await tempDir("aio-accepted-journal-off-");
  try {
    await run(dir, "seed");
    inFlight(dir, "op-ok", "ok2");
    // Killed right after its boot: what the boot saved is all there is.
    const b1 = await run(dir, "read", { JOURNAL: "0", KILL: "1" });
    assertEquals(b1.report.notes, ["ok1", "ok2"], b1.log);
    assertEquals(b1.report.tally, 2, b1.log);
    const b2 = await run(dir, "read");
    assertEquals(b2.report.notes, ["ok1", "ok2"], b2.log);
    assertEquals(b2.report.tally, 2, `never counted twice\n${b2.log}`);
  } finally {
    await dropTempDir(dir);
  }
});

async function exportTag(tag: string): Promise<string> {
  const dir = await tempDir("aio-old-tree-");
  const tar = join(dir, "tree.tar");
  const a = await new Deno.Command("git", {
    args: ["-C", TREE, "archive", "--format=tar", "-o", tar, tag],
    stderr: "piped",
  }).output();
  assert(a.success, new TextDecoder().decode(a.stderr));
  const x = await new Deno.Command("tar", {
    args: ["-xf", tar, "-C", dir],
    stderr: "piped",
  }).output();
  assert(x.success, new TextDecoder().decode(x.stderr));
  return dir;
}

Deno.test("an op caught in flight, then REAL v1.0.9 (journal off) folds and saves it, then this build: its store listener's reaction is held, not applied a second time", async () => {
  // 1.0.9 folds the op through every listener and saves the store: the
  // store may hold the reaction, whatever the journal says (store-gen.ts).
  const given = Deno.env.get("AIO_V109_TREE");
  const old = given ?? await exportTag("v1.0.9-beta");
  const dir = await tempDir("aio-in-flight-foreign-");
  try {
    await run(dir, "seed");
    inFlight(dir, "op-ok", "ok2");
    const v109 = await run(dir, "read", { JOURNAL: "0" }, old);
    assertEquals(v109.report.notes, ["ok1", "ok2"], v109.log);
    const b = await run(dir, "read");
    assert(/written outside aio.s journalled saves/.test(b.log), b.log);
    assertEquals(b.report.notes, ["ok1", "ok2"], b.log);
    assertEquals(b.report.tally, v109.report.tally, `held\n${b.log}`);
  } finally {
    await dropTempDir(dir);
    if (!given) await dropTempDir(old);
  }
});
