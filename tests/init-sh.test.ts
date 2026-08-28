// init.sh is the LEGACY entrypoint — kept, and documented as kept, so old
// `curl … | sh` URLs keep working. It had no test at all, and it was the one
// script of the four still written the way run.sh explains at length that a
// script must not be:
//
//   exec sh -c "$(curl -fsSL …/install.sh)"
//
// A command substitution's exit status is not the simple command's, so `set -e`
// does not see the curl fail. A 404, a dropped connection or an empty body
// leaves the substitution empty, `sh -c ""` runs nothing and exits 0 — and
// whoever typed the old URL is told the install succeeded with nothing
// installed. That is the exact failure this project's first rule is about.
//
// No network here: `AIO_RAW` accepts a `file://` URL, which is also why it is
// read at all rather than hardcoded.
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(fromFileUrl(import.meta.url)).replace(/\/tests$/, "");
const INIT = join(REPO_ROOT, "init.sh");
const dec = new TextDecoder();

/** Run init.sh against a local directory standing in for the raw-content host. */
async function runInit(
  installer: string | null,
): Promise<{ code: number; out: string; err: string }> {
  const dir = await Deno.makeTempDir({ prefix: "aio-init-" });
  if (installer !== null) {
    await Deno.writeTextFile(join(dir, "install.sh"), installer);
  }
  const p = await new Deno.Command("sh", {
    args: [INIT],
    env: { AIO_RAW: `file://${dir}` },
    stdout: "piped",
    stderr: "piped",
  }).output();
  await Deno.remove(dir, { recursive: true });
  return {
    code: p.code,
    out: dec.decode(p.stdout),
    err: dec.decode(p.stderr),
  };
}

Deno.test("init.sh: valid POSIX syntax (sh -n)", async () => {
  const p = await new Deno.Command("sh", {
    args: ["-n", INIT],
    stderr: "piped",
  }).output();
  assertEquals(p.code, 0, dec.decode(p.stderr));
});

Deno.test("init.sh: a download that fails is a failure, not a silent success", async () => {
  const r = await runInit(null); // nothing at that URL → curl 404/37
  assertEquals(r.code, 1, `expected a refusal, got:\n${r.out}${r.err}`);
  assert(r.err.includes("could not download the installer"), r.err);
});

Deno.test("init.sh: an EMPTY installer is refused rather than run", async () => {
  // The shape that made `sh -c "$(curl …)"` report success: nothing to run.
  const r = await runInit("");
  assertEquals(r.code, 1, `expected a refusal, got:\n${r.out}${r.err}`);
  assert(r.err.includes("EMPTY"), r.err);
});

Deno.test("init.sh: the installer's own exit code is propagated", async () => {
  const r = await runInit("#!/bin/sh\necho doing work\nexit 7\n");
  assertEquals(r.code, 1);
  assert(r.out.includes("doing work"), r.out);
  assert(r.err.includes("exit 7"), "the real status is named: " + r.err);
});

Deno.test("init.sh: a successful install forwards cleanly and leaves nothing", async () => {
  const before = await tmpLeftovers();
  const r = await runInit("#!/bin/sh\necho installed am\n");
  assertEquals(r.code, 0, r.err);
  assert(r.out.includes("installed am"), r.out);
  assertEquals(
    await tmpLeftovers(),
    before,
    "a downloaded installer was left behind",
  );
});

/** Count `aio-init.*.sh` files in the temp dir — the script must clean up on
 *  every path, including the one where it succeeds. */
async function tmpLeftovers(): Promise<number> {
  const tmp = Deno.env.get("TMPDIR") ?? "/tmp";
  let n = 0;
  try {
    for await (const e of Deno.readDir(tmp)) {
      if (/^aio-init\..*\.sh$/.test(e.name)) n++;
    }
  } catch { /* unreadable temp dir — the count is 0 either way */ }
  return n;
}
