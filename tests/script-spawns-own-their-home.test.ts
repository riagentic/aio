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

/** THE scan: the files that name a repo script (`named`), and those of them
 *  with neither `ownHome(` nor a SAFE entry whose proof still holds
 *  (`offenders`). Pure. */
function scan(
  files: { name: string; src: string }[],
  safeList: typeof SAFE = SAFE,
): { named: string[]; offenders: string[] } {
  const offenders: string[] = [];
  const named: string[] = [];
  for (const { name, src } of files) {
    if (!SCRIPT.test(src)) continue;
    named.push(name);
    if (/\bownHome\(/.test(src)) continue;
    const safe = safeList[name];
    if (!safe) offenders.push(name);
    else if (!safe.proof.every((re) => re.test(src))) {
      offenders.push(
        `${name} (listed as safe — "${safe.why}" — but that is no longer in it)`,
      );
    }
  }
  return { named, offenders };
}

Deno.test("tests: a file that runs run.sh / install.sh takes its HOME from ownHome()", async () => {
  const files: { name: string; src: string }[] = [];
  for await (const e of Deno.readDir(TESTS)) {
    if (!e.isFile || !e.name.endsWith(".ts")) continue;
    files.push({
      name: e.name,
      src: await Deno.readTextFile(join(TESTS, e.name)),
    });
  }
  const { named, offenders } = scan(files);
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

// The control: the scan above is green today, and a scan that can only be
// green proves nothing. These are the files it exists to refuse.
Deno.test("tests: the scan REFUSES a file that runs a repo script with neither ownHome() nor a SAFE entry", () => {
  const spawn = (extra: string) =>
    `const RUN = join(REPO, "run.sh");\n` +
    `await new Deno.Command("sh", { args: [RUN], env: { ...Deno.env.toObject()${extra} } }).output();\n`;
  const safe = {
    "listed.test.ts": { why: "a cleared env", proof: [/clearEnv: true/] },
    "rotted.test.ts": { why: "a cleared env", proof: [/clearEnv: true/] },
  };
  const { named, offenders } = scan([
    // The 2026-10-07 shape: the developer's env, HOME and all, into run.sh.
    { name: "leaks.test.ts", src: spawn("") },
    // The same file through the other spelling of the repo root, and install.ps1.
    {
      name: "leaks-ps1.test.ts",
      src: `const I = join(REPO_ROOT, "install.ps1");\n`,
    },
    { name: "owns.test.ts", src: spawn(", ...await ownHome(root)") },
    { name: "listed.test.ts", src: spawn("") + "// clearEnv: true\n" },
    // Listed, and the text that made it safe is gone.
    { name: "rotted.test.ts", src: spawn("") },
    // Names no script: not this guard's business.
    { name: "other.test.ts", src: `const x = join(REPO, "mod.ts");\n` },
  ], safe);
  assertEquals(named, [
    "leaks.test.ts",
    "leaks-ps1.test.ts",
    "owns.test.ts",
    "listed.test.ts",
    "rotted.test.ts",
  ]);
  assertEquals(offenders, [
    "leaks.test.ts",
    "leaks-ps1.test.ts",
    'rotted.test.ts (listed as safe — "a cleared env" — but that is no longer in it)',
  ]);
});
