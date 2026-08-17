// updates-rebuild.ts — taking an update from a git source.
//
// A repository has no published artifact, so "install it" means BUILD it. That
// is a longer path than downloading a binary, and every step of it can fail for
// ordinary reasons, so the whole thing happens in a throwaway clone and touches
// nothing the running app owns until there is a working artifact AND its data
// contract has been checked.
//
// A fresh shallow clone rather than the checkout the app was installed from:
// that directory may not exist any more, may have moved, or may have local
// edits. Reusing it would make an update depend on the state of somebody's
// working tree.
import { join } from "@std/path";
import type { DataContract } from "../build/ship.ts";
import type { Log } from "../diagnostics/logger-api.ts";

export type RebuildResult =
  | { ok: true; artifact: string; contract?: DataContract; sha: string }
  | { ok: false; error: string };

async function run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = await new Deno.Command(cmd, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      ok: p.success,
      out: new TextDecoder().decode(p.stdout).trim(),
      err: new TextDecoder().decode(p.stderr).trim(),
    };
  } catch (e) {
    return {
      ok: false,
      out: "",
      err: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Does this app's deno.json declare the named task? */
async function hasTask(dir: string, task: string): Promise<boolean> {
  try {
    const raw = await Deno.readTextFile(join(dir, "deno.json"));
    const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
      tasks?: Record<string, unknown>;
    };
    return !!cfg.tasks?.[task];
  } catch {
    return false;
  }
}

/** The artifact a build just produced, found by TIME rather than by name.
 *
 *  Exactly the rule `run.sh` uses, and for the same reason: the framework's
 *  binary-naming rules live in the build, and a second copy of them here would
 *  go stale silently. Everything executable created after the marker is a
 *  candidate; an AppImage wins over a plain binary because the Electron target
 *  emits both. */
export async function findBuiltArtifact(
  dir: string,
  after: Date,
): Promise<string | null> {
  let plain: string | null = null;
  const skip = /node_modules|[/\\]\.git[/\\]/;
  const walk = async (d: string, depth: number): Promise<string | null> => {
    if (depth > 3) return null;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(d)];
    } catch {
      return null;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (skip.test(p)) continue;
      if (e.isDirectory) {
        const found = await walk(p, depth + 1);
        if (found) return found;
        continue;
      }
      if (!e.isFile) continue;
      if (/\.(log|sh|ts|tsx|js|json|md|lock)$/i.test(e.name)) continue;
      const st = await Deno.stat(p).catch(() => null);
      if (!st?.mtime || st.mtime < after) continue;
      const executable = Deno.build.os === "windows"
        ? /\.(exe|zip)$/i.test(e.name)
        : ((st.mode ?? 0) & 0o111) !== 0;
      if (!executable) continue;
      if (/\.AppImage$/i.test(e.name)) return p; // decisive
      plain ??= p;
    }
    return null;
  };
  return (await walk(dir, 0)) ?? plain;
}

/** Clone the ref, build it, and ask the result what it does to persisted data.
 *
 *  Returns the artifact WITHOUT installing it. The caller runs the data gate
 *  and does the swap — this function is deliberately unable to touch the
 *  running app. */
export async function rebuildFromGit(opts: {
  source: string;
  /** Branch or tag to follow. */
  ref: string;
  /** Where to work. Removed by the caller. */
  workDir: string;
  log: Log;
}): Promise<RebuildResult> {
  const { log } = opts;
  const src = join(opts.workDir, "src");

  log.info("updates", `cloning ${opts.source} @ ${opts.ref}`);
  const cloned = await run("git", [
    "clone",
    "--depth=1",
    "--branch",
    opts.ref,
    opts.source,
    src,
  ]);
  if (!cloned.ok) {
    return {
      ok: false,
      error: `git clone failed: ${cloned.err || "see the build output"}`,
    };
  }

  const head = await run("git", ["rev-parse", "HEAD"], src);
  if (!head.ok || !/^[0-9a-f]{40}$/.test(head.out)) {
    return {
      ok: false,
      error: `could not read the cloned commit: ${head.err}`,
    };
  }

  // Everything the build produces after this instant is a candidate artifact.
  const marker = new Date();
  // A filesystem with coarse timestamps would otherwise include files the
  // clone itself just wrote.
  await new Promise((r) => setTimeout(r, 1100));

  log.info("updates", `building ${head.out.slice(0, 8)}…`);
  const built = await hasTask(src, "compile")
    ? await run("deno", ["task", "compile"], src)
    : { ok: false, out: "", err: "no `compile` task in the repo's deno.json" };
  if (!built.ok) {
    return {
      ok: false,
      error: `build failed — ${
        built.err.split("\n").slice(-3).join(" ") ||
        "see the app's own build output"
      }`,
    };
  }

  const artifact = await findBuiltArtifact(src, marker);
  if (!artifact) {
    return {
      ok: false,
      error: "the build finished but produced no runnable artifact — run " +
        "`deno task compile` in the repo to see why",
    };
  }

  // What does this build do to the data already on disk? The same question a
  // published manifest answers; here it is asked of the binary directly,
  // because there is no manifest to sign it into.
  let contract: DataContract | undefined;
  const probed = await run(artifact, ["--aio-data-contract"]);
  if (probed.ok) {
    try {
      contract = JSON.parse(probed.out) as DataContract;
    } catch { /* left undefined — the gate treats that as "not declared" */ }
  }

  return { ok: true, artifact, contract, sha: head.out };
}
