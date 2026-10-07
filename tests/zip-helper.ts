// A .zip made by the HOST's own archiver, on every OS.
//
// The tests that read a zip want one a foreign tool wrote — that is what the
// reader meets in the field. Off Windows that tool is `zip`. Windows has no
// `zip`; it ships bsdtar as `tar.exe` (since Windows 10 1803), which writes
// zip too — deflated, or stored when asked. (.NET's `ZipFile` cannot store:
// its `NoCompression` is still method 8.)
import { resolve } from "@std/path";

/** Pack the CONTENTS of `stage` (no folder on top) into `out`. `store` keeps
 *  every entry uncompressed. Symlinks stay links (`zip -y`). */
export async function zipTree(
  stage: string,
  out: string,
  opts: { store?: boolean } = {},
): Promise<void> {
  const win = Deno.build.os === "windows";
  // tar names what it is given: the top-level entries, not `.`, so no entry
  // is called `./x`.
  const top = win ? [...Deno.readDirSync(stage)].map((e) => e.name) : [];
  const p = await new Deno.Command(win ? "tar" : "zip", {
    args: win
      ? [
        "-a",
        "-cf",
        resolve(out),
        ...(opts.store ? ["--options", "zip:compression=store"] : []),
        ...top,
      ]
      : ["-q", "-r", "-y", ...(opts.store ? ["-0"] : []), resolve(out), "."],
    cwd: stage,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!p.success) {
    throw new Error(
      `could not zip ${stage}: ${new TextDecoder().decode(p.stderr)}`,
    );
  }
}
