// Audit a4 (B): `journal: true` acked a write whose journal append FAILED.
//
// The append rides in `afterAction`, which the dispatcher guards as an
// observe-only hook: a refused append (EACCES, ENOSPC, a journal replaced by
// something unwritable) was reported as HOOK_ERROR — "diagnostics for this
// action are lost" — the call was acked ok, and the write lived nowhere durable
// until the debounce timer fired. A SIGKILL in that window lost an acked write
// under the one option that exists to prevent exactly that.
//
// The state is already committed and broadcast when the append runs, so the
// promise is kept by the other mechanism: the failure is reported as what it
// is (PERSIST_ERROR) and the debounce window is closed NOW, so the snapshot
// carries the write. Proof: with an effectively infinite debounce, the write
// is on disk — read through a second connection, before close — anyway.
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

const kvHolds = (dbPath: string, needle: string): boolean => {
  const c = new DatabaseSync(dbPath);
  try {
    const rows = c.prepare("SELECT v FROM aio_kv").all() as { v: string }[];
    return rows.some((r) => r.v.includes(needle));
  } finally {
    c.close();
  }
};

Deno.test("journal: a refused append is PERSIST_ERROR and the write lands in the snapshot at once", async () => {
  const dir = await Deno.makeTempDir();
  const dbPath = dir + "/data.db";
  _resetAioRuntime();
  const c = cell("jdur_counter", {
    state: { n: 0 },
    methods: {
      add(s: { n: number }, by: number) {
        s.n += by;
      },
    },
  });
  const errors: { code?: string; message?: string }[] = [];
  const app = await aio.run({
    cells: [c],
    appId: "jdur",
    journal: true,
    dbPath,
    persistDebounceMs: 999999, // the journal is supposed to be the only net
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
    onError: (e: { code?: string; message?: string }) => errors.push(e),
  });
  try {
    // Make every append fail from now on: the journal path becomes a
    // directory (EISDIR — deterministic, and it works as root too, where a
    // chmod would not bite).
    const jp = dbPath + ".journal";
    await Deno.remove(jp).catch(() => {});
    await Deno.mkdir(jp);

    await (c as unknown as { add: (n: number) => Promise<void> }).add(7);

    assert(
      errors.some((e) => e.code === "PERSIST_ERROR"),
      `the refused append is a durability failure, got: ${
        JSON.stringify(errors.map((e) => e.code))
      }`,
    );
    assert(
      !errors.some((e) => e.code === "HOOK_ERROR"),
      "it is not an observe-only hook failure",
    );
    // The window was closed immediately — the write is on disk with the
    // process still running (a SIGKILL now would not lose it).
    let onDisk = false;
    for (let i = 0; i < 100 && !onDisk; i++) {
      await new Promise((r) => setTimeout(r, 20));
      onDisk = kvHolds(dbPath, '"n":7');
    }
    assert(onDisk, "the acked write must be in the snapshot, not only in RAM");
  } finally {
    await app.close();
    _resetAioRuntime();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
