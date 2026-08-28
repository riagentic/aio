// A WORKER cell's in-flight method must finish writing at shutdown, exactly as
// a main-isolate cell's does.
//
// The two guarantees are implemented in completely different places. For a
// main-isolate cell, shutdown.ts Phase 1 aborts and drains. A worker cell's
// method registries live in ANOTHER ISOLATE, where `abortAllInflight` cannot
// reach them, so the worker host runs its own abort + settle on the `close`
// message and streams the final writes home as patches before acking. Two
// implementations of one contract is exactly the shape this codebase keeps
// getting wrong, and until now only the main-isolate half had a test:
// `tests/shutdown-inflight.test.ts` cannot cover the worker half, because
// `libraryMode` deliberately runs worker cells IN-ISOLATE (a test owns the
// entry module, so there is nothing to host them from). Every in-process test
// therefore exercises the main-isolate path while appearing to test workers.
//
// So this one spawns a real app with a real entry module, kills it mid-write,
// and reads the DISK.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import {
  WORKER_CLOSE_DEADLINE_MS,
  WORKER_CLOSE_DRAIN_MS,
} from "../src/server/cell-worker-protocol.ts";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** An app whose worker cell streams, and only its abort signal ends it. */
function appSource(port: number): string {
  return `import { aio, cell } from "${REPO}/mod.ts";

export const stream = cell("stream", {
  worker: true,
  // alpha52: streaming cell — incremental commits, the documented opt-out.
  transaction: false,
  state: { chunks: [], status: "idle" },
  methods: {
    async reply(s) {
      s.status = "streaming";
      for (let i = 0; i < 2000; i++) {
        if (s.$signal?.aborted) {
          // THE WRITE UNDER TEST: what the stream produced before the app was
          // told to stop, plus how it ended. It is written INSIDE the worker,
          // after the abort, and has to cross the thread boundary and reach
          // the main isolate's persist.
          s.status = "aborted";
          return "done";
        }
        s.chunks.push("c" + i);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  },
});

const app = await aio.run({
  cells: [stream],
  appId: "worker-durability-probe",
  client: "server-only",
  persist: true,
  port: ${port},
  appDir: Deno.env.get("PROBE_DIR"),
});

// Start the stream, let it get going, then shut down WHILE it is mid-write.
stream.reply();
await new Promise((r) => setTimeout(r, 300));
console.log("PROBE_SHUTTING_DOWN");
await app.close();
console.log("PROBE_CLOSED");
`;
}

Deno.test({
  name: "shutdown: a WORKER cell's in-flight method finishes writing to disk",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-worker-durability-" });
    const entry = join(dir, "app.ts");
    await Deno.writeTextFile(entry, appSource(freePort()));

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", join(REPO, "deno.json"), entry],
      env: { ...Deno.env.toObject(), PROBE_DIR: dir },
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);
    const all = stdout + stderr;

    assert(
      stdout.includes("PROBE_SHUTTING_DOWN"),
      `app never reached shutdown:\n${all}`,
    );
    assert(
      stdout.includes("PROBE_CLOSED"),
      `app.close() never resolved — a worker close that cannot be bounded ` +
        `hangs the process:\n${all}`,
    );
    assertEquals(out.code, 0, `app exited ${out.code}:\n${all}`);

    // Read what actually reached the disk, through the same restore path a
    // real next launch uses.
    const dbPath = join(dir, "data", "state.db");
    assert(
      await Deno.stat(dbPath).then(() => true).catch(() => false),
      `no state.db at ${dbPath}:\n${all}`,
    );
    const db = new DatabaseSync(dbPath);
    let stored = "";
    try {
      const rows = db.prepare("SELECT k, v FROM aio_kv").all() as Array<
        { k: string; v: string }
      >;
      stored = rows.map((r) => `${r.k}=${r.v}`).join("\n");
    } finally {
      db.close();
    }

    // The contract: the write the method made ON ITS WAY OUT is present.
    // Before the worker host ran its own abort+settle, the thread was simply
    // terminated and this write died with it — the app came back on the next
    // launch with `status: "streaming"`, a state it was never actually in.
    assert(
      stored.includes('"status":"aborted"'),
      `the worker's post-abort write did not reach disk. A worker cell must ` +
        `get the same finish-writing contract as a main-isolate cell.\n` +
        `stored:\n${stored}\n\napp output:\n${all}`,
    );
    // And it must have produced something before being cut short — otherwise
    // the assertion above could pass on an app that never really streamed.
    assert(
      stored.includes('"chunks":["c0"'),
      `expected streamed chunks to persist too:\n${stored}`,
    );

    await Deno.remove(dir, { recursive: true }).catch(() => {});
  },
});

Deno.test("worker close: the drain deadline must stay UNDER the ack deadline", () => {
  // The two budgets sit on opposite sides of a thread boundary and only work
  // as a pair: the worker drains for WORKER_CLOSE_DRAIN_MS and then acks, while
  // the main isolate waits WORKER_CLOSE_DEADLINE_MS for that ack before
  // TERMINATING the thread. If the drain ever reached or passed the deadline,
  // the main isolate would kill the worker part-way through the very writes the
  // drain exists to deliver — and it would do it silently, on the shutdown path,
  // which is the hardest place to notice a missing write.
  //
  // Their relationship was documented in a comment next to the constants.
  // A comment cannot fail a build, and the durability test above cannot catch
  // this either: it would still pass with both set to the same value, because
  // a cooperative worker acks in milliseconds and never approaches either
  // bound. Only a shape assertion catches it, so here it is.
  assert(
    WORKER_CLOSE_DRAIN_MS < WORKER_CLOSE_DEADLINE_MS,
    `WORKER_CLOSE_DRAIN_MS (${WORKER_CLOSE_DRAIN_MS}) must be strictly less ` +
      `than WORKER_CLOSE_DEADLINE_MS (${WORKER_CLOSE_DEADLINE_MS}) — the ` +
      `worker has to finish draining and get its ack out before the main ` +
      `isolate gives up and terminates the thread, or an aborted method's ` +
      `final writes are lost with no error anywhere.`,
  );
});
