#!/usr/bin/env -S deno run -A
/**
 * test-shards.ts — the full suite, split across parallel `deno test` PROCESSES.
 *
 *   deno run -A scripts/test-shards.ts [--shards=N] [--quiet-ms=N] [files or dirs…]
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
 *
 * A shard's output goes to `.aio/test-shards/<n>.log` AS IT ARRIVES, so a run
 * that hangs has left, on disk, the file it hangs in. A shard that prints
 * nothing for `--quiet-ms` (5 minutes) is named on the runner's own output,
 * with the last file it started — and again every 5 minutes. It is not
 * stopped: a long test is not a failure.
 */
import { dirname, join, relative, resolve, SEPARATOR } from "@std/path";
import { homeStoreEnv } from "../src/testing/test-strict.ts";
import { testDisplay } from "../src/testing/test-display.ts";
import { HEAP_FLOOR_MB } from "../src/server/heap-policy.ts";
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
  rootRegistryEntry,
  sweepRootRegistry,
} from "../src/server/single-instance-lock.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TIMINGS = join(ROOT, ".aio", "test-timings.json");
const OUT = join(ROOT, ".aio", "test-shards");

/** A running shard's two pipes: both into its `log` as they arrive
 *  ({@linkcode pumpToLog}), and `say(quietMs, header)` each time BOTH have
 *  been silent for `quietMs` — `header` is the file stdout last started
 *  ({@linkcode headerTracker}). Resolves with what each printed. */
export async function followShard(
  pipes: {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  },
  log: { write(p: Uint8Array): Promise<number> },
  quietMs: number,
  say: (quietMs: number, header: string | null) => void,
): Promise<{ stdout: string; stderr: string }> {
  const at = headerTracker();
  const quiet = quietWatch(quietMs, (ms) => say(ms, at.last()));
  try {
    const [stdout, stderr] = await Promise.all([
      pumpToLog(pipes.stdout, log, (text) => {
        at.feed(text);
        quiet.touch();
      }),
      pumpToLog(pipes.stderr, log, quiet.touch),
    ]);
    return { stdout, stderr };
  } finally {
    quiet.stop();
  }
}

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
export async function discover(
  dirs: string[],
  root: string = ROOT,
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory) await walk(p);
      else if (e.isFile && TEST_FILE.test(e.name)) out.push(relative(root, p));
    }
  };
  for (const d of dirs) await walk(resolve(root, d));
  return out.sort();
}

/** The named arguments as FILES: a directory is the test files under it, the
 *  way `deno test` reads one. Handed on as a directory it was one "file" that
 *  is no file — never planned or timed by name, and skipped by the judge
 *  that every listed file ran its tests ({@linkcode unrunFiles}), so a file
 *  with no test under it rode a green summary. */
export async function expandDirs(
  named: string[],
  root: string = ROOT,
): Promise<string[]> {
  const out: string[] = [];
  for (const a of named) {
    const dir = await Deno.stat(resolve(root, a))
      .then((s) => s.isDirectory, () => false);
    out.push(...(dir ? await discover([a], root) : [a]));
  }
  return [...new Set(out)];
}

/** The last `running N tests from <file>` line in what a shard printed — the
 *  file it is in now. */
export function lastHeader(text: string): string | null {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
    .match(/^running \d+ tests? from .+$/gm)?.at(-1) ?? null;
}

/** {@linkcode lastHeader} of output that arrives in pieces: a header cut in
 *  two by a chunk boundary is still one line, and the last one stands however
 *  much the file prints after it. */
export function headerTracker(): {
  feed(text: string): void;
  last(): string | null;
} {
  let partial = "";
  let header: string | null = null;
  return {
    feed(text) {
      const lines = partial + text;
      const cut = lines.lastIndexOf("\n") + 1;
      header = lastHeader(lines.slice(0, cut)) ?? header;
      partial = lines.slice(cut);
    },
    last: () => header,
  };
}

/** Call `say(quietMs)` each time `ms` pass with no `touch()` — again after
 *  every further `ms` — until `stop()`. It only tells: nothing is killed. */
export function quietWatch(
  ms: number,
  say: (quietMs: number) => void,
): { touch(): void; stop(): void } {
  let rounds = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer = setTimeout(() => {
      say(++rounds * ms);
      arm();
    }, ms);
  };
  arm();
  return {
    touch() {
      clearTimeout(timer);
      rounds = 0;
      arm();
    },
    stop: () => clearTimeout(timer),
  };
}

/** Copy `stream` into the open `log` chunk by chunk — the file on disk shows
 *  what a shard has printed while it is still running — and return it whole,
 *  for the judges. Kept in memory until the end only, a hung shard's output
 *  was lost with the run that was stopped to end it.
 *
 *  The log is shared by a shard's two streams, so it is given WHOLE
 *  characters only: the bytes of one a chunk ends inside wait for the rest.
 *  Written as they came, the other stream's text landed between the two
 *  halves and both were unreadable on disk. `seen` gets the very text the log
 *  got — the replacement character of a stream that ENDS inside one too. */
export async function pumpToLog(
  stream: ReadableStream<Uint8Array>,
  log: { write(p: Uint8Array): Promise<number> },
  seen: (text: string) => void,
): Promise<string> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let all = "";
  const pass = async (text: string) => {
    const bytes = enc.encode(text);
    for (let off = 0; off < bytes.length;) {
      off += await log.write(bytes.subarray(off));
    }
    all += text;
    seen(text);
  };
  for await (const chunk of stream) {
    await pass(dec.decode(chunk, { stream: true }));
  }
  // What a stream that ended inside a character left behind.
  const cut = dec.decode();
  if (cut !== "") await pass(cut);
  return all;
}

/** THE reader of every whole-number setting of this runner: `raw` as a
 *  number, or the sentence that refuses it (`said` is the setting as the
 *  user wrote it). Digits only, no sign, no leading zero, 1 to `max`:
 *  `Number()` also takes `0x10`, `1e3`, ` 5` and `5.0` and ran each as
 *  something the setting did not say — and takes `abc` as NaN, which went on
 *  into the run. Pure. */
export function wholeNumber(
  said: string,
  raw: string | undefined,
  max: number,
  what: string,
): number | string {
  return raw !== undefined && /^[1-9][0-9]*$/.test(raw) && Number(raw) <= max
    ? Number(raw)
    : `test-shards: ${said} is not a whole number of ${what} from 1 to ${max}`;
}

/** The value of the whole-number flag `--name=N` on a command line:
 *  undefined when the flag is absent, else {@linkcode wholeNumber} of it.
 *  EVERY occurrence is read (a later bad one is not excused by an earlier
 *  good one) and the last one counts; a bare `--name` gives no number at
 *  all. Pure. */
function flagNumber(
  args: readonly string[],
  name: string,
  max: number,
  what: string,
): number | string | undefined {
  let value: number | undefined;
  for (const arg of args) {
    if (arg !== name && !arg.startsWith(`${name}=`)) continue;
    const read = wholeNumber(
      arg,
      arg === name ? undefined : arg.slice(name.length + 1),
      max,
      what,
    );
    if (typeof read === "string") return read;
    value = read;
  }
  return value;
}

/** The `--quiet-ms` of a command line: milliseconds (1 to 2³¹−1 — what a
 *  timer can hold; 300000 when the flag is absent), or the sentence that
 *  refuses it. Pure. */
export function quietMsOf(args: readonly string[]): number | string {
  return flagNumber(args, "--quiet-ms", 2 ** 31 - 1, "milliseconds") ??
    300_000;
}

/** How many shards: `--shards=N`, else `AIO_TEST_SHARDS`, else `fallback` —
 *  or the sentence that refuses what was said. 1 to 256. Pure. */
export function shardsOf(
  args: readonly string[],
  env: string | undefined,
  fallback: number,
): number | string {
  return flagNumber(args, "--shards", 256, "shards") ??
    (env === undefined
      ? fallback
      : wholeNumber(`AIO_TEST_SHARDS=${env}`, env, 256, "shards"));
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
  // `error:` line is the whole story. Intentional cell-worker crash fixtures
  // (load boom, loop-died timer, …) still print
  // `error: Uncaught (in worker "aio-cell:…") …` on stderr after
  // preventDefault — not a suite failure when every test passed. Match any
  // aio-cell Uncaught (optional "(in promise)") when the suite was ok; a
  // real red suite still surfaces via FAILURES / "… FAILED" above.
  const suiteOk = lines.some((l) => /^ok \| /.test(l));
  const intentionalWorkerCrash =
    /^error: Uncaught \(in worker "aio-cell:[^"]+"\)( \(in promise\))? Error:/;
  // minify's "type error in the ORIGINAL still fails" fixture runs `deno check`
  // on a deliberately broken file; its `error: Type checking failed.` lands in
  // post-test output beside an `ok |` suite — not a shard failure.
  const intentionalTypecheckFail = /^error: Type checking failed\.?$/;
  return failed.length ? failed : lines.filter((l) =>
    /^error: /.test(l) &&
    !(suiteOk &&
      (intentionalWorkerCrash.test(l) || intentionalTypecheckFail.test(l)))
  );
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
    // Cap every app this shard spawns at the heap FLOOR. Without it each app
    // inherits 25% of the HOST's RAM — ~46 GB on a 186 GB box — and the suite's
    // spawned apps sum to more than the machine, freezing it (2026-10-01).
    // Sharding does not help: the demand is per-app. See `envHeapCapMB`.
    AIO_MAX_HEAP_MB: String(HEAP_FLOOR_MB),
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

/** The listed test files a `deno test` that exited 0 did NOT run, each with
 *  why. Pure.
 *
 *  Exit 0 and `ok | N passed` say nothing failed — not that every file ran. A
 *  file that calls `Deno.exit(0)` at its top level ends its own isolate: deno
 *  prints a `note`, goes on to the next file, and the summary counts none of
 *  that file's tests — a failing test beside the call was a green shard. So a
 *  listed file must be seen running: its `running N tests from ./<file>`
 *  header, with N > 0 (ignored tests count: deno lists them). A file with no
 *  code in it (`blank`) has nothing to run, and is the one exception.
 *
 *  A file is named as typed on the command line and as deno prints it — two
 *  spellings of one path, so both are read as that path under `root`: an
 *  absolute or un-normalised name (`tests/../tests/a.test.ts`) ran, passed,
 *  and was "never started". */
export function unrunFiles(
  log: string,
  files: string[],
  blank: (file: string) => boolean,
  root: string = ROOT,
): string[] {
  const key = (f: string) =>
    relative(root, resolve(root, f.replaceAll("\\", "/")))
      .replaceAll("\\", "/");
  // deno-lint-ignore no-control-regex
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const ran = new Map<string, number>();
  const exited = new Map<string, string>();
  for (const l of lines) {
    // To the end of the line: a path may hold a space.
    const r = /^running (\d+) tests? from (.+)$/.exec(l.trim());
    if (r) ran.set(key(r[2]!), (ran.get(key(r[2]!)) ?? 0) + Number(r[1]));
    const x = /^note (.+) called `(Deno\.exit\(-?\d*\))` from outside any test/
      .exec(l.trim());
    if (x) exited.set(key(x[1]!), x[2]!);
  }
  const out: string[] = [];
  for (const file of files) {
    const f = key(file);
    if (exited.has(f)) {
      out.push(
        `${f} called ${exited.get(f)} outside any test — deno stopped the ` +
          `file there, and the tests in it never ran`,
      );
    } else if (!ran.has(f)) {
      out.push(`${f} never started (deno printed no "running N tests" for it)`);
    } else if (ran.get(f) === 0 && !blank(file)) {
      out.push(
        `${f} ran 0 tests — it registered none, so it tested nothing`,
      );
    }
  }
  return out;
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
  // Never every core. Whatever the caller asks for, ONE core stays untouched:
  // the OS, the desktop and the freeze watcher need somewhere to run.
  // `AIO_TEST_FREE_CORES=0` used to mean `taskset -c 0-(n-1)` — the whole
  // machine — and a run that takes every core is the one load that can wedge a
  // desktop. "Maximum performance with total stability": take the rest, keep
  // one. A non-finite request is treated the same way.
  const leave = Number.isFinite(free) ? Math.max(1, Math.floor(free)) : 1;
  const usable = Math.max(1, cores - leave);
  const nice = have.nice ? ["nice", "-n", "10"] : [];
  if (os === "linux" && have.taskset && cores > leave) {
    return {
      usable,
      prefix: ["taskset", "-c", `${leave}-${cores - 1}`, ...nice],
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

/** `AIO_TEST_FREE_CORES` as a number: unset is 4, a whole number ≥ 0 is
 *  itself, and anything else THROWS. `Number("abc")` is NaN, which the fence
 *  read as "keep one core" — a typo took 31 of 32 cores without a word. Pure. */
export function freeCores(raw: string | undefined): number {
  if (raw === undefined) return 4;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      `test-shards: AIO_TEST_FREE_CORES=${
        JSON.stringify(raw)
      } is not a whole ` +
        `number of cores to keep free (e.g. AIO_TEST_FREE_CORES=4)`,
    );
  }
  return Number(raw);
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
      freeCores(Deno.env.get("AIO_TEST_FREE_CORES")),
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
      if (await lockDirHeld(d)) left.push(d);
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

/** Prune lock dir `d` by the one rule; true when something is still in it. */
async function lockDirHeld(d: string): Promise<boolean> {
  if (pruneDeadLockDirAt(d, true) || !dirHasEntries(d)) return false;
  await dropRefusedSockets(d);
  return !pruneDeadLockDirAt(d, true) && dirHasEntries(d);
}

/** The runtime base a shard WITHOUT a private one inherits — where the lock
 *  module puts its lock dirs when nothing says otherwise. */
export function sessionRuntimeBase(): string {
  return Deno.build.os === "windows"
    ? (Deno.env.get("TEMP") ?? Deno.env.get("TMP") ?? "C:\\Temp")
    : (Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp");
}

/** The lock dirs under runtime base `base` that serve an apps root at or
 *  inside `home` — read from the registry `lockDir()` keeps beside them
 *  (`<base>/.aio-roots/<dir>` holds the root). By the ROOT, never by the
 *  name: `base` here is the developer's own session dir, and the apps they
 *  are running hold locks in it too — under other roots, so they are never
 *  listed, judged or pruned. Never throws. */
export function lockDirsOf(base: string, home: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = [...Deno.readDirSync(join(base, ".aio-roots"))].map((e) => e.name);
  } catch {
    return out; // aio-ok: no registry — no scoped lock dir was made here
  }
  for (const n of names.sort()) {
    if (!n.startsWith("aio-")) continue;
    const dir = join(base, n);
    try {
      const root = Deno.readTextFileSync(rootRegistryEntry(dir));
      if (root === home || root.startsWith(home + SEPARATOR)) out.push(dir);
    } catch { /* aio-ok: unregistered meanwhile — its dir is gone */ }
  }
  return out;
}

/** Every entry (`<dir>/<name>`) still in a lock dir of `home` under `base`
 *  once each is pruned by the one rule — what something live holds — with a
 *  stamp of WHICH file it is (inode and mtime): a lock published again under
 *  the same name is another file. `base` itself is never removed. Never
 *  throws. */
export async function heldLockEntries(
  base: string,
  home: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const d of lockDirsOf(base, home)) {
    try {
      if (!await lockDirHeld(d)) continue;
      for (const e of Deno.readDirSync(d)) {
        const st = Deno.lstatSync(join(d, e.name));
        out.set(join(d, e.name), `${st.ino}:${st.mtime?.getTime()}`);
      }
    } catch { /* aio-ok: gone between the two looks — nothing holds it */ }
  }
  return out;
}

/** {@link dropShardRuntime}, with patience and no mercy. A child a test
 *  stopped may not be gone the instant `deno test` exits (a detached app
 *  still shutting down under a loaded shard), so the dir is asked again,
 *  `tries` times over ~35 s — and what is STILL held after that is a process
 *  that outlived its test, which fails the shard whatever the suite's own
 *  summary says. `first` is what the first ask found, for the log: a shard
 *  that needed the wait names the lock dirs that made it wait, so the test
 *  behind a slow teardown is found by name rather than guessed. Never throws. */
export function settleShardRuntime(
  runtime: string,
  tries = 12,
  stepMs = 500,
): Promise<Settled> {
  return settle(() => dropShardRuntime(runtime), tries, stepMs);
}

/** {@link settleShardRuntime} for the real-window shard, which inherits the
 *  session's runtime dir `base`: the same wait and the same verdict, over the
 *  lock dirs of its own apps root `home` and nothing else in `base`. It was
 *  the one shard never judged — the shard every Electron and Chromium test
 *  runs in — so an app one of them left running was a green run.
 *
 *  `before` is what {@link heldLockEntries} found when the shard STARTED:
 *  an earlier run's leftover is not this shard's, and a dir holding nothing
 *  newer is not counted. */
export function settleHomeLockDirs(
  base: string,
  home: string,
  before: ReadonlyMap<string, string>,
  tries = 12,
  stepMs = 500,
): Promise<Settled> {
  return settle(
    async () => [
      ...new Set(
        [...await heldLockEntries(base, home)]
          .filter(([p, stamp]) => before.get(p) !== stamp)
          .map(([p]) => dirname(p)),
      ),
    ],
    tries,
    stepMs,
  );
}

type Settled = { left: string[]; first: string[]; waitedMs: number };

async function settle(
  drop: () => Promise<string[]>,
  tries: number,
  stepMs: number,
): Promise<Settled> {
  const t0 = performance.now();
  const named = (dirs: string[]) => dirs.map((d) => `${d}${dirEntries(d)}`);
  let left = named(await drop());
  const first = left;
  for (let i = 1; i < tries && left.length > 0; i++) {
    await new Promise((r) => setTimeout(r, stepMs * i));
    left = named(await drop());
  }
  return {
    left,
    first,
    waitedMs: first.length ? Math.round(performance.now() - t0) : 0,
  };
}

/** ` [a.lock, a.sock]` — what is in a held lock dir: the lock's name is the
 *  appId, which names the test. Empty for anything that is not a directory. */
function dirEntries(d: string): string {
  try {
    return ` [${
      [...Deno.readDirSync(d)].map((e) => e.name).sort().join(", ")
    }]`;
  } catch {
    return ""; // aio-ok: a `<dir> (error)` entry, or gone meanwhile
  }
}

/** The line that fails a shard whose runtime dir is still held, "" for none.
 *  Unconditional: it was once a log-only WARN whenever the suite itself was
 *  green — which is exactly when a leaked process is otherwise invisible. Pure. */
export function leftoverFailure(runtime: string, left: string[]): string {
  return left.length === 0
    ? ""
    : `shard runtime dir ${runtime} still holds live lock dirs (a process ` +
      `outlived its test): ${left.join(", ")}`;
}

/** THE verdict on one shard: the `✓`/`✗` beside it and whether the run ends
 *  red are both this. They were two expressions, and disagreed — a shard could
 *  print `✗` under a closing `✓ all shards passed`, and the reverse. Pure. */
export function shardPassed(
  r: { code: number; left: boolean; unrun?: boolean },
): boolean {
  return r.code === 0 && !r.left && !r.unrun;
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

function isFile(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false; // aio-ok: a missing path is deno's to refuse, and it does
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
  const fence = await machineFence();
  const cores = fence.cores;
  // A setting that is no whole number stops the run here, by name: `abc`
  // shards planned nothing and crashed on the empty plan; a timer handed
  // `Infinity`, `1e10` or `0.5` runs as 1 ms — a line every millisecond.
  const said = (value: number | string): number => {
    if (typeof value === "string") {
      console.error(value);
      Deno.exit(1);
    }
    return value;
  };
  const n = said(shardsOf(
    Deno.args,
    Deno.env.get("AIO_TEST_SHARDS"),
    Math.max(1, Math.min(16, fence.usable >> 1)),
  ));
  const quietMs = said(quietMsOf(Deno.args));
  const named = Deno.args.filter((a) => !a.startsWith("--"));
  const files = named.length
    ? await expandDirs(named)
    : await discover(["tests", "amui/src"]);
  let timings: Record<string, number> = {};
  try {
    timings = JSON.parse(await Deno.readTextFile(TIMINGS));
  } catch { /* first run: every file counts as one second */ }

  const windowed = new Set<string>();
  await Promise.all(files.map(async (f) => {
    const src = await Deno.readTextFile(resolve(ROOT, f)).catch(() => "");
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
    const where = runtime ?? sessionRuntimeBase();
    // Registration is best effort: the dir this home maps to is pruned even
    // when the registry never heard of it.
    if (!runtime) pruneDeadLockDir(home);
    // Held before the shard starts: an earlier run's leftover, named now and
    // not charged to this shard later.
    const before = runtime
      ? new Map<string, string>()
      : await heldLockEntries(where, home);
    if (before.size) {
      console.error(
        `shard ${i}: its lock dir is already held by a live process an ` +
          `earlier run left (check:orphans names its owner): ${
            [...before.keys()].join(", ")
          }`,
      );
    }
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
    const logFile = await Deno.open(log, {
      write: true,
      create: true,
      truncate: true,
    });
    const [{ code }, { stdout, stderr }] = await Promise.all([
      child.status,
      followShard(child, logFile, quietMs, (ms, header) =>
        console.log(
          `… shard ${i}: no output for ${Math.round(ms / 1000)}s — ${
            header ?? "no test file started yet"
          } (still running; its output so far: ${relative(ROOT, log)})`,
        )),
    ]).finally(() => {
      logFile.close();
      _children.delete(child);
    });
    // The shard is done, and so is every process it started: the scoped lock
    // dir its AIO_APPS_DIR made in $XDG_RUNTIME_DIR goes, unless something
    // live is still in it (check:orphans reports that one).
    // Asked patiently, judged without exception: the private runtime dir
    // whole, and for the real-window shard — in the session's own — the lock
    // dirs of this shard's home only.
    if (!runtime) pruneDeadLockDir(home);
    const settled = runtime
      ? await settleShardRuntime(runtime)
      : await settleHomeLockDirs(where, home, before);
    const left = settled.left;
    const out = stdout + stderr;
    // A press the harness only WARNED about fails the run here (see
    // `swallowedPresses`): read each named file's source once, for its marker.
    const swallowed = swallowedPresses(out, (f) => {
      try {
        return Deno.readTextFileSync(join(ROOT, f));
      } catch {
        return ""; // aio-ok: an unreadable file carries no marker — it fails
      }
    });
    const held = leftoverFailure(where, left);
    // Exit 0 is only "nothing failed": every listed file must have RUN.
    const unrun = code === 0
      ? unrunFiles(
        out,
        list.filter((f) => isFile(resolve(ROOT, f))),
        (f) => Deno.readTextFileSync(resolve(ROOT, f)).trim() === "",
      )
      : [];
    const text = out +
      (held ? `\nFAILED | ${held}\n` : "") +
      // Gone in time, but only after a wait: not a failure, and not silent —
      // the next slow teardown starts from a name instead of a guess.
      (settled.waitedMs > 0 && !held
        ? `\nNOTE | shard runtime dir ${where} held lock dirs for ` +
          `${settled.waitedMs} ms after the shard exited (a child was still ` +
          `shutting down): ${settled.first.join(", ")}\n`
        : "") +
      (swallowed.length
        ? `\nFAILED | a press was swallowed by an input and no handler ran ` +
          `(${SWALLOWED_PRESS}) in: ${swallowed.join(", ")} — press on the ` +
          `window (\`ui.window.press(…)\`), or, when the test asserts the ` +
          `binding does NOT fire, mark the file \`// aio-ok: press ` +
          `swallowed on purpose — <why>\`\n`
        : "") +
      (unrun.length
        ? `\nFAILED | ${unrun.length} test file(s) did not run their tests ` +
          `under a green summary:\n  ${unrun.join("\n  ")}\n`
        : "");
    await Deno.writeTextFile(log, text);
    const secs = Math.round((performance.now() - t0) / 1000);
    const failed = failures(text);
    const summary = text.replace(/\x1b\[[0-9;]*m/g, "")
      .match(/^(ok|FAILED) \| .*$/m)?.[0] ?? `exit ${code}`;
    let times: Record<string, number> = {};
    try {
      times = junitTimes(await Deno.readTextFile(junit));
    } catch { /* a shard that died before writing its report */ }
    const result = {
      i,
      code,
      failed: [
        ...failed,
        ...(held ? [held] : []),
        ...(swallowed.length
          ? [`swallowed press (no handler ran): ${swallowed.join(", ")}`]
          : []),
        ...unrun,
      ],
      log,
      times,
      left: left.length > 0 || swallowed.length > 0,
      unrun: unrun.length > 0,
    };
    console.log(
      `${
        shardPassed(result) ? "✓" : "✗"
      } shard ${i}  ${list.length} files  ${secs}s  ${summary}`,
    );
    return result;
  }));

  // Remember what each file cost, for the next run's balance.
  const merged = { ...timings };
  for (const r of results) Object.assign(merged, r.times);
  await Deno.mkdir(join(ROOT, ".aio"), { recursive: true });
  await Deno.writeTextFile(TIMINGS, JSON.stringify(merged, null, 0));

  const bad = results.filter((r) => !shardPassed(r));
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
