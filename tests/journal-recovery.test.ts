// risoto #3 — end-to-end journal recovery wired into the runtime. `journal:true`
// appends every committed user action; on the next boot the actions past the
// last snapshot are replayed on top of the restored state. Proves the WIRING
// (afterAction append + boot replay); replay correctness itself is journal.test.ts.
import { assert, assertEquals } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

function counter() {
  return cell("jrec_counter", {
    state: { n: 0 },
    methods: {
      add(s: { n: number }, by: number) {
        s.n += by;
      },
    },
  });
}

Deno.test("journal: committed actions are appended (user actions only)", async () => {
  const dir = await Deno.makeTempDir();
  const dbPath = dir + "/data.db";
  _resetAioRuntime();
  const c = counter();
  const app = await aio.run({
    cells: [c],
    appId: "jrec",
    journal: true,
    dbPath,
    persistDebounceMs: 999999, // never auto-persist — the action lives in the journal
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
  });
  await (c as unknown as { add: (n: number) => Promise<void> }).add(7);
  await (c as unknown as { add: (n: number) => Promise<void> }).add(5);
  const jtxt = await Deno.readTextFile(dbPath + ".journal");
  const lines = jtxt.trim().split("\n").map((l) => JSON.parse(l));
  const adds = lines.filter((e) => e.type === "jrec_counter:add");
  assertEquals(
    adds.map((e) => e.payload.args[0]),
    [7, 5],
    "both adds journalled",
  );
  assert(
    !lines.some((e) => String(e.type).includes(":__")),
    "framework-internal __methods are NOT journalled",
  );
  await app.close();
  _resetAioRuntime();
});

Deno.test("journal: boot replays the tail on top of the restored snapshot", async () => {
  const dir = await Deno.makeTempDir();
  const dbPath = dir + "/data.db";
  // Simulate a crash: an action was journalled (seq 1) but the KV snapshot never
  // caught up (fresh db, watermark 0). Boot must replay it.
  await Deno.writeTextFile(
    dbPath + ".journal",
    JSON.stringify({
      seq: 1,
      type: "jrec_counter:add",
      payload: { args: [42] },
      ts: 1,
    }) + "\n",
  );
  _resetAioRuntime();
  const c = counter();
  const app = await aio.run({
    cells: [c],
    appId: "jrec",
    journal: true,
    dbPath,
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
  });
  // Recovered from the journal (KV was empty → initial 0, replay +42).
  assertEquals((c as unknown as { n: number }).n, 42);
  await app.close();
  _resetAioRuntime();
});
