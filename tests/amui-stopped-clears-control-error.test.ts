// amui keeps a DEAD process's control-plane error banner forever.
//
// When the selected app stops answering, tick() sets `controlError` (the red
// "amui cannot read this app's control plane — the panels below are the LAST
// reading" banner). When the next rescan then notices the process is gone,
// applyScan() calls clearLiveDiagnostics() — "Drop every reading that belongs
// to a specific PROCESS" — which clears health/vitals/clients/history/mem but
// NOT controlError. tick() returns early for a stopped app, so nothing ever
// clears it: a stopped app shows a banner about panels that were just emptied,
// quoting a transport error from a process that no longer exists.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import type { DiscoveredProject, ProjectDetail } from "../amui/src/manager.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

testCell(
  manager,
  "amui: an app noticed dead by the rescan drops its control-plane error",
  async (t) => {
    const sandbox = await tempDir("amui-r9-ctlerr-");
    const dir = join(sandbox, "proj");
    await Deno.mkdir(dir);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ name: "gone", imports: { aio: "../mod.ts" } }),
    );
    const keys = ["AIO_APPS_DIR", "AMUI_ROOTS", "HOME"] as const;
    const prev = keys.map((k) => Deno.env.get(k));
    Deno.env.set("AIO_APPS_DIR", join(sandbox, "apps")); // empty registry
    Deno.env.set("AMUI_ROOTS", dir);
    Deno.env.set("HOME", sandbox);
    _resetInstanceVerify();
    try {
      const meta = {
        name: "gone",
        version: null,
        target: null,
        tasks: {},
        isAio: true,
        entry: null,
      };
      const id = `${dir}#gone-app#`;
      const running: DiscoveredProject = {
        id,
        path: dir,
        name: "gone",
        meta,
        running: {
          appId: "gone-app",
          pid: 2147483646,
          port: 1,
          status: "started",
        },
        git: false,
      };
      const detail: ProjectDetail = {
        id,
        path: dir,
        name: "gone",
        running: true,
        appId: "gone-app",
        pid: 2147483646,
        port: 1,
        status: "started",
        build: "dev",
        meta,
        git: false,
        self: false,
        config: null,
        cells: null,
        cpuPct: 1,
        memMb: 1,
        uptimeSec: 1,
        connections: 0,
        errors: null,
        schedules: null,
        at: "2020-01-01T00:00:00.000Z",
      };
      t.init({
        projects: [running],
        selectedId: id,
        selectedPath: dir,
        detail,
        // what tick() wrote while the process was dying
        controlError: "app not running on port 1 (connection refused)",
      });
      await t.send.discover();
      const s = t.getState();
      // Precondition: the rescan DID notice the death and fold it in.
      assertEquals(s.detail?.running, false);
      assertEquals(s.health, null, "live diagnostics were cleared");
      assertEquals(
        s.controlError,
        null,
        "a stopped app still shows the dead process's control-plane banner",
      );
    } finally {
      keys.forEach((k, i) => {
        const v = prev[i];
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      });
      _resetInstanceVerify();
      await dropTempDir(sandbox);
    }
  },
);
