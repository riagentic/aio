// A worker cell stuck in synchronous code at close(): Deno's terminate() does
// not stop a busy thread, so it — and a process aio does not own (testServer,
// libraryMode, an embedder) — lives on until the code returns. aio cannot end
// a host's process; it says so, naming the cell and the method, instead of
// the host hanging with nothing in the log.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { wburn } from "./fixtures/worker-sync-burn-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-sync-burn-app.ts");
const W = wburn as unknown as {
  spin(ms: number): Promise<void>;
  wait(ms: number): Promise<void>;
  inc(): Promise<void>;
};

function capture(): string[] {
  const lines: string[] = [];
  setLogger(
    {
      pub: (lvl: string, cat: string, msg: string) => {
        if (lvl === "warn" && cat === "cell-worker") lines.push(msg);
      },
    } as unknown as LogSink,
  );
  return lines;
}

Deno.test("worker close: a thread stuck in sync code is named, loudly", async () => {
  const lines = capture();
  try {
    const srv = await testServer({
      cells: [wburn],
      workers: "real",
      workerEntry: ENTRY,
    });
    await W.inc(); // booted and answering
    const spun = W.spin(2500).catch(() => {});
    await new Promise((r) => setTimeout(r, 100)); // it is spinning now
    await srv.close();
    await spun;
    const said = lines.filter((l) => l.includes("stuck in synchronous code"));
    assertEquals(said.length, 1, lines.join("\n"));
    assert(said[0]!.includes("wburn"), said[0]);
    assert(said[0]!.includes("wburn:spin"), said[0]);
  } finally {
    setLogger(null);
  }
});

Deno.test("worker close: an idle worker closes without the warning", async () => {
  const lines = capture();
  try {
    const srv = await testServer({
      cells: [wburn],
      workers: "real",
      workerEntry: ENTRY,
    });
    await W.inc();
    await srv.close();
    assertEquals(
      lines.filter((l) => l.includes("stuck in synchronous code")),
      [],
    );
  } finally {
    setLogger(null);
  }
});

Deno.test("worker close: an async method that ignores its signal is not called stuck", async () => {
  const lines = capture();
  try {
    const srv = await testServer({
      cells: [wburn],
      workers: "real",
      workerEntry: ENTRY,
    });
    await W.inc();
    const waiting = W.wait(2500).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await srv.close();
    await waiting;
    assertEquals(
      lines.filter((l) => l.includes("stuck in synchronous code")),
      [],
      "its loop took the close — terminate() stops it",
    );
  } finally {
    setLogger(null);
  }
});
