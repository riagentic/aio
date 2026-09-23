// A window that CRASHES is not a window the user closed.
//
// The Electron child's exit was one answer: whatever it was, the app logged
// "electron closed (…) — shutting down" at INFO and exited 0. A window the
// display refused ("Authorization required" → Chromium dies of SIGTRAP) thus
// looked, to a launcher, a supervisor or a test, exactly like a user closing
// it — measured: test:hosts under a relocated XDG_RUNTIME_DIR lost a whole
// step to it, and only noticed two steps later as missing state.
//
// Now: a crash (any signal but a stop signal, or a non-zero code) still takes
// the SAME graceful shutdown — drained, persisted — but logs an ERROR naming
// the cause and the window's last stderr, and the process exits 1. A clean
// close stays exit 0.
//
// Instrument: `$ELECTRON_PATH` pointed at a shell stub (the seam every
// Electron e2e here uses) — it never opens a window. It waits for the app's
// write to land, then ends the way each row says.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  electronClosedPlan,
  electronExitIsCrash,
} from "../src/server/aio-lifecycle.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("electronExitIsCrash: stop signals and code 0 are ends, the rest crashes", () => {
  const is = (code: number, signal: Deno.Signal | null) =>
    electronExitIsCrash({ code, signal });
  assertEquals(is(0, null), false, "a user closing the window");
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    assertEquals(is(128, sig), false, `${sig} is a stop, not a crash`);
  }
  for (const sig of ["SIGTRAP", "SIGSEGV", "SIGABRT", "SIGKILL"] as const) {
    assertEquals(is(128, sig), true, `${sig} is a crash`);
  }
  assertEquals(is(1, null), true, "a non-zero code is a crash");
});

Deno.test("electronClosedPlan: a crash stops with exit 1; our own stop's kill does not", () => {
  const base = { keepServer: false, restarting: false, url: "http://x/" };
  const trap = { code: 133, signal: "SIGTRAP" as const };
  const p = electronClosedPlan(trap, base);
  assertEquals([p.stop, p.crashed, p.exitCode], [true, true, 1]);
  assertStringIncludes(p.line, "electron crashed (signal SIGTRAP)");
  // The shutdown already running killed it: nothing to report.
  const own = electronClosedPlan(trap, { ...base, stopping: true });
  assertEquals([own.crashed, own.exitCode], [false, 0]);
  // keepServer: the server stays, the crash is still called one.
  const kept = electronClosedPlan(trap, { ...base, keepServer: true });
  assertEquals([kept.stop, kept.crashed], [false, true]);
  // A restart's teardown is never a crash.
  assertEquals(
    electronClosedPlan(trap, { ...base, restarting: true }).crashed,
    false,
  );
});

type Row = {
  name: string;
  end: string; // the stub's last shell line
  code: number;
  crash: boolean;
};

const ROWS: Row[] = [
  { name: "exits 0 (closed)", end: "exit 0", code: 0, crash: false },
  { name: "dies of SIGTRAP", end: "kill -TRAP $$", code: 1, crash: true },
  { name: "exits 1", end: "exit 1", code: 1, crash: true },
];

for (const row of ROWS) {
  Deno.test({
    name: `electron window ${row.name} → app exit ${row.code}, state saved`,
    ignore: Deno.build.os !== "linux", // a sh stub + DISPLAY-gated launch
    async fn() {
      const dir = await tempDir("el-crash-");
      try {
        const ready = join(dir, "ready");
        const stub = join(dir, "electron");
        await Deno.writeTextFile(
          stub,
          `#!/bin/sh
i=0
while [ ! -f '${ready}' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
echo "Authorization required, but no authorization protocol specified" >&2
${row.end}
`,
        );
        await Deno.chmod(stub, 0o755);
        const app = join(dir, "app");
        await Deno.mkdir(join(app, "src"), { recursive: true });
        const head = JSON.parse(
          await Deno.readTextFile(join(ROOT, "deno.json")),
        );
        const imports: Record<string, string> = {};
        for (
          const [k, v] of Object.entries(head.imports as Record<string, string>)
        ) {
          imports[k] = v.startsWith("./") ? `${ROOT}/${v.slice(2)}` : v;
        }
        await Deno.writeTextFile(
          join(app, "deno.json"),
          JSON.stringify({ compilerOptions: head.compilerOptions, imports }),
        );
        await Deno.writeTextFile(
          join(app, "src", "cell.ts"),
          `import { cell } from "aio";\nexport const c = cell("c", { state: { v: "" }, methods: { set(s, v: string) { s.v = v; } } });\n`,
        );
        await Deno.writeTextFile(
          join(app, "src", "App.tsx"),
          `import { c } from "./cell.ts";\nexport default function App() { return <p>{c.v}</p>; }\n`,
        );
        await Deno.writeTextFile(
          join(app, "src", "app.ts"),
          `import { c } from "./cell.ts";
import { aio } from "aio";
await aio.run({ appId: "elcrash", cells: [c] });
await c.set(Deno.env.get("MARK")!);
Deno.writeTextFileSync(Deno.env.get("READY")!, "1");
`,
        );
        const mark = `MARK-${crypto.randomUUID().slice(0, 8)}`;
        const home = join(dir, "home");
        const child = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            "src/app.ts",
            "--client=electron",
            `--port=${freePort()}`,
          ],
          cwd: app,
          env: {
            // A DISPLAY so the launch happens at all — the test's own, never
            // the desktop (the stub opens nothing either way).
            ...testDisplayEnv(),
            ELECTRON_PATH: stub,
            AIO_APPS_DIR: home,
            MARK: mark,
            READY: ready,
          },
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const dec = new TextDecoder();
        let log = "";
        const pump = async (s: ReadableStream<Uint8Array>) => {
          for await (const x of s) log += dec.decode(x);
        };
        const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const st = await Promise.race([
          child.status,
          new Promise<null>((r) => timer = setTimeout(() => r(null), 90_000)),
        ]).finally(() => clearTimeout(timer));
        if (!st) {
          child.kill("SIGKILL");
          await child.status;
        }
        await pumps;
        assert(st, `the app never exited after its window ended:\n${log}`);
        assert(
          log.includes("launching Electron"),
          `the stub was never launched — nothing was tested:\n${log}`,
        );
        assertEquals(st.code, row.code, `exit code:\n${log.slice(-3000)}`);
        const crashLine = log.split("\n").find((l) =>
          l.includes("electron crashed")
        );
        if (row.crash) {
          assert(crashLine, `no crash line:\n${log.slice(-3000)}`);
          assertStringIncludes(crashLine, "ERROR");
          assertStringIncludes(crashLine, "Authorization required");
        } else {
          assertEquals(crashLine, undefined, log.slice(-3000));
          assertStringIncludes(log, "electron closed (code 0)");
        }
        // Drained and persisted, crash or not: the write is on disk.
        const db = join(home, "elcrash", "data", "state.db");
        const bytes = dec.decode(await Deno.readFile(db));
        let wal = "";
        try {
          wal = dec.decode(await Deno.readFile(db + "-wal"));
        } catch { /* aio-ok: checkpointed on a clean stop — no -wal left */ }
        assert(
          bytes.includes(mark) || wal.includes(mark),
          `the last write was not persisted:\n${log.slice(-3000)}`,
        );
      } finally {
        await dropTempDir(dir);
      }
    },
  });
}
