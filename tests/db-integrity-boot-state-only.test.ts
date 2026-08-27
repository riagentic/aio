// Audit 2026-08-27 (HIGH): `checkIntegrityOnBoot` was a silent no-op for the
// DEFAULT app shape.
//
// The check lived inside `if (dbKeys.length > 0 || syncCellIds.length > 0)`, so
// an app with neither `db:` tables nor sync cells — the shape every app starts
// as — never ran it, and the persistence-only open path never called
// `checkAndRecover`. Verified: a state-only app with a corrupt `state.db` and a
// VALID `state.db.snapshot` beside it threw
//   persistence unavailable: Error: disk I/O error
//   Fix permissions or set persist: false to disable persistence.
// — nothing quarantined, nothing restored, and the named cause is not the
// cause. The one boot-wiring test declared `db:`, so it took the other branch
// and the gap was invisible; this test deliberately declares NO `db:` key.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";

type Snapshotter = { db: { snapshot(path: string): Promise<void> } };

Deno.test({
  name:
    "boot: a state-only app (no db:, no sync) still integrity-checks and restores",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-integrity-stateonly-" });
    const appId = `integ-${crypto.randomUUID().slice(0, 8)}`;
    const mkCell = () =>
      cell("counter", {
        state: { n: 0 },
        methods: {
          bump(s: { n: number }) {
            s.n++;
          },
        },
      });
    const boot = (c: ReturnType<typeof mkCell>) =>
      aio.run({
        cells: [c],
        appId,
        appVersion: "0.0.0",
        client: "server-only",
        libraryMode: true,
        singleton: false,
        port: freePort(),
        appDir: dir,
        baseDir: dir,
        persistDebounceMs: 10,
        checkIntegrityOnBoot: true,
      });
    const dbPath = join(dir, "data", "state.db");

    try {
      const c1 = mkCell();
      const app1 = await boot(c1);
      await c1.bump();
      await c1.bump();
      await new Promise((r) => setTimeout(r, 150));
      // A real snapshot (VACUUM INTO): copying the file would miss the WAL.
      await (app1 as unknown as Snapshotter).db.snapshot(dbPath + ".snapshot");
      await app1.close();

      // Corrupt the live file: keep the 100-byte SQLite header so it still
      // OPENS, scribble everything after it.
      for (const ext of ["-wal", "-shm"]) {
        await Deno.remove(dbPath + ext).catch(() => {});
      }
      const bytes = await Deno.readFile(dbPath);
      bytes.fill(0x7a, 100);
      await Deno.writeFile(dbPath, bytes);

      const app2 = await boot(mkCell());
      try {
        assertEquals(
          (app2.getState() as { counter: { n: number } }).counter.n,
          2,
          "booted on the restored snapshot",
        );
        const names: string[] = [];
        for await (const e of Deno.readDir(join(dir, "data"))) {
          names.push(e.name);
        }
        assert(
          names.some((n) => n.startsWith("state.db.corrupt-")),
          `the damaged file must be quarantined, never deleted — saw ${names}`,
        );
      } finally {
        await app2.close();
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
