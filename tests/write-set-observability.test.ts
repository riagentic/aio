// What an ASYNC method actually wrote has to exist somewhere.
//
// An async or transactional method does not commit inside its `cell:method`
// action. That action fires at CALL time — before the method body has written
// anything — and everything the body writes is published later as one atomic
// `cell:__setMethod` write-set (the batcher in `src/state/cell-impl.ts`).
//
// `__set` was filtered out of the journal, the timeline and time-travel alike,
// as "framework noise". It is the opposite: it is the ONLY record of what an
// async method did. With it filtered, three surfaces lied rather than degraded:
//
//   • journal replay reconstructed the state as it was BEFORE the writes, while
//     boot cheerfully logged "recovered 1 action(s)";
//   • `am timeline` reported `"diff": []` for an action that changed the whole
//     cell;
//   • time-travel `undo` restored a state the app had never been in, and the
//     `undo`→`redo` shape destroyed a committed write permanently — the history
//     contained no entry that had it.
//
// `docs/state/transactional-methods.md` promises a transactional commit is "a
// single journal entry … boot replay reconstructs it". These tests are that
// promise.

import { assert, assertEquals } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { createTimeline } from "../src/server/timeline.ts";
import { makeRedactor, REDACTED } from "../src/diagnostics/redact.ts";
import { testServer } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const NEVER_PERSIST = 999_999; // the snapshot must never catch up

async function boot(
  cells: Any[],
  dir: string,
  extra: Record<string, Any> = {},
) {
  _resetAioRuntime();
  return await aio.run({
    cells,
    appId: "wso",
    journal: true,
    dbPath: `${dir}/data.db`,
    persistDebounceMs: NEVER_PERSIST,
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
    ...extra,
  } as Any);
}

function asyncCell() {
  return cell("wso_async", {
    state: { n: 1, s: "" },
    methods: {
      async grow(s: { n: number; s: string }, by: number) {
        await Promise.resolve();
        s.n += by;
        s.s = "async-wrote";
      },
    },
  });
}

// ─── Journal: replay must reproduce what the method wrote ───────────────────

Deno.test("write-set: journal replay reconstructs an ASYNC method's writes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-wso-async-" });
  try {
    const c1 = asyncCell();
    const app1 = await boot([c1], dir);
    await (c1 as Any).grow(10);
    const live = (app1.getState() as Any).wso_async;
    assertEquals(live, { n: 11, s: "async-wrote" }, "control: what LIVE was");

    // Read the journal WHILE RUNNING: a clean close persists a snapshot and
    // compacts the journal away, which is precisely the tail a crash keeps.
    const jtxt = await Deno.readTextFile(`${dir}/data.db.journal`);
    await app1.close();
    const lines = jtxt.trim().split("\n").map((l) => JSON.parse(l));
    const writeSet = lines.find((l) => l.type === "wso_async:__setGrow");
    assert(
      writeSet,
      `the write-set commit is the only record of what grow() wrote, and it ` +
        `is not in the journal:\n${jtxt}`,
    );
    assertEquals(
      writeSet.origin,
      "wso_async:grow",
      "it must be attributed to the method that produced it",
    );

    // SIGKILL: that journal tail exists and no snapshot ever caught up.
    // A pristine data dir + the tail is exactly that situation.
    const crashDir = await Deno.makeTempDir({ prefix: "aio-wso-crash-" });
    await Deno.writeTextFile(`${crashDir}/data.db.journal`, jtxt);
    const app2 = await boot([asyncCell()], crashDir);
    assertEquals(
      (app2.getState() as Any).wso_async,
      { n: 11, s: "async-wrote" },
      "replay dropped the async write — recovery reported success and " +
        "restored { n: 1, s: '' }",
    );
    await app2.close();
    _resetAioRuntime();
    await Deno.remove(crashDir, { recursive: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("write-set: a TRANSACTIONAL commit is one journal entry, and replay reconstructs it", async () => {
  const mk = () =>
    cell("wso_txn", {
      transaction: true,
      state: { b: 100, mv: 0 },
      methods: {
        async move(s: { b: number; mv: number }, amt: number) {
          await Promise.resolve();
          s.b -= amt;
          s.mv += amt;
        },
      },
    });
  const dir = await Deno.makeTempDir({ prefix: "aio-wso-txn-" });
  try {
    const t1 = mk();
    const app1 = await boot([t1], dir);
    await (t1 as Any).move(30);
    assertEquals(
      (app1.getState() as Any).wso_txn,
      { b: 70, mv: 30 },
      "control: what LIVE was",
    );

    const jtxt = await Deno.readTextFile(`${dir}/data.db.journal`);
    await app1.close();
    const setLines = jtxt.trim().split("\n").map((l) => JSON.parse(l))
      .filter((l) => l.type === "wso_txn:__setMove");
    assertEquals(
      setLines.length,
      1,
      "the docs promise ONE journal entry per transactional commit",
    );

    const crashDir = await Deno.makeTempDir({ prefix: "aio-wso-txn-crash-" });
    await Deno.writeTextFile(`${crashDir}/data.db.journal`, jtxt);
    const app2 = await boot([mk()], crashDir);
    assertEquals(
      (app2.getState() as Any).wso_txn,
      { b: 70, mv: 30 },
      "replay produced { b: 100, mv: 0 } — the money moved and then unmoved",
    );
    await app2.close();
    _resetAioRuntime();
    await Deno.remove(crashDir, { recursive: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ─── Timeline: the diff must describe the change ────────────────────────────

Deno.test("write-set: the timeline shows the diff, attributed to the method", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-wso-tl-" });
  try {
    const c = asyncCell();
    await using srv = await testServer({
      cells: [c],
      baseDir: dir,
      appId: "wso-tl",
    } as Any);
    await (c as Any).grow(4);

    // Read it the way a developer does: `am timeline` hits this exact route.
    const res = await fetch(`${srv.url}/__aio/trojan/timeline`);
    const body = await res.text();
    assertEquals(res.status, 200, body);
    const entries = (JSON.parse(body) as { entries: Any[] }).entries;

    const e = entries.find((x) => x.type === "wso_async:__setGrow");
    assert(
      e,
      `the write-set is absent from the timeline entirely:\n${body}`,
    );
    assert(
      e.diff.length > 0,
      `am timeline reported "diff": [] for the action that changed ` +
        `everything:\n${JSON.stringify(e)}`,
    );
    assertEquals(
      e.origin,
      "wso_async:grow",
      "an opaque `__setGrow` with no attribution is not an answer",
    );
    // The diff has to describe the REAL change, not merely be non-empty.
    const paths = e.diff.map((d: Any) => d.path).sort();
    assertEquals(paths, ["wso_async.n", "wso_async.s"]);
    _resetAioRuntime();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ─── Redaction must follow the write-set, under its OWN type ────────────────

Deno.test("write-set: an EXACT redaction pattern still covers the write-set it produces", () => {
  // `redactActions: ["vault:unlockWith"]` matches the call action and NOT
  // `vault:__setUnlockWith`. Recording the write-set without checking its
  // origin would have plugged the arguments and then written the same secret
  // straight back out as a mutation value.
  const tl = createTimeline(10, makeRedactor(["vault:unlockWith"]));
  tl.record(
    1,
    "vault:__setUnlockWith",
    { mutations: [{ path: ["key"], value: "hunter2" }], _origin: "unlockWith" },
    { vault: { key: "" } },
    { vault: { key: "hunter2" } },
    1000,
    "vault:unlockWith",
  );
  const e = tl.entries()[0]!;
  assertEquals(e.payload, REDACTED);
  assertEquals(e.diff.every((d) => d.after === REDACTED), true);
  const blob = JSON.stringify(e);
  assert(!blob.includes("hunter2"), `the secret survived redaction: ${blob}`);
});

// ─── Time travel: every entry is a state the app really had ─────────────────

Deno.test("write-set: undo/redo never destroys a committed async write", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-wso-tt-" });
  try {
    const c = asyncCell();
    await using srv = await testServer({
      cells: [c],
      baseDir: dir,
      appId: "wso-tt",
      diagnostics: { timeTravel: true },
    } as Any);
    await (c as Any).grow(10);
    assertEquals(
      (srv.app.getState() as Any).wso_async.n,
      11,
      "control: the write committed",
    );

    const tt = async (cmd: string) => {
      const r = await fetch(`${srv.url}/__aio/trojan/tt`, {
        method: "POST",
        headers: { "X-AIO": "1" }, // CSRF guard — `am` sends the same
        body: JSON.stringify({ cmd }),
      });
      const t = await r.text();
      assertEquals(r.status, 200, `tt ${cmd}: ${t}`);
    };

    await tt("undo");
    await tt("redo");
    await tt("resume");
    assertEquals(
      (srv.app.getState() as Any).wso_async.n,
      11,
      "undo->redo left the committed write DESTROYED at n=1: time travel " +
        "held no entry that contained it, so redo could not restore it",
    );
    _resetAioRuntime();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
