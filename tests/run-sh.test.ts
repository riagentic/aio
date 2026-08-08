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

Deno.test("run.sh: the artifact is launched with a private TMPDIR, not /tmp", async () => {
  // An AppImage unpacks itself into $TMPDIR BEFORE any aio code runs, so the
  // launcher is the only place that can decide where. /tmp is shared: the
  // extract path's dir name is a digest of the AppImage (predictable, 0755), a
  // second user running the same file lands in the first user's copy, and the
  // runtime warns-but-continues into whatever tree is already there.
  const src = await Deno.readTextFile(join(REPO_ROOT, "run.sh"));
  const exec = src.indexOf('exec "$artifact"');
  assert(exec > 0, "run.sh no longer execs the artifact — update this guard");
  const before = src.slice(0, exec);
  assert(
    /export TMPDIR=/.test(before),
    "run.sh must export a private TMPDIR before exec'ing the artifact",
  );
  // ...and it must ASK for the path rather than rebuild an app's identity in
  // shell: two copies of that rule split an app's address (payload under one
  // directory, data under another) the moment either one moves.
  assert(
    before.includes("--print-app-tmpdir"),
    "the path must come from the build, not from a shell-side naming rule",
  );
  assert(
    /chmod 700 "\$app_tmpdir"/.test(before),
    "$HOME is 0755 on most distros — moving out of /tmp without 0700 fixes nothing",
  );
});
