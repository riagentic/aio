// A Windows clone with `core.autocrlf=true` (Git for Windows' default) checked
// android-template/ out with CRLF, and the generated constant compared byte-
// wise against it failed ("app/build.gradle.kts — regenerate") on a tree
// nobody edited. Every tracked text file must check out LF whatever the
// clone's git config says: the templates, the journal fixtures, the stub's
// Rust sources and the .ps1 scripts are all read or hashed byte for byte.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

Deno.test("repo: every tracked text file checks out LF under any core.autocrlf", () => {
  const out = new Deno.Command("git", {
    args: ["ls-files", "--eol"],
    cwd: ROOT,
    stdout: "piped",
  }).outputSync();
  assert(out.success, "git ls-files --eol failed");
  const lines = new TextDecoder().decode(out.stdout).split("\n").filter(
    Boolean,
  );
  assert(lines.length > 1000, `only ${lines.length} tracked files listed`);
  // `i/<index> w/<worktree> attr/<attrs>\t<path>`: a binary in the index is
  // never converted; a text file is safe only with eol=lf (or -text).
  const loose = lines.map((l) => l.split("\t")).filter(([meta = ""]) =>
    !meta.startsWith("i/-text") && !/attr\/(.* )?(eol=lf|-text)\b/.test(meta)
  ).map(([, path]) => path);
  assertEquals(loose, [], "text files whose line endings follow core.autocrlf");
});
