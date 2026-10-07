// `stopEsbuildService` waits for esbuild's native child to be reaped, and it
// finds that child by reading `/proc/self/task/<tid>/children` for every
// thread of the process. A thread can exit between the listing and its read —
// a test-file worker, a blocking-pool thread — and that one read then fails
// with NotFound. The failure used to be caught around the WHOLE scan, so one
// vanished thread answered "this process has no children": the wait for a
// live esbuild was skipped, the caller returned on a fixed 10 ms, and under
// load the test that had booted a dev server ended with "A child process was
// started during the test, but not closed". Each task is now read on its own.
//
// Windows had no listing at all: the stop returned one loop turn after the
// kill, and under load the service outlived the test that stopped it (4 tests
// of import-map-local-alias.test.ts failed for a leaked child process). It
// reads the process table now, and waits on it.
import { assert, assertEquals } from "@std/assert";
import * as esbuild from "esbuild";
import {
  _childPids,
  _esbuildChildPids,
  _stillThere,
  stopEsbuildService,
} from "../src/build/esbuild-shared.ts";

const children: Record<string, string> = {
  "100": "",
  "101": "4242 4243 ",
  "102": "", // exits between the listing and its read
  "103": "4250",
};
const read = (gone: string | null) => (tid: string): string => {
  if (tid === gone) {
    throw new Deno.errors.NotFound(
      `No such file or directory (os error 2): readfile ` +
        `'/proc/self/task/${tid}/children'`,
    );
  }
  return children[tid]!;
};

Deno.test("child pids: every thread's children are listed", () => {
  assertEquals(
    _childPids(Object.keys(children), read(null)),
    [4242, 4243, 4250],
  );
});

Deno.test("child pids: a thread that exited mid-scan does not hide the other threads' children", () => {
  assertEquals(
    _childPids(Object.keys(children), read("102")),
    [4242, 4243, 4250],
  );
});

Deno.test("child pids: the real /proc answers the same way with a vanished task in the listing", () => {
  if (Deno.build.os !== "linux") return;
  const tasks = [...Deno.readDirSync("/proc/self/task")].map((t) => t.name);
  const real = (tid: string) =>
    Deno.readTextFileSync(`/proc/self/task/${tid}/children`);
  // A tid no thread of this process has: the read fails exactly as it does
  // for a thread that has just exited.
  assertEquals(
    _childPids([...tasks, "0"], real),
    _childPids(tasks, real),
  );
});

Deno.test("still there: Linux waits for each service named; Windows, told none, for any one to leave", () => {
  const listed = (left: number[]) => (pid: number) => left.includes(pid);
  assertEquals(_stillThere([1, 2], "linux", listed([1, 2])), [1, 2]);
  assertEquals(_stillThere([1, 2], "linux", listed([2])), [2]);
  assertEquals(_stillThere([1, 2], "linux", listed([])), []);
  // Windows: 2 is another isolate's live service, which this stop never
  // touched — the stop's own (1) leaving ends the wait.
  assertEquals(_stillThere([1, 2], "windows", listed([1, 2])), [1, 2]);
  assertEquals(_stillThere([1, 2], "windows", listed([2])), []);
  assertEquals(_stillThere([], "windows", listed([])), []);
});

Deno.test({
  name:
    "esbuild stop: the service is a listed child while it runs, and gone when the stop returns",
  // macOS has no listing (see `stopEsbuildService`): nothing to ask.
  ignore: Deno.build.os === "darwin",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const before = new Set(_esbuildChildPids());
    const ours = () => _esbuildChildPids().filter((p) => !before.has(p));
    try {
      for (let i = 0; i < 10; i++) {
        await esbuild.transform("let a: number = 1", { loader: "ts" });
        assertEquals(ours().length, 1, "the running service is listed");
        await stopEsbuildService(() => esbuild.stop());
        assertEquals(ours(), [], `round ${i}: the stopped service is gone`);
      }
    } finally {
      await stopEsbuildService(() => esbuild.stop());
    }
  },
});

Deno.test({
  name:
    "esbuild stop (Windows): another instance's live service costs one reap, once — later stops neither wait for it nor name it, and still wait for their own",
  // The rule exists only where the services cannot be told apart; Linux can
  // (esbuild-stop-in-flight.test.ts: "a service another esbuild instance
  // owns is neither waited for nor named").
  ignore: Deno.build.os !== "windows",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const had = new Set(_esbuildChildPids());
    const fresh = () => _esbuildChildPids().filter((p) => !had.has(p));
    const warned = async (fn: () => Promise<void>): Promise<string[]> => {
      const notes: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => notes.push(a.map(String).join(" "));
      try {
        await fn();
      } finally {
        console.warn = warn;
      }
      return notes;
    };
    const w = new Worker(
      new URL("./fixtures/esbuild-other-instance.ts", import.meta.url).href,
      { type: "module" },
    );
    const said = (what: string) =>
      new Promise<void>((r) => {
        w.onmessage = (e) => e.data === what && r();
      });
    try {
      await said("up");
      const theirs = fresh();
      assertEquals(theirs.length, 1, "the worker's own service");
      // A stop that ends nothing — this instance has no service yet.
      const first = await warned(() => stopEsbuildService(() => {}, 200));
      assertEquals(first.length, 1, first.join("\n"));
      assert(first[0]!.includes(String(theirs[0])), first[0]);
      assert(!first[0]!.includes("was told to stop"), first[0]);
      let t0 = performance.now();
      assertEquals(await warned(() => stopEsbuildService(() => {})), []);
      let ms = performance.now() - t0;
      assert(ms < 1000, `a stop that ended nothing waited ${ms.toFixed(0)} ms`);
      // Ours, beside it: waited for, and theirs left alone.
      await esbuild.transform("let a: number = 1", { loader: "ts" });
      assertEquals(fresh().length, 2, "our service beside theirs");
      t0 = performance.now();
      assertEquals(
        await warned(() => stopEsbuildService(() => esbuild.stop())),
        [],
      );
      ms = performance.now() - t0;
      assert(ms < 1000, `the stop of ours waited ${ms.toFixed(0)} ms`);
      assertEquals(fresh(), theirs, "ours is gone, theirs is not");
    } finally {
      const stopped = said("stopped");
      w.postMessage("stop");
      await stopped;
      w.terminate();
      // The worker's `stop()` only sends the kill: its service must not
      // outlive this test in the table the next one reads.
      const t0 = Date.now();
      while (fresh().length > 0) {
        assert(Date.now() - t0 < 10_000, `left behind: pid ${fresh()}`);
        await new Promise((r) => setTimeout(r, 5));
      }
      await stopEsbuildService(() => esbuild.stop());
    }
  },
});
