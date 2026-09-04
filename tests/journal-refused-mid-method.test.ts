// The journal refused MID-METHOD, under concurrent dispatches.
//
// tests/journal-append-durability pins the single-shot case: a refused append
// is PERSIST_ERROR and the write lands in the snapshot at once. This is the
// differential the audit asked for — several async methods in flight, the
// journal replaced by something unwritable while they are suspended, then all
// of them committing into the refusal at once:
//
//   • every ack resolves — the ack means APPLIED, by design, and a refused
//     append must not turn into a rejected call (the state is committed and
//     broadcast by the time the append runs);
//   • the refusal is REPORTED where an operator looks: `/__aio/health` is
//     `degraded` with a `journal:<appId>` entry from the FIRST refusal, and it
//     recovers — and says so — once appends land again;
//   • `am persist` (the trojan persist route) answers 200, because the state
//     IS on disk: each refusal closed the persist window, and the snapshot
//     holds every one of the concurrent writes before the process is asked
//     for anything else;
//   • `persist.ok` stays true — the durability verdict is about the state,
//     and the state landed. The journal's broken promise is the `degraded`
//     entry, not a false "not on disk".
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Health = {
  status: string;
  persist?: { ok: boolean; error?: string };
  degraded?: { name: string; failures: number; lastError: string }[];
};

const kvHolds = (dbPath: string, needle: string): boolean => {
  const c = new DatabaseSync(dbPath);
  try {
    const rows = c.prepare("SELECT v FROM aio_kv").all() as { v: string }[];
    return rows.some((r) => r.v.includes(needle));
  } finally {
    c.close();
  }
};

Deno.test("journal refused mid-method: every ack resolves, health says degraded, the snapshot holds every write", async () => {
  const dir = await tempDir("jref-");
  const dbPath = join(dir, "data.db");
  const port = freePort();
  _resetAioRuntime();

  // A gate the test opens: N methods suspend on it, the journal is broken
  // while they wait, and they all commit into the refusal together.
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  // Each in-flight method writes ITS OWN key. An async method reads through
  // the draft it was handed when it started, so eight concurrent `s.n += by`
  // resolve to the last writer (measured: n=9, not 37) — a property of async
  // methods, not of the journal, and not what this test is about. Distinct
  // paths commit as distinct patches, so every write is observable.
  const c = cell("jref_counter", {
    state: { n: 0, slots: {} as Record<string, number> },
    methods: {
      async slowAdd(s: { slots: Record<string, number> }, by: number) {
        await gate;
        s.slots[String(by)] = by;
      },
      add(s: { n: number }, by: number) {
        s.n += by;
      },
    },
  });
  const errors: { code?: string }[] = [];
  const app = await aio.run({
    cells: [c],
    appId: "jref",
    journal: true,
    dbPath,
    port,
    persistDebounceMs: 999999, // only a refusal (or a forced flush) may write
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
    onError: (e: { code?: string }) => errors.push(e),
  });
  const api = c as unknown as {
    slowAdd: (n: number) => Promise<void>;
    add: (n: number) => Promise<void>;
  };
  const health = async (): Promise<Health> =>
    JSON.parse(
      await (await fetch(`http://127.0.0.1:${port}/__aio/health`, {
        headers: { "X-AIO": "1" },
      })).text(),
    ) as Health;
  const persist = () =>
    fetch(`http://127.0.0.1:${port}/__aio/trojan/persist`, {
      method: "POST",
      headers: { "X-AIO": "1" },
    });
  const jp = dbPath + ".journal";
  try {
    // Healthy, and positively so, before anything goes wrong.
    await api.add(1);
    const well = await health();
    assertEquals(well.status, "healthy", JSON.stringify(well));
    assertEquals(well.degraded, undefined);

    // ── N methods in flight, suspended inside their bodies ────────────
    const N = 8;
    const inflight = Array.from({ length: N }, (_, i) => api.slowAdd(i + 1));
    await new Promise((r) => setTimeout(r, 30)); // all of them are at the gate

    // MID-METHOD: the journal becomes a directory (EISDIR — deterministic,
    // and it bites as root too, where a chmod would not).
    await Deno.remove(jp);
    await Deno.mkdir(jp);

    release();
    // Every ack resolves: a refused append is a durability failure, never a
    // rejected call — the write it failed to journal is already committed.
    await Promise.all(inflight);

    const slots = (app.getState() as {
      jref_counter: { slots: Record<string, number> };
    }).jref_counter.slots;
    assertEquals(
      Object.keys(slots).map(Number).sort((a, b) => a - b),
      Array.from({ length: N }, (_, i) => i + 1),
      "every concurrent write is applied",
    );
    assert(
      errors.some((e) => e.code === "PERSIST_ERROR"),
      `the refusals are PERSIST_ERROR, got: ${
        JSON.stringify(errors.map((e) => e.code))
      }`,
    );
    assert(
      !errors.some((e) => e.code === "HOOK_ERROR"),
      "not an observe-only hook failure",
    );

    // ── the refusal is REPORTED: health is degraded, and names the journal ─
    const sick = await health();
    assertEquals(sick.status, "degraded", JSON.stringify(sick));
    const entry = sick.degraded?.find((d) => d.name === "journal:jref");
    assert(
      entry,
      `health must carry the journal: ${JSON.stringify(sick.degraded)}`,
    );
    assert(entry!.failures >= 1);
    assert(
      /EISDIR|directory|Is a directory/i.test(entry!.lastError),
      entry!.lastError,
    );
    // …while the STATE verdict is true: it landed (the refusal flushed it).
    assertEquals(sick.persist, { ok: true });

    // ── the writes are on disk, with the process still up ────────────
    const allOnDisk = () =>
      Array.from({ length: N }, (_, i) => i + 1).every((by) =>
        kvHolds(dbPath, `"${by}":${by}`)
      );
    let onDisk = false;
    for (let i = 0; i < 100 && !onDisk; i++) {
      await new Promise((r) => setTimeout(r, 20));
      onDisk = allOnDisk();
    }
    assert(
      onDisk,
      "every concurrent write must be in the snapshot, not only in RAM",
    );
    // `am persist` agrees — the state IS on disk, so it is a 200.
    const persisted = await persist();
    assertEquals(persisted.status, 200);
    await persisted.body?.cancel();

    // ── and it RECOVERS, and says so: appends land again → healthy ───
    await Deno.remove(jp, { recursive: true });
    await api.add(100);
    const cured = await health();
    assertEquals(cured.status, "healthy", JSON.stringify(cured));
    assertEquals(cured.degraded, undefined);
    assert(
      (await Deno.readTextFile(jp)).includes("jref_counter:add"),
      "the journal is being appended to again",
    );
  } finally {
    await app.close();
    _resetAioRuntime();
    await dropTempDir(dir);
  }
});
