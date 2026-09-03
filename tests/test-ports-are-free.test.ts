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

/** Every `*.test.ts` under `dir`, RECURSIVELY. The guard used to read only
 *  the top level, so `tests/sync/integration/multi-client-ws.test.ts` kept a
 *  literal `const PORT = 8971` for a year — the exact class it exists to
 *  refuse — while reporting the suite clean. */
async function* testFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* testFiles(path);
    else if (entry.isFile && entry.name.endsWith(".test.ts")) yield path;
  }
}

Deno.test("tests: every port constant comes from freePort()", async () => {
  const offenders: string[] = [];
  let seenNested = false;
  for await (const path of testFiles("tests")) {
    if (path === "tests/test-ports-are-free.test.ts") continue;
    if (path.split("/").length > 2) seenNested = true;
    const src = await Deno.readTextFile(path);
    for (const m of src.matchAll(PORT_CONST)) {
      const rhs = m[1]!;
      if (/Deno\.pid/.test(rhs) || !OK.test(rhs)) {
        offenders.push(`${path}: ${m[0]!.trim()}`);
      }
    }
  }
  // The walk must actually descend — a guard that quietly stops scanning is
  // the failure mode this test was found in.
  assertEquals(seenNested, true, "the scan reached tests/**/ subdirectories");
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

Deno.test("tests: no test writes into the repo root", () => {
  // A test that writes a file into the shared cwd changes another test's
  // ANSWER. `am.test.ts` wrote `.aio.log` there, and `logPathFor` resolves that
  // exact relative path as its legacy candidate — so
  // `am-log-finds-the-app-log` intermittently asserted against a file a
  // different test file had just created. It passed alone and failed in the
  // suite, which is the shape that makes a release run untrustworthy (and cost
  // a field report an hour of exactly that).
  //
  // Write into a temp dir and give the subprocess `cwd`. There is no case that
  // needs the repo root.
  const offenders: string[] = [];
  for (const e of Deno.readDirSync(new URL("./", import.meta.url))) {
    if (!e.isFile || !/\.test\.tsx?$/.test(e.name)) continue;
    const raw = Deno.readTextFileSync(
      new URL(`./${e.name}`, import.meta.url),
    );
    // A file that takes responsibility for its own cwd is doing the right
    // thing — the relative write then lands in ITS temp dir, which is the
    // pattern this gate exists to encourage.
    if (/Deno\.chdir\(/.test(raw)) continue;
    // Template literals are DATA — fixture SOURCE handed to a scanner or
    // written into a child script — not code this file runs. Blanked with
    // offsets kept, so a real finding still names its line. (Same reasoning as
    // the comment exemption in tests/context-vocabulary.test.ts: a rule that
    // cannot tell a program from a program it is quoting reports noise, and a
    // gate with false positives gets switched off.)
    const src = raw.replace(
      /`(?:[^`\\]|\\.)*`/g,
      (m) => m.replace(/[^\n]/g, " "),
    );
    // A bare relative path handed to a writer — no `join(dir, …)`, no `/tmp`.
    for (
      const m of src.matchAll(
        /Deno\.(?:writeTextFile|writeFile|mkdir|create)(?:Sync)?\(\s*"(\.[^"]*|[A-Za-z0-9_][^"/]*)"/g,
      )
    ) {
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`tests/${e.name}:${line} — writes "${m[1]}"`);
    }
  }
  assertEquals(
    offenders,
    [],
    "write into a temp dir and pass it as the subprocess `cwd`; a file in the " +
      "repo root is visible to every other test file:\n  " +
      offenders.join("\n  "),
  );
});
