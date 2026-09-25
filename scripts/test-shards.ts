#!/usr/bin/env -S deno run -A
/**
 * test-shards.ts — the full suite, split across parallel `deno test` PROCESSES.
 *
 *   deno run -A scripts/test-shards.ts [--shards=N] [files…]
 *
 * `deno test tests/` runs one file at a time: 27 minutes on a 32-core box,
 * with 1,270 of ~1,500 files finishing in under a second. The same files, the
 * same flags and the same sanitizers, spread over N processes, take ~4.
 *
 * Processes, not `deno test --parallel`: that runs files as workers of ONE
 * process, which share `Deno.cwd()` and `Deno.env` — and 32 test files `chdir`,
 * 75 set env vars. A process per shard keeps both private, exactly as the
 * serial run did. Each shard also gets its own data home
 * (`.aio-test-shards/<n>/.aio-test-home`), so two apps booted by two shards
 * never share a lock or a state.db.
 *
 * Tests that open a REAL window (Electron, Chromium, video capture, a nested X
 * display) all go to ONE shard, which runs them in order: two of them at once
 * fight over the display and the focus. They run in parallel with the other
 * shards, never with each other.
 *
 * Balance comes from measured time: every run writes each file's wall time to
 * `.aio/test-timings.json`, and the next run assigns the slowest files first,
 * each to the least-loaded shard (longest-processing-time first). A file with
 * no timing yet counts as one second.
 */
import { dirname, join, relative } from "@std/path";
import { homeStoreEnv } from "../src/testing/test-strict.ts";
import { testDisplay } from "../src/testing/test-display.ts";
import {
  nestedDisplayAccepts,
  nestedDisplayCookie,
  pickNestedDisplay,
} from "../src/server/nested-display.ts";
import {
  realStoreDirs,
  snapshotStores,
  storeChanges,
} from "./check-home-clean.ts";
import {
  pruneDeadLockDir,
  pruneDeadLockDirAt,
  sweepRootRegistry,
} from "../src/server/single-instance-lock.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TIMINGS = join(ROOT, ".aio", "test-timings.json");
const OUT = join(ROOT, ".aio", "test-shards");

/** What in a test file's OWN source means it puts a window
 *  on a DISPLAY — Electron, a headed browser, the shared nested Xephyr, a
 *  screen recording. Those run one at a time: two windows on one display
 *  overlap, and a screenshot or recording then shows the other test's window.
 *
 *  Headless Chromium is NOT in it: no display, its own profile, nothing to
 *  overlap — it runs in parallel like any other process. Decided by CONTENT,
 *  not name: a name rule sent ~30 stub-only "electron-*" files to the serial
 *  shard, and would miss a window test named anything else. Helpers are not
 *  followed: `e2e-harness.ts` names `testDisplayEnv` only as a safety net for
 *  a `--client=server-only` app, and following it serialized 44 s of headless
 *  work. */
export const REAL_WINDOW =
  /testDisplayEnv|Xephyr|ELECTRON_E2E|ffmpeg|\bDISPLAY\b/;

/** `deno test`'s own discovery rule for a directory argument. */
const TEST_FILE = /(^|[._])test\.(ts|tsx|mts|js|mjs|jsx)$/;

/** Every test file under the dirs `deno task test` names, repo-relative. */
export async function discover(dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory) await walk(p);
      else if (e.isFile && TEST_FILE.test(e.name)) out.push(relative(ROOT, p));
    }
  };
  for (const d of dirs) await walk(join(ROOT, d));
  return out.sort();
}

/** Split `files` into `n` shards of near-equal measured time. The `serial`
 *  files are pinned to shard 0 together, in order; everything else is placed slowest
 *  first onto the least-loaded shard. Pure. */
export function plan(
  files: string[],
  n: number,
  timings: Record<string, number>,
  serial: (file: string) => boolean,
): string[][] {
  const cost = (f: string) => (timings[f] ?? 1) + 0.3; // + process/load share
  const shards = Array.from({ length: Math.max(1, n) }, () => ({
    load: 0,
    files: [] as string[],
  }));
  for (const f of files.filter(serial)) {
    shards[0]!.files.push(f);
    shards[0]!.load += cost(f);
  }
  const rest = files.filter((f) => !serial(f))
    .sort((a, b) => cost(b) - cost(a));
  for (const f of rest) {
    const s = shards.reduce((a, b) => (b.load < a.load ? b : a));
    s.files.push(f);
    s.load += cost(f);
  }
  return shards.map((s) => s.files).filter((f) => f.length > 0);
}

/** Per-file time from a `--junit-path` report. Deno 2.9 puts no `time` on
 *  `<testsuite>` (measured), so each file is the sum of its `<testcase
 *  classname="./x" time="…">` entries. Pure. */
export function junitTimes(xml: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of xml.matchAll(/<testcase\b[^>]*>/g)) {
    const file = /\bclassname="([^"]+)"/.exec(m[0])?.[1];
    const time = Number(/\btime="([^"]+)"/.exec(m[0])?.[1]);
    if (!file || !Number.isFinite(time)) continue;
    const key = file.replace(/^\.\//, "");
    out[key] = (out[key] ?? 0) + time;
  }
  return out;
}

/** Every failure one shard's log names, colour stripped. Pure.
 *
 *  Read from deno's closing ` FAILURES ` list (`name => ./file:line`), which
 *  names each failure whatever its kind — a failed case, an uncaught error in
 *  a module, a leak reported against a test. The per-case "… FAILED" lines
 *  are only the fallback (a shard killed before its summary): matching them
 *  alone once reported "no FAILED line" for a shard with 2 failures. */
export function failures(log: string): string[] {
  // deno-lint-ignore no-control-regex
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const at = lines.findIndex((l) => l.trim() === "FAILURES");
  if (at >= 0) {
    const out: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (/^(ok|FAILED) \|/.test(l)) break;
      if (l.trim()) out.push(l.trim());
    }
    if (out.length) return out;
  }
  const failed = lines.filter((l) =>
    / \.\.\. FAILED/.test(l) && !l.startsWith(" ")
  );
  // Nothing ran at all (a module that did not load, a bad path): deno's own
  // `error:` line is the whole story.
  return failed.length ? failed : lines.filter((l) => /^error: /.test(l));
}

/** Shard `i` of `n`'s port range, "<first>-<last>": 20000–32767 split
 *  evenly (below the OS ephemeral range, so the OS never hands them out). */
export function portSliceFor(i: number, n: number): string {
  const first = 20000, total = 32768 - first;
  const span = Math.floor(total / Math.max(1, n));
  return `${first + i * span}-${first + (i + 1) * span - 1}`;
}

/** Shard `i` of `n`'s environment — the three things that keep two shards
 *  from sharing anything: its own data home, its own port slice (below the
 *  OS ephemeral range, so `freePort()` in two shards can never be handed the
 *  same port), and its own `XDG_RUNTIME_DIR` — lock dirs, sockets, the
 *  registry — so a shard never writes into the developer's real one and
 *  cannot see another shard's locks.
 *
 *  The real-window shard is the ONE exception to the runtime dir: its
 *  Electron needs the session's display/dbus sockets there, so it inherits.
 *  Every other shard MUST have one: `runtimeDir === null` there is a runner
 *  bug, and it throws rather than quietly letting the shard share the real
 *  dir (which is what made two shards' locks see each other). Pure. */
export function shardEnv(
  i: number,
  n: number,
  runtimeDir: string | null,
  opts: { home: string; realWindow: boolean },
): Record<string, string> {
  if (!opts.realWindow && !runtimeDir) {
    throw new Error(
      `test-shards: shard ${i} has no private XDG_RUNTIME_DIR — only the ` +
        `real-window shard may inherit the session's`,
    );
  }
  return {
    AIO_APPS_DIR: opts.home,
    // Every per-user store a test can write (the framework version store, the
    // install root, feedback, the canonical install `am update` mutates),
    // private to the shard and BESIDE its apps dir — never inside it, where
    // `am ls` would read them as apps. Unconditional: the value the runner
    // inherited IS the real store. A test that sets its own still wins, and
    // its restore lands back here instead of on "unset" = the real one.
    ...homeStoreEnv(join(dirname(opts.home), "stores")),
    AIO_TEST_PORT_SLICE: portSliceFor(i, n),
    ...(opts.realWindow ? {} : { XDG_RUNTIME_DIR: runtimeDir! }),
  };
}

/** The dev warning a `press`/`keyDown` into a field prints when a window key
 *  binding skipped it (`ignoreInInput`) and NOTHING ran — src/air/ui-trigger.ts
 *  `warnKeySwallowedByInput`. */
export const SWALLOWED_PRESS = "window key handlers skip inputs by design";

/** The marker a test file carries when it swallows a press ON PURPOSE (it is
 *  asserting that the binding does NOT fire): `// aio-ok: press swallowed on
 *  purpose — <why>`. The reason is required — a bare marker is not one. */
export const SWALLOW_OK =
  /\/\/\s*aio-ok:\s*press swallowed on purpose\s*—\s*\S/;

/** The test files in one shard's log that printed {@link SWALLOWED_PRESS}
 *  without carrying {@link SWALLOW_OK}. Pure.
 *
 *  For users the warning stays a warning — the surface is frozen, and a
 *  passing test of theirs must not start failing. In THIS repo it is a
 *  failure: a `ui.Field.press("Enter")` whose shortcut ran zero times passes
 *  every assertion after it, so a test that does it without saying why is a
 *  test that tests nothing. Output is attributed to the file whose
 *  `running N tests from ./<file>` header precedes it — a shard runs its
 *  files one after another, and deno prints every test's console output
 *  (stdout or stderr alike) under that header. */
export function swallowedPresses(
  log: string,
  source: (file: string) => string,
): string[] {
  // deno-lint-ignore no-control-regex
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const out = new Set<string>();
  let file = "";
  for (const l of lines) {
    const m = /^running \d+ tests? from \.\/(.+)$/.exec(l.trim());
    if (m) file = m[1]!;
    else if (l.includes(SWALLOWED_PRESS) && !SWALLOW_OK.test(source(file))) {
      out.add(file || "(before any test file)");
    }
  }
  return [...out];
}

/** The cores a test run may use, and the command prefix that holds it there.
 *
 *  The run used to take the whole machine: 16 shards, each spawning apps,
 *  browsers and Electron, saturated all 32 cores and starved the maintainer's
 *  own work ("I need at least 4 cores free"). Linux pins every shard — and so
 *  every child it spawns, which inherits the mask — off the first `free`
 *  cores with `taskset`, and `nice`s it below interactive work. Elsewhere, or
 *  without taskset, it is `nice` alone and fewer shards. Pure, for its test. */
export function cpuFence(
  cores: number,
  free: number,
  os: string,
  have: { taskset: boolean; nice: boolean },
): { usable: number; prefix: string[] } {
  const usable = Math.max(1, cores - free);
  const nice = have.nice ? ["nice", "-n", "10"] : [];
  if (os === "linux" && have.taskset && cores > free) {
    return {
      usable,
      prefix: ["taskset", "-c", `${free}-${cores - 1}`, ...nice],
    };
  }
  return { usable, prefix: nice };
}

async function onPath(cmd: string): Promise<boolean> {
  try {
    const r = await new Deno.Command(cmd, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return r.success;
  } catch {
    return false; // aio-ok: not installed — the fence degrades to what exists
  }
}

/** THE fence for this machine — the runner and `check:release` share it.
 *  `AIO_TEST_FREE_CORES` (default 4) is how many cores stay untouched. */
export async function machineFence(): Promise<
  ReturnType<typeof cpuFence> & { cores: number }
> {
  const cores = navigator.hardwareConcurrency ?? 4;
  // Already inside a fence (`check:release` runs every gate in one): the
  // affinity mask this process inherited IS the budget. Fencing again would
  // subtract the free cores a second time — 12 visible, 20 kept free → one
  // shard, and the 8-minute suite took 34.
  if (Deno.env.get("AIO_TEST_FENCED") === "1") {
    return { cores, usable: cores, prefix: [] };
  }
  return {
    cores,
    ...cpuFence(
      cores,
      Number(Deno.env.get("AIO_TEST_FREE_CORES") ?? 4),
      Deno.build.os,
      { taskset: await onPath("taskset"), nice: await onPath("nice") },
    ),
  };
}

/** Remove a shard's private runtime dir once the shard is done: every lock
 *  dir in it pruned by the one rule (`pruneDeadLockDirAt` — dead locks,
 *  unbound sockets, idle mutexes; never recursively), the registry swept,
 *  then the rest. A lock dir something LIVE still holds is left, with the
 *  whole runtime dir, and named — a process that outlived its test, which
 *  `check:orphans` must still be able to find. Never throws: what went wrong
 *  is returned with what was left, for the report.
 *
 *  Where the platform has no socket table the rule reads (`boundUnixSockets`
 *  → null), a socket is "unknown" and kept; here, where every process the
 *  shard started is done, a socket nobody ANSWERS on (connect refused) is
 *  dead, and goes — so an unknown platform does not fail every shard. */
async function dropShardRuntime(runtime: string): Promise<string[]> {
  const left: string[] = [];
  try {
    // Already gone: the shard's own finish and an interrupt can both get here.
    if (!exists(runtime)) {
      _runtimes.delete(runtime);
      return left;
    }
    for (const e of Deno.readDirSync(runtime)) {
      if (!e.isDirectory || !/^aio(-|$)/.test(e.name)) continue;
      const d = join(runtime, e.name);
      if (pruneDeadLockDirAt(d, true) || !dirHasEntries(d)) continue;
      await dropRefusedSockets(d);
      if (!pruneDeadLockDirAt(d, true) && dirHasEntries(d)) left.push(d);
    }
    sweepRootRegistry(runtime);
    if (left.length) return left;
    // Nothing of aio's is live: the rest (a registry, a dconf cache a child
    // made) goes with the dir this run created.
    Deno.removeSync(runtime, { recursive: true });
    _runtimes.delete(runtime);
  } catch (e) {
    left.push(`${runtime} (${e instanceof Error ? e.message : String(e)})`);
  }
  return left;
}

/** Remove the sockets in `dir` that refuse a connection — nobody is bound. */
async function dropRefusedSockets(dir: string): Promise<void> {
  for (const e of Deno.readDirSync(dir)) {
    if (!e.name.endsWith(".sock")) continue;
    const path = join(dir, e.name);
    try {
      (await Deno.connect({ transport: "unix", path })).close();
    } catch (err) {
      if (
        err instanceof Deno.errors.ConnectionRefused ||
        err instanceof Deno.errors.NotFound
      ) {
        try {
          if (Deno.lstatSync(path).isSocket) Deno.removeSync(path);
        } catch { /* aio-ok: gone meanwhile */ }
      }
    }
  }
}

function exists(p: string): boolean {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false; // aio-ok: absent (or unreadable, which prunes nothing)
  }
}

function dirHasEntries(d: string): boolean {
  try {
    return [...Deno.readDirSync(d)].length > 0;
  } catch {
    return false;
  }
}

/** Runtime dirs made and not yet removed — an interrupted run (Ctrl-C, a
 *  kill) removes them too, once nothing live is in them. */
const _runtimes = new Set<string>();
function dropAllRuntimesSync(): void {
  for (const r of _runtimes) {
    try {
      for (const e of Deno.readDirSync(r)) {
        if (e.isDirectory && /^aio(-|$)/.test(e.name)) {
          pruneDeadLockDirAt(join(r, e.name), true);
        }
      }
      sweepRootRegistry(r);
      const live = [...Deno.readDirSync(r)].some((e) =>
        e.isDirectory && /^aio(-|$)/.test(e.name)
      );
      if (!live) Deno.removeSync(r, { recursive: true });
    } catch {
      /* aio-ok: best effort on the way out — named by check:orphans */
    }
  }
  _runtimes.clear();
}

/** The shard processes still running — an interrupt stops them first. */
const _children = new Set<Deno.ChildProcess>();

/** Interrupted: stop every shard and AWAIT its exit before any runtime dir is
 *  judged. Pruning first (the old signal handler did) found every lock still
 *  held by a shard that had not died yet, and left all the dirs behind.
 *  SIGTERM, up to `graceMs` for them to go, then SIGKILL; then each runtime
 *  dir by the one rule. Returns what is still held — a process outlived its
 *  shard — for the caller to NAME. Never throws. */
export async function interruptShards(
  children: ReadonlySet<Deno.ChildProcess>,
  runtimes: ReadonlySet<string>,
  graceMs = 5000,
): Promise<string[]> {
  const kill = (sig: Deno.Signal) => {
    for (const c of children) {
      try {
        c.kill(sig);
      } catch { /* aio-ok: already exited */ }
    }
  };
  const done = Promise.all([...children].map((c) => c.status));
  kill("SIGTERM");
  if (!await within(done, graceMs)) {
    kill("SIGKILL");
    await within(done, 2000);
  }
  const left: string[] = [];
  for (const r of [...runtimes]) left.push(...await dropShardRuntime(r));
  return left;
}

/** Whether `p` settled within `ms`. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((r) =>
    timer = setTimeout(() => r(false), ms)
  );
  try {
    return await Promise.race([p.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main) {
  // Interrupted (Ctrl-C, SIGTERM from an outer timeout): the shards are
  // stopped and awaited, THEN no runtime dir is left behind unless something
  // live is still in it — and that one is named. A second signal exits now.
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, async () => {
        const code = sig === "SIGINT" ? 130 : 143;
        if (stopping) Deno.exit(code);
        stopping = true;
        const left = await interruptShards(_children, _runtimes);
        if (left.length) {
          console.error(
            `\ninterrupted — still held by a live process (check:orphans ` +
              `names its owner):\n  ${left.join("\n  ")}`,
          );
        }
        Deno.exit(code);
      });
    } catch { /* aio-ok: no such signal here (windows SIGTERM) */ }
  }
  addEventListener("unload", dropAllRuntimesSync);
  const flag = Deno.args.find((a) => a.startsWith("--shards="));
  const fence = await machineFence();
  const cores = fence.cores;
  const n = flag ? Number(flag.slice(9)) : Number(
    Deno.env.get("AIO_TEST_SHARDS") ??
      Math.max(1, Math.min(16, fence.usable >> 1)),
  );
  const named = Deno.args.filter((a) => !a.startsWith("--"));
  const files = named.length ? named : await discover(["tests", "amui/src"]);
  let timings: Record<string, number> = {};
  try {
    timings = JSON.parse(await Deno.readTextFile(TIMINGS));
  } catch { /* first run: every file counts as one second */ }

  const windowed = new Set<string>();
  await Promise.all(files.map(async (f) => {
    const src = await Deno.readTextFile(join(ROOT, f)).catch(() => "");
    if (REAL_WINDOW.test(src)) windowed.add(f);
  }));
  const shards = plan(files, n, timings, (f) => windowed.has(f));
  // The nested test display is SHARED by every shard and every later run. A
  // shard that started it kept its cookie in the shard's private
  // XDG_RUNTIME_DIR — deleted when the shard ended — and every later GUI child
  // was refused ("Invalid MIT-MAGIC-COOKIE-1 key": 5 Electron tests, a hosts
  // row and 4 mutation rows red in one release check). So the runner starts it,
  // under the real runtime dir, before any shard; and one it cannot
  // authenticate to stops the run here, not an hour later.
  if (
    windowed.size > 0 && Deno.build.os === "linux" &&
    Deno.env.get("DISPLAY") && !Deno.env.get("AIO_TEST_DISPLAY")
  ) {
    const pick = pickNestedDisplay();
    const cookie = pick?.up ? nestedDisplayCookie(pick.display) : null;
    if (
      pick?.up &&
      (cookie === null || !await nestedDisplayAccepts(pick.display, cookie))
    ) {
      console.error(
        `test-shards: the test display ${pick.display} is up, but it refuses ` +
          `this user's access cookie (${cookie ?? "none on file"}) — it was ` +
          `started under another runtime dir — so every window test would be ` +
          `refused. Close that Xephyr and run again.`,
      );
      Deno.exit(1);
    }
    testDisplay();
  }
  await Deno.remove(OUT, { recursive: true }).catch(() => {});
  await Deno.mkdir(OUT, { recursive: true });
  // The real stores, as they were before any shard ran — compared at the end,
  // so a write that got past the sandbox fails the run, naming the entry.
  const storeDirs = realStoreDirs(Deno.env.toObject());
  const storesBefore = snapshotStores(storeDirs);
  const started = performance.now();
  console.log(
    `${files.length} test files → ${shards.length} parallel shards on ` +
      `${fence.usable} of ${cores} cores (${
        fence.prefix.join(" ") || "no fence"
      }) ` +
      `(${windowed.size} real-window tests serialized in shard 0) · logs: ${
        relative(ROOT, OUT)
      }/`,
  );

  const results = await Promise.all(shards.map(async (list, i) => {
    const home = join(ROOT, ".aio-test-shards", String(i), ".aio-test-home");
    await Deno.remove(home, { recursive: true }).catch(() => {});
    await Deno.remove(join(dirname(home), "stores"), { recursive: true })
      .catch(() => {});
    await Deno.mkdir(home, { recursive: true });
    const log = join(OUT, `${i}.log`);
    const junit = join(OUT, `${i}.xml`);
    // Its OWN runtime dir — lock dirs, sockets, the registry — so a shard
    // never writes into the developer's real $XDG_RUNTIME_DIR, and shards
    // cannot see each other's locks. Short (`/tmp/xdg-shard-XXXX`): socket
    // paths are built under it. Not for the real-window shard 0, whose
    // Electron needs the session's display/dbus sockets there.
    const realWindow = i === 0 && windowed.size > 0;
    const runtime = realWindow
      ? null
      // A FIXED short base: `makeTempDir` follows TMPDIR, which on macOS is
      // `/var/folders/…/T/` — long enough to push socket paths past the limit.
      : await Deno.makeTempDir({
        dir: Deno.build.os === "windows" ? undefined : "/tmp",
        prefix: "xdg-shard-",
      });
    if (runtime) _runtimes.add(runtime);
    const t0 = performance.now();
    const [cmd, ...pre] = [...fence.prefix, Deno.execPath()];
    const child = new Deno.Command(cmd!, {
      args: [
        ...pre,
        "test",
        "-A",
        "--sanitize-ops",
        "--sanitize-resources",
        `--junit-path=${junit}`,
        ...list,
      ],
      cwd: ROOT,
      env: shardEnv(i, shards.length, runtime, { home, realWindow }),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    _children.add(child); // an interrupt stops it before judging its dir
    const { code, stdout, stderr } = await child.output()
      .finally(() => _children.delete(child));
    // The shard is done, and so is every process it started: the scoped lock
    // dir its AIO_APPS_DIR made in $XDG_RUNTIME_DIR goes, unless something
    // live is still in it (check:orphans reports that one).
    let left: string[] = [];
    if (runtime) left = await dropShardRuntime(runtime);
    else pruneDeadLockDir(home);
    const dec = new TextDecoder();
    const out = dec.decode(stdout) + dec.decode(stderr);
    // A press the harness only WARNED about fails the run here (see
    // `swallowedPresses`): read each named file's source once, for its marker.
    const swallowed = swallowedPresses(out, (f) => {
      try {
        return Deno.readTextFileSync(join(ROOT, f));
      } catch {
        return ""; // aio-ok: an unreadable file carries no marker — it fails
      }
    });
    const text = out +
      (left.length
        ? `\nFAILED | shard runtime dir ${runtime} still holds live lock ` +
          `dirs (a process outlived its test): ${left.join(", ")}\n`
        : "") +
      (swallowed.length
        ? `\nFAILED | a press was swallowed by an input and no handler ran ` +
          `(${SWALLOWED_PRESS}) in: ${swallowed.join(", ")} — press on the ` +
          `window (\`ui.window.press(…)\`), or, when the test asserts the ` +
          `binding does NOT fire, mark the file \`// aio-ok: press ` +
          `swallowed on purpose — <why>\`\n`
        : "");
    await Deno.writeTextFile(log, text);
    const secs = Math.round((performance.now() - t0) / 1000);
    const failed = failures(text);
    const summary = text.replace(/\x1b\[[0-9;]*m/g, "")
      .match(/^(ok|FAILED) \| .*$/m)?.[0] ?? `exit ${code}`;
    console.log(
      `${
        code === 0 && swallowed.length === 0 ? "✓" : "✗"
      } shard ${i}  ${list.length} files  ${secs}s  ${summary}`,
    );
    let times: Record<string, number> = {};
    try {
      times = junitTimes(await Deno.readTextFile(junit));
    } catch { /* a shard that died before writing its report */ }
    return {
      i,
      code,
      failed: swallowed.length
        ? [
          ...failed,
          `swallowed press (no handler ran): ${swallowed.join(", ")}`,
        ]
        : failed,
      log,
      times,
      left: left.length > 0 || swallowed.length > 0,
    };
  }));

  // Remember what each file cost, for the next run's balance.
  const merged = { ...timings };
  for (const r of results) Object.assign(merged, r.times);
  await Deno.mkdir(join(ROOT, ".aio"), { recursive: true });
  await Deno.writeTextFile(TIMINGS, JSON.stringify(merged, null, 0));

  const bad = results.filter((r) => r.code !== 0 || r.left);
  const wall = Math.round((performance.now() - started) / 1000);
  const storeWrites = storeChanges(storesBefore, snapshotStores(storeDirs));
  if (storeWrites.length > 0) {
    console.error(
      `\n✗ the run wrote a REAL per-user store (a test escaped the ` +
        `AIO_VERSIONS_DIR/AIO_HOME sandbox):\n  ${storeWrites.join("\n  ")}` +
        `\n  Every pinned app on this machine runs what is in that store. ` +
        `Inspect the entry, remove it by hand if a test made it, and find ` +
        `the test that resolved the store without the sandbox.`,
    );
  }
  if (bad.length === 0 && storeWrites.length === 0) {
    console.log(`\n✓ all ${shards.length} shards passed in ${wall}s`);
    Deno.exit(0);
  }
  if (bad.length > 0) {
    console.error(`\n✗ ${bad.length} shard(s) failed (${wall}s):`);
  }
  for (const r of bad) {
    console.error(`  shard ${r.i} — ${relative(ROOT, r.log)}`);
    for (const f of r.failed) console.error(`    ${f.trim()}`);
    if (r.failed.length === 0) {
      console.error("    (no FAILED line — see the log)");
    }
  }
  Deno.exit(1);
}
