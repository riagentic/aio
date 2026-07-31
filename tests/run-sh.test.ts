// run.sh — fast, always-on checks (no network, no build). The full
// build-and-run path lives in tests/run-sh-e2e.test.ts behind the onboard gate.
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(fromFileUrl(import.meta.url)).replace(/\/tests$/, "");
const dec = new TextDecoder();

Deno.test("run.sh: valid POSIX syntax (sh -n)", async () => {
  const p = await new Deno.Command("sh", {
    args: ["-n", join(REPO_ROOT, "run.sh")],
    stderr: "piped",
  }).output();
  assertEquals(p.code, 0, dec.decode(p.stderr));
});

Deno.test("run.sh: an unknown flag fails loud, before touching anything", async () => {
  const p = await new Deno.Command("sh", {
    args: [join(REPO_ROOT, "run.sh"), "--bogus"],
    cwd: await Deno.makeTempDir(),
    stderr: "piped",
    stdout: "piped",
  }).output();
  assertEquals(p.code, 1);
  const err = dec.decode(p.stderr);
  assert(err.includes("unknown flag: --bogus"), err);
  assert(err.includes("--dev"), "the error names the valid flags");
});

Deno.test("run.sh: --git without a URL fails loud", async () => {
  const p = await new Deno.Command("sh", {
    args: [join(REPO_ROOT, "run.sh"), "--git"],
    cwd: await Deno.makeTempDir(),
    stderr: "piped",
    stdout: "piped",
  }).output();
  assertEquals(p.code, 1);
  assert(dec.decode(p.stderr).includes("--git needs a URL"));
});
