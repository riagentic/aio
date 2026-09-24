// A permission test that cannot fail proves nothing.
//
// A file created with no mode comes out at `0o666 & ~umask`. Under a
// restrictive umask (077 — this dev box's, and many hardened hosts') that is
// already 0600, so a test asserting "owner-only" passes whether or not the
// code under test ever stated a mode — and a `{ mode: 0o644 }` fixture meant
// to be "the loose file an old install left" silently comes out 0600 too.
// `permissiveUmask` runs the body under 022 (the stock-distro default, where a
// forgotten mode really is world-readable), proves the umask took with a
// control file, and restores the caller's umask however the body ends.
//
// `Deno.umask` is process-wide and is inherited by spawned children, so a
// child process started inside the body runs under 022 as well. Tests in one
// file run one at a time, which is what makes a process-wide swap safe here.
// tests/mode-tests-force-umask.test.ts requires every test file that asserts
// a permission mode to use this (or say why the umask cannot hide the bug).
import { assertEquals } from "@std/assert";
import { join } from "@std/path";

/** Run `fn` with the process umask at 0o022; restore it afterwards. On
 *  Windows (no umask, no POSIX modes) `fn` just runs. */
export async function permissiveUmask<T>(
  fn: () => T | Promise<T>,
): Promise<T> {
  if (Deno.build.os === "windows") return await fn();
  const was = Deno.umask(0o022);
  try {
    // aio-ok: a sync probe, removed in the finally below within milliseconds
    const dir = Deno.makeTempDirSync({ prefix: "aio-umask-control-" });
    try {
      const control = join(dir, "control");
      Deno.writeTextFileSync(control, "");
      assertEquals(
        Deno.statSync(control).mode! & 0o777,
        0o644,
        "the umask did not take — every mode check under it would be vacuous",
      );
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
    return await fn();
  } finally {
    Deno.umask(was);
  }
}
