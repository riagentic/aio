// 50audits §5 (RED, total data loss): `am snapshot load wrong.json` — a
// snapshot taken from a DIFFERENT app, the most likely mistake on the restore
// path — replaced the whole state, reported `{"status":"loaded"}`, exited 0,
// and the next persist window wrote `{}` over the row on disk. `am errors`
// showed nothing, because the only signal was a `log.warn` for unknown keys
// (a level `am errors` does not collect) and MISSING keys were never checked
// at all.
//
// Both halves are refusals now, decided in one pure function.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { snapshotCellsError } from "../src/server/server-static.ts";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

Deno.test("snapshotCellsError: an exact cell set loads", () => {
  assertEquals(snapshotCellsError({ todo: {}, ui: {} }, ["todo", "ui"]), null);
});

Deno.test("snapshotCellsError: a MISSING cell is refused by name", () => {
  const e = snapshotCellsError({ todo: {} }, ["todo", "ui"]);
  assert(e, "a snapshot with nothing for `ui` destroys `ui`");
  assertStringIncludes(e, '"ui"');
  assertStringIncludes(e, "DESTROYED");
  assertStringIncludes(e, "--force");
});

Deno.test("snapshotCellsError: an UNKNOWN cell is refused by name", () => {
  const e = snapshotCellsError({ todo: {}, ui: {}, nosuchcell: {} }, [
    "todo",
    "ui",
  ]);
  assert(e);
  assertStringIncludes(e, '"nosuchcell"');
});

Deno.test("snapshotCellsError: the wrong app's file names BOTH halves", () => {
  const e = snapshotCellsError({ nosuchcell: { x: 1 } }, ["todo"]);
  assert(e);
  assertStringIncludes(e, '"todo"'); // would be destroyed
  assertStringIncludes(e, '"nosuchcell"'); // not declared here
});

Deno.test("snapshotCellsError: a non-object is left to snapshotShapeError", () => {
  assertEquals(snapshotCellsError(null, ["todo"]), null);
  assertEquals(snapshotCellsError([1, 2], ["todo"]), null);
});

/** The route `am snapshot load` posts to. */
const postSnapshot = (port: number, body: unknown, force = false) =>
  fetch(
    `http://127.0.0.1:${port}/__aio/trojan/snapshot${force ? "/force" : ""}`,
    {
      method: "POST",
      headers: { "X-AIO": "1", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

Deno.test("am snapshot load: the WRONG app's file is refused, state untouched", async () => {
  const dir = await tempDir("snap-cellset-");
  const port = freePort();
  _resetAioRuntime();
  const c = cell("sc_todo", {
    state: { items: [] as number[] },
    methods: {
      add(s: { items: number[] }, n: number) {
        s.items.push(n);
      },
    },
  });
  const app = await aio.run({
    cells: [c],
    appId: "snap-cellset",
    dbPath: join(dir, "state.db"),
    port,
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
  });
  try {
    await (c as unknown as { add: (n: number) => Promise<void> }).add(7);
    const before = JSON.stringify(app.getState());
    assertStringIncludes(before, "7");

    const resp = await postSnapshot(port, { nosuchcell: { x: 1 } });
    assertEquals(resp.status, 400);
    const body = await resp.json();
    assertStringIncludes(String(body.error), "sc_todo");
    assertStringIncludes(String(body.error), "DESTROYED");

    assertEquals(
      JSON.stringify(app.getState()),
      before,
      "a refused snapshot must not have touched the state",
    );

    // `--force` is the operator saying they meant it — the same body, loaded.
    const forced = await postSnapshot(port, { nosuchcell: { x: 1 } }, true);
    assertEquals(forced.status, 200);
    assertEquals(
      (app.getState() as Record<string, unknown>).nosuchcell,
      { x: 1 },
    );
  } finally {
    await app.close();
    _resetAioRuntime();
    await dropTempDir(dir);
  }
});

Deno.test("am snapshot load: an app's OWN snapshot still round-trips", async () => {
  const dir = await tempDir("snap-roundtrip-");
  const port = freePort();
  _resetAioRuntime();
  const c = cell("rt_todo", {
    state: { items: [] as number[] },
    methods: {
      add(s: { items: number[] }, n: number) {
        s.items.push(n);
      },
    },
  });
  const app = await aio.run({
    cells: [c],
    appId: "snap-roundtrip",
    dbPath: join(dir, "state.db"),
    port,
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
  });
  try {
    const add = (c as unknown as { add: (n: number) => Promise<void> }).add;
    await add(1);
    const saved = app.snapshot!();
    await add(2);
    assertStringIncludes(JSON.stringify(app.getState()), "2");

    const resp = await postSnapshot(port, JSON.parse(saved));
    assertEquals(resp.status, 200);
    assertEquals(
      (app.getState() as { rt_todo: { items: number[] } }).rt_todo.items,
      [1],
    );
  } finally {
    await app.close();
    _resetAioRuntime();
    await dropTempDir(dir);
  }
});
