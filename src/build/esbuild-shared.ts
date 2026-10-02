// esbuild-shared.ts — the ONE authority for the esbuild version + JSX config
// shared by the dev transpiler and the prod bundler (B-6: a drift between the
// two means dev and prod compile with different toolchains — a parity bug the
// old copies could only warn about in comments).
//
// NOTE: src/build/build-bundle.ts must keep a LITERAL `npm:esbuild@…` import
// (a computed specifier would defeat deno's static prefetch for the build
// path). It cannot reference this constant syntactically, so
// tests/esbuild-version-pin.test.ts asserts the literal matches this value.

import { AIO_LIBRARY_ENTRIES } from "../entries.ts";

/** The pinned esbuild version — must equal deno.json's pin and the literal in
 *  build-bundle.ts (CI-enforced). */
export const ESBUILD_VERSION = "0.24.2";

/** Computed specifier — lazy (never statically prefetched); used by paths
 *  that must stay esbuild-free at install time (dev transpile, aiol). */
export const ESBUILD_SPEC: string = ["npm:esbuild", ESBUILD_VERSION].join("@");

// ── stopping the service ───────────────────────────────────────────────
//
// esbuild transpiles and bundles through a NATIVE CHILD PROCESS, and its
// `stop()` only sends the kill: it offers no way to await the exit. A caller
// that returns on `stop()` alone hands the child's exit to whatever runs next
// — in the test suite, to the next test, as a leaked subprocess plus a leaked
// "wait for a subprocess to exit" op. A fixed "allow it to terminate" wait is
// true on an idle machine and false under load (the parallel suite), which is
// the shape that made the Android bundle test fail in shard 4 and pass alone.
//
// So: take the service's pids first, then poll until they are reaped. Bounded
// — a stuck child must not hang a shutdown. Lives here, beside the version
// pin, because every esbuild caller needs it: the dev transpiler, the graph
// validator and each test that drives esbuild itself.

/** Is `pid` still in the process table (a zombie counts — it is not reaped)? */
function inProcTable(pid: number): boolean {
  try {
    Deno.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

/** The pids listed in `/proc/self/task/<tid>/children`, over every thread.
 *
 *  Each task is read on its own: a thread can exit between the listing and
 *  its read (test-file workers, the blocking pool), and that read then fails.
 *  One vanished thread used to drop the WHOLE list — the caller saw "no
 *  children", skipped the wait for a live esbuild and returned on the fixed
 *  one, which is the leaked-subprocess failure this section exists to end.
 *  Pure: the lister and the reader are passed in. @internal */
export function _childPids(
  tasks: Iterable<string>,
  readChildren: (tid: string) => string,
): number[] {
  const kids: number[] = [];
  for (const tid of tasks) {
    let raw: string;
    try {
      raw = readChildren(tid);
    } catch {
      // aio-ok: that thread exited since the listing — skip IT. The other
      // threads' children are still true, and they are what the caller needs.
      continue;
    }
    for (const p of raw.trim().split(/\s+/)) if (p) kids.push(Number(p));
  }
  return kids;
}

/** The esbuild service processes this process started (Linux: `/proc`).
 *  Empty elsewhere, or when nothing can tell. */
function esbuildChildPids(): number[] {
  if (Deno.build.os !== "linux") return [];
  try {
    const tasks = [...Deno.readDirSync("/proc/self/task")].map((t) => t.name);
    return _childPids(
      tasks,
      (tid) => Deno.readTextFileSync(`/proc/self/task/${tid}/children`),
    ).filter((pid) => {
      try {
        // The SERVICE, not anything named esbuild: `stop()` ends only that
        // one, and waiting on another child would be waiting for nothing.
        const cmd = Deno.readTextFileSync(`/proc/${pid}/cmdline`);
        return cmd.includes("esbuild") && cmd.includes("--service=");
      } catch {
        return false; // already gone
      }
    });
  } catch {
    return []; // no /proc — the fallback wait below
  }
}

/** How long a stopped service gets to leave the process table, for a caller
 *  with no budget of its own (a test, a script). The dev server passes what
 *  is left of ITS stop budget instead — see `stopEsbuild`. */
const STOP_REAP_MS = 2000;

/** Run esbuild's own `stop()` and return only once its child has EXITED.
 *
 *  Why there is a process-table scan here at all: the pinned npm build gives
 *  no handle on the exit. Its `stop()` destroys the pipes, sends the kill and
 *  returns `Promise.resolve()`; the child lives in a closure inside
 *  `ensureServiceIsRunning` and is never exported (lib/main.js). The only
 *  deterministic wait would be to patch `node:child_process.spawn`
 *  process-wide to capture it, which is a worse thing than the scan.
 *
 *  What this guarantees:
 *   - Linux: every esbuild service child this process had is REAPED — and its
 *     subprocess resource with it, the runtime closes it in the same turn —
 *     or, after `reapMs`, it is named on stderr and left behind.
 *   - No `/proc` (macOS, Windows): the kill has been sent and one loop turn
 *     has passed. The exit itself is NOT awaited there; nothing can tell.
 *
 *  Call it with nothing in flight: a transform still pending when the pipes
 *  are destroyed never settles (measured on 0.24.2 — neither resolved nor
 *  rejected). `stopEsbuild` in server-transpile.ts waits for its own first. */
/** The services among `pids` that `stop()` just ended: those whose stdin this
 *  process no longer holds. esbuild's `stop()` destroys the stdin pipe of ITS
 *  service — synchronously — and nothing else; a service whose pipe is still
 *  open here belongs to another live esbuild instance in this process (a
 *  worker's isolate, a second copy of the package), which was never asked to
 *  stop. Waiting on one of those cost every close the whole reap and named a
 *  process the stop had never touched (measured: one such service, then 2 s
 *  and a wrong `note:` on every dev-server close for the rest of the run).
 *  Pure: both readers are passed in; a pid whose stdin cannot be read is
 *  kept — waiting on it is the old behaviour, never a skipped wait. @internal */
export function _stoppedByUs(
  pids: number[],
  stdinOf: (pid: number) => string,
  heldHere: () => Set<string>,
): number[] {
  const held = heldHere();
  return pids.filter((pid) => {
    let pipe: string;
    try {
      pipe = stdinOf(pid);
    } catch {
      return true; // aio-ok: unreadable — wait on it, as before
    }
    return !held.has(pipe);
  });
}

/** Every file this process holds open, as `/proc/self/fd` names them. */
function heldHere(): Set<string> {
  const held = new Set<string>();
  try {
    for (const e of Deno.readDirSync("/proc/self/fd")) {
      try {
        held.add(Deno.readLinkSync(`/proc/self/fd/${e.name}`));
      } catch {
        // aio-ok: the fd that listed the directory itself, closed by now
      }
    }
  } catch {
    // aio-ok: no /proc — then no pid was listed either, nothing to judge
  }
  return held;
}

export async function stopEsbuildService(
  stop: () => void | Promise<void>,
  reapMs: number = STOP_REAP_MS,
): Promise<void> {
  const before = esbuildChildPids();
  await stop();
  // Only what this stop ended is waited for — see `_stoppedByUs`.
  const pids = _stoppedByUs(
    before,
    (pid) => Deno.readLinkSync(`/proc/${pid}/fd/0`),
    heldHere,
  );
  const asked = Date.now();
  const deadline = asked + reapMs;
  while (pids.some(inProcTable) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const stuck = pids.filter(inProcTable);
  if (stuck.length > 0) {
    console.warn(
      `note: esbuild's service process (pid ${stuck.join(", ")}) was told ` +
        `to stop and is still there ${
          ((Date.now() - asked) / 1000).toFixed(1)
        } s later — not waiting any longer; it is left to exit by itself.`,
    );
  }
  // One more turn, so the exit the runtime has just observed is delivered
  // (a turn, not a duration: any timer yields one).
  await new Promise((r) => setTimeout(r, 10));
}

/** JSX config every esbuild invocation must share (dev == prod). */
export const ESBUILD_JSX = {
  jsx: "automatic",
  jsxImportSource: "aio",
} as const;

/** THE map from an `aio*` import specifier to the framework module a BROWSER
 *  BUNDLE resolves it to, as a path from the framework's PACKAGE ROOT.
 *
 *  Two things live here that an app's own import map can never supply:
 *   - the BROWSER SUBSTITUTION — `aio` / `aio/air` resolve to the browser (or
 *     Android/WebView) entry, never to `mod.ts`, so the server module graph
 *     cannot enter the bundle;
 *   - `aio/renderer`, which the build's OWN generated entry imports and which
 *     is not a published export at all, so no app could declare it.
 *
 *  It is shared because there are TWO bundling paths that build their esbuild
 *  import map from different places: a local framework (a `dep/aio` checkout)
 *  maps file: paths, while a framework consumed from JSR is fetched over HTTP
 *  by {@link makeHttpPlugin}. esbuild cannot resolve `jsr:`/`npm:` specifiers,
 *  so every `aio*` entry in a JSR-pinned app's deno.json is DROPPED from the
 *  alias — and the remote path had no map of its own to put back. The result
 *  was total: `deno run -A jsr:@riagentic/aio/build --compile` in a JSR app
 *  died on `Could not resolve "aio/renderer"` before writing a byte, and no
 *  app-side change could fix it. One table, applied by both paths. */
export function bundleFrameworkEntries(
  standalone: boolean,
): Record<string, string> {
  const air = standalone ? "src/standalone-air.ts" : "src/browser-air.ts";
  return {
    ...AIO_LIBRARY_ENTRIES,
    "aio": air,
    "aio/air": air,
    "aio/renderer": "src/air/aio-renderer.ts",
  };
}
