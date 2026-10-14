// A test file that reaches `am` arms the per-user store sandbox at its first
// import (tests/store-sandbox.ts says why). Three such files were fixed by
// hand after each had written the developer's real version store; this makes
// the class unshippable: a file that names the `am` entry point or imports
// an `am` command, and imports neither the sandbox nor the app harness
// (which imports it), is refused here.
import "./store-sandbox.ts"; // this file names the patterns it looks for
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, relative } from "@std/path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

/** Does this test source run `am` — spawned (it names `src/am.ts`) or in
 *  process (it imports a command module, or the version store's)? Pure. */
export function reachesAm(src: string): boolean {
  return /src\/am\.ts|["'`/]am\.ts["'`]|src\/am\/am-(cmd-[a-z-]+|versions|electron|onboard|install[a-z-]*)\.ts/
    .test(src);
}

/** Does it arm the sandbox when it loads? Pure. */
export function armsSandbox(src: string): boolean {
  return /^import\s[^;]*["'](?:\.\.?\/)+(?:tests\/)?(?:store-sandbox|e2e-app-harness)\.ts["'];/m
    .test(src);
}

Deno.test("store sandbox: what counts as reaching am, and as arming", () => {
  assert(reachesAm('args: ["run", "-A", `${ROOT}src/am.ts`, "pin"]'));
  assert(reachesAm('const AM = join(ROOT, "src", "am.ts");'));
  assert(reachesAm('import { cmdPin } from "../src/am/am-cmd-pin.ts";'));
  assert(reachesAm('import { provision } from "../../src/am/am-versions.ts";'));
  assert(!reachesAm('import { parseFlags } from "../src/am/am-flags.ts";'));
  assert(!reachesAm('import { x } from "../src/team.ts";'));

  assert(armsSandbox('import "./store-sandbox.ts";'));
  assert(armsSandbox('import "../../tests/store-sandbox.ts";'));
  assert(
    armsSandbox('import {\n  childEnv,\n} from "./e2e-app-harness.ts";'),
  );
  // Said, not done: a comment or a dynamic import arms nothing at load.
  assert(!armsSandbox('// import "./store-sandbox.ts";'));
  assert(!armsSandbox('await import("./store-sandbox.ts");'));
  assert(!armsSandbox('import { tempDir } from "../src/testing/temp-dir.ts";'));
});

Deno.test("store sandbox: every test file that reaches am arms it at load", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of Deno.readDirSync(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory) {
        if (e.name !== "node_modules" && e.name !== "fixtures") walk(p);
      } else if (/\.test\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(join(ROOT, "tests"));
  walk(join(ROOT, "amui", "src"));
  const reaching = files.filter((f) => reachesAm(Deno.readTextFileSync(f)));
  // The scan saw the suite (not an empty folder, not a pattern gone stale).
  assert(reaching.length > 100, `only ${reaching.length} files reach am`);
  assertEquals(
    reaching.filter((f) => !armsSandbox(Deno.readTextFileSync(f)))
      .map((f) => relative(ROOT, f)).sort(),
    [],
    'these reach `am` without arming the store sandbox — add `import "./store-sandbox.ts";` as their first import',
  );
});
