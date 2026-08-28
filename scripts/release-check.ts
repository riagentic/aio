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

const root = new URL("../", import.meta.url).pathname;
const FAST_ONLY = Deno.args.includes("--fast");

type Result = { name: string; ok: boolean; detail: string };

async function run(name: string, cmd: string[]): Promise<Result> {
  const t0 = Date.now();
  const p = await new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (p.success) return { name, ok: true, detail: `${secs}s` };
  // The last few lines of a failing gate are the part that says why.
  const text = new TextDecoder().decode(
    p.stderr.length > 0 ? p.stderr : p.stdout,
  );
  const tail = text.trimEnd().split("\n").slice(-4).join("\n      ");
  return { name, ok: false, detail: `${secs}s\n      ${tail}` };
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
  const cur = VERSION.replace(/^1\.0\.0-/, "");
  const guides = [...Deno.readDirSync(root + "docs/upgrade")]
    .map((e) => e.name)
    .filter((n) => n.endsWith(`-to-${cur}.md`));
  const index = await read("docs/upgrade/README.md");
  const linked = guides.some((g) => index.includes(g));
  out.push(surface(
    "upgrade guide exists and is listed",
    guides.length > 0 && linked,
    guides.length === 0
      ? `no docs/upgrade/*-to-${cur}.md`
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
  ["check:vacuous", ["deno", "task", "check:vacuous"]],
  ["check:dead-wiring", ["deno", "task", "check:dead-wiring"]],
  ["check:log-prefix", ["deno", "task", "check:log-prefix"]],
  ["check:api", ["deno", "task", "check:api"]],
  ["check:docs", ["deno", "task", "check:docs"]],
  ["update:docs (no diff)", ["deno", "task", "update:docs", "--", "--check"]],
  ["check:doc-coverage", ["deno", "task", "check:doc-coverage"]],
  ["check:sanitizers", ["deno", "task", "check:sanitizers"]],
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
  // ~30 s: breaks each load-bearing invariant on purpose and requires its
  // named test to go red. Heavy because it runs `deno test` twice per entry,
  // not because it is slow to fail.
  ["check:mutations", ["deno", "task", "check:mutations"]],
  ["test:onboard", ["deno", "task", "test:onboard"]],
  ["test:build", ["deno", "task", "test:build"]],
  // The Electron package is a release surface (`docs/build/targets.md` says
  // it builds), and both e2e tests that prove it are behind a second opt-in
  // that no task set — so `check:release` claimed the AppImage and never built
  // one. It fetches the runtime once (~/.cache/aio/tools) and packages a real
  // image; the cost is minutes on the first run and seconds after.
  ["test:electron", ["deno", "task", "test:electron"]],
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

function report(results: Result[]): void {
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(38)} ${r.detail}`);
  }
}

console.log(`\nrelease check — v${VERSION}\n`);
console.log("surfaces");
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
      detail: "SKIPPED — no docker/podman on this machine. The one gate that " +
        "tests onboarding on a machine that is not this one did not run.",
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
console.log(
  FAST_ONLY
    ? "\n✓ fast gates + surfaces pass — run without --fast before pushing\n"
    : "\n✓ releasable — every gate and surface in .katana/release.md passes\n",
);
