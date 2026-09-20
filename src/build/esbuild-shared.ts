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

/** The esbuild service processes this process started (Linux: `/proc`).
 *  Empty elsewhere, or when nothing can tell. */
function esbuildChildPids(): number[] {
  if (Deno.build.os !== "linux") return [];
  try {
    const kids: number[] = [];
    for (const t of Deno.readDirSync("/proc/self/task")) {
      const raw = Deno.readTextFileSync(`/proc/self/task/${t.name}/children`);
      for (const p of raw.trim().split(/\s+/)) if (p) kids.push(Number(p));
    }
    return kids.filter((pid) => {
      try {
        return Deno.readTextFileSync(`/proc/${pid}/cmdline`).includes(
          "esbuild",
        );
      } catch {
        return false; // already gone
      }
    });
  } catch {
    return []; // no /proc — the fallback wait below
  }
}

/** Run esbuild's own `stop()` and return only once its child has EXITED.
 *  The fixed wait stays only where no process table can be read. */
export async function stopEsbuildService(
  stop: () => void | Promise<void>,
): Promise<void> {
  const pids = esbuildChildPids();
  await stop();
  const deadline = Date.now() + 2000;
  while (pids.some(inProcTable) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  // one more turn so the runtime settles the exit it just observed
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
  doAndroid: boolean,
): Record<string, string> {
  const air = doAndroid ? "src/standalone-air.ts" : "src/browser-air.ts";
  return {
    ...AIO_LIBRARY_ENTRIES,
    "aio": air,
    "aio/air": air,
    "aio/renderer": "src/air/aio-renderer.ts",
  };
}
