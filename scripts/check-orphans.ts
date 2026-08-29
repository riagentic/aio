// Nothing outlives the run.
//
// A test that hangs and is then killed by an outer `timeout` never reaches its
// `finally`, and the aio app it spawned is reparented to init — holding its
// port, its lock, and (exposed) a LAN-visible listener. One ran for 5 h on a
// developer machine, answering `am discover` as a ghost, invisible to
// `am instances` because its lock sat in a per-`AIO_APPS_DIR` lock dir.
//
// This is the gate: every `aio*` lock dir under $XDG_RUNTIME_DIR and /tmp is
// scanned, and a live lock in a SCOPED dir (anything but the shared `…/aio`)
// is an app a test started and did not stop — red, with pid and command line.
// A lock whose owner still has a living `AIO_PARENT_PID` is skipped: another
// suite on this machine is mid-run, and its apps are its business.
//
//   deno task check:orphans          report (exit 1 if any)
//   deno task clean:tmp              also SIGTERM them, remove ownerless
//                                    /tmp/aio-* dirs, stale lock dirs and
//                                    stale watcher sentinels
import { join } from "@std/path";

const clean = Deno.args.includes("--clean");
const dec = new TextDecoder();

function alive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Deno.errors.PermissionDenied;
  }
}

/** /proc only — elsewhere the answer is "unknown", which counts as orphan. */
function envOf(pid: number): Record<string, string> | null {
  try {
    const raw = Deno.readFileSync(`/proc/${pid}/environ`);
    const out: Record<string, string> = {};
    for (const kv of dec.decode(raw).split("\0")) {
      const i = kv.indexOf("=");
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return out;
  } catch {
    return null;
  }
}
function cmdlineOf(pid: number): string {
  try {
    return dec.decode(Deno.readFileSync(`/proc/${pid}/cmdline`))
      .split("\0").filter(Boolean).join(" ");
  } catch {
    return "?";
  }
}

function lockRoots(): string[] {
  const roots = new Set<string>();
  const xdg = Deno.env.get("XDG_RUNTIME_DIR");
  if (xdg) roots.add(xdg);
  roots.add(
    Deno.build.os === "windows" ? (Deno.env.get("TEMP") ?? "") : "/tmp",
  );
  return [...roots].filter(Boolean);
}

type Orphan = { pid: number; appId: string; port: number; dir: string };
const orphans: Orphan[] = [];
const staleDirs: string[] = [];

for (const root of lockRoots()) {
  let entries: Deno.DirEntry[] = [];
  try {
    entries = [...Deno.readDirSync(root)];
  } catch {
    continue;
  }
  for (const e of entries) {
    if (!e.isDirectory || !e.name.startsWith("aio")) continue;
    const dir = join(root, e.name);
    const scoped = e.name !== "aio";
    let live = 0;
    let files: Deno.DirEntry[] = [];
    try {
      files = [...Deno.readDirSync(dir)];
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile) continue;
      const path = join(dir, f.name);
      if (f.name.endsWith(".lock")) {
        let lock: { pid?: number; appId?: string; port?: number } | null = null;
        try {
          lock = JSON.parse(Deno.readTextFileSync(path));
        } catch { /* corrupt — stale */ }
        const pid = lock?.pid ?? 0;
        if (pid > 0 && alive(pid)) {
          live++;
          if (!scoped) continue; // the machine's real apps
          const parent = Number(envOf(pid)?.AIO_PARENT_PID ?? "");
          if (parent > 0 && alive(parent)) continue; // another suite, mid-run
          // A lock whose "owner" is a test RUNNER (or this very process) is a
          // fixture a test wrote with its own pid, not an app — the am
          // stop-all tests do exactly that, and a suite running right now
          // must not read as seven orphans.
          if (pid === Deno.pid || /\bdeno(\S*)? test\b/.test(cmdlineOf(pid))) {
            continue;
          }
          orphans.push({
            pid,
            appId: lock?.appId ?? f.name,
            port: lock?.port ?? 0,
            dir,
          });
        } else if (clean) {
          Deno.removeSync(path);
        }
      } else if (f.name.startsWith("watch-") && f.name.endsWith(".tmp")) {
        // A watcher sentinel whose process is gone is a hard-killed app. The
        // name carries the PID of the process that wrote it.
        const pid = Number(f.name.slice(6, -4));
        if (pid > 0 && alive(pid)) live++;
        else if (clean) Deno.removeSync(path);
      }
    }
    if (scoped && live === 0) staleDirs.push(dir);
  }
}

// Ownerless temp homes: /tmp/aio-* that no live process refers to — by cwd,
// by an env var (AIO_APPS_DIR, DENO_COVERAGE_DIR), or on its command line —
// AND that nothing has touched for a while. A suite that is running right now
// owns its temp dirs through exactly those three, and a dir modified minutes
// ago is in use by something even if we cannot see by whom. Never delete what
// is not clearly abandoned: this script runs with write permission.
const RECENT_MS = 10 * 60_000;
const liveRefs: string[] = [];
try {
  for (const p of Deno.readDirSync("/proc")) {
    const pid = Number(p.name);
    if (!(pid > 0)) continue;
    try {
      liveRefs.push(Deno.readLinkSync(`/proc/${pid}/cwd`));
    } catch { /* not ours */ }
    try {
      liveRefs.push(dec.decode(Deno.readFileSync(`/proc/${pid}/environ`)));
      liveRefs.push(dec.decode(Deno.readFileSync(`/proc/${pid}/cmdline`)));
    } catch { /* not ours */ }
  }
} catch { /* no /proc */ }
const tmpDirs: string[] = [];
try {
  for (const e of Deno.readDirSync("/tmp")) {
    if (!e.isDirectory || !e.name.startsWith("aio-")) continue;
    const dir = join("/tmp", e.name);
    if (liveRefs.some((r) => r.includes(dir))) continue;
    let mtime = 0;
    try {
      mtime = Deno.statSync(dir).mtime?.getTime() ?? 0;
    } catch {
      continue;
    }
    if (Date.now() - mtime < RECENT_MS) continue;
    tmpDirs.push(dir);
  }
} catch { /* no /tmp */ }

for (const o of orphans) {
  console.error(
    `ORPHAN  pid ${o.pid}  ${o.appId}${o.port ? ` :${o.port}` : ""}\n` +
      `        ${cmdlineOf(o.pid)}\n        lock: ${o.dir}`,
  );
}
if (clean) {
  for (const o of orphans) {
    try {
      Deno.kill(o.pid, "SIGTERM");
      console.error(`        → SIGTERM sent`);
    } catch { /* gone */ }
  }
  let removed = 0;
  for (const d of staleDirs) {
    try {
      Deno.removeSync(d, { recursive: true });
      removed++;
    } catch { /* in use */ }
  }
  let homes = 0;
  const kept: string[] = [];
  for (const d of tmpDirs) {
    try {
      Deno.removeSync(d, { recursive: true });
      homes++;
    } catch (e) {
      kept.push(`${d} (${String((e as Error).message).split("\n")[0]})`);
    }
  }
  console.log(
    `clean: ${orphans.length} orphan(s) signalled, ${removed} stale lock ` +
      `dir(s) and ${homes} ownerless /tmp/aio-* dir(s) removed`,
  );
  // Never a silent "0 removed": say which ones resisted, and why.
  for (const k of kept) console.error(`  could not remove ${k}`);
  Deno.exit(0);
}
if (orphans.length) {
  console.error(
    `\n${orphans.length} aio process(es) outlived their test run. ` +
      `\`deno task clean:tmp\` stops them; the test that started them needs a ` +
      `deadline (and its app childEnv() — see tests/e2e-app-harness.ts).`,
  );
  Deno.exit(1);
}
console.log(
  `no orphaned aio processes (${staleDirs.length} stale lock dir(s), ` +
    `${tmpDirs.length} ownerless /tmp/aio-* dir(s) — deno task clean:tmp removes them)`,
);

// ── The leak nobody was failing on ──
//
// This script has always COUNTED abandoned directories and always exited 0
// about them. Measured on a developer machine after a few weeks of suite runs:
// 5,612 ownerless `/tmp/aio-*` directories holding 4.3 GB. Every one is a test
// that made a temp home and did not remove it, and the number only goes up.
//
// A process left running is red because it holds a port; a directory left
// behind is not red, because one directory is nothing. Ten thousand of them is
// not nothing, and there was no point at which anyone was told. So: a ceiling,
// which only ever goes DOWN — the same ratchet as `check:silent-catch` and
// friends. It is deliberately generous, because this counts what is on the
// WHOLE machine (a colleague's suite, a container's leftovers), not just what
// this run made; the job of the number is to catch a new leak class, not to
// police a tidy /tmp.
const LEFTOVER_CEILING = 400;
const leftovers = staleDirs.length + tmpDirs.length;
if (leftovers > LEFTOVER_CEILING) {
  console.error(
    `\ncheck:orphans FAIL — ${leftovers} abandoned director(ies) ` +
      `(${staleDirs.length} stale lock, ${tmpDirs.length} ownerless ` +
      `/tmp/aio-*), ceiling ${LEFTOVER_CEILING}.\n` +
      `  Every one is a test that made a temp home and did not remove it. ` +
      `They are invisible one at a time and 4 GB in aggregate.\n` +
      `  \`deno task clean:tmp\` removes them; then find the test that made ` +
      `them and give it an \`await using\` or a finally.`,
  );
  Deno.exit(1);
}
if (leftovers > 0 && leftovers <= LEFTOVER_CEILING / 4) {
  console.log(
    `  (${leftovers} abandoned dir(s), ceiling ${LEFTOVER_CEILING} — ` +
      `lower it in scripts/check-orphans.ts to keep the win)`,
  );
}
