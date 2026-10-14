// The physical-proof matrix: which targets have been proven on REAL hardware,
// when, and at which commit.
//
// The beta gate names things the Linux workstation cannot answer by itself — a
// Windows pass, a macOS pass, a real Android device, the 72-hour soak, an
// off-box remote run (todo.md, "Facts this side cannot change"). "We tested
// Windows" was a memory, and a memory is what the docs-vs-gates work keeps
// finding to be wrong.
//
// So the ledger is WRITTEN BY A RUN, never by hand. A hand-kept matrix is a
// claim; a generated one is evidence. Two writers, and no third:
//
//   • `recordProof` — called by a gated test itself, on success, with the
//     commit it ran against. It writes only when AIO_PROOF_RECORD=1, which
//     `deno task check:release` sets for its gates: a plain `deno task
//     test:build` proves the same thing and leaves this tracked file alone.
//   • `deno task update:proof` (scripts/proof-record.ts) — for a suite that
//     ran on ANOTHER machine (the Windows VM, a Mac, a real Windows laptop):
//     it reads that run's own log, refuses one with a failure in it, and
//     writes the row with the counts it found there.
import { dirname, fromFileUrl, resolve } from "@std/path";

const FILE = resolve(
  fromFileUrl(new URL("../", import.meta.url)),
  "proof-matrix.json",
);

/** One proven run. `detail` is free text the gate chose (a version, a device). */
export type ProofEntry = {
  target: string;
  env: string;
  commit: string;
  date: string;
  detail?: string;
  /** How the row was produced, when a gate did not write it itself (the
   *  recorder's `--how`, or the log it read). */
  how?: string;
  /** The run's own counts, read from its log (`deno task update:proof`). */
  passed?: number;
  failed?: number;
  ignored?: number;
};

/** Every physical claim the beta gate makes, and the gate that can prove it.
 *  An entry here with no proof is the honest state: "not yet run". */
export const CLAIMS: {
  target: string;
  env: string;
  how: string;
  /** Is there a GATE that writes this row on success? `false` means the claim
   *  has no mechanism at all — nobody can prove it without building one, which
   *  is worth seeing beside the ones that merely have not been run yet. */
  auto: boolean;
  /** The `env` of another row of the same target that proves MORE than this
   *  one. While this row is unrecorded it is not "never run": the matrix
   *  points at the row to record instead, and does not count it missing. */
  coveredBy?: string;
}[] = [
  {
    target: "windows",
    env: "wine",
    how: "AIO_PROOF_RECORD=1 AIO_WINE_E2E=1 deno task test:wine",
    auto: true,
  },
  // The suite itself, run ON the other OS — what "tested on Windows and macOS
  // as on Linux" (1.0.19) means, recorded. The run happens on another machine,
  // so no test here can write the row: `deno task update:proof` reads that
  // run's log (scripts/test-shards.ts prints one line per shard and a closing
  // verdict), refuses a run with a failure in it, and writes the counts.
  {
    target: "windows",
    env: "native suite",
    how: "the suite on the Windows 11 VM, then: deno task update:proof -- " +
      '--row="windows (native suite)" --from=<its suite.log> --commit=<sha>',
    auto: true,
  },
  {
    target: "macos",
    env: "native suite",
    how: "the suite on a real Mac, then: deno task update:proof -- " +
      '--row="macos (native suite)" --from=<its suite.log> --commit=<sha>',
    auto: true,
  },
  {
    target: "windows",
    env: "real hardware",
    how: "the suite on a real Windows laptop (not a VM), then: deno task " +
      'update:proof -- --row="windows (real hardware)" ' +
      "--from=<its suite.log> --commit=<sha>",
    auto: true,
  },
  // These two say `lab`, not `real`, because that is what their gate checks:
  // `am lab windows` boots the VM and its viewer and artifact share answer.
  // A row reading "windows (real) ✓" for that would claim an APP had run on
  // Windows — broader than the evidence, which is the one mistake this file
  // exists to prevent. Since the suite runs natively on both, a native-suite
  // row proves everything these do and more (a suite cannot run on a VM that
  // did not boot), so an unrecorded lab row points there instead of printing
  // "never run" at every release.
  {
    target: "windows",
    env: "lab-vm",
    how: "AIO_PROOF_RECORD=1 AIO_VM_LAB=1 deno test -A tests/am-lab.test.ts " +
      "— a real Windows VM boots; its viewer + share answer",
    auto: true,
    coveredBy: "native suite",
  },
  {
    target: "macos",
    env: "lab-vm",
    how: "AIO_PROOF_RECORD=1 AIO_VM_LAB=macos deno test -A " +
      "tests/am-lab.test.ts — a real Mac's artifact share is serving",
    auto: true,
    coveredBy: "native suite",
  },
  {
    target: "windows",
    env: "app-on-real",
    how: "NO GATE — the packaged artifact started the way a user starts it " +
      "(double-click, offline, no console) is checked BY HAND on the Windows " +
      "VM, its DOM read over --cdp. Nothing automates that, so nothing can " +
      "write this row; `windows (native suite)` is the part that is recorded",
    auto: false,
  },
  {
    target: "macos",
    env: "app-on-real",
    how: "NO GATE — the same, by hand on a real Mac (app.log + lsappinfo, no " +
      "screencapture; a killed Gatekeeper-held launch poisons that copy). " +
      "`macos (native suite)` is the part that is recorded",
    auto: false,
  },
  {
    target: "windows",
    env: "exe-doors",
    how:
      "NO GATE — the packaged app's doors (CSP <meta> in the shell, no TCP " +
      "listen socket, the snapshot route off) are asserted by test:hosts on " +
      "the LINUX packaged Electron only. Nothing runs them against the " +
      "Windows exe",
    auto: false,
  },
  {
    target: "soak",
    env: "72h",
    how: "deno task soak:72h",
    auto: true,
  },
  {
    target: "android",
    env: "emulator",
    how: "AIO_PROOF_RECORD=1 deno task test:android (the SDK + an AVD; " +
      "boots it headless)",
    auto: true,
  },
  {
    target: "android",
    env: "device",
    how: "AIO_ANDROID_SERIAL=<serial> AIO_PROOF_RECORD=1 deno task " +
      "test:android (a phone attached over USB, authorised: the serial is " +
      "the one `adb devices` prints)",
    auto: true,
  },
  // The iOS route is the `web` target (a PWA) and the server-served page, on
  // Apple's engine. No iPhone here: this row is WebKit itself (Playwright's
  // build), under iPhone and iPad emulation — the engine, not the device.
  {
    target: "ios route",
    env: "webkit engine",
    how: "AIO_PROOF_RECORD=1 AIO_PLAYWRIGHT_DIR=<a directory with " +
      "node_modules/playwright and its WebKit installed> deno task test:webkit",
    auto: true,
  },
  {
    target: "remote",
    env: "off-box",
    how: "NO GATE — needs a second machine",
    auto: false,
  },
  // The two surfaces a release ships on EVERY time and the matrix never named,
  // so it read as a list of exotica rather than as the physical record. Both
  // already run as release gates; they simply were not writing their row.
  {
    target: "cli",
    env: "binary",
    how: "deno task check:release (its test:build gate) — a compiled " +
      "cli-client talks to a compiled server, both from a foreign cwd",
    auto: true,
  },
  {
    target: "web",
    env: "real-browser",
    how: "deno task check:release (its test gate, with Chromium on the " +
      "machine) — real Chromium: surface → trigger → server state converges",
    auto: true,
  },
];

/** What each target is BUILT from — the paths whose change makes a recorded
 *  row describe older code than the tree ships. A row can be recent, on a
 *  tagged commit, and still be about the build before the one that matters
 *  (the Windows stub was rewritten after the last Windows row). Empty: the
 *  claim is about the whole runtime, and no path list says less than "any
 *  commit" — the 90-day rule is its only clock. A guard test holds every
 *  path to the tree and every claimed target to a line here. */
export const BUILD_PATHS: Record<string, string[]> = {
  windows: [
    "src/build/build-windows-exe.ts",
    "src/build/windows-sfx-stub",
    "src/build/sfx-trailer.ts",
    "src/build/pe-icon.ts",
    "src/build/build-electron.ts",
    "src/electron",
    "run.ps1",
  ],
  macos: [
    "src/build/macos-app.ts",
    "src/build/dmg.ts",
    "src/build/build-electron.ts",
    "src/electron",
  ],
  android: [
    "android-template",
    "src/build/build-android.ts",
    "src/build/android-template.ts",
    "src/build/android-run-options.ts",
  ],
  "ios route": [
    "ios-template",
    "src/build/build-ios.ts",
    "src/build/ios-template.ts",
    "src/build/build-web.ts",
  ],
  cli: [
    "src/build/build-cli.ts",
    "src/build/build-compile.ts",
    "src/server/cli-client.ts",
  ],
  web: [
    "src/browser",
    "src/air",
    "src/build/build-client.ts",
    "src/build/client-bundle.ts",
  ],
  soak: [],
  remote: [],
};

/** The commits after `commit` that changed `paths`, newest first — `sha
 *  date` each. Empty when there are none, no paths, or git cannot say (a row
 *  whose commit is gone is already printed STALE). */
export function changedSince(
  commit: string,
  paths: readonly string[],
  cwd = dirname(FILE),
): string[] {
  if (paths.length === 0) return [];
  try {
    const r = new Deno.Command("git", {
      args: ["log", "--format=%h %cs", `${commit}..HEAD`, "--", ...paths],
      cwd,
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    return r.success
      ? new TextDecoder().decode(r.stdout).split("\n").filter(Boolean)
      : [];
  } catch {
    return []; // aio-ok: no git binary — cannot judge, like commitExists
  }
}

/** The line under a row whose target was changed after it was recorded, or
 *  "" for none. `changed` — {@linkcode changedSince}. Pure. */
export function behindLine(target: string, changed: readonly string[]): string {
  return changed.length === 0
    ? ""
    : `BEHIND: ${changed.length} commit(s) since this row changed what ` +
      `${target} is built from (newest ${
        changed[0]
      }) — the row proves the build before them. Run it again`;
}

async function load(file = FILE): Promise<ProofEntry[]> {
  try {
    return JSON.parse(await Deno.readTextFile(file)) as ProofEntry[];
  } catch {
    return [];
  }
}

/** Put `entry` in the matrix at `file`, replacing the row of the same
 *  target+env. THE one write: both recorders end here. */
export async function writeRow(entry: ProofEntry, file = FILE): Promise<void> {
  const entries = (await load(file)).filter((e) =>
    !(e.target === entry.target && e.env === entry.env)
  );
  entries.push(entry);
  entries.sort((a, b) => (a.target + a.env).localeCompare(b.target + b.env));
  await Deno.writeTextFile(file, JSON.stringify(entries, null, 2) + "\n");
}

/** Does this run RECORD? Only when asked: `AIO_PROOF_RECORD=1`, which
 *  `deno task check:release` sets for its gates. The matrix is a tracked file,
 *  and every `deno task test` on a clean tree with Chromium installed used to
 *  rewrite it — a test run that leaves `git status` dirty, and a row whose
 *  date moved for a run nobody meant as proof. Pure. */
export function recordingAsked(value: string | undefined): boolean {
  return value === "1";
}

async function shortCommit(): Promise<string> {
  try {
    const r = await new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      cwd: dirname(FILE),
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(r.stdout).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** The `git status --porcelain` lines that make a proof row a lie: any change
 *  to the code that ran, tracked or new — except this file itself (a second
 *  gated test in the same run records into it). Pure. */
export function uncommittedChanges(porcelain: string): string[] {
  return porcelain.split("\n").filter((l) =>
    l.trim() !== "" && !l.slice(3).trim().endsWith("proof-matrix.json")
  );
}

async function porcelain(): Promise<string | null> {
  try {
    const r = await new Deno.Command("git", {
      args: ["status", "--porcelain", "--untracked-files=normal"],
      cwd: dirname(FILE),
      stdout: "piped",
      stderr: "null",
    }).output();
    return r.success ? new TextDecoder().decode(r.stdout) : null;
  } catch {
    return null; // aio-ok: no git (a tarball) — commit is "unknown" anyway
  }
}

/** What the tree was at one instant: HEAD, and its uncommitted changes
 *  (`null`: git could not say). */
export type TreeStamp = { head: string; dirty: string[] | null };

/** The tree as it is now. A gate takes one when it STARTS and hands it to
 *  {@linkcode recordProof}: the end alone cannot see a tree that was dirty
 *  and then reverted, or a HEAD that moved during a 72-hour soak. */
export async function treeStamp(): Promise<TreeStamp> {
  const p = await porcelain();
  return {
    head: await shortCommit(),
    dirty: p === null ? null : uncommittedChanges(p),
  };
}

/** Why a row must NOT be written, or null. `end` is the tree at record time,
 *  `start` the gate's stamp from when it began (optional). A tree git cannot
 *  read is refused, unless there is no git at all (`head` "unknown" — a
 *  tarball, whose row the matrix prints as stale). Pure. */
export function proofRefusal(
  end: TreeStamp,
  start?: TreeStamp,
): string | null {
  const stamps = [[end, "now"], [start, "when the gate started"]] as const;
  for (const [t, when] of stamps) {
    if (!t) continue;
    if (t.dirty === null) {
      if (t.head !== "unknown") {
        return `git could not list the tree's changes ${when}`;
      }
    } else if (t.dirty.length > 0) {
      return `the working tree had ${t.dirty.length} uncommitted ` +
        `change(s) ${when} (e.g. ${t.dirty[0]!.slice(3).trim()})`;
    }
  }
  if (start && start.head !== end.head) {
    return `HEAD moved during the run (${start.head} → ${end.head})`;
  }
  return null;
}

/** Record that `target` was proven in `env`. Called BY the gated test, on
 *  success — so the ledger cannot claim a run that did not happen.
 *
 *  Not from a tree with uncommitted changes, nor — given the gate's `start`
 *  stamp ({@linkcode treeStamp}) — one that had them or another HEAD when the
 *  gate began: the row names HEAD, and HEAD is then not the code that ran. A
 *  row that says "proven at <commit>" about other code is the
 *  claim-without-evidence this file exists to end. Said, not silent. */
export async function recordProof(
  target: string,
  env: string,
  detail?: string,
  start?: TreeStamp,
): Promise<void> {
  if (!recordingAsked(Deno.env.get("AIO_PROOF_RECORD"))) {
    console.log(
      `[aio] proof: ${target}/${env} passed — not recorded ` +
        `(\`deno task check:release\` records; AIO_PROOF_RECORD=1 records ` +
        `this run)`,
    );
    return;
  }
  const end = await treeStamp();
  const why = proofRefusal(end, start);
  if (why) {
    console.warn(
      `[aio] proof: ${target}/${env} passed but is NOT recorded — ${why}, ` +
        `so HEAD is not the code that ran. Commit, then run the gate again.`,
    );
    return;
  }
  await writeRow({
    target,
    env,
    commit: end.head,
    date: new Date().toISOString().slice(0, 10),
    detail,
  });
}

function ageDays(iso: string, now = Date.now()): number {
  return Math.floor((now - Date.parse(iso)) / 86_400_000);
}

/** A row older than this is stale. */
export const STALE_DAYS = 90;

/** What one proven row is worth today. Pure — the caller answers whether the
 *  row's commit still exists.
 *
 *  `gone`: the commit the gate ran against is not in this repository any more
 *  (a history rewrite, a squash, a clone without it). The row still says a
 *  gate passed, but nobody can name the code it passed on — which is exactly
 *  the "a memory, not evidence" state this file exists to end, so it prints
 *  as stale, never as ✓, however recent its date. */
export function rowStatus(
  entry: Pick<ProofEntry, "date" | "commit">,
  commitExists: boolean,
  now = Date.now(),
): { state: "ok" | "old" | "gone"; age: number } {
  const age = ageDays(entry.date, now);
  if (!commitExists) return { state: "gone", age };
  return { state: age > STALE_DAYS ? "old" : "ok", age };
}

/** Is `commit` in the TAGGED history of the repo `proof-matrix.json` lives
 *  in — a commit object that some tag contains? Existing is not enough: an
 *  amended draft of a release commit still sits in the object store, on no
 *  ref, and a row naming it printed ✓ for code no release ever shipped. No
 *  git at all counts as unknown and answers true: a tarball checkout cannot
 *  judge, and must not call every row stale for it. */
export function commitExists(commit: string, cwd = dirname(FILE)): boolean {
  try {
    const run = (args: string[]) =>
      new Deno.Command("git", {
        args,
        cwd,
        stdout: "piped",
        stderr: "null",
      }).outputSync();
    const git = (args: string[]) => run(args).success;
    if (!git(["rev-parse", "--git-dir"])) return true;
    if (!git(["cat-file", "-e", `${commit}^{commit}`])) return false;
    const tags = run(["tag", "--contains", commit]);
    return tags.success && tags.stdout.length > 0;
  } catch {
    return true; // aio-ok: no git binary — cannot judge (see above)
  }
}

/** ` 6644 passed · 0 failed · 15 ignored` for a row that carries its run's
 *  counts, "" for one that does not. Pure. */
export function countsOf(e: ProofEntry): string {
  return e.passed === undefined
    ? ""
    : `  ${e.passed} passed · ${e.failed ?? 0} failed · ${
      e.ignored ?? 0
    } ignored`;
}

/** The line for a claim with NO row, and how the summary counts it. Three
 *  different facts that once printed alike: no mechanism exists (`·`, no
 *  gate); a stronger row of the same target stands in (`·`, covered — or, if
 *  that row is unrecorded too, the reader is sent to record THAT one); and
 *  nobody has recorded it (`✗`, with the command that does). Pure —
 *  `isProven(env)` answers for another row of this claim's target. */
export function unrecordedLine(
  c: (typeof CLAIMS)[number],
  isProven: (env: string) => boolean,
): {
  mark: "✗" | "·";
  text: string;
  counts: "missing" | "no-gate" | "covered";
} {
  if (!c.auto) {
    return { mark: "·", text: `no gate        — ${c.how}`, counts: "no-gate" };
  }
  if (c.coveredBy) {
    const by = `${c.target} (${c.coveredBy})`;
    return {
      mark: "·",
      text: isProven(c.coveredBy)
        ? `covered by     — ${by}, which proves more (its own gate: ${c.how})`
        : `not recorded   — record ${by} instead: it proves more, and it is ` +
          `the row that counts (this one's own gate: ${c.how})`,
      counts: "covered",
    };
  }
  return {
    mark: "✗",
    text: `never recorded — to record it: ${c.how}`,
    counts: "missing",
  };
}

if (import.meta.main) {
  const entries = await load();
  const require = Deno.args.includes("--require");
  // Report-only unless asked: `--require-current` also fails on a row that is
  // BEHIND its target's build path (see BUILD_PATHS).
  const requireCurrent = Deno.args.includes("--require-current");
  const behind: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  const noGate: string[] = [];
  const covered: string[] = [];
  /** Is `target (env)` recorded, on a commit that can still be named? */
  const proven = (target: string, env: string): boolean => {
    const e = entries.find((x) => x.target === target && x.env === env);
    return !!e && rowStatus(e, commitExists(e.commit)).state === "ok";
  };

  console.log("\nphysical proof matrix\n");
  for (const c of CLAIMS) {
    const hit = entries.find((e) => e.target === c.target && e.env === c.env);
    const label = `${c.target} (${c.env})`.padEnd(23);
    if (!hit) {
      const line = unrecordedLine(c, (env) => proven(c.target, env));
      console.log(`  ${line.mark} ${label} ${line.text}`);
      if (line.counts === "missing") missing.push(label.trim());
      else if (line.counts === "no-gate") noGate.push(label.trim());
      else covered.push(label.trim());
      continue;
    }
    const { state, age } = rowStatus(hit, commitExists(hit.commit));
    if (state !== "ok") stale.push(label.trim());
    const why = state === "gone"
      ? "  STALE: commit in no tagged history — the proven code cannot be " +
        `named. Run it again on a release commit: ${c.how}.  Was:`
      : state === "old"
      ? `  STALE: ${age}d old. Run it again: ${c.how}.  Was:`
      : "";
    console.log(
      `  ${
        state === "ok" ? "✓" : "!"
      } ${label} ${hit.date} @${hit.commit}${why}${countsOf(hit)}${
        hit.detail ? `  ${hit.detail}` : ""
      }${hit.how ? `  [${hit.how}]` : ""}`,
    );
    const late = state === "ok"
      ? behindLine(
        c.target,
        changedSince(hit.commit, BUILD_PATHS[c.target] ?? []),
      )
      : "";
    if (late) {
      behind.push(label.trim());
      console.log(`      ↳ ${late}: ${c.how}`);
    }
  }
  const provenCount = CLAIMS.length - missing.length - stale.length -
    noGate.length - covered.length;
  console.log(
    `\n  ${provenCount}/${CLAIMS.length} proven` +
      (missing.length ? ` · ${missing.length} never recorded` : "") +
      (stale.length
        ? ` · ${stale.length} stale (older than ${STALE_DAYS}d, or commit gone)`
        : "") +
      (behind.length
        ? ` · ${behind.length} proven BEFORE their target's build last changed`
        : "") +
      (covered.length
        ? ` · ${covered.length} left to the row that covers them`
        : "") +
      (noGate.length ? ` · ${noGate.length} with NO GATE to prove them` : ""),
  );
  console.log(
    "  a run writes its own row on success — this file is evidence, not a claim\n",
  );
  // Only `--require` fails, because a release cut on Linux cannot be blocked by
  // a Mac it does not have. Beta is where --require belongs.
  if (require && (missing.length || stale.length)) Deno.exit(1);
  if (requireCurrent && behind.length) Deno.exit(1);
}
