// A database deleted under a RUNNING app is reported by the persist window
// that meets it — not only by the shutdown.
//
// POSIX keeps an unlinked inode alive for the open fd, so SQLite commits into
// a file no path reaches. Only the shutdown path checked for that: until then
// `am persist` answered {"ok":true}, `/__aio/health` said healthy, a dispatch
// reply carried `unsaved: null`, and nothing was logged. Every persist window
// now stats the file (one stat per window, never per write) and a missing one
// is a refused cycle: the existing PERSIST_ERROR → `lastCycleError()` →
// persist route / health / dispatch `unsaved` paths all say it. The window is
// NOT written — with `journal: true` a "successful" write would advance the
// watermark and compact away the journal lines that are then the only record.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const H = { "Content-Type": "application/json", "X-AIO": "1" };

Deno.test("persist: deleting state.db under a running app fails `persist`, health and the dispatch reply", async () => {
  const dir = await tempDir("aio-db-deleted-live-");
  const dbPath = join(dir, "state.db");
  const port = freePort();
  _resetAioRuntime();
  const box = cell("dbgone", {
    state: { n: 0 },
    methods: {
      set(s: { n: number }, n: number) {
        s.n = n;
      },
    },
  });
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  const app = await aio.run({
    cells: [box],
    appId: "dbgone",
    client: "server-only",
    libraryMode: true,
    port,
    dbPath,
    baseDir: dir,
    journal: true,
    persistDebounceMs: 20,
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const persist = () =>
      fetch(`${base}/__aio/trojan/persist`, { method: "POST", headers: H });
    const r0 = await persist();
    assertEquals(r0.status, 200, await r0.text());

    for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
      await Deno.remove(f).catch(() => {});
    }
    const d = await fetch(`${base}/__aio/trojan/dispatch`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ type: "dbgone:set", payload: { args: [2] } }),
    });
    assertEquals(d.status, 200, await d.clone().text());
    await d.body?.cancel();

    const r1 = await persist();
    const body = await r1.text();
    assertEquals(r1.status, 500, `persist must not say ok: ${body}`);
    assertStringIncludes(body, "GONE");

    const h = await (await fetch(`${base}/__aio/health`)).json();
    assert(h.status !== "healthy", JSON.stringify(h));
    assertEquals(h.persist?.ok, false, JSON.stringify(h));

    const d2 = await fetch(`${base}/__aio/trojan/dispatch`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ type: "dbgone:set", payload: { args: [3] } }),
    });
    const d2b = await d2.json();
    assert(
      d2b.unsaved,
      `the dispatch reply names the refusal: ${JSON.stringify(d2b)}`,
    );

    // The journal still holds the writes: nothing compacted them away.
    const j = await Deno.readTextFile(dbPath + ".journal");
    assertStringIncludes(j, '"args":[2]');
    // Said in the log, once per loss — not once per window.
    const gone = errors.filter((l) => l.includes("database file is GONE"));
    assertEquals(gone.length >= 1, true, errors.join("\n"));
  } finally {
    console.error = origError;
    await app.close();
    _resetAioRuntime();
    await dropTempDir(dir);
  }
});
