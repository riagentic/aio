// `app.loadSnapshot(json)` is the documented restore path (docs/persistence/
// auto-persist.md: "replace state, broadcast to all clients … triggers
// persistence"), and it is what `POST /__aio/snapshot` calls.
//
// A `db:`-bound array lives in state like any other field, so a snapshot
// carries its rows — and a restore has to reach SQLite, because SQLite is
// where those rows are read back from on the NEXT boot. If it doesn't, the
// restore looks perfect (state replaced, every client re-rendered, the call
// returns) and evaporates at the next restart.

import { assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { aio, cell, pk, table, text } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";

type Item = { id: number; v: string };

Deno.test({
  name: "db: loadSnapshot writes the restored rows to SQLite, not just state",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-db-snap-" });
    const appId = `snap-${crypto.randomUUID().slice(0, 8)}`;
    const notes = cell("notes", {
      state: { items: [] as Item[], n: 0 },
      methods: {
        add(s: { items: Item[]; n: number }, v: string) {
          s.n++;
          s.items.push({ id: s.n, v });
        },
      },
    });
    const boot = () =>
      aio.run({
        cells: [notes],
        appId,
        appVersion: "0.0.0",
        client: "server-only",
        libraryMode: true,
        singleton: false,
        port: freePort(),
        appDir: dir,
        baseDir: dir,
        persistDebounceMs: 10,
        db: { "notes.items": table({ id: pk(), v: text() }) },
      });

    const readRows = (): string[] => {
      const db = new DatabaseSync(join(dir, "data", "state.db"));
      const rows = db.prepare("SELECT v FROM notes_items ORDER BY id")
        .all() as Array<{ v: string }>;
      db.close();
      return rows.map((r) => r.v);
    };

    try {
      const app1 = await boot();
      await notes.add("keep");
      await new Promise((r) => setTimeout(r, 120));
      const backup = app1.snapshot!();

      // Drift away from the backup, and persist that.
      await notes.add("drift");
      await new Promise((r) => setTimeout(r, 120));
      assertEquals(readRows(), ["keep", "drift"], "precondition: both stored");

      // Restore.
      app1.loadSnapshot!(backup);
      await new Promise((r) => setTimeout(r, 120));
      assertEquals(
        (app1.getState() as { notes: { items: Item[] } }).notes.items.map((
          r,
        ) => r.v),
        ["keep"],
        "state is restored (this half has always worked)",
      );
      assertEquals(
        readRows(),
        ["keep"],
        "the SQL table must be restored too — it is what the next boot reads",
      );
      await app1.close();

      // And it survives the restart.
      const app2 = await boot();
      assertEquals(
        (app2.getState() as { notes: { items: Item[] } }).notes.items.map((
          r,
        ) => r.v),
        ["keep"],
        "after a restart the restored rows are still the ones in state",
      );
      await app2.close();
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
