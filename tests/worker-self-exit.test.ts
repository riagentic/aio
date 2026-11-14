// A `worker: true` cell whose thread ends ITSELF — app code calling
// `Deno.exit()` or `self.close()` — and one that crashes during its own
// close().
//
// Neither self-exit raises `onerror`, and the owner noticed nothing else: the
// call that exited, and every later call, hung forever with not a line in any
// log. The host now says so before the thread ends; the owner treats it as a
// crash (answered by name, respawned under `workerRespawn: true`).
//
// A crash DURING close() never acked `closed`, so shutdown stalled the whole
// WORKER_CLOSE_DEADLINE_MS and then blamed a thread "stuck in synchronous
// code" that was already dead.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { WORKER_CLOSE_DEADLINE_MS } from "../src/server/cell-worker-protocol.ts";
import {
  wclose,
  wexit,
  wexitr,
  wteardown,
} from "./fixtures/worker-self-exit-app.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const ENTRY = import.meta.resolve("./fixtures/worker-self-exit-app.ts");

/** The call's outcome, or "HUNG" — the bug was a promise that never settles. */
const within = (p: Promise<unknown>, ms = 5000) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.then((v) => ({ v }), (e) => ({ e: String(e?.message ?? e) })),
    new Promise((r) => t = setTimeout(() => r("HUNG"), ms)),
  ]).finally(() => clearTimeout(t));
};

function capture(): { lvl: string; cat: string; msg: string }[] {
  const lines: { lvl: string; cat: string; msg: string }[] = [];
  setLogger(
    {
      pub: (lvl: string, cat: string, msg: string) => {
        if (cat === "cell-worker") lines.push({ lvl, cat, msg });
      },
      flush: () => {},
    } as unknown as LogSink,
  );
  return lines;
}

Deno.test("worker self-exit: Deno.exit() in a method rejects it by name, and every later call", async () => {
  const lines = capture();
  try {
    await using _srv = await testServer({
      cells: [wexit],
      workers: "real",
      workerEntry: ENTRY,
    });
    const W = wexit as Any;
    assertEquals(await W.inc(), 1);
    const q = await within(W.quit()) as { e?: string };
    assert(q !== ("HUNG" as unknown), "the exiting call hung");
    assertStringIncludes(
      q.e ?? "",
      "the worker exited (Deno.exit(3)) in quit()",
    );
    const after = await within(W.inc()) as { e?: string };
    assert(after !== ("HUNG" as unknown), "a later call hung");
    assertStringIncludes(after.e ?? "", "crashed");
    const said = lines.filter((l) =>
      l.lvl === "error" && l.msg.includes("Deno.exit(3)")
    );
    assertEquals(said.length, 1, JSON.stringify(lines));
  } finally {
    setLogger(null);
  }
});

Deno.test("worker self-exit: self.close() in an async method rejects it by name", async () => {
  const lines = capture();
  try {
    await using _srv = await testServer({
      cells: [wclose],
      workers: "real",
      workerEntry: ENTRY,
    });
    const W = wclose as Any;
    assertEquals(await W.inc(), 1);
    const q = await within(W.shut()) as { e?: string };
    assert(q !== ("HUNG" as unknown), "the closing call hung");
    assertStringIncludes(
      q.e ?? "",
      "the worker exited (self.close()) in shut()",
    );
    assert(
      (await within(W.inc())) !== "HUNG",
      "a later call into the closed thread hung",
    );
  } finally {
    setLogger(null);
  }
});

Deno.test("worker self-exit: under workerRespawn an exit is one crash, and the cell comes back", async () => {
  const lines = capture();
  try {
    await using _srv = await testServer({
      cells: [wexitr],
      workers: "real",
      workerEntry: ENTRY,
    });
    const W = wexitr as Any;
    assertEquals(await W.inc(), 1);
    const q = await within(W.quit()) as { e?: string };
    assertStringIncludes(q.e ?? "", "Deno.exit(4)");
    let n: unknown = "HUNG";
    for (let i = 0; i < 100; i++) {
      const r = await within(W.inc()) as { v?: unknown };
      if (r && typeof r === "object" && "v" in r) {
        n = r.v;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(n, 2, "the respawn keeps the committed state and answers");
    assert(
      lines.some((l) => l.msg.includes("respawning")),
      JSON.stringify(lines),
    );
  } finally {
    setLogger(null);
  }
});

Deno.test("worker close: a crash during close() releases the wait and is not called stuck", async () => {
  const lines = capture();
  try {
    const srv = await testServer({
      cells: [wteardown],
      workers: "real",
      workerEntry: ENTRY,
    });
    assertEquals(await (wteardown as Any).inc(), 1);
    const t0 = performance.now();
    await srv.close();
    const ms = performance.now() - t0;
    assert(
      ms < WORKER_CLOSE_DEADLINE_MS,
      `close took ${Math.round(ms)}ms — it waited out the deadline`,
    );
    assertEquals(
      lines.filter((l) => l.msg.includes("stuck in synchronous code")),
      [],
    );
    const crash = lines.filter((l) =>
      l.lvl === "error" && l.msg.includes("died-in-teardown")
    );
    assertEquals(crash.length, 1, JSON.stringify(lines));
  } finally {
    setLogger(null);
  }
});
