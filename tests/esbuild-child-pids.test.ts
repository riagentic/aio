// `stopEsbuildService` waits for esbuild's native child to be reaped, and it
// finds that child by reading `/proc/self/task/<tid>/children` for every
// thread of the process. A thread can exit between the listing and its read —
// a test-file worker, a blocking-pool thread — and that one read then fails
// with NotFound. The failure used to be caught around the WHOLE scan, so one
// vanished thread answered "this process has no children": the wait for a
// live esbuild was skipped, the caller returned on a fixed 10 ms, and under
// load the test that had booted a dev server ended with "A child process was
// started during the test, but not closed". Each task is now read on its own.
import { assertEquals } from "@std/assert";
import { _childPids } from "../src/build/esbuild-shared.ts";

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
