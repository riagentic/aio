// The process tree the test helpers KILL by (tests/stop-child.ts,
// tests/proc-helper.ts). Windows never re-parents and reuses pids, so a
// parent pid alone ties strangers to a test's child.
import { assertEquals } from "@std/assert";
import {
  descendantsIn,
  familyTies,
  windowsProcessRows,
} from "./proc-helper.ts";

Deno.test("test helpers' tree: a process OLDER than the one holding its parent's pid is nobody's child", () => {
  const ties = familyTies([
    [500, 4, 1000], // a test's child — pid 500 was handed out again
    [77, 500, 200], // somebody's program: its long-dead parent was pid 500
    [78, 77, 250], // …and that program's own child
    [501, 500, 1010],
    [502, 501, 1020],
    [503, 500, 1000], // the same tick as its parent: a child
    [90, 500, NaN], // no creation time: proves nothing
    [60, 501, 900], // the rule holds below the root too
  ]);
  assertEquals(descendantsIn(ties, 500).sort(), [501, 502, 503]);
  // The stranger keeps ITS family, and every pid is still listed as live.
  assertEquals(descendantsIn(ties, 77), [78]);
  assertEquals(ties.size, 8);
  assertEquals([ties.get(77), ties.get(90), ties.get(60)], [0, 0, 0]);
});

Deno.test("test helpers' tree: the Windows listing is read with its creation time", () => {
  assertEquals(
    windowsProcessRows(
      "500 4 638000000000001000\r\n501 500 638000000000002000\r\n88 4 \r\n\r\n",
    ).map(([pid, parent, at]) => [pid, parent, Number.isNaN(at)]),
    [[500, 4, false], [501, 500, false], [88, 4, true]],
  );
});
