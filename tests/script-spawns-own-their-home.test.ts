// A test that runs `run.sh` / `install.sh` gives it a HOME of its own.
//
// Those scripts are INSTALLERS: run.sh puts a ~110 MB program in
// `~/app/<name>/` and links it from `~/.local/bin`, install.sh appends a PATH
// line to `~/.profile` and every rc file that exists. `AIO_APPS_DIR` — the
// sandbox every test task sets — moves none of that, because it is the app's
// DATA. MEASURED 2026-10-07: tests/run-sh-e2e.test.ts spread the developer's
// env into run.sh for seven weeks; 794 programs, ~140 GB, a full home disk.
//
// `check:home-clean` names such a leak after it happened. This refuses the
// test file that would make it: one that names a repo script and neither takes
// its HOME from `ownHome()` nor is listed below with what makes it safe.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const TESTS = fromFileUrl(new URL(".", import.meta.url));

/** A repo script, named the way a test reaches it to run it. */
const SCRIPT = /join\(\s*REPO(_ROOT)?,\s*"(run|install|init)\.(sh|ps1)"\s*\)/;

/** Files that name a script and do NOT use `ownHome()`, each with the text in
 *  it that makes that safe. The text is checked: an entry whose proof is gone
 *  is red, so the list cannot outlive its reasons. */
const SAFE: Record<string, { why: string; proof: RegExp[] }> = {
  "init-sh.test.ts": {
    why: "init.sh only downloads an installer — a stub this test writes",
    proof: [/AIO_RAW: `file:\/\/\$\{dir\}`/],
  },
  "install-sh-verifies.test.ts": {
    why: "`sh -n` and reads of the text; the script never runs",
    proof: [/args: \["-n", INSTALL\]/],
  },
  "install-deno-version.test.ts": {
    why: "a cleared env whose HOME is the test's own directory",
    proof: [/clearEnv: true/, /HOME: dir,/],
  },
  "install-sh-shim-root.test.ts": {
    why: "a cleared env; every case passes its own HOME",
    proof: [/clearEnv: true/, /HOME: home/],
  },
};

Deno.test("tests: a file that runs run.sh / install.sh takes its HOME from ownHome()", async () => {
  const offenders: string[] = [];
  const named: string[] = [];
  for await (const e of Deno.readDir(TESTS)) {
    if (!e.isFile || !e.name.endsWith(".ts")) continue;
    const src = await Deno.readTextFile(join(TESTS, e.name));
    if (!SCRIPT.test(src)) continue;
    named.push(e.name);
    if (/\bownHome\(/.test(src)) continue;
    const safe = SAFE[e.name];
    if (!safe) offenders.push(e.name);
    else if (!safe.proof.every((re) => re.test(src))) {
      offenders.push(
        `${e.name} (listed as safe — "${safe.why}" — but that is no longer in it)`,
      );
    }
  }
  assert(named.length >= 5, `the scan found only ${named.join(", ")}`);
  assertEquals(
    offenders,
    [],
    "these test files name a repo install script without a HOME of their own. " +
      "Spread `...await ownHome(root)` (tests/deno-dir-helper.ts) into the " +
      "child's env after the inherited one and remove `root` when the test " +
      "ends — or list the file in SAFE with the text that proves it cannot " +
      "write into the developer's home",
  );
  // A listed file that no longer names a script is a stale exemption.
  assertEquals(Object.keys(SAFE).filter((f) => !named.includes(f)), []);
});
