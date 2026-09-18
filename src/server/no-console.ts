/**
 * @module
 * The one rule for spawning a child from a process that may have NO console.
 *
 * A `deno compile --no-terminal` GUI exe opened by double-click on Windows has
 * no std handles, so `stdout: "inherit"` makes `spawn()` throw
 * `TypeError: Failed to spawn '…': Invalid handle`. Measured on real
 * Windows 11 (2026-09-17): every desktop app that spawned its window this way
 * opened nothing. Every production spawn that inherits stdio retries through
 * {@link spawnInheritingOrNull} rather than growing its own copy of the check.
 */

/** Whether a spawn failure is Windows' "the std handles I was given to inherit
 *  are not valid". Kept to a message match so the retry is the fallback, never
 *  the first move: a real failure that merely mentions a handle must not be
 *  retried into silence. `os` is injected so the rule is a unit test off
 *  Windows. */
export function isInvalidHandleError(
  e: unknown,
  os: typeof Deno.build.os = Deno.build.os,
): boolean {
  return os === "windows" &&
    e instanceof TypeError &&
    /invalid handle/i.test(e.message);
}

/** Spawn with inherited stdio, and — only when this process has no console to
 *  inherit from — again with the std handles discarded. `make` builds the
 *  command for either mode, so the caller keeps every other option. */
export function spawnInheritingOrNull(
  make: (stdio: "inherit" | "null") => Deno.Command,
  os: typeof Deno.build.os = Deno.build.os,
): Deno.ChildProcess {
  try {
    return make("inherit").spawn();
  } catch (e) {
    if (!isInvalidHandleError(e, os)) throw e;
    return make("null").spawn();
  }
}
