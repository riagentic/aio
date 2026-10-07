// Symlinks a test can create on every OS.
//
// Windows wants the link's kind stated whenever the target does not exist yet
// (and a relative target is looked up from the cwd, so it "does not exist"),
// and a real DIRECTORY symlink needs a privilege a stock box does not have —
// the product links directories as junctions for that reason (`dirLinkType`
// in src/am/am-utils.ts), and so do the tests.
import { dirname, resolve } from "@std/path";
import { dirLinkType } from "../src/am/am-utils.ts";

/** A symlink to a FILE (the target may be relative, dangling, or both).
 *  Windows keeps a link's text as written and cannot follow one spelled with
 *  `/` ("the filename … syntax is incorrect"), so there it is written `\\`. */
export function linkFile(target: string, link: string): Promise<void> {
  return Deno.symlink(
    Deno.build.os === "windows" ? target.replaceAll("/", "\\") : target,
    link,
    { type: "file" },
  );
}

/** A symlink to a DIRECTORY. On Windows it is a junction, and a junction's
 *  target is absolute: a relative one is resolved against the link's folder,
 *  which is what a symlink would have meant. Elsewhere `target` is kept as
 *  written. */
export function linkDir(target: string, link: string): Promise<void> {
  const type = dirLinkType();
  return Deno.symlink(
    type === "junction" ? resolve(dirname(link), target) : target,
    link,
    { type },
  );
}

/** `node_modules` for a fixture app, from the fixture's OWN deno.json (which
 *  must say `nodeModulesDir: "auto"` and name its npm deps): `deno install`,
 *  served by the module cache.
 *
 *  The fixtures used to link the framework checkout's `node_modules` instead.
 *  Nothing creates that tree — the repo's deno.json has no `nodeModulesDir` —
 *  so on a fresh clone (CI, the Windows lab) the link dangled and every deno
 *  child died `failed to create directory '…/node_modules/.deno/node_modules':
 *  File exists`, on Linux as on Windows.
 *
 *  With `npm` (`"npm:immer@10.2.0"`), those packages are materialized instead
 *  and the fixture's deno.json is neither read for deps nor needed to opt in —
 *  for an app whose npm deps arrive transitively. */
export async function fixtureNodeModules(
  dir: string,
  ...npm: string[]
): Promise<void> {
  const { success, stderr } = await new Deno.Command(Deno.execPath(), {
    args: npm.length
      ? ["cache", "--quiet", "--no-lock", "--node-modules-dir=auto", ...npm]
      : ["install", "--quiet"],
    cwd: dir,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!success) {
    throw new Error(
      `deno install in ${dir} failed:\n${new TextDecoder().decode(stderr)}`,
    );
  }
}

/** What `Deno.readLink(link)` answers for a link `linkDir(target, link)` made:
 *  `target` as written — on Windows the junction's absolute path. */
export function linkText(target: string, link: string): string {
  return dirLinkType() === "junction" ? resolve(dirname(link), target) : target;
}
