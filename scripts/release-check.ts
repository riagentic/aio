// The release gate, as ONE command: `deno task check:release`.
//
// `.katana/release.md` has always listed what must pass before a release. It
// listed it in prose, so running it was a human loop — and alpha56 shipped with
// `deno lint` red and `deno publish --dry-run` refusing the package outright,
// because nobody ran the list. (CI ran both and had been red on main since that
// release; a remote result that arrives after the push, and that nobody reads,
// is not a gate.) A kata that cannot be executed decays into a wish.
//
// So: this script IS the kata. Two tiers, because the heavy ones cost ~12
// minutes and there is no reason to spend that on a tree that fails `deno fmt`:
//
//   fast    every static gate + every release SURFACE (version triple,
//           dated CHANGELOG entry, upgrade guide written AND listed)
//   heavy   the real-execution suites (test, onboard, build), the mutation
//           gate, and the check that the suite left nothing running
//
// Every fast gate runs even after one fails — a release report that stops at
// the first problem makes you re-run the whole thing per fix. The heavy tier is
// skipped when the fast tier failed, and only then.
//
//   deno task check:release          # everything (fast, then heavy)
//   deno task check:release --fast   # static gates + surfaces only
import { VERSION } from "../src/server/aio-cli.ts";
import { STAMP_PATH, writeStamp } from "./release-stamp.ts";
import { descendantPids } from "../src/server/single-instance-lock.ts";
import { machineFence } from "./test-shards.ts";

const root = new URL("../", import.meta.url).pathname;
const FAST_ONLY = Deno.args.includes("--fast");

/** One gate's answer. `skipped` marks a gate that did not RUN — it does not
 *  fail the release (only the docker-less lab may skip, and
 *  ci-mirrors-release-check.test.ts holds it to that), but it must never read
 *  like one that passed. */
export type Result = {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
};

/** No gate may run forever. `deno test` has no per-test timeout: one child that
 *  ignores SIGTERM turns the suite into a process that prints "has been running
 *  for over 16m0s" and never stops — measured, once, at 56 minutes, on a
 *  release check nobody was watching. A gate that hangs is a gate that never
 *  reports, so every one carries a ceiling and a hang FAILS, naming the last
 *  line it printed (for `deno test`, that is the test that was running).
 *
 *  Generous on purpose: the ceiling catches a hang, never a slow machine. */
const DEFAULT_CEILING_MIN = 20;
const CEILING_MIN: Record<string, number> = {
  test: 45,
  "test:onboard": 45,
  "test:build": 45,
  "test:electron": 45,
  "test:hosts": 20,
  // 347 ledger rows × two `deno test` runs each, 4 workers: ~36 min measured
  // (187 rows in 20 min on the release cores). Twice that is still a hang.
  "check:mutations": 60,
  "lab (fresh ubuntu)": 45,
};

/** 12 ÷ the fence's usable cores (≥ 1), set once in `main()`. */
let CEILING_SCALE = 1;

/** The tail is all that is ever printed — keep that much, not 250 KB of green. */
function keepTail(buf: string, add: string): string {
  const s = buf + add;
  return s.length > 64_000 ? s.slice(-64_000) : s;
}

/** Where every gate's FULL output goes, one file per gate, streamed as it
 *  arrives (so a gate that hangs and is killed still left its log). The
 *  report keeps a tail; the tail of an 18-minute suite is type-check chatter,
 *  and the test that failed is 12,000 lines up. Gitignored (`.aio/`). */
const GATE_LOG_DIR = `${root}.aio/release-check/`;
function gateLogPath(name: string): string {
  return GATE_LOG_DIR + name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() +
    ".log";
}

/** Every gate runs inside the same CPU fence as the test runner: off the
 *  first cores, niced — the heavy tier (builds, onboarding, mutations) used
 *  to take the whole machine too. See `machineFence` in test-shards.ts. */
let FENCE: string[] = [];

async function run(name: string, cmd: string[]): Promise<Result> {
  const t0 = Date.now();
  const [bin, ...args] = [...FENCE, ...cmd];
  const child = new Deno.Command(bin!, {
    args,
    cwd: root,
    // The gate already runs inside FENCE; a nested runner must not fence again.
    env: { AIO_TEST_FENCED: "1" },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let out = "", err = "";
  const dec = new TextDecoder();
  await Deno.mkdir(GATE_LOG_DIR, { recursive: true });
  const logPath = gateLogPath(name);
  const log = await Deno.open(logPath, {
    write: true,
    create: true,
    truncate: true,
  });
  // The NAMES of the tests that failed, harvested from the stream as it goes
  // by — the one thing a person re-runs the whole gate by hand to learn.
  const failedTests: string[] = [];
  const FAILED_LINE = /^(.*?) \.\.\. .*FAILED/;
  let partial = "";
  const harvest = (t: string) => {
    partial += t;
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const l of lines) {
      const m = FAILED_LINE.exec(l.replace(/\x1b\[[0-9;]*m/g, ""));
      if (m && failedTests.length < 40) failedTests.push(m[1]!.trim());
    }
  };
  const pump = async (
    s: ReadableStream<Uint8Array>,
    sink: (t: string) => void,
  ) => {
    for await (const c of s) {
      const t = dec.decode(c);
      sink(t);
      harvest(t);
      await log.write(c).catch(() => {
        // aio-ok: the log is a convenience beside the report; a full disk
        // must not turn a passing gate into a failing one
      });
    }
  };
  const pumps = Promise.all([
    pump(child.stdout, (t) => out = keepTail(out, t)).catch(() => {}),
    pump(child.stderr, (t) => err = keepTail(err, t)).catch(() => {}),
  ]).finally(() => log.close());
  const failedList = () =>
    failedTests.length
      ? `\n      failed tests (${failedTests.length}):\n      ` +
        failedTests.map((t) => `✗ ${t}`).join("\n      ")
      : "";
  const where = () => `\n      full log: ${logPath.slice(root.length)}`;
  const ceilingMs = Math.round(
    (CEILING_MIN[name] ?? DEFAULT_CEILING_MIN) * CEILING_SCALE * 60_000,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = await Promise.race([
    child.status,
    new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), ceilingMs);
    }),
  ]);
  clearTimeout(timer);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  // WHICH stream says why. `deno test` writes its type-check chatter to stderr
  // and its FAILURES to stdout, so taking stderr's tail (the old rule) printed
  // three identical "Check src/db/db-worker.ts" lines for a suite that had a
  // real failing test in it — a gate that reports nothing is a gate you re-run
  // by hand. Prefer the stream whose tail carries a verdict.
  const VERDICT = /FAILED|failed \(|error:|✗|panicked/i;
  const lastLines = (n: number) => {
    const tail = (t: string) =>
      t.trimEnd().split("\n").filter((l) => l.trim()).slice(-n);
    const eTail = tail(err), oTail = tail(out);
    const pick = eTail.some((l) => VERDICT.test(l))
      ? eTail
      : oTail.some((l) => VERDICT.test(l))
      ? oTail
      : (eTail.length ? eTail : oTail);
    return pick.join("\n      ");
  };
  if (status === "timeout") {
    // Kill the tree, not just the runner: `deno test` spawns real apps, and a
    // survivor holds the ports (and the locks) the next gate needs.
    let kids: number[] = [];
    try {
      kids = await descendantPids(child.pid);
    } catch { /* pgrep missing — the direct child still goes */ }
    try {
      child.kill("SIGKILL");
    } catch { /* raced */ }
    for (const pid of kids.reverse()) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch { /* already gone, or not ours */ }
    }
    await child.status.catch(() => {});
    await pumps;
    return {
      name,
      ok: false,
      detail: `${secs}s — HUNG: no result within ${
        Math.round(ceilingMs / 60_000)
      }m, killed.\n      last output:\n      ${
        lastLines(3)
      }${failedList()}${where()}`,
    };
  }
  await pumps;
  if (status.success) return { name, ok: true, detail: `${secs}s` };
  // The last few lines of a failing gate are the part that says why — and
  // for a test gate, the NAMES, which the tail never carries.
  return {
    name,
    ok: false,
    detail: `${secs}s\n      ${lastLines(8)}${failedList()}${where()}`,
  };
}

/** A release SURFACE — the checks no command covers, which is exactly why they
 *  are the ones that rot (a version left behind in one of three files, an
 *  upgrade guide written but never linked). */
function surface(name: string, ok: boolean, detail: string): Result {
  return { name, ok, detail };
}

async function surfaceChecks(): Promise<Result[]> {
  const read = (rel: string) => Deno.readTextFile(root + rel);
  const denoJson = JSON.parse(await read("deno.json")) as { version: string };
  const readme = await read("README.md");
  const changelog = await read("CHANGELOG.md");

  const out: Result[] = [];

  // One version, three places. Any one left behind ships a binary that lies
  // about itself.
  const badge = readme.includes(`<code>v${VERSION}</code>`);
  const sameVersion = denoJson.version === VERSION && badge;
  out.push(surface(
    "version triple (deno.json = VERSION = README badge)",
    sameVersion,
    sameVersion
      ? VERSION
      : `deno.json=${denoJson.version} VERSION=${VERSION} ` +
        `README badge ${badge ? "ok" : `missing v${VERSION}`}`,
  ));

  // A dated entry for THIS version — the version the tree currently IS.
  //
  // Deliberately not "the top entry is dated": between releases the top entry
  // is the NEXT version, marked (unreleased), and that is the healthy state for
  // most of a release cycle. A check that went red for all of it would be noise
  // within a day, and a gate people learn to ignore is worse than no gate. So
  // the rule is: wherever this version's entry sits, it carries a date.
  const heading =
    changelog.split("\n").find((l) =>
      l.startsWith("## ") && l.includes(VERSION)
    ) ?? "";
  const dated = /\(\d{4}-\d{2}-\d{2}\)/.test(heading);
  const top = changelog.split("\n").find((l) => l.startsWith("## ")) ?? "";
  const pending = top !== heading ? ` · in progress above: ${top.trim()}` : "";
  out.push(surface(
    "CHANGELOG has a dated entry for this version",
    dated,
    dated
      ? `${heading.trim()}${pending}`
      : heading
      ? `found but undated: ${heading.trim()}`
      : `no "## …${VERSION}…" entry at all (top is: ${top.trim() || "(none)"})`,
  ));

  // The upgrade guide has to exist AND be reachable. Written-but-unlinked is
  // the failure mode: it looks done in the diff and is invisible to a reader.
  // Two spellings of "this version" in a guide name: the alpha habit elided
  // the `1.0.0-` (`from-alpha76-to-alpha77.md`); from the beta line on the
  // guide carries the full triple (`from-alpha77-to-1.0.0-beta.md`,
  // `from-1.0.0-beta-to-1.0.1-beta.md`), because `-to-beta.md` would name
  // every beta at once.
  const cur = VERSION.replace(/^1\.0\.0-/, "");
  const guides = [...Deno.readDirSync(root + "docs/upgrade")]
    .map((e) => e.name)
    .filter((n) =>
      n.endsWith(`-to-${cur}.md`) || n.endsWith(`-to-${VERSION}.md`)
    );
  const index = await read("docs/upgrade/README.md");
  const linked = guides.some((g) => index.includes(g));
  out.push(surface(
    "upgrade guide exists and is listed",
    guides.length > 0 && linked,
    guides.length === 0
      ? `no docs/upgrade/*-to-${VERSION}.md (or *-to-${cur}.md)`
      : linked
      ? guides.join(", ")
      : `${guides[0]} exists but is not listed in docs/upgrade/README.md`,
  ));

  return out;
}

const FAST: [string, string[]][] = [
  ["fmt", ["deno", "fmt", "--check"]],
  ["check", ["deno", "task", "check"]],
  ["lint", ["deno", "task", "lint"]],
  ["lint:aio", ["deno", "task", "lint:aio"]],
  ["check:boundaries", ["deno", "task", "check:boundaries"]],
  ["check:silent-catch", ["deno", "task", "check:silent-catch"]],
  // The other half of what `check:orphans` measures: that gate counts the
  // directories left on disk AFTER the suite, this one refuses the new call
  // that would leave one. Counting a leak nobody can stop creating is a gate
  // that only ever rises.
  ["check:tempdirs", ["deno", "task", "check:tempdirs"]],
  ["check:placeholders", ["deno", "task", "check:placeholders"]],
  ["check:gated-tests", ["deno", "task", "check:gated-tests"]],
  ["check:lock", ["deno", "task", "check:lock"]],
  ["check:home-clean", ["deno", "task", "check:home-clean"]],
  ["check:vacuous", ["deno", "task", "check:vacuous"]],
  ["check:dead-wiring", ["deno", "task", "check:dead-wiring"]],
  ["check:log-prefix", ["deno", "task", "check:log-prefix"]],
  ["check:api", ["deno", "task", "check:api"]],
  ["check:docs", ["deno", "task", "check:docs"]],
  ["check:env", ["deno", "task", "check:env"]],
  ["update:docs (no diff)", ["deno", "task", "update:docs", "--", "--check"]],
  ["check:doc-coverage", ["deno", "task", "check:doc-coverage"]],
  // docs/basics/every-option.md — generated from the source; stale, or an
  // option with no one-line doc, or one more entry without an example, is red.
  ["update:reference (no diff)", [
    "deno",
    "task",
    "update:reference",
    "--",
    "--check",
  ]],
  ["check:sanitizers", ["deno", "task", "check:sanitizers"]],
  // The randomized rounds. FAST because they are seconds, not minutes, and
  // because what they catch is a class the other gates cannot see: every gate
  // above asks whether the code matches a decision someone wrote down. These
  // ask what happens on an input nobody chose. Nine defects in their first run
  // — a duplicated Accept-Encoding token that got a body the client had said
  // it could not read, an `allowedOrigins` entry that made every response a
  // 500, `aria-controls` naming an element that is not there.
  ["check:audit", ["deno", "task", "check:audit"]],
  // The size a page actually downloads, and whether the docs still say it.
  ["check:bundle-size", ["deno", "task", "check:bundle-size"]],
  ["publish --dry-run", ["deno", "publish", "--dry-run", "--allow-dirty"]],
];

const HEAVY: [string, string[]][] = [
  ["test", ["deno", "task", "test"]],
  // Straight after the suite, because that is the only moment the answer means
  // anything: an aio process still serving here was started by a test that did
  // not clean up after itself. A field report measured a `--expose` server on
  // 0.0.0.0 left running for 5.5 hours by a hung test — a ghost in
  // `am discover`, invisible to `am instances`. The script existed and no gate
  // ran it, so nothing ever noticed. It names the process and its lock, so a
  // failure here is readable even when the culprit is something else you have
  // running on this machine.
  ["check:orphans", ["deno", "task", "check:orphans"]],
  // Report-only: the physical proof matrix cannot BLOCK a release cut on Linux
  // (a Mac it does not have would fail it), but a release that never prints it
  // is a release nobody checked it against. `.katana/beta.md` requires every
  // row to be proven or waiting on hardware/time; `--require` is beta's job.
  ["check:proof", ["deno", "task", "check:proof"]],
  // ~36 min at 347 rows: breaks each load-bearing invariant on purpose and
  // requires its named test to go red — `deno test` twice per entry.
  ["check:mutations", ["deno", "task", "check:mutations"]],
  // ~20 s: N overlapping server renders on a seeded schedule (FUZZ_SEED
  // replays a failure), a third aborted mid-stream, plus the real Deno.serve
  // path with clients that leave mid-body. Every response must equal its solo
  // render and carry only its own head; every server render reaches `finally`.
  ["test:ssr-soak", ["deno", "task", "test:ssr-soak"]],
  // Seeded HLC / cursor / offline-replay / compaction properties over the
  // real engine and a real SQLite op-log, plus every sync regression file.
  ["test:sync", ["deno", "task", "test:sync"]],
  ["test:onboard", ["deno", "task", "test:onboard"]],
  ["test:build", ["deno", "task", "test:build"]],
  // The Electron package is a release surface (`docs/build/targets.md` says
  // it builds), and both e2e tests that prove it are behind a second opt-in
  // that no task set — so `check:release` claimed the AppImage and never built
  // one. It fetches the runtime once (~/.cache/aio/tools) and packages a real
  // image; the cost is minutes on the first run and seconds after.
  ["test:electron", ["deno", "task", "test:electron"]],
  // One app, every runtime (server, standalone ×2, packaged Electron from a
  // foreign cwd): `persist: "none"` never on disk and never restored, the
  // last write survives shutdown, and the packaged doors hold on the ARTIFACT.
  // After test:electron, which has already fetched the Electron runtime.
  // Two data bugs were live in 1.0.9 when this lane first ran.
  ["test:hosts", ["deno", "task", "test:hosts"]],
];

/** Is there a container runtime for the onboarding lab?
 *
 *  The lab is the ONLY gate that runs on a machine which is not this one, and
 *  that is exactly what the other onboarding tests cannot do: they run here,
 *  where deno is current and the framework is already checked out, so they
 *  stayed green for months while the published one-liner failed on a fresh
 *  Ubuntu (it needed `unzip`, which that image does not have).
 *
 *  When no runtime is installed the gate is REPORTED as skipped rather than
 *  silently dropped — a release that never ran it should say so out loud. */
function labRuntime(): string | null {
  for (const bin of ["docker", "podman"]) {
    try {
      const out = new Deno.Command(bin, {
        args: ["version", "--format", "{{.Server.Version}}"],
        stdout: "null",
        stderr: "null",
      }).outputSync();
      if (out.success) return bin;
    } catch { /* not installed */ }
  }
  return null;
}

/** The onboarding lab's gate name — the one gate allowed to skip. */
const LAB = "lab (fresh ubuntu)";

/** One report line. A SKIPPED gate is `⚠`, never `✓`: the lab skipped for
 *  want of docker printed the same tick as a lab that passed, so a release
 *  that never tested onboarding on a stranger's machine looked like one that
 *  had. Pure. */
export function resultLine(r: Result): string {
  const mark = r.skipped ? "⚠" : r.ok ? "✓" : "✗";
  return `  ${mark} ${r.name.padEnd(38)} ${r.detail}`;
}

/** The last line of a passing run. What was SKIPPED is named in it — the one
 *  line a person reads — so "releasable" never stands alone beside a gate that
 *  did not run. Pure. */
export function verdictLine(fastOnly: boolean, results: Result[]): string {
  if (fastOnly) {
    return "\n✓ fast gates + surfaces pass — run without --fast before pushing\n";
  }
  const lab = results.some((r) => r.skipped && r.name === LAB)
    ? " (lab SKIPPED — no docker/podman)"
    : "";
  return "\n✓ releasable" + lab + " — every gate and surface in " +
    ".katana/release.md passes; `deno task check:release-stamp` confirms " +
    "the tree before you tag\n";
}

function report(results: Result[]): void {
  for (const r of results) console.log(resultLine(r));
}

/** The run itself. Behind `import.meta.main` so the pure report helpers above
 *  can be imported by a test without running every gate. */
async function main(): Promise<void> {
  const fence = await machineFence();
  FENCE = fence.prefix;
  // The ceilings are measured on the 12-core fence; a narrower one is slower
  // in proportion, and a ceiling must never read a slow machine as a hang.
  CEILING_SCALE = Math.max(1, 12 / fence.usable);
  console.log(`\nrelease check — v${VERSION}\n`);
  console.log("surfaces");
  // The physical matrix is PRINTED at every release, never enforced here: a cut
  // made on Linux cannot be blocked by a Mac this machine does not have. What it
  // must not do is stay invisible — the beta gate names five things only real
  // hardware can answer, and before this they were tracked by memory. Seeing
  // "0/6 proven" beside a green release is the point.
  await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${root}scripts/proof.ts`],
    stdout: "inherit",
    stderr: "inherit",
  }).output();

  const surfaces = await surfaceChecks();
  report(surfaces);

  console.log("\ngates (fast)");
  const fast: Result[] = [];
  for (const [name, cmd] of FAST) fast.push(await run(name, cmd));
  report(fast);

  const failedEarly = [...surfaces, ...fast].filter((r) => !r.ok);
  let heavy: Result[] = [];
  if (FAST_ONLY) {
    console.log("\ngates (heavy)  — skipped (--fast)");
  } else if (failedEarly.length > 0) {
    console.log(
      `\ngates (heavy)  — skipped: fix the ${failedEarly.length} failure(s) ` +
        `above first (they cost seconds, these cost ~12 minutes)`,
    );
  } else {
    console.log("\ngates (heavy)");
    for (const [name, cmd] of HEAVY) heavy.push(await run(name, cmd));
    // The lab last: it is the slowest, and everything above has to hold before
    // "does a stranger's machine survive this?" is even a meaningful question.
    const runtime = labRuntime();
    if (runtime) {
      heavy.push(
        await run("lab (fresh ubuntu)", [
          "deno",
          "task",
          "lab",
          "--scenario=install,create-dev,run-sh",
        ]),
      );
    } else {
      heavy.push({
        name: "lab (fresh ubuntu)",
        ok: true,
        detail:
          "SKIPPED — no docker/podman on this machine. The one gate that " +
          "tests onboarding on a machine that is not this one did not run.",
        skipped: true,
      });
    }
    report(heavy);
  }

  const failed = [...surfaces, ...fast, ...heavy].filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(
      `\n✗ NOT releasable — ${failed.length} failing: ${
        failed.map((f) => f.name).join(", ")
      }\n`,
    );
    Deno.exit(1);
  }
  if (!FAST_ONLY) {
    // The stamp: the one thing that turns "every gate passed" from a sentence
    // in a release note into a fact about THIS tree. `deno task check:release-stamp`
    // reads it back before a tag is cut; an edit after this line invalidates it.
    const stamp = await writeStamp(VERSION, root);
    console.log(
      `  ✓ release stamp                          tree ${
        stamp.tree.slice(0, 12)
      } (${STAMP_PATH})`,
    );
  }
  console.log(verdictLine(FAST_ONLY, [...surfaces, ...fast, ...heavy]));
}

if (import.meta.main) await main();
