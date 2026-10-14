// deno task update:proof — write a proof row from a suite run's own log.
//
// "Tested on Windows and macOS as on Linux" was the headline of a release
// whose proof matrix had no native Windows row and no macOS row at all: the
// suite had run there, and the only record was a log in a scratch folder. A
// run on another machine cannot call `recordProof` — the tracked matrix is
// here, the run is there — so this reads what that run printed and writes the
// row from it: the counts are the log's, never typed.
//
//   deno task update:proof -- --row="windows (native suite)" \
//     --from=<suite.log, or a folder holding one> --commit=<sha> \
//     [--how="…"] [--exit=<the run's exit code>] [--dry-run]
//
// `--from` is the output of `deno task test` (scripts/test-shards.ts): one
// `✓ shard N … ok | P passed | 0 failed | I ignored` line per shard and a
// closing `✓ all N shards passed`. A run with a failing shard, a shard line
// missing, no closing verdict (a run that was cut), or a non-zero exit is
// REFUSED and nothing is written. So is a log whose first line (`suite: full ·
// os=… · commit=… · date=…`) is missing, says `partial`, names another OS than
// the row, or another commit than `--commit` — which is required, and must be
// a commit this repository has. A copy with no `.git` cannot know its commit:
// run the suite there with `AIO_TEST_COMMIT=<sha>`.
import { basename, fromFileUrl, join } from "@std/path";
import { CLAIMS, type ProofEntry, writeRow } from "./proof.ts";

/** The rows this recorder may write: a whole-suite run on another machine. */
export const SUITE_ROWS: readonly { target: string; env: string }[] = [
  { target: "windows", env: "native suite" },
  { target: "macos", env: "native suite" },
  { target: "windows", env: "real hardware" },
];

/** What a suite log says, or why it is not proof. */
export type SuiteVerdict =
  | {
    ok: true;
    passed: number;
    failed: number;
    ignored: number;
    files: number;
    shards: number;
    seconds: number;
  }
  | { ok: false; why: string };

const SHARD = /^([✓✗]) shard (\d+)\s+(\d+) files\s+\d+s\s+(.*)$/;
const COUNTS =
  /^ok \| (\d+) passed(?: \([^)]*\))? \| (\d+) failed(?: \([^)]*\))?(?: \| (\d+) ignored)?/;

/** Read the runner's output. Every way a run can be less than "the whole
 *  suite passed" is a refusal with its own sentence. `exit` is the run's exit
 *  code when the caller knows it (a wrapper's `…EXIT=<n>` line in the log is
 *  read too). Pure. */
export function suiteVerdict(log: string, exit?: number): SuiteVerdict {
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const no = (why: string): SuiteVerdict => ({ ok: false, why });
  const code = exit ??
    lines.map((l) => /^\w*EXIT=(-?\d+)\s*$/.exec(l)).filter(Boolean)
      .map((m) => Number(m![1])).find((n) => n !== 0);
  if (code !== undefined && code !== 0) return no(`the run exited ${code}`);
  const failedRun = lines.find((l) => /^✗ \d+ shard\(s\) failed/.test(l));
  if (failedRun) return no(`the run failed: "${failedRun.trim()}"`);
  const escaped = lines.find((l) => l.startsWith("✗ the run wrote a REAL"));
  if (escaped) return no("the run wrote a real per-user store");
  const all = lines.map((l) => /^✓ all (\d+) shards passed in (\d+)s/.exec(l))
    .find(Boolean);
  if (!all) {
    return no(
      'no closing "✓ all N shards passed" line — the run failed, was cut, ' +
        "or this is not the output of `deno task test`",
    );
  }
  const shards = lines.map((l) => SHARD.exec(l)).filter(
    Boolean,
  ) as RegExpExecArray[];
  if (shards.length !== Number(all[1])) {
    return no(
      `the verdict names ${all[1]} shards and the log has ${shards.length} ` +
        `shard line(s) — part of the run is missing`,
    );
  }
  let passed = 0, failed = 0, ignored = 0, files = 0;
  for (const s of shards) {
    const c = COUNTS.exec(s[4]!);
    if (s[1] !== "✓" || !c) {
      return no(`shard ${s[2]} did not pass: "${s[0]!.trim()}"`);
    }
    if (Number(c[2]) > 0) return no(`shard ${s[2]} has ${c[2]} failed test(s)`);
    passed += Number(c[1]);
    failed += Number(c[2]);
    ignored += Number(c[3] ?? 0);
    files += Number(s[3]);
  }
  if (passed === 0) return no("the run passed no test at all");
  return {
    ok: true,
    passed,
    failed,
    ignored,
    files,
    shards: shards.length,
    seconds: Number(all[2]),
  };
}

/** What binds a log to the row it is recorded as: the runner's own first
 *  line (`suiteHeader` in scripts/test-shards.ts). `deno task test
 *  tests/one.test.ts > suite.log` ends "✓ all 1 shards passed" too, and a log
 *  says nothing of the machine or the commit it ran on — so a log with no
 *  header, of part of the suite, of another OS, or of another commit than
 *  `commit` (the full sha `--commit` names) is refused. The row's date is the
 *  run's, read here: a copied file's mtime is the copy's. Pure. */
export function suiteBinding(
  log: string,
  target: string,
  commit: string,
): { ok: true; date: string } | { ok: false; why: string } {
  const no = (why: string) => ({ ok: false as const, why });
  const h = log.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) =>
    /^suite: (\S+) · os=(\S+) · commit=(\S+) · date=(\S+)\s*$/.exec(l)
  ).find(Boolean);
  if (!h) {
    return no(
      'no "suite: … · os=… · commit=… · date=…" line — the log is cut at ' +
        "its start, or the run was of a runner older than this recorder",
    );
  }
  const [, suite, os, ran, date] = h;
  if (suite !== "full") {
    return no(
      `the run was of PART of the suite ("suite: ${suite}" — files were ` +
        `named on its command line)`,
    );
  }
  const want = target === "macos" ? "darwin" : target;
  if (os !== want) return no(`the run was on ${os}, and the row is ${target}`);
  if (!/^[0-9a-f]{7,40}$/.test(ran!) || !commit.startsWith(ran!)) {
    return no(
      `the run says commit=${ran}, and --commit is ${commit}` +
        (ran === "unknown"
          ? " — a copy with no .git: run it with AIO_TEST_COMMIT=<sha>"
          : ran!.endsWith("+dirty")
          ? " — the tree it ran differed from that commit"
          : ""),
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date!)) {
    return no(`the run's date "${date}" is not a date`);
  }
  return { ok: true, date: date! };
}

/** `windows (native suite)` → its pair, or null for a row this recorder does
 *  not write. Pure. */
export function suiteRow(
  name: string,
): { target: string; env: string } | null {
  const m = /^(\S+) \((.+)\)$/.exec(name.trim());
  return SUITE_ROWS.find((r) => r.target === m?.[1] && r.env === m?.[2]) ??
    null;
}

/** A log as text. PowerShell 5's `>` writes UTF-16 with a byte-order mark —
 *  read as UTF-8 that is a file with no shard line in it. Pure. */
export function decodeLog(bytes: Uint8Array): string {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(bytes)
    .replace(/^﻿/, "");
}

function fail(msg: string): never {
  console.error(`update:proof REFUSED — ${msg}\n  nothing was written.`);
  Deno.exit(1);
}

if (import.meta.main) {
  const arg = (name: string) =>
    Deno.args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const rowName = arg("row") ?? "";
  const row = suiteRow(rowName);
  if (!row) {
    fail(
      `--row="${rowName}" is not a suite row. This records: ${
        SUITE_ROWS.map((r) => `"${r.target} (${r.env})"`).join(", ")
      }. (Every other row is written by its own gate under ` +
        `AIO_PROOF_RECORD=1 — see \`deno task check:proof\`.)`,
    );
  }
  if (!CLAIMS.some((c) => c.target === row.target && c.env === row.env)) {
    fail(`"${rowName}" is not a claim in scripts/proof.ts`);
  }
  const from = arg("from");
  if (!from) fail("--from=<suite.log or the folder holding it> is required");
  let path = from;
  try {
    if (Deno.statSync(path).isDirectory) path = join(path, "suite.log");
  } catch { /* the read below names it */ }
  let bytes: Uint8Array;
  try {
    bytes = Deno.readFileSync(path);
  } catch (e) {
    fail(`cannot read ${path}: ${e instanceof Error ? e.message : e}`);
  }
  const exit = arg("exit");
  if (exit !== undefined && !/^-?\d+$/.test(exit)) {
    fail(`--exit=${exit} is not a number`);
  }
  const log = decodeLog(bytes);
  const v = suiteVerdict(log, exit === undefined ? undefined : Number(exit));
  if (!v.ok) fail(`${path}: ${v.why}`);

  const root = fromFileUrl(new URL("../", import.meta.url));
  const git = (args: string[]) =>
    new Deno.Command("git", {
      args,
      cwd: root,
      stdout: "piped",
      stderr: "null",
    })
      .outputSync();
  const asked = arg("commit");
  if (!asked) {
    fail(
      "--commit=<sha> is required: the commit the other machine's copy was " +
        "made from (this checkout's HEAD may have moved since)",
    );
  }
  const full = git(["rev-parse", `${asked}^{commit}`]);
  if (!full.success) fail(`--commit=${asked} is not a commit in this repo`);
  const sha = new TextDecoder().decode(full.stdout).trim();
  const bound = suiteBinding(log, row.target, sha);
  if (!bound.ok) fail(`${path}: ${bound.why}`);
  const commit = sha.slice(0, 9);
  const tagged = git(["tag", "--contains", commit]).stdout.length > 0;

  const entry: ProofEntry = {
    target: row.target,
    env: row.env,
    commit,
    date: bound.date,
    detail: `${v.files} test files in ${v.shards} shard(s), ${v.seconds}s`,
    how: arg("how") ?? `deno task test there; read from ${basename(path)}`,
    passed: v.passed,
    failed: v.failed,
    ignored: v.ignored,
  };
  console.log(
    `${rowName}: ${v.passed} passed · ${v.failed} failed · ${v.ignored} ` +
      `ignored — ${entry.detail} @${commit} (${entry.date})`,
  );
  if (!tagged) {
    console.log(
      `  note: ${commit} is in no tag yet — the matrix prints this row as ` +
        `STALE until a release tag contains it.`,
    );
  }
  if (Deno.args.includes("--dry-run")) {
    console.log("  --dry-run: not written.");
  } else {
    await writeRow(entry);
    console.log("  recorded in proof-matrix.json — commit it.");
  }
}
