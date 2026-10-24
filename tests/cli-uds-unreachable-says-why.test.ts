// B20: a local-socket client that cannot connect retried in silence — once a
// listener re-made on the same path stayed unreachable for 10 s and nothing
// said whether the path was missing, a stale file, or a socket nobody
// accepted on. Each failed dial now logs the path's state (debug), and a run
// of them past UNREACHABLE_SAY_MS says so once at warn.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { connectCliUDS, UNREACHABLE_SAY_MS } from "../src/server/cli-client.ts";
import { socketPathState } from "../src/server/local-listen.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test({
  name: "socketPathState names absent, a stale file, and a live socket",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await tempDir("uds-state-");
    try {
      const p = join(dir, "s.sock");
      assertEquals(socketPathState(p), "absent");
      await Deno.writeTextFile(p, "");
      assertStringIncludes(socketPathState(p), "not a socket (a file");
      await Deno.remove(p);
      const l = Deno.listen({ transport: "unix", path: p });
      try {
        assert(
          /^a socket \(inode \d+, made /.test(socketPathState(p)),
          socketPathState(p),
        );
      } finally {
        l.close();
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "a local-socket client unreachable past UNREACHABLE_SAY_MS warns once, naming the path's state",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await tempDir("uds-unreach-");
    const lines: { lvl: string; msg: string }[] = [];
    const prev = getLogger();
    setLogger(
      {
        logDir: "",
        pub: (lvl: string, _cat: string, msg: string) =>
          lines.push({ lvl, msg }),
        perf: () => {},
        flush: () => Promise.resolve(),
      } as unknown as Parameters<typeof setLogger>[0],
    );
    const path = join(dir, "gone.sock");
    const c = connectCliUDS(path, { readyTimeoutMs: 60_000 });
    c.ready.catch(() => {});
    try {
      const until = Date.now() + UNREACHABLE_SAY_MS + 15_000;
      while (Date.now() < until && !lines.some((l) => l.lvl === "warn")) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      c.close();
      setLogger(prev);
      await dropTempDir(dir);
    }
    const debug = lines.filter((l) =>
      l.lvl === "debug" && l.msg.includes("connect failed")
    );
    assert(
      debug.length >= 2,
      `each failed dial is logged: ${JSON.stringify(lines)}`,
    );
    assertStringIncludes(debug[0]!.msg, "the path is absent");
    const warns = lines.filter((l) =>
      l.lvl === "warn" && l.msg.includes("unreachable for")
    );
    assertEquals(warns.length, 1, JSON.stringify(lines));
    assertStringIncludes(warns[0]!.msg, path);
    assertStringIncludes(warns[0]!.msg, "the path is absent");
  },
});
