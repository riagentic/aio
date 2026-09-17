// `am start` never kills an app that is still booting, and says the truth
// when its wait runs out (h7 F2 / cc §6).
//
// Measured before the fix: a cell module that sleeps 15 s → the first
// `am start` exits 1 after 10.4 s ("not responding … after 10s"), the second
// prints `{"killing":<pid>,"reason":"stuck-starting"}`, kills the LIVE
// booting child and spawns another — an agent re-running on exit 1 killed the
// app every ~10 s forever. And a child whose boot throws a teachable error
// was reported by its last 8 log lines: the stack frames, never the `→ fix:`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  bootStalled,
  crashTail,
  stillStartingMessage,
} from "../src/am/am-cmd-process.ts";
import { STUCK_STARTING_MS } from "../src/server/single-instance-lock.ts";
import { childEnv, freePort, makeApp } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const dec = new TextDecoder();

// ── pure ─────────────────────────────────────────────────────────────────

const TEACHABLE_LOG = [
  "\x1b[0m\x1b[1m\x1b[31merror\x1b[0m: Uncaught (in promise) Error: [aio] " +
  'cell "todo" declares no state',
  '  → fix: pass cell("todo", { state: { … } })',
  "  → docs: docs/state/cells.md",
  ...Array.from(
    { length: 10 },
    (_, i) => `    at frame${i} (file:///app/src/cell.ts:${i + 1}:3)`,
  ),
  "",
].join("\n");

Deno.test("crashTail: the error line and its → fix: survive a 10-frame stack", () => {
  const got = crashTail(TEACHABLE_LOG);
  assert(got[0]!.startsWith("error: Uncaught"), got.join("\n"));
  assertStringIncludes(got.join("\n"), "→ fix: pass cell(");
  assertStringIncludes(got.join("\n"), "→ docs:");
  assert(!got.some((l) => /^\s*at /.test(l)), "no stack frames");
  assert(!got.join("").includes("\x1b["), "no ANSI");
});

Deno.test("crashTail: no error line → the tail, minus frames and carets", () => {
  const got = crashTail(
    "boot 1\nboot 2\n    ^\n    at x (y:1:1)\nlast words\n",
  );
  assertEquals(got, ["boot 1", "boot 2", "last words"]);
  assertEquals(crashTail(""), []);
});

Deno.test("bootStalled: a young lock is never stuck; an old one only without log progress", () => {
  const now = 1_000_000_000;
  const old = now - STUCK_STARTING_MS - 1;
  assertEquals(bootStalled(now - 15_000, null, now), false, "15 s = booting");
  assertEquals(bootStalled(old, null, now), true, "old, no log");
  assertEquals(bootStalled(old, now - 1_000, now), false, "log moving");
  assertEquals(bootStalled(old, old, now), true, "log as old as the lock");
});

Deno.test("stillStartingMessage: says still starting, the pid, and the way on", () => {
  const m = stillStartingMessage(10, 4242, null);
  assert(m.startsWith("still starting after 10s (pid 4242 alive"), m);
  assertStringIncludes(m, "am status");
  assertStringIncludes(m, "exit 2 = transitional");
  assertStringIncludes(m, "--wait=60");
  assert(!/not responding/.test(m), "not fault-shaped");
  assertStringIncludes(stillStartingMessage(10, 1, 4321), "port 4321");
  assertStringIncludes(stillStartingMessage(10, 1, "socket"), "socket");
});

// ── e2e ──────────────────────────────────────────────────────────────────

async function amStart(
  dir: string,
  apps: string,
  ...args: string[]
): Promise<{ code: number; out: string; err: string }> {
  const r = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(dir, "dep", "aio", "src", "am.ts"),
      "start",
      "--client=server-only",
      "--json",
      ...args,
    ],
    cwd: dir,
    env: {
      ...Deno.env.toObject(),
      ...childEnv({ AIO_APPS_DIR: apps }),
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: r.code,
    out: dec.decode(r.stdout),
    err: dec.decode(r.stderr),
  };
}

async function reap(pids: Iterable<number>): Promise<void> {
  for (const pid of pids) {
    try {
      Deno.kill(pid, "SIGTERM");
    } catch { /* gone */ }
  }
  for (const pid of pids) {
    for (let i = 0; i < 50; i++) {
      try {
        Deno.kill(pid, "SIGCONT");
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Every pid mentioned in am's JSON output. */
const pidsIn = (text: string): number[] =>
  [...text.matchAll(/"(?:pid|killing|waiting)":(\d+)/g)].map((m) => +m[1]!);

Deno.test({
  name:
    "am start ×2 on a 15 s boot: the second WAITS for the first, never kills it",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await makeApp("counter", "am-still-starting-");
    const apps = await tempDir("am-still-starting-apps-");
    const seen = new Set<number>();
    try {
      const cell = join(dir, "src", "cell.ts");
      await Deno.writeTextFile(
        cell,
        `await new Promise((r) => setTimeout(r, 15_000));\n` +
          await Deno.readTextFile(cell),
      );
      const port = freePort();
      const first = await amStart(dir, apps, `--port=${port}`);
      pidsIn(first.out + first.err).forEach((p) => seen.add(p));
      assertEquals(first.code, 1, `${first.out}\n${first.err}`);
      assertStringIncludes(first.out + first.err, "still starting after 10s");
      assert(
        !/not responding/.test(first.out + first.err),
        `a booting app is not "not responding":\n${first.out}\n${first.err}`,
      );
      const lock = JSON.parse(
        (await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            join(dir, "dep", "aio", "src", "am.ts"),
            "status",
            "--json",
          ],
          cwd: dir,
          env: {
            ...Deno.env.toObject(),
            ...childEnv({ AIO_APPS_DIR: apps }),
            AIO_AM_NO_DELEGATE: "1",
          },
          stdout: "piped",
          stderr: "null",
        }).output().then((r) => dec.decode(r.stdout))).trim().split("\n")
          .at(-1)!,
      );
      const firstPid: number = lock.pid;
      seen.add(firstPid);
      assertEquals(lock.status, "starting", JSON.stringify(lock));

      const second = await amStart(dir, apps, `--port=${port}`);
      pidsIn(second.out + second.err).forEach((p) => seen.add(p));
      assert(
        !/killing|stuck-starting/.test(second.out + second.err),
        `the second am start killed the booting app:\n${second.out}\n${second.err}`,
      );
      assertEquals(second.code, 0, `${second.out}\n${second.err}`);
      assertStringIncludes(second.err, "still starting (pid");
      const started = JSON.parse(second.out.trim().split("\n").at(-1)!);
      assertEquals(started.status, "started", second.out);
      assertEquals(started.pid, firstPid, "the FIRST child is the app");
      assertEquals(started.port, port);
      assertEquals(seen.size, 1, `one child only, saw ${[...seen]}`);
    } finally {
      await reap(seen);
      await dropTempDir(apps);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "am start: a boot that throws a teachable error shows its → fix:",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await makeApp("counter", "am-crash-tail-");
    const apps = await tempDir("am-crash-tail-apps-");
    try {
      const entry = join(dir, "src", "app.ts");
      // A 10-deep call chain, then the framework's own teachable error.
      await Deno.writeTextFile(
        entry,
        `import { teachableError } from "../dep/aio/src/diagnostics/error.ts";\n` +
          `await new Promise((r) => setTimeout(r, 400));\n` +
          `const deep = (n: number): never => {\n` +
          `  if (n === 0) {\n` +
          `    throw teachableError("the widget is misconfigured", ` +
          `"set widget.size in deno.json");\n` +
          `  }\n` +
          `  return deep(n - 1);\n` +
          `};\n` +
          `deep(10);\n`,
      );
      const r = await amStart(dir, apps);
      const all = r.out + r.err;
      assertEquals(r.code, 1, all);
      assertStringIncludes(all, "the widget is misconfigured");
      assertStringIncludes(all, "fix: set widget.size in deno.json");
      assert(!/\bat deep\b/.test(all), `stack frames shown:\n${all}`);
    } finally {
      await dropTempDir(apps);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
