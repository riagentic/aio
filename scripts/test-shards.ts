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
import { join, relative } from "@std/path";

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

if (import.meta.main) {
  const flag = Deno.args.find((a) => a.startsWith("--shards="));
  const cores = navigator.hardwareConcurrency ?? 4;
  const n = flag ? Number(flag.slice(9)) : Number(
    Deno.env.get("AIO_TEST_SHARDS") ?? Math.max(1, Math.min(16, cores >> 1)),
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
  await Deno.remove(OUT, { recursive: true }).catch(() => {});
  await Deno.mkdir(OUT, { recursive: true });
  const started = performance.now();
  console.log(
    `${files.length} test files → ${shards.length} parallel shards ` +
      `(${windowed.size} real-window tests serialized in shard 0) · logs: ${
        relative(ROOT, OUT)
      }/`,
  );

  const results = await Promise.all(shards.map(async (list, i) => {
    const home = join(ROOT, ".aio-test-shards", String(i), ".aio-test-home");
    await Deno.remove(home, { recursive: true }).catch(() => {});
    await Deno.mkdir(home, { recursive: true });
    const log = join(OUT, `${i}.log`);
    const junit = join(OUT, `${i}.xml`);
    const t0 = performance.now();
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "-A",
        "--sanitize-ops",
        "--sanitize-resources",
        `--junit-path=${junit}`,
        ...list,
      ],
      cwd: ROOT,
      // Its own port slice, below the OS ephemeral range (32768+): freePort()
      // draws from it, so two shards can never be handed the same port.
      env: {
        AIO_APPS_DIR: home,
        AIO_TEST_PORT_SLICE: portSliceFor(i, shards.length),
      },
      stdin: "null",
    }).output();
    const dec = new TextDecoder();
    const text = dec.decode(stdout) + dec.decode(stderr);
    await Deno.writeTextFile(log, text);
    const secs = Math.round((performance.now() - t0) / 1000);
    const failed = failures(text);
    const summary = text.replace(/\x1b\[[0-9;]*m/g, "")
      .match(/^(ok|FAILED) \| .*$/m)?.[0] ?? `exit ${code}`;
    console.log(
      `${
        code === 0 ? "✓" : "✗"
      } shard ${i}  ${list.length} files  ${secs}s  ${summary}`,
    );
    let times: Record<string, number> = {};
    try {
      times = junitTimes(await Deno.readTextFile(junit));
    } catch { /* a shard that died before writing its report */ }
    return { i, code, failed, log, times };
  }));

  // Remember what each file cost, for the next run's balance.
  const merged = { ...timings };
  for (const r of results) Object.assign(merged, r.times);
  await Deno.mkdir(join(ROOT, ".aio"), { recursive: true });
  await Deno.writeTextFile(TIMINGS, JSON.stringify(merged, null, 0));

  const bad = results.filter((r) => r.code !== 0);
  const wall = Math.round((performance.now() - started) / 1000);
  if (bad.length === 0) {
    console.log(`\n✓ all ${shards.length} shards passed in ${wall}s`);
    Deno.exit(0);
  }
  console.error(`\n✗ ${bad.length} shard(s) failed (${wall}s):`);
  for (const r of bad) {
    console.error(`  shard ${r.i} — ${relative(ROOT, r.log)}`);
    for (const f of r.failed) console.error(`    ${f.trim()}`);
    if (r.failed.length === 0) {
      console.error("    (no FAILED line — see the log)");
    }
  }
  Deno.exit(1);
}
