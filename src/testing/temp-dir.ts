// ONE decider for "this test needs a throwaway directory".
//
// A temp dir removed on the happy path only is removed most of the time. The
// test that throws, the assertion that fails, the `await using` that was never
// written — each skips its own cleanup, and the directory outlives the suite.
// Measured before this module existed: one full `deno task test` run left 143
// ownerless `/tmp/aio-*` directories behind, and a developer machine had
// accumulated 5,612 of them holding 4.3 GB. `scripts/check-orphans.ts` counts
// them and fails the gate above a ceiling, which is how the leak became
// visible; this is how it stops happening.
//
// So: every directory made through here is registered, and the registry is
// swept when the process exits — after the tests, whatever they did to get
// there. Explicit `dropTempDir()` on the happy path is still the right thing
// (a long test file should not hold a hundred directories open, and a test
// that inspects /tmp must not see its predecessors); the exit sweep is the net
// under it, not a replacement for it.
//
// It is a net, not a guarantee: a process killed with SIGKILL (an outer
// `timeout` on a hung test) never runs it. That case is `deno task clean:tmp`.

const registry = new Set<string>();
let sweepArmed = false;

/** Remove every still-registered temp dir. Runs once, at process exit. */
function sweep(): void {
  for (const dir of registry) {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue; // already gone — fine
      // Anything else is a directory this process is leaving behind on disk,
      // and the whole point of this module is that nobody finds that out from
      // a 4 GB /tmp six weeks later.
      console.error(`[temp-dir] could not remove ${dir}: ${e}`);
    }
  }
  registry.clear();
}

function arm(): void {
  if (sweepArmed) return;
  sweepArmed = true;
  globalThis.addEventListener("unload", sweep);
}

/** Register an already-created directory for removal at process exit. Use it
 *  when the directory came from somewhere else (a fixture, a build output). */
export function keepTempDir(dir: string): string {
  arm();
  registry.add(dir);
  return dir;
}

/** A throwaway directory that is removed at process exit even if this test
 *  throws first. Same signature as `Deno.makeTempDir({ prefix })`. */
export async function tempDir(prefix: string): Promise<string> {
  return keepTempDir(await Deno.makeTempDir({ prefix }));
}

/** Sync twin of {@linkcode tempDir} — for module-scope fixtures. */
export function tempDirSync(prefix: string): string {
  return keepTempDir(Deno.makeTempDirSync({ prefix }));
}

/** Remove a temp dir now. Best effort: a directory a live child still holds
 *  stays registered and the exit sweep tries again, so a failure here is never
 *  the difference between clean and leaked. */
export async function dropTempDir(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
    registry.delete(dir);
  } catch {
    // aio-ok: still in use (a child's cwd, an open handle) or already gone.
    // Neither is worth a line here, and neither is a leak: the dir stays
    // registered, so the exit sweep tries again and SAYS SO if it also fails.
  }
}

let childCov: string | undefined;

/** Where a spawned `deno` should write its coverage profile.
 *
 *  Under `deno test --coverage` this is the parent's own profile dir, so a
 *  child process's work COUNTS toward `src/` coverage. Outside a coverage run
 *  it is one throwaway per process — never the repo (an empty
 *  `DENO_COVERAGE_DIR` means "cwd"), never a fresh dir per test file. */
// aio-ok: a test-only seam — tests hand it to spawned `deno`, src/ never does.
export function childCoverageDir(): string {
  if (childCov !== undefined) return childCov;
  childCov = Deno.env.get("DENO_COVERAGE_DIR") ?? tempDirSync("aio-child-cov-");
  return childCov;
}
