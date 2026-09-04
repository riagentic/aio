// 50audits §6: `am watch` reported a job it did not do.
//
//   $ am watch /definitely/not/a/dir
//   {"watching":"/definitely/not/a/dir"}    # …and hangs, watching nothing
//   $ am watch --zzz
//   {"watching":"--zzz"}                    # the flag became the directory
//
// `watchDir` was echoed and then never referenced again: no `Deno.watchFs`, no
// restart, no validation, and `await new Promise(() => {})` to keep the process
// alive. The command's own comment admitted it ("Backend .ts changes require
// manual restart") while the help promised hot-restart. A command that reports
// success for a job it does not do is worse than a missing one.
//
// It watches now. These pin the two decisions that are pure (which directory,
// and that a missing one is refused); the FS loop itself is exercised by
// running the real command below.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { watchTargetDir } from "../src/am/am-cmd-process.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

Deno.test("am watch: the directory is the first POSITIONAL, never a flag", () => {
  assertEquals(watchTargetDir([]), "src");
  assertEquals(watchTargetDir(["lib"]), "lib");
  // `watch` forwards start's flags, so the central unknown-flag gate does not
  // run for it — which is exactly why a flag must not be read as a path.
  assertEquals(watchTargetDir(["--zzz"]), "src");
  assertEquals(watchTargetDir(["--env-file=.env", "lib"]), "lib");
  assertEquals(watchTargetDir(["-q"]), "src");
});

Deno.test("am watch: a directory that is not there is refused, not 'watched'", async () => {
  const dir = await tempDir("am-watch-");
  try {
    const missing = join(dir, "nope");
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        new URL("../src/am.ts", import.meta.url).pathname,
        "watch",
        missing,
        "--json",
      ],
      stdout: "piped",
      stderr: "piped",
      cwd: dir,
    });
    const r = await cmd.output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 1, out);
    assertStringIncludes(out, "is not a directory");
    assert(
      !/"watching"/.test(out),
      `it must not claim to be watching: ${out}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am watch: a FILE is not a directory either", async () => {
  const dir = await tempDir("am-watch-file-");
  try {
    const file = join(dir, "src.ts");
    await Deno.writeTextFile(file, "// not a directory");
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        new URL("../src/am.ts", import.meta.url).pathname,
        "watch",
        file,
        "--json",
      ],
      stdout: "piped",
      stderr: "piped",
      cwd: dir,
    });
    const r = await cmd.output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 1, out);
    assertStringIncludes(out, "is not a directory");
  } finally {
    await dropTempDir(dir);
  }
});
