// Convention guard: a test that binds a port takes it from `freePort()`.
//
// The suite used to hand-partition port ranges — `const PORT = 9870 + (Deno.pid
// % 60)` in one file, `9830 + (Deno.pid % 200)` in another, plus fixed 198xx
// constants. Two of those ranges overlapped and two files literally shared
// 19840, so a lingering listener made whichever test ran second fail — a real
// flake we chased (auth-client, 2026-07-25). `freePort()` asks the OS for a port
// that is free right now, which removes the bookkeeping AND the flake class.
import { assertEquals } from "@std/assert";
import { appDirs } from "../src/server/app-dirs.ts";

// `\w*(?<![A-Za-z])PORT` = a PORT-named const (PORT, TT_PORT, CDP_PORT) and not
// a word that merely contains it (IMPORT_RE).
const PORT_CONST = /^\s*const\s+\w*(?<![A-Za-z])PORT\w*\s*=\s*(.+?);/gm;
// Allowed right-hand sides: freePort(), another already-checked port const, or
// an env/config lookup. A bare literal or a pid formula is the bug.
const OK = /freePort\(\)|PORT|Deno\.env|env\[|opts\.|config\./;

Deno.test("tests: every port constant comes from freePort()", async () => {
  const offenders: string[] = [];
  for await (const entry of Deno.readDir("tests")) {
    if (!entry.isFile || !entry.name.endsWith(".test.ts")) continue;
    if (entry.name === "test-ports-are-free.test.ts") continue;
    const src = await Deno.readTextFile(`tests/${entry.name}`);
    for (const m of src.matchAll(PORT_CONST)) {
      const rhs = m[1]!;
      if (/Deno\.pid/.test(rhs) || !OK.test(rhs)) {
        offenders.push(`${entry.name}: ${m[0]!.trim()}`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "a hardcoded or pid-derived test port collides sooner or later — use freePort()",
  );
});

// Same class of problem, one directory up: an app that persists writes to
// `~/.<appId>` by default (docs/specs/2026-07-26-data-dir-and-updates.md), and a
// test that spawns a real app process inherits that default. One suite run left
// 57 stray dot-dirs in the developer's home — and the state inside them carried
// between runs, which is how a worker-persistence test started asserting 7 where
// it had written 2. `AIO_APPS_DIR` in the task is the fix: it is inherited by
// every child process, so no test can reach the real home. This guards the task
// definitions, because the failure is silent until someone's home is full.
Deno.test("tests: every test task pins AIO_APPS_DIR", async () => {
  const cfg = JSON.parse(await Deno.readTextFile("deno.json")) as {
    tasks: Record<string, string>;
  };
  const offenders = Object.entries(cfg.tasks)
    .filter(([, cmd]) => /(^|\s)deno test\b/.test(cmd))
    .filter(([, cmd]) => !cmd.includes("AIO_APPS_DIR="))
    .map(([name]) => name);
  assertEquals(
    offenders,
    [],
    "a `deno test` task without AIO_APPS_DIR lets a spawned app — and am's " +
      "launch records, which follow it — write into ~/",
  );
});

Deno.test("tests: the suite is running against a pinned data home", () => {
  // Belt to the braces above: proves the var actually reached this process.
  const root = Deno.env.get("AIO_APPS_DIR") ?? "";
  assertEquals(
    root !== "" && root.endsWith(".aio-test-home"),
    true,
    `expected AIO_APPS_DIR to point at the test home, got ${root || "(unset)"}`,
  );
  // am's launch records used to be a second way into the real home; they now
  // live in the app's own directory, so this one variable covers them too.
  const probe = appDirs("pin-probe").launch;
  assertEquals(
    probe.startsWith(root),
    true,
    `expected app paths under the test home, got ${probe}`,
  );
});
