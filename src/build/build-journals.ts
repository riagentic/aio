// What a build that DIED leaves behind, by name — and the one cheap question
// a starting app asks about it. Kept apart from build-compile.ts so the boot
// path can ask without loading the build.
import { join } from "@std/path";

/** The links a running build holds aside, written before each removal: ONE
 *  file per build (`.aio-build-links.<pid>-<nonce8><tag>.json`), so two
 *  builds never share a read-modify-write. The name is one an OLDER aio's
 *  pattern (`.<pid>-<hex>`) still reads as its pid's journal; the owner's
 *  start stamp rides in the hex tail. An older build's `.aio-build-links.json`
 *  is still recovered. `<journal>.tmp` is a write killed before its rename. */
export const LINK_JOURNAL_RE =
  /^\.aio-build-links(?:\.(\d+)-([0-9a-f]+))?\.json(?:\.tmp)?$/;

/** A build's trim journal under `<project>/.aio` — one per build, as the link
 *  journal; the un-stamped name is the single pair an older aio wrote. */
export const TRIM_JOURNAL_RE =
  /^trim-journal(?:\.((\d+)-([0-9a-f]+)))?\.json(?:\.tmp)?$/;

/** Does the project at `root` hold a build journal — a build running now, or
 *  one that was killed with `node_modules` links aside and package files in
 *  its trim mirror? Two directory listings and nothing else: every source
 *  start asks (`recoverInterruptedBuild`), and the answer is almost always
 *  no. */
export function buildJournalsIn(root: string): boolean {
  const any = (dir: string, re: RegExp): boolean => {
    try {
      for (const e of Deno.readDirSync(dir)) if (re.test(e.name)) return true;
    } catch {
      // aio-ok: no such directory — no build ever held anything aside there
    }
    return false;
  };
  return any(join(root, ".aio"), TRIM_JOURNAL_RE) ||
    any(join(root, "node_modules"), LINK_JOURNAL_RE);
}
