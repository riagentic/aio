// install.sh installs deno two ways, and only one of them used to prove it
// worked.
//
// The official-installer branch runs `curl … | sh` — a POSIX pipeline, whose
// exit status is the LAST command's, and /bin/sh has no `pipefail`. A 404, a
// dropped connection or an empty body means `sh` reads nothing and exits 0, so
// the `|| return 1` written beside it never fires. That branch then did a bare
// `return 0`, three lines above a sibling branch that ended by checking
// `deno --version` actually runs. The caller printed "+ deno  installed" — with
// an empty version, because there was no deno — and carried on.
//
// The whole script lives inside `main()`, so a unit test cannot call
// `install_deno` and the real path needs the network. What IS checkable, and
// is the thing that was actually wrong, is that no branch reports success
// without the proof.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(fromFileUrl(import.meta.url)).replace(/\/tests$/, "");
const INSTALL = join(REPO_ROOT, "install.sh");

/** The body of a shell function, by brace depth from its `name() {` line. */
function shellFunction(src: string, name: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^\\s*${name}\\(\\)`).test(l)
  );
  assert(start >= 0, `${name}() not found in install.sh`);
  let depth = 0;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]!;
    out.push(l);
    depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
    if (i > start && depth <= 0) break;
  }
  return out.join("\n");
}

Deno.test("install.sh: valid POSIX syntax (sh -n)", async () => {
  const p = await new Deno.Command("sh", {
    args: ["-n", INSTALL],
    stderr: "piped",
  }).output();
  assertEquals(p.code, 0, new TextDecoder().decode(p.stderr));
});

Deno.test("install.sh: deno_ok actually runs deno, it does not just look for a file", async () => {
  const src = await Deno.readTextFile(INSTALL);
  const fn = /^deno_ok\(\).*$/m.exec(src)?.[0] ?? "";
  assert(fn, "deno_ok() is gone — every branch's proof went with it");
  // A file being present is not the same as it running: a truncated download,
  // a wrong-arch binary and a missing loader all leave an executable file.
  assertStringIncludes(fn, "deno --version");
});

Deno.test("install.sh: no branch of install_deno reports success unproven", async () => {
  const src = await Deno.readTextFile(INSTALL);
  for (const name of ["install_deno", "install_deno_no_unzip"]) {
    const body = shellFunction(src, name);
    // Strip comments — this file explains the trap in prose, and prose is not
    // a code path.
    const code = body.split("\n")
      .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
      .join("\n");
    // A bare `return 0` is a success nobody proved. `deno_ok && return 0` is
    // the guarded form and does not match this pattern, so every hit IS a
    // bare one — a guarded line elsewhere in the function is no alibi.
    const bare = [...code.matchAll(/^\s*return 0\s*$/gm)];
    assertEquals(
      bare.length,
      0,
      `${name}() has an unguarded \`return 0\` — a pipeline's exit status is ` +
        `\`sh\`'s, so success there means nothing without deno_ok`,
    );
    assertStringIncludes(
      code,
      "deno_ok",
      `${name}() never proves deno runs`,
    );
  }
});
