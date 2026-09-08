/**
 * @module
 * `am feedback` — where an app's findings about aio actually go.
 *
 * The project asks every app built on aio to write its rough edges down, and
 * `.katana/_aio.md` said, four times, to put them in `dep/aio/feedback/<app>.md`.
 * That path is wrong in two different ways, and both of them cost the project
 * exactly the reports it was asking for:
 *
 * 1. `dep/aio` under a VERSION pin is a provisioned worktree of a release, and
 *    a release excludes `feedback/` — correctly, it holds other people's
 *    private reports. So the directory the instruction names does not exist at
 *    all, precisely when an app has done the recommended thing and pinned.
 * 2. `dep/aio` is INSIDE the version store (`~/.local/lib/aio-versions/<ref>`).
 *    A file written there belongs to one version: `am pin latest` provisions a
 *    new directory and the notes are orphaned, and pruning an old version
 *    deletes them outright.
 *
 * A findings file has to outlive the framework version it was written against
 * — that is the whole point of it. So it lives in one place that no upgrade
 * touches, and this command is the one decider for where that is: nothing else
 * computes the path, and the kata now names the command instead of a path that
 * drifts.
 */
import { join } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out } from "./am-output.ts";
import { homedir } from "../server/paths.ts";

/** Stable home for findings, independent of any pinned framework version.
 *
 *  `AIO_FEEDBACK_DIR` overrides it (a test, a shared team location, a repo
 *  that keeps its reports in-tree). Otherwise the XDG data home — the same
 *  vocabulary the rest of aio uses for files that belong to the USER rather
 *  than to an app or a version. */
export function feedbackDir(): string {
  const override = Deno.env.get("AIO_FEEDBACK_DIR");
  if (override) return override;
  const dataHome = Deno.env.get("XDG_DATA_HOME") ??
    join(homedir(), ".local", "share");
  return join(dataHome, "aio", "feedback");
}

/** The file one app's findings go in. `name` is used as a filename, so it is
 *  reduced to something that safely is one — a slug, never a path. A name that
 *  escapes its directory is the difference between a note and an overwrite. */
export function feedbackFile(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return join(feedbackDir(), `${slug || "app"}.md`);
}

/** The heading a fresh findings file opens with — enough that a reader (or an
 *  agent) knows what the file is for without being told twice. */
function template(name: string): string {
  return `# ${name} — findings against aio

Rough edges, bugs, and "this should be easier" notes from building ${name}.
Written for the aio maintainers: say what you tried, what happened, and what
you expected. A report that names the version and the file it happened in is
worth several that do not.

Framework version: run \`am pin\` to print the one this app builds against.

## 1 ·
`;
}

export async function cmdFeedback(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const dir = feedbackDir();
  const name = args.find((a) => !a.startsWith("-"));
  const create = args.includes("--create");

  if (!name) {
    // No app named: report the directory itself. Created on demand, because a
    // path that is printed and does not exist is a path the reader has to
    // second-guess.
    await Deno.mkdir(dir, { recursive: true });
    let files: string[] = [];
    try {
      for await (const e of Deno.readDir(dir)) {
        if (e.isFile && e.name.endsWith(".md")) files.push(e.name);
      }
    } catch {
      // aio-ok: the directory was just created; an unreadable one is reported
      // by the listing being empty, and the path below is still the answer.
    }
    files = files.sort();
    out({ dir, files }, mode, () =>
      [
        `feedback dir  ${dir}`,
        files.length
          ? `reports       ${files.join(", ")}`
          : `reports       none yet`,
        ``,
        `This location is deliberate: it is OUTSIDE the version store, so`,
        `\`am pin latest\` and pruning an old version cannot delete it.`,
        `Write findings to \`am feedback <app-name>\` — never to dep/aio/feedback,`,
        `which belongs to one pinned version and is absent from a release.`,
      ].join("\n"));
    return;
  }

  const file = feedbackFile(name);
  const existed = await exists(file);
  if (create && !existed) {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(file, template(name));
  }
  out({ file, exists: existed || create, dir }, mode, () =>
    [
      `report file   ${file}`,
      existed
        ? `status        exists`
        : create
        ? `status        created`
        : `status        not created yet — \`am feedback ${name} --create\``,
    ].join("\n"));
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}
