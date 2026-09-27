// An app restarted in place (same row, NEW pid) keeps showing the DEAD
// process's trojan snapshot — its recent errors, cell list, config and build.
//
// reconcileDetail() drops that snapshot only on the way DOWN ("the whole live
// snapshot (config/cells/build/errors/schedules) came from the trojan of a
// now-dead process; drop it"). A restart that the 9s rescan sees as pid A →
// pid B never passes through "down", yet pid A is just as dead — and
// clearLiveDiagnostics() says as much ("When that process dies — or is
// replaced by a restart with a new pid — they describe something that no
// longer exists"). tick() never re-reads config/cells/errors, so Overview's
// "recent errors" keeps listing the previous process's failures under the new
// pid, and the Cells tab keeps offering methods the new code may not have.
import { assertEquals, assertNotEquals } from "@std/assert";
import { reconcileDetail } from "../amui/src/manager.ts";
import type { DiscoveredProject, ProjectDetail } from "../amui/src/manager.ts";

const meta = {
  name: "p",
  version: null,
  target: null,
  tasks: {},
  isAio: true,
  entry: null,
};

Deno.test("reconcileDetail: a new pid drops the old process's trojan snapshot", () => {
  const before: ProjectDetail = {
    id: "/p#p#",
    path: "/p",
    name: "p",
    running: true,
    appId: "p",
    pid: 42,
    port: 8000,
    status: "started",
    build: "prod",
    meta,
    git: false,
    self: false,
    config: { title: "old", prod: true },
    cells: { removedCell: ["gone"] },
    cpuPct: 1,
    memMb: 1,
    uptimeSec: 500,
    connections: 3,
    errors: [{ message: "crash in the OLD process" }],
    schedules: ["old-schedule"],
    at: "t",
  };
  const fresh: DiscoveredProject = {
    id: "/p#p#",
    path: "/p",
    name: "p",
    meta,
    running: { appId: "p", pid: 999, port: 8000, status: "started" },
    git: false,
  };
  const next = reconcileDetail(before, fresh);
  assertEquals(next.pid, 999);
  assertNotEquals(next, before);
  // Metrics ARE reset for the new process (existing behaviour)…
  assertEquals(next.uptimeSec, null);
  // …but the trojan snapshot of pid 42 is still presented as pid 999's.
  assertEquals(
    next.errors,
    null,
    "the new process shows the dead process's recent errors",
  );
  assertEquals(next.cells, null, "the new process shows the dead one's cells");
  assertEquals(next.build, null, "the new process shows the dead one's build");
});
