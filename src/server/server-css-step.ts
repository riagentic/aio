// The dev half of `build.css` — the app's CSS toolchain, run by the watcher.
//
// Split from the watcher so the watcher stays a pure, testable state machine
// with no subprocess in it, and split from `build-css.ts` so the DEV policy
// lives with the dev server: a failing Tailwind run reports and keeps serving,
// where a failing BUILD refuses. That is the allowed direction of the dev/prod
// split — dev is never more permissive about what ships, and an unstyled
// artifact still cannot be built.
//
// It returns the paths the step wrote, which the watcher needs: the output is a
// file inside the watched tree, so a step writing `style.css` wakes the watcher
// that ran it. Without knowing what the step touched, that is an edit loop at
// save speed.
import { join } from "@std/path";
import { cssBuildStep, runCssBuild } from "../build/build-css.ts";
import { readDenoJson } from "./deno-json.ts";
import { log } from "../diagnostics/logger.ts";

/** `.css` files directly under `dir`, with the mtime+size that identifies a
 *  version of each. Shallow on purpose: a CSS toolchain writes its output
 *  beside the source, and walking a whole tree on every save to catch an
 *  unusual layout would cost more than the case is worth. */
async function cssStamps(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".css")) continue;
      const p = join(dir, e.name);
      try {
        const st = await Deno.stat(p);
        out.set(p, `${st.mtime?.getTime() ?? 0}:${st.size}`);
      } catch { /* raced with a writer — treat as unknown */ }
    }
  } catch { /* no such dir */ }
  return out;
}

let _saidFailure = false;

/** Run the app's declared CSS step. Returns the files it wrote. */
export async function _runAppCssStep(
  absBaseDir: string,
): Promise<readonly string[]> {
  // NOTHING happens for an app that declares no step — checked FIRST, before
  // any directory read. Stamping the app dir up front cost every dev server a
  // `Deno.readDir` on boot and on every save whether or not the app had asked
  // for anything, and the sanitizers caught it: eight tests that merely boot a
  // server reported "readDir created during the test, but not cleaned up".
  // A feature nobody opted into must cost nothing, including no I/O.
  const step = cssBuildStep((await readDenoJson(absBaseDir))?.config);
  if (!step) return [];
  const before = await cssStamps(absBaseDir);
  const res = await runCssBuild(absBaseDir, {
    throwOnFail: false,
    log: (msg) => {
      // Repeated on every save while the stylesheet is broken, which is
      // exactly the situation where you want to see it — but the first one
      // carries the fix, and after that the tool's own output is the signal.
      if (!_saidFailure) {
        _saidFailure = true;
        log.error("css", msg);
        log.warn(
          "css",
          "the previous stylesheet is still being served — fix the command " +
            "or the CSS and save again; the dev server stays up on purpose.",
        );
      } else {
        log.error("css", msg);
      }
    },
  });
  if (!res.ran) return [];
  if (res.ok) {
    _saidFailure = false;
    log.debug("css", `${res.command} (${res.ms}ms)`);
  }
  const after = await cssStamps(absBaseDir);
  const written: string[] = [];
  for (const [p, stamp] of after) {
    if (before.get(p) !== stamp) written.push(p);
  }
  return written;
}
