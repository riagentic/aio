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
import { dirname, join } from "@std/path";
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
      } catch {
        // aio-ok: this stat RACES the CSS tool that is writing these very
        // files. A miss means "I could not stamp this one", which the caller
        // already handles — an unstamped file simply counts as changed, so the
        // watcher errs toward running the step again rather than skipping it.
      }
    }
  } catch {
    // aio-ok: the app dir not being readable means there are no stylesheets to
    // stamp, which is the same answer as an empty one. The step itself reports
    // its own failures loudly (`runCssBuild`); this is only the before/after
    // snapshot that tells the watcher what the step wrote.
  }
  return out;
}

let _saidFailure = false;

/** The nearest directory at or above `dir` holding a deno.json — the app's
 *  project root. Walks up, because the app dir is normally `<project>/src`. */
async function _projectRootOf(dir: string): Promise<string> {
  let at = dir;
  for (;;) {
    if (await readDenoJson(at)) return at;
    const up = dirname(at);
    if (up === at) return dir; // no project above: behave as before
    at = up;
  }
}

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
  // The deno.json is at the PROJECT ROOT; `absBaseDir` is the app dir, which
  // for every scaffold is `<project>/src` ("Zero-config baseDir: the main
  // module's directory"). So this looked one level below the file it needed
  // and found nothing — and the whole step ran only in `build`, which does
  // read from the root.
  //
  // Measured on `am create --css=tailwind`: `deno task dev` never produced
  // `src/style.css`, not on boot and not after an edit, so the app rendered
  // completely unstyled in the only mode a newcomer uses for the first hour —
  // and `deno task compile` produced a correct 13 KB stylesheet. Green in dev,
  // different in prod, from the one flag a Tailwind user reaches for. The
  // scaffold's own comment on that key says "Runs before every dev reload and
  // every build".
  //
  // The root is also the right CWD: the declared command's paths are relative
  // to the deno.json that declares it (`-i src/app.css -o src/style.css`).
  const root = await _projectRootOf(absBaseDir);
  const step = cssBuildStep((await readDenoJson(root))?.config);
  if (!step) return [];
  const before = await cssStamps(root);
  const res = await runCssBuild(root, {
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
  const after = await cssStamps(root);
  const written: string[] = [];
  for (const [p, stamp] of after) {
    if (before.get(p) !== stamp) written.push(p);
  }
  return written;
}
