// tests/sync-migration-e2e.test.ts — the END-TO-END proof of a sync cell's
// shape migration (a field report's #1 ask), through the REAL boot: real
// `aio.run`, ops written by a real WebSocket client, SQLite read back directly.
//
// Boots v1 → v2 → v3 (→ v1 again) of the same app against ONE data directory:
//   v1  `nav` { cols, theme } + a non-sync `accounts` cell; ops carry the state
//   v2  rename cols→columns, add rows, drop theme — onMigrate(state, from)
//       PROD boot: hook runs once per boundary, state = migrated op-derived
//       values, `accounts` bytes untouched, compaction writes the MIGRATED
//       slice, the boot report names the cell
//   v3  version bumped WITHOUT onMigrate — dev REFUSES (cell + fix in the
//       message), prod QUARANTINES (snapshot kept, no compaction, new ops still
//       land, `am migrations` row)
//   v1  again against the v2 log (downgrade) — newer ops skipped + reported
// docs/persistence/crdt.md "Shape changes" points app authors here.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { freePort } from "../src/testing/server-test.ts";
import { log } from "../src/diagnostics/logger-api.ts";
import { createDB } from "../src/server-entry.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { _resetParsedCli } from "../src/server/aio-cli.ts";
import { getSyncReplayContext } from "../src/server/aio-boot.ts";
import type { HLC } from "../src/sync/types.ts";

const APP = "sync-shape-e2e";
type Any = Record<string, unknown>;

// ── prod/dev: the ONE decider is `parseCli().prod` (isDevBoot) ─────────────
const _argsDesc = Object.getOwnPropertyDescriptor(Deno, "args")!;
function setMode(mode: "dev" | "prod"): void {
  Object.defineProperty(Deno, "args", {
    value: mode === "prod" ? ["--prod"] : [],
    configurable: true,
    enumerable: true,
  });
  _resetParsedCli();
}
function restoreArgs(): void {
  Object.defineProperty(Deno, "args", _argsDesc);
  _resetParsedCli();
}

// ── a real WebSocket client writing sync ops ───────────────────────────────
let _opSeq = 0;
async function sendOps(
  port: number,
  ops: { cell: string; action: string; payload: unknown }[],
): Promise<string[]> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    w.addEventListener("open", () => resolve(w));
    w.addEventListener("error", () => reject(new Error("ws failed")));
  });
  const acked = new Set<string>();
  const rejected: string[] = [];
  ws.addEventListener("message", (e) => {
    const f = JSON.parse(e.data as string);
    if (f?.t === "sync-ack") acked.add(f.d.opId);
    if (f?.t === "op-rejected") rejected.push(`${f.d.opId}: ${f.d.reason}`);
  });
  const ids: string[] = [];
  for (const op of ops) {
    const id = `op-${++_opSeq}`;
    ids.push(id);
    ws.send(JSON.stringify({
      v: 2,
      t: "op",
      d: { id, hlc: [Date.now(), _opSeq, "e2e"] as HLC, ...op },
    }));
  }
  for (let i = 0; i < 500 && acked.size < ids.length; i++) {
    if (rejected.length) throw new Error(`op rejected: ${rejected.join("; ")}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  ws.close();
  assertEquals([...acked].sort(), [...ids].sort(), "every op acked");
  return ids;
}

/** Send ONE op and expect the server to refuse it — returns the reason. */
async function sendOpExpectingRefusal(
  port: number,
  op: { cell: string; action: string; payload: unknown },
): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let reason: string | null = null;
  let acked = false;
  ws.addEventListener("message", (e) => {
    const f = JSON.parse(e.data as string);
    if (f?.t === "op-rejected") reason = String(f.d.reason);
    if (f?.t === "sync-ack") acked = true;
  });
  const id = `op-${++_opSeq}`;
  ws.send(JSON.stringify({
    v: 2,
    t: "op",
    d: { id, hlc: [Date.now(), _opSeq, "e2e"] as HLC, ...op },
  }));
  for (let i = 0; i < 500 && reason === null && !acked; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  ws.close();
  assert(!acked, "a refused op must never be acked");
  assert(reason !== null, "the server said nothing about the refused op");
  return reason;
}

// ── read the data directory back, with the app STOPPED ────────────────────
type Snap = { state: Any; cell_version: number } | null;
async function readDisk(dir: string): Promise<{
  snapshot: Snap;
  ops: { id: string; action: string; version: number }[];
  kv: Record<string, string>;
}> {
  const db = createDB(appDirs(APP, dir).stateDb);
  try {
    const snap = await db.query<{ state: string; cell_version: number }>(
      "SELECT state, cell_version FROM sync_snapshots WHERE cell = 'nav'",
    );
    const ops = await db.query<{ id: string; action: string; version: number }>(
      "SELECT id, action, version FROM sync_ops WHERE cell = 'nav' ORDER BY server_ts",
    );
    // The KV document minus the stamps that legitimately change per build.
    const kv = await db.query<{ k: string; v: string }>(
      "SELECT k, v FROM aio_kv WHERE k NOT LIKE '%:__versions' AND k NOT LIKE '%:__schema'",
    );
    return {
      snapshot: snap.rows[0]
        ? {
          state: JSON.parse(snap.rows[0].state),
          cell_version: snap.rows[0].cell_version,
        }
        : null,
      ops: ops.rows,
      kv: Object.fromEntries(kv.rows.map((r) => [r.k, r.v])),
    };
  } finally {
    await db.close();
  }
}

// ── boot helpers ───────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function boot(dir: string, cells: any[]) {
  const { aio } = await import("../mod.ts");
  return await aio.run({
    cells,
    appId: APP,
    appDir: dir,
    appVersion: "0.0.0",
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    // deno-lint-ignore no-explicit-any
  } as any);
}

const accountsCell = () =>
  cell("accounts", {
    state: { list: [] as { id: string; balance: number }[] },
    methods: {
      add(
        s: { list: { id: string; balance: number }[] },
        a: { id: string; balance: number },
      ) {
        s.list.push(a);
      },
    },
  });

const navV1 = () =>
  cell("nav", {
    version: 1,
    sync: true,
    state: { cols: 2, theme: "a" },
    methods: {
      setCols(s: Any, n: number) {
        s.cols = n;
      },
      setTheme(s: Any, t: string) {
        s.theme = t;
      },
    },
  });

/** v2: cols→columns (rename), +rows (add), −theme (remove). The v1 methods
 *  STAY — the op-log replays `nav:setCols` through THIS build's reducer, and
 *  an op whose method is gone cannot be folded. */
const navV2 = (calls: Record<number, number>) =>
  cell("nav", {
    version: 2,
    sync: true,
    state: { columns: 2, rows: 1 },
    onMigrate(s: Any, from: number) {
      calls[from] = (calls[from] ?? 0) + 1;
      if (from < 2) {
        const { cols, theme: _drop, ...rest } = s as {
          cols: number;
          theme: string;
        };
        return { ...rest, columns: cols, rows: 1 };
      }
      return s;
    },
    methods: {
      setCols(s: Any, n: number) {
        s.cols = n;
      },
      setTheme(s: Any, t: string) {
        s.theme = t;
      },
      setColumns(s: Any, n: number) {
        s.columns = n;
      },
      setRows(s: Any, n: number) {
        s.rows = n;
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);

/** v3: the bump an author forgets the hook for. */
const navV3 = () =>
  cell("nav", {
    version: 3,
    sync: true,
    state: { columns: 2, rows: 1, dense: false },
    methods: {
      setColumns(s: Any, n: number) {
        s.columns = n;
      },
      setRows(s: Any, n: number) {
        s.rows = n;
      },
    },
  });

Deno.test({
  name:
    "sync shape migration e2e: v1 ops → v2 onMigrate (prod) → v3 hookless (dev refuses / prod quarantines) → v1 downgrade",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-sync-mig-e2e-" });
    const prevApps = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", dir);
    const errors: string[] = [];
    const warnings: string[] = [];
    const origErr = log.error.bind(log);
    const origWarn = log.warn.bind(log);
    // deno-lint-ignore no-explicit-any
    log.error = ((a: string, b?: string) => errors.push(b ?? a)) as any;
    // deno-lint-ignore no-explicit-any
    log.warn = ((a: string, b?: string) => warnings.push(b ?? a)) as any;
    const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
    try {
      // ═══ v1 (dev): ops over the wire carry the state; no compaction ═══
      setMode("dev");
      _resetAioRuntime();
      const accounts1 = accountsCell();
      const a = await boot(dir, [navV1(), accounts1]);
      // deno-lint-ignore no-explicit-any
      await (accounts1 as any).add({ id: "acc-1", balance: 1234 });
      await sendOps(a.port!, [
        { cell: "nav", action: "setCols", payload: { args: [3] } },
        { cell: "nav", action: "setTheme", payload: { args: ["b"] } },
        { cell: "nav", action: "setCols", payload: { args: [4] } },
      ]);
      assertEquals((a.getState() as Any).nav, { cols: 4, theme: "b" });
      await a.close();

      const d1 = await readDisk(dir);
      assertEquals(
        d1.ops.map((o) => [o.action, o.version]),
        [["setCols", 1], ["setTheme", 1], ["setCols", 1]],
        "three v1-stamped ops survive in the log (no compaction ran)",
      );
      assertEquals(
        d1.snapshot,
        { state: { cols: 2, theme: "a" }, cell_version: 1 },
        "the adoption seed holds the v1 DEFAULTS — the ops are what carries state",
      );
      const accountsBytes = JSON.stringify(d1.kv);
      assert(
        accountsBytes.includes("acc-1") && !accountsBytes.includes('"nav"'),
        `KV holds accounts and not the sync cell: ${accountsBytes}`,
      );

      // ═══ v2 (PROD): the shape change ═══
      setMode("prod");
      _resetAioRuntime();
      const calls: Record<number, number> = {};
      const b = await boot(dir, [navV2(calls), accountsCell()]);
      let report;
      try {
        // (a) once per boundary — the whole v1 world folds, then ONE hook call
        assertEquals(calls, { 1: 1 }, "onMigrate ran exactly once, from=1");
        // (b) migrated shape, op-derived values (cols 4 → columns 4), not defaults
        assertEquals(
          (b.getState() as Any).nav,
          { columns: 4, rows: 1 },
          `renamed field carries the op-derived value; theme gone; rows at default — errors: ${
            errors.join(" | ")
          }`,
        );
        // (c) the non-sync cell rode along untouched
        assertEquals((b.getState() as Any).accounts, {
          list: [{ id: "acc-1", balance: 1234 }],
        });
        // (e) the boot report `am migrations` prints names the cell + outcome
        report = getSyncReplayContext(b.db!)?.report ?? [];
        assert(
          report.some((r) =>
            r.cell === "nav" && r.from === 1 && r.to === 2 &&
            r.outcome === "migrated"
          ),
          `report names nav v1→v2 [migrated]: ${JSON.stringify(report)}`,
        );
        // (d) a compaction AFTER boot: a server-origin write folds live state
        // into sync_snapshots through the one path every snapshot takes.
        await b.dispatch({ type: "nav:setRows", payload: { args: [3] } });
        assertEquals((b.getState() as Any).nav, { columns: 4, rows: 3 });
      } finally {
        await b.close(); // flushServerWrites → compaction of the noted cell
      }
      const d2 = await readDisk(dir);
      assert(d2.snapshot, "compaction wrote a snapshot");
      assertEquals(d2.snapshot.cell_version, 2, "snapshot stamped v2");
      assert(
        !("cols" in d2.snapshot.state) && !("theme" in d2.snapshot.state) &&
          d2.snapshot.state.columns !== 2,
        `snapshot is the MIGRATED slice, never initialState: ${
          JSON.stringify(d2.snapshot.state)
        }`,
      );
      assertEquals(
        JSON.stringify(d2.kv),
        accountsBytes,
        "(c) accounts' KV bytes are identical before and after the migration",
      );
      const v2Snapshot = d2.snapshot.state;
      assertEquals(
        d2.ops,
        [],
        "compaction folded the v1 ops into the snapshot",
      );

      // ═══ v2 again (prod): a migrated snapshot does not re-run the hook; a
      // v2 op on the wire is the log the hookless v3 will trip over ═══
      _resetAioRuntime();
      const b2 = await boot(dir, [navV2(calls), accountsCell()]);
      try {
        assertEquals(
          calls,
          { 1: 1 },
          "no second onMigrate call on a v2 snapshot",
        );
        assertEquals((b2.getState() as Any).nav, v2Snapshot);
        await sendOps(b2.port!, [
          { cell: "nav", action: "setColumns", payload: { args: [5] } },
        ]);
        assertEquals((b2.getState() as Any).nav, { columns: 5, rows: 3 });
      } finally {
        await b2.close(); // no server-origin write → no compaction
      }
      assertEquals(
        (await readDisk(dir)).ops.map((o) => [o.action, o.version]),
        [["setColumns", 2]],
        "a v2-stamped op is in the log",
      );

      // ═══ v3 without onMigrate — DEV refuses, naming cell + fix ═══
      setMode("dev");
      _resetAioRuntime();
      const refused = await assertRejects(
        () => boot(dir, [navV3(), accountsCell()]),
        Error,
        "sync: refusing to boot",
      );
      assert(refused.message.includes('"nav"'), refused.message);
      assert(
        refused.message.includes(
          `Bump "nav"'s \`version\` and add an onMigrate(state, from)`,
        ),
        refused.message,
      );
      assert(refused.message.includes("NOTHING was written"), refused.message);
      assertEquals(
        (await readDisk(dir)).snapshot?.state,
        v2Snapshot,
        "dev refusal wrote nothing",
      );

      // ═══ v3 without onMigrate — PROD quarantines ═══
      setMode("prod");
      _resetAioRuntime();
      errors.length = 0;
      const c = await boot(dir, [navV3(), accountsCell()]);
      try {
        assertEquals(
          (c.getState() as Any).nav,
          { ...v2Snapshot, dense: false },
          "quarantined: nav runs at its last (v2) snapshot (new field at its default) — v2 ops NOT folded, not initialState",
        );
        assertEquals((c.getState() as Any).accounts, {
          list: [{ id: "acc-1", balance: 1234 }],
        });
        assert(
          errors.some((e) => /cell "nav" QUARANTINED/.test(e)),
          `quarantine is loud: ${errors.join(" | ")}`,
        );
        const rep = getSyncReplayContext(c.db!)?.report ?? [];
        assert(
          rep.some((r) => r.cell === "nav" && r.outcome === "sync-quarantined"),
          `am migrations shows sync-quarantined for nav: ${
            JSON.stringify(rep)
          }`,
        );
        // …and a client write is REFUSED while the cell is quarantined: the
        // ack is a durability promise, and a log that cannot be folded cannot
        // keep it (the op would sit in a log that re-quarantines on the next
        // boot, so the change would be gone with nothing said).
        const before = (await readDisk(dir)).ops.length;
        const refusal = await sendOpExpectingRefusal(c.port!, {
          cell: "nav",
          action: "setRows",
          payload: { args: [9] },
        });
        assert(
          /quarantined/.test(refusal) && /onMigrate|version/.test(refusal),
          `the refusal names the cause and the fix: ${refusal}`,
        );
        assertEquals(
          (await readDisk(dir)).ops.length,
          before,
          "a refused op never reaches the log",
        );
        // …and a server-origin write must NOT compact the quarantined cell.
        warnings.length = 0;
        await c.dispatch({ type: "nav:setRows", payload: { args: [10] } });
        void before;
      } finally {
        await c.close();
      }
      const d3 = await readDisk(dir);
      assertEquals(
        d3.snapshot,
        { state: v2Snapshot, cell_version: 2 },
        "compaction did not rewrite the quarantined cell's snapshot",
      );
      assert(
        warnings.some((w) => /compaction of "nav" skipped/.test(w)),
        `compaction skip is said out loud: ${warnings.join(" | ")}`,
      );
      assertEquals(
        d3.ops.map((o) => [o.action, o.version]),
        [["setColumns", 2]],
        "the v2 op is intact and the refused op never joined it",
      );
      assertEquals(JSON.stringify(d3.kv), accountsBytes, "accounts untouched");

      // ═══ downgrade: v1 build against the v2/v3 log ═══
      setMode("prod");
      _resetAioRuntime();
      errors.length = 0;
      const d = await boot(dir, [navV1(), accountsCell()]);
      try {
        const rep = getSyncReplayContext(d.db!)?.report ?? [];
        assert(
          rep.some((r) => r.cell === "nav" && r.outcome === "sync-quarantined"),
          `downgrade is reported: ${JSON.stringify(rep)}`,
        );
        assert(
          errors.some((e) =>
            // One op, not two: the v3 write this build's predecessor made was
            // REFUSED while the cell was quarantined, so the log holds only
            // the v2 op the downgrade cannot fold.
            /cell "nav" QUARANTINED — 1\/1 op\(s\) could not be folded/.test(
              e,
            ) &&
            /1 newer-shape skipped/.test(e) &&
            /snapshot was written by v2, this build declares v1 \(downgrade\)/
              .test(e)
          ),
          `newer ops skipped + said: ${errors.join(" | ")}`,
        );
        // The line must say what quarantine DOES now. It used to promise that
        // writes "are not durable across a restart" — true when a quarantined
        // cell still accepted and ACKED them; since they are refused at the
        // door with an `op-rejected` reason, that sentence sent the reader
        // looking for lost data instead of a read-only cell.
        assert(
          errors.some((e) =>
            /cell "nav" QUARANTINED/.test(e) && /REFUSED at the door/.test(e) &&
            /op-rejected/.test(e) && !/not durable/.test(e)
          ),
          `the refusal is named, not "not durable": ${errors.join(" | ")}`,
        );
        assertEquals(
          (d.getState() as Any).nav,
          { cols: 2, theme: "a", ...v2Snapshot },
          "held at the snapshot (defaults filled) — nothing folded, nothing invented",
        );
      } finally {
        await d.close();
      }
      assertEquals(
        (await readDisk(dir)).ops.length,
        1,
        "the newer op is still on disk for the build that understands it",
      );
    } finally {
      log.error = origErr;
      log.warn = origWarn;
      restoreArgs();
      _resetAioRuntime();
      if (prevApps === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prevApps);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
