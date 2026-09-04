// release-stamp — a tag is cut only from a tree the release check actually ran on.
//
// Four gates were red at the v1.0.0-alpha76 tag while every release note since
// said "all gates green": each claim was a run on SOME earlier tree, and a
// stale green reads exactly like a current one. The proof matrix already
// records physical proofs BY the gate that produced them; this is the same
// idea for the release check as a whole. `check:release` writes this stamp
// only when every gate and surface passed, keyed by the hash of the WORKING
// TREE it ran on — not the commit, because the check runs before the release
// commit exists, and a squash that changes no file keeps the same tree hash.
// `deno task check:release-stamp` then refuses unless the tree at hand is the
// stamped one. Edit one file after the check and the stamp no longer applies.
//
// The stamp lives under `.aio/` (gitignored): it is evidence about this
// machine's run, never something to commit.
//
// Usage:
//   deno run -A scripts/release-stamp.ts            # verify (exit 1 on mismatch)
//   deno run -A scripts/release-stamp.ts --write    # what check:release calls
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
export const STAMP_PATH = ".aio/release-stamp.json";

export type ReleaseStamp = {
  /** `git write-tree` over the working tree (tracked + untracked, minus
   *  ignored) — the content the check saw, regardless of what was staged. */
  tree: string;
  version: string;
  at: string;
};

/** Hash of the working tree as git would store it — through a THROWAWAY
 *  index, so the real one is never touched (staging is the caller's). Untracked
 *  files count (a new test file is content); ignored files do not. */
export async function workingTreeHash(root = ROOT): Promise<string> {
  const index = await Deno.makeTempFile({ prefix: "aio-stamp-index-" });
  await Deno.remove(index); // git wants to create it itself
  const env = { ...Deno.env.toObject(), GIT_INDEX_FILE: index };
  const run = async (...args: string[]) => {
    const p = await new Deno.Command("git", {
      args,
      cwd: root,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (p.code !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`,
      );
    }
    return new TextDecoder().decode(p.stdout).trim();
  };
  try {
    await run("read-tree", "HEAD");
    await run("add", "-A");
    return await run("write-tree");
  } finally {
    await Deno.remove(index).catch(() => {
      // aio-ok: a throwaway index git may never have created
    });
  }
}

export async function readStamp(root = ROOT): Promise<ReleaseStamp | null> {
  try {
    return JSON.parse(
      await Deno.readTextFile(join(root, STAMP_PATH)),
    ) as ReleaseStamp;
  } catch {
    return null; // aio-ok: no stamp is a verdict ("never checked"), reported by verifyStamp
  }
}

export async function writeStamp(
  version: string,
  root = ROOT,
): Promise<ReleaseStamp> {
  const stamp: ReleaseStamp = {
    tree: await workingTreeHash(root),
    version,
    at: new Date().toISOString(),
  };
  await Deno.mkdir(join(root, ".aio"), { recursive: true });
  await Deno.writeTextFile(
    join(root, STAMP_PATH),
    JSON.stringify(stamp, null, 2) + "\n",
  );
  return stamp;
}

/** The verdict `check:release-stamp` prints. `ok` only when a stamp exists AND its
 *  tree is this tree AND its version is the one deno.json declares. */
export async function verifyStamp(
  version: string,
  root = ROOT,
): Promise<{ ok: boolean; reason: string; stamp: ReleaseStamp | null }> {
  const stamp = await readStamp(root);
  if (!stamp) {
    return {
      ok: false,
      stamp,
      reason:
        `no release stamp at ${STAMP_PATH} — check:release has not passed on this machine yet`,
    };
  }
  const tree = await workingTreeHash(root);
  if (stamp.tree !== tree) {
    return {
      ok: false,
      stamp,
      reason: `the tree changed since check:release passed (stamped ${
        stamp.tree.slice(0, 12)
      } at ${stamp.at}, now ${tree.slice(0, 12)}) — run check:release again`,
    };
  }
  if (stamp.version !== version) {
    return {
      ok: false,
      stamp,
      reason:
        `the stamp is for ${stamp.version}, deno.json says ${version} — run check:release again`,
    };
  }
  return {
    ok: true,
    stamp,
    reason: `check:release passed on exactly this tree (${
      tree.slice(0, 12)
    }, ${stamp.at}) for ${version}`,
  };
}

async function declaredVersion(root: string): Promise<string> {
  const dj = JSON.parse(await Deno.readTextFile(join(root, "deno.json"))) as {
    version?: string;
  };
  return dj.version ?? "?";
}

if (import.meta.main) {
  const version = await declaredVersion(ROOT);
  if (Deno.args.includes("--write")) {
    const s = await writeStamp(version, ROOT);
    console.log(`✓ stamped tree ${s.tree.slice(0, 12)} for ${s.version}`);
  } else {
    const v = await verifyStamp(version, ROOT);
    console.log(`${v.ok ? "✓" : "✗"} release stamp: ${v.reason}`);
    if (!v.ok) Deno.exit(1);
  }
}
