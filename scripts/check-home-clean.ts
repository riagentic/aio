// check:home-clean — the test suite may not write into the developer's HOME.
//
// `_armTestStrict` has sandboxed app directories since alpha70, with the right
// reasoning written next to it ("a harness must not be able to write into the
// user's home — not by design, and not by accident"). It arms on the first
// HARNESS use, which is the hole: a test that scaffolds an app and SPAWNS it
// never touches the harness, and a spawned app resolves its home to
// `~/.<appId>` unless something pins `AIO_APPS_DIR`.
//
// The suite's own task pins it. Running one file — `deno test -A tests/x.test.ts`,
// which is how CLAUDE.md tells you to run one — does not. So every e2e app,
// every scaffolded fixture and every version probe left a directory behind,
// each with a fresh random id so nothing ever collided and nothing was ever
// noticed. 169 of them had accumulated: 107 `.e2e-*`, 51 `.app-*`, 15
// `.ver-probe-*`.
//
// This looks for the shapes those tests produce. It never deletes anything —
// it names what is there and the one command that removes it, because a gate
// that tidies the user's home is a worse idea than the mess.
//
// It also guards the per-user STORES a test can reach through code aio owns —
// above all the framework version store, `~/.local/lib/aio-versions`, which
// every pinned app on the machine runs. MEASURED 2026-09-24: a test wrote a
// mid-development snapshot there under the real release name
// (`v1.0.11-beta`, its `.git` pointing into tests/am-version-pin.test.ts's
// sandbox); two real apps ran it for hours and `am pin` would not replace it.
// Two checks, because one of them needs a baseline:
//
//   - standalone: a store entry whose worktree `.git` points into a TEST root
//     (`~/tmp/aio/…`, `$AIO_TEST_ROOT`, `.aio-test-*`) is a test's, by
//     construction — that is the exact fingerprint of the 10:39 write.
//   - around a run: `--save=<file>` before and `--against=<file>` after (the
//     shard runner does the same in-process) — ANY entry added, changed or
//     removed in a real store fails, named.
//
// Usage: deno run --allow-read --allow-env scripts/check-home-clean.ts
//          [--save=<file> (needs --allow-write) | --against=<file>]
import { join } from "@std/path";

type Env = Record<string, string | undefined>;

/** A real store's entries: `<dir>/<name>` → {@link entryStamp} (ms). */
export type StoreSnapshot = Record<string, number>;

/** The REAL per-user store directories a test run must not change: the
 *  framework version store (the user's own `AIO_VERSIONS_DIR` when they set
 *  one, and the default) and the canonical install's worktree registry (where
 *  `git worktree add` records each provisioned version). Pure. */
export function realStoreDirs(env: Env): string[] {
  const home = env.HOME ?? env.USERPROFILE;
  const dirs = [
    env.AIO_VERSIONS_DIR,
    home ? join(home, ".local", "lib", "aio-versions") : undefined,
    env.AIO_HOME ? join(env.AIO_HOME, ".git", "worktrees") : undefined,
    home ? join(home, ".local", "lib", "aio", ".git", "worktrees") : undefined,
  ];
  return [...new Set(dirs.filter((d): d is string => !!d))];
}

/** What says an entry was (re)MADE: a marker file's own mtime; for a
 *  worktree, its link — `<v>/.git` in the store, `<name>/gitdir` in the
 *  install's registry — which only `git worktree add`/`repair` write.
 *
 *  Not the directory's mtime. MEASURED: a real app running from its pinned
 *  store rewrote `<v>/deno.lock` (atomic rename → new dir mtime) in the middle
 *  of a suite run, and every `git status` in a worktree renames its index in
 *  the registry — a gate that fails on the user's own apps working is noise,
 *  and noise gets ignored. -1: the entry vanished between readDir and here. */
function entryStamp(p: string): number {
  for (const f of [join(p, ".git"), join(p, "gitdir")]) {
    try {
      return Deno.lstatSync(f).mtime?.getTime() ?? 0;
    } catch { /* aio-ok: not this kind of entry — try the next */ }
  }
  try {
    const st = Deno.lstatSync(p);
    return st.isDirectory ? 0 : st.mtime?.getTime() ?? 0;
  } catch {
    return -1; // aio-ok: gone mid-scan — the next snapshot reports it removed
  }
}

/** Every entry of `dirs`, with its stamp ({@link entryStamp}). A missing dir has no entries. */
export function snapshotStores(dirs: string[]): StoreSnapshot {
  const snap: StoreSnapshot = {};
  for (const dir of dirs) {
    let names: string[];
    try {
      names = [...Deno.readDirSync(dir)].map((e) => e.name);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      throw e; // unreadable is not "empty" — the gate cannot vouch for it
    }
    for (const n of names) snap[join(dir, n)] = entryStamp(join(dir, n));
  }
  return snap;
}

/** What changed between two snapshots, one line per entry. Pure. */
export function storeChanges(
  before: StoreSnapshot,
  after: StoreSnapshot,
): string[] {
  const out: string[] = [];
  for (const [p, m] of Object.entries(after)) {
    if (!(p in before)) out.push(`added    ${p}`);
    else if (before[p] !== m) out.push(`changed  ${p}`);
  }
  for (const p of Object.keys(before)) {
    if (!(p in after)) out.push(`removed  ${p}`);
  }
  return out.sort();
}

/** Is `gitdir` inside a directory only a TEST makes? Pure. */
export function isTestGitdir(gitdir: string, env: Env): boolean {
  const home = (env.HOME ?? env.USERPROFILE ?? "").replace(/[/\\]+$/, "");
  const roots = [
    home ? `${home}/tmp/aio/` : undefined,
    env.AIO_TEST_ROOT ? env.AIO_TEST_ROOT.replace(/[/\\]+$/, "") + "/" : "",
  ].filter((r): r is string => !!r);
  return roots.some((r) => gitdir.startsWith(r)) ||
    /[/\\]\.aio-test-[^/\\]*[/\\]/.test(gitdir);
}

/** Version-store entries whose worktree `.git` points into a test root —
 *  `"<entry> → <gitdir>"`. */
export function testMadeVersions(storeDir: string, env: Env): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = [...Deno.readDirSync(storeDir)].map((e) => e.name);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return out;
    throw e;
  }
  for (const n of names.sort()) {
    let text: string;
    try {
      text = Deno.readTextFileSync(join(storeDir, n, ".git"));
    } catch {
      continue; // aio-ok: not a worktree (a marker file, a plain dir)
    }
    const gitdir = text.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    if (gitdir && isTestGitdir(gitdir, env)) {
      out.push(`${join(storeDir, n)} → ${gitdir}`);
    }
  }
  return out;
}

/** The appId shapes this repo's tests generate. Anchored, so a real app called
 *  `apple` or a user's own `~/.appointments` is never matched. */
const TEST_SHAPES: RegExp[] = [
  /^\.app-[0-9a-f]{8}$/, // e2e-app-harness makeApp()
  /^\.e2e-[0-9a-f]{8}$/, // e2e-harness scaffoldApp()
  /^\.ver-probe-[0-9a-f]{8}$/, // app-version-identity
  /^\.aio-test-apps-/, // an older sandbox prefix
  /^\.[a-z0-9-]*-e2e$/, // cell-worker-e2e, worker-parity-e2e, dev-restart-e2e
  /^\.e2e-probe$/,
];

export function isTestStray(name: string): boolean {
  return TEST_SHAPES.some((re) => re.test(name));
}

export function straysIn(names: string[]): string[] {
  return names.filter(isTestStray).sort();
}

/** The store checks. Exit code: 0 clean, 1 dirty. */
function checkStores(): number {
  const env = Deno.env.toObject();
  const dirs = realStoreDirs(env);
  const save = Deno.args.find((a) => a.startsWith("--save="))?.slice(7);
  const against = Deno.args.find((a) => a.startsWith("--against="))?.slice(10);
  if (save) {
    // A baseline only: what is ALREADY there is not this run's doing, and the
    // standalone checks report it on their own.
    Deno.writeTextFileSync(save, JSON.stringify(snapshotStores(dirs)));
    console.log(`✓ home-clean: store snapshot saved (${dirs.length} dirs)`);
    Deno.exit(0);
  }
  if (against) {
    const before = JSON.parse(Deno.readTextFileSync(against)) as StoreSnapshot;
    const changes = storeChanges(before, snapshotStores(dirs));
    if (changes.length > 0) {
      console.error(
        `✗ the run changed a REAL per-user store:\n  ${
          changes.join("\n  ")
        }\n  A test resolved AIO_VERSIONS_DIR/AIO_HOME without the sandbox.`,
      );
    } else console.log(`✓ home-clean: real stores unchanged by the run`);
    // The run's verdict only — what was there before is the standalone
    // gate's to report, not a reason to fail the run that did not make it.
    Deno.exit(changes.length > 0 ? 1 : 0);
  }
  const versionStores = dirs.filter((d) => !d.endsWith("worktrees"));
  const planted = versionStores.flatMap((d) => testMadeVersions(d, env));
  if (planted.length > 0) {
    console.error(
      `✗ ${planted.length} entr${planted.length === 1 ? "y" : "ies"} in a ` +
        `REAL framework version store came from a TEST — its worktree points ` +
        `into a test sandbox:\n\n  ${planted.join("\n  ")}\n\n` +
        `  Every app pinned to that version runs this checkout, and \`am pin\`\n` +
        `  will not replace a provisioned version. Remove the entry (and its\n` +
        `  \`.provisioned\` marker) by hand, then \`am fix\` each app pinned to it.`,
    );
  }
  return planted.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  const storesBad = checkStores();
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    console.log("✓ home-clean: no HOME to check");
    Deno.exit(storesBad);
  }
  const names: string[] = [];
  try {
    for (const e of Deno.readDirSync(home)) names.push(e.name);
  } catch (e) {
    console.error(
      `✗ home-clean: cannot read ${home} (${
        e instanceof Error ? e.message : e
      })`,
    );
    Deno.exit(1);
  }
  const strays = straysIn(names);
  if (strays.length > 0) {
    console.error(
      `✗ ${strays.length} test artefact(s) in ${home} — a test wrote an app ` +
        `home outside its sandbox:\n`,
    );
    for (const s of strays.slice(0, 12)) console.error(`  ${join(home, s)}`);
    if (strays.length > 12) {
      console.error(`  … and ${strays.length - 12} more`);
    }
    console.error(
      `\n  cause: a spawned app resolves its home as \`~/.<appId>\` unless\n` +
        `  AIO_APPS_DIR is set. Pin it in the child's env — \`childEnv()\` in\n` +
        `  tests/e2e-app-harness.ts is where every spawned test app gets it.\n` +
        `\n  These are yours to remove, not this gate's:\n` +
        `      ls -d ~/.app-* ~/.e2e-* ~/.ver-probe-* ~/.*-e2e 2>/dev/null\n` +
        `      # review the list, then delete it`,
    );
    Deno.exit(1);
  }
  console.log(`✓ home-clean: no test artefacts in ${home}`);
  Deno.exit(storesBad);
}
