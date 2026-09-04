/**
 * @module
 * `am remove <app>` — uninstall an app that `run.sh` installed.
 *
 * The one-line installer puts a built app under `~/app/<name>/`, drops a
 * `.desktop` entry and (for headless targets) a `~/.local/bin` symlink. Nothing
 * took them away again: "install" existed and "uninstall" did not, so the only
 * way back was to remember all three locations and delete them by hand — which
 * is exactly the knowledge an uninstaller exists to hold.
 *
 * The line this command will not cross: it removes the PROGRAM, never the
 * DATA. `~/.<appId>/` holds state, logs, keys and user files, and deleting
 * those because someone wanted the binary gone is unrecoverable. `--data` asks
 * for that explicitly, and the summary always names what was kept and how to
 * remove it.
 */

import { join, resolve, SEPARATOR } from "@std/path";
import {
  appDirs,
  appsRoot,
  installedAppParents,
  installedAppPaths,
  installRoot,
} from "../server/app-dirs.ts";
import type { GlobalFlags } from "./am-types.ts";
import {
  count,
  detectMode,
  heading,
  hints,
  indent,
  mark,
  out,
  outError,
  stack,
  style,
  table,
} from "./am-output.ts";
import { instances } from "../server/single-instance-lock.ts";
import { readRecord } from "../server/install-record.ts";
import { readPending } from "../server/updates-apply.ts";
import { cmdUpdate } from "./am-cmd-meta.ts";
import { appNameError } from "./am-utils.ts";

/** Deleting an app's DATA is the one step with no way back — `~/.<appId>/`
 *  holds state, logs, keys and user files, and no reinstall returns them. So
 *  it is confirmed at a terminal, and in a script it has to be said twice
 *  (`--data --force`) instead of once. Pure — the caller does the prompting,
 *  so both branches are testable without a tty.
 *
 *  The PROGRAM is not confirmed: reinstalling it is one command. */
export function dataRemovalGate(
  opts: { data: boolean; force: boolean; interactive: boolean },
): "skip" | "ask" | "force" | "refuse" {
  if (!opts.data) return "skip";
  if (opts.force) return "force";
  return opts.interactive ? "ask" : "refuse";
}

/** Is `path` a path this command may delete — a PROPER descendant of `parent`?
 *
 *  `appNameError` refuses `.`, `..` and `a/b` because `join()` normalizes them,
 *  and its own message says why: "am remove .. would delete $HOME". That guard
 *  was the only thing standing between a name and a recursive delete of the
 *  user's home, and two of the three paths an install occupies are built from
 *  `homedir()` rather than from `installRoot()`, so no sandbox variable moves
 *  them:
 *
 *      installedAppPaths("..").binLink  →  ~/.local
 *      installedAppPaths("../..").binLink  →  ~
 *
 *  One guard, one mistake away from the whole home directory. This is the
 *  second one, and it does not depend on the name at all: whatever the name
 *  resolved to, the path must sit strictly inside the directory that owns it.
 *  Equal-to-parent is refused as firmly as outside-it — deleting the parent is
 *  the failure mode, not a boundary case.
 *
 *  (Written after a mutation test disabled `appNameError` and the traversal
 *  case removed ~/.local before the assertion could fail.) */
export function insideParent(path: string, parent: string): boolean {
  const p = resolve(path);
  const base = resolve(parent);
  if (p === base) return false;
  return p.startsWith(base.endsWith(SEPARATOR) ? base : base + SEPARATOR);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Is the directory under `installRoot()` named `name` an aio INSTALL, rather
 *  than just a directory that happens to live there?
 *
 *  `~/app` (and `AIO_INSTALL_ROOT`) is a plain directory a person may keep
 *  anything in. "Installed" was defined as "a directory exists there" — no
 *  record, no marker — so `am installed` listed the machine's `lmstudio`,
 *  `obsidian`, `discord`, `mega` and `ledger` folders, and `am remove
 *  <any-of-them>` recursively deleted one with exit 0 and no confirmation.
 *  `am upgrade` already requires a record ("no install record for X"); one
 *  fact, two homes, and the destructive verb had the looser one. The two
 *  existing guards (`appNameError`, "THE SECOND GUARD") both check the path's
 *  SHAPE; neither checks membership.
 *
 *  Evidence, any one of: an install record; the stable launcher aio writes
 *  (`<dir>/<name>`); or a `versions/` directory (the rollback layout). */
export async function isAioInstall(name: string): Promise<boolean> {
  if (await readRecord(name) !== null) return true;
  const p = installedAppPaths(name);
  if (await exists(p.stable)) return true;
  return await exists(join(p.dir, "versions"));
}

/** Every path an install created, and whether it is there. Pure enough to
 *  print before anything is deleted. */
export async function installedFootprint(name: string): Promise<
  { path: string; kind: string; present: boolean; parent: string }[]
> {
  const p = installedAppPaths(name);
  const parents = installedAppParents();
  const out: {
    path: string;
    kind: string;
    present: boolean;
    parent: string;
  }[] = [];
  // Each path travels with the directory that owns it, so the removal loop can
  // check containment without re-deriving where anything is supposed to live.
  for (
    const [path, kind, parent] of [
      [p.dir, "the app and its versions", parents.dir],
      [p.desktop, "menu entry", parents.desktop],
      [p.binLink, "PATH symlink", parents.binLink],
    ] as const
  ) {
    out.push({ path, kind, parent, present: await exists(path) });
  }
  return out;
}

export async function cmdRemove(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const name = args[0] ?? flags.app;
  if (!name) {
    outError(
      `which app? usage: am remove <name> [--data]\n` +
        `  installed apps live in ${installRoot()}`,
      mode,
    );
    Deno.exit(1);
  }
  // `join()` NORMALIZES, so an unvalidated name is a path traversal with a
  // recursive delete on the end of it: `am remove ..` resolved to $HOME and
  // ~/.local and removed both (measured, exit 0). See appNameError.
  const nameErr = appNameError(name, "am remove");
  if (nameErr) {
    outError(nameErr, mode);
    Deno.exit(1);
  }

  const footprint = await installedFootprint(name);
  const present = footprint.filter((f) => f.present);
  const dataDir = appDirs(name).home;
  const hasData = await exists(dataDir);

  if (present.length === 0 && !(flags.data && hasData)) {
    outError(
      `nothing installed as "${name}" under ${installRoot()}` +
        (hasData
          ? `\n  (its DATA is still at ${dataDir} — remove it with: am remove ${name} --data)`
          : ""),
      mode,
    );
    Deno.exit(1);
  }

  // Data is unrecoverable, so it is confirmed before anything is deleted —
  // not after the program is already gone.
  const gate = dataRemovalGate({
    data: !!flags.data && hasData,
    force: !!flags.force,
    interactive: Deno.stdin.isTerminal() && mode === "pretty",
  });
  if (gate === "refuse") {
    outError(
      `am remove ${name} --data would DELETE ${dataDir} — state, logs, ` +
        `keys and user files. There is no undo and no reinstall that brings ` +
        `them back.\n` +
        `  This is not a terminal, so it cannot be confirmed here.\n` +
        `  fix: am remove ${name} --data --force   (say it twice, on purpose)\n` +
        `  or:  am remove ${name}                  (removes the PROGRAM, keeps the data)`,
      mode,
    );
    Deno.exit(1);
  }

  // MEMBERSHIP, before the recursive delete. See `isAioInstall`.
  // Only when a directory is actually THERE: with none, "nothing installed as
  // …, its data is still at …" is the answer a person is looking for, and it
  // already exists below.
  if (
    !flags.force && await exists(installedAppPaths(name).dir) &&
    !await isAioInstall(name)
  ) {
    outError(
      `"${name}" is a directory under ${installRoot()}, but it is not an aio ` +
        `install: no install record, no launcher, no versions/. Refusing to ` +
        `delete it — this command runs a recursive remove, and that directory ` +
        `is not aio's.\n` +
        `  If it really is one (a very old install), re-run with --force.`,
      mode,
    );
    Deno.exit(1);
  }

  if (gate === "ask") {
    const answer = prompt(
      `DELETE ${dataDir} — state, logs, keys, user files? There is no undo.\n` +
        `  type the app name to confirm:`,
    );
    if (answer?.trim() !== name) {
      outError(`not confirmed — nothing was removed`, mode);
      Deno.exit(1);
    }
  }

  // A running app whose binary is deleted keeps running from an unlinked
  // inode and dies confusingly at the next restart, so this refuses instead.
  const running = (await instances()).find((i) => i.appId === name);
  if (running && !flags.force) {
    outError(
      `"${name}" is running (pid ${running.pid}) — stop it first:\n` +
        `      am stop --app=${name}\n` +
        `  or re-run with --force to remove it anyway`,
      mode,
    );
    Deno.exit(1);
  }

  // THE SECOND GUARD. `appNameError` above refuses the names that resolve
  // outside an app's own directories; this refuses the PATHS, whatever name
  // produced them. Two guards because the first one is one edit away from the
  // user's home directory: `installedAppPaths("..").binLink` is `~/.local`,
  // and `Deno.remove(…, { recursive: true })` does not ask twice.
  const escaping = [...present, {
    path: dataDir,
    kind: "app data",
    parent: appsRoot(),
  }].filter((f) => !insideParent(f.path, f.parent));
  if (escaping.length > 0) {
    outError(
      `refusing to remove "${name}": ${
        escaping.map((f) => `${f.path} is not inside ${f.parent}`).join("; ")
      }.\n` +
        `  This is a bug in aio, not something you did — please report it with ` +
        `this line (\`am report\`).`,
      mode,
    );
    Deno.exit(1);
  }

  const removed: string[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const f of present) {
    try {
      await Deno.remove(f.path, { recursive: true });
      removed.push(f.path);
    } catch (e) {
      failed.push({ path: f.path, error: String(e) });
    }
  }

  let dataRemoved = false;
  if (flags.data && hasData) {
    try {
      await Deno.remove(dataDir, { recursive: true });
      removed.push(dataDir);
      dataRemoved = true;
    } catch (e) {
      failed.push({ path: dataDir, error: String(e) });
    }
  }

  if (failed.length > 0) {
    outError(
      `removed ${count(removed.length, "path")}; could NOT remove:\n` +
        failed.map((f) => `  ${f.path} — ${f.error}`).join("\n"),
      mode,
    );
    Deno.exit(1);
  }

  if (mode === "json") {
    out({
      removed,
      dataRemoved,
      dataKept: dataRemoved ? null : (hasData ? dataDir : null),
    }, mode);
    return;
  }
  out(
    `✓ removed ${name}\n` +
      removed.map((r) => `    ${r}`).join("\n") +
      (hasData && !dataRemoved
        ? `\n\n  KEPT its data: ${dataDir}\n` +
          `  (state, logs, keys, user files — remove with: am remove ${name} --data)`
        : ""),
    mode,
  );
}

/** `~/app` may hold apps this machine has forgotten about; listing them is how
 *  someone finds the name to pass to `remove`. */
export async function cmdInstalled(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const root = installRoot();
  type Row = {
    name: string;
    path: string;
    version?: string;
    source?: string;
    aioVersion?: string;
    installedAt?: string;
    versions: number;
  };
  const apps: Row[] = [];
  try {
    for await (const e of Deno.readDir(root)) {
      if (!e.isDirectory) continue;
      // The kept rollbacks are DIRECTORIES: `<app>/versions/<version>/<app><ext>`
      // (install-record.ts `pruneVersions`, updates-apply.ts). Counting flat
      // `<app>-<version>` files was the layout before that, so this quietly
      // reported "1 version" for every app however many it was keeping.
      let versions = 0;
      try {
        for await (const f of Deno.readDir(join(root, e.name, "versions"))) {
          if (f.isDirectory) versions++;
        }
      } catch { /* no versions/ (an older install) — still list the app */ }
      const rec = await readRecord(e.name);
      // Only aio's own — `installRoot()` is a plain directory a person keeps
      // other things in, and listing them here is what made `am remove` look
      // like it had a right to delete them.
      if (!await isAioInstall(e.name)) continue;
      apps.push({
        name: e.name,
        path: join(root, e.name),
        version: rec?.version,
        source: rec?.source,
        aioVersion: rec?.aioVersion,
        installedAt: rec?.installedAt,
        versions,
      });
    }
  } catch {
    out(
      mode === "json"
        ? { root, apps: [] }
        : `no installed apps (${root} does not exist)`,
      mode,
    );
    return;
  }
  if (mode === "json") {
    out({ root, apps }, mode);
    return;
  }
  // A TABLE, because it is one: an app per row, and the same four facts on
  // every row. The old shape put `from …` and `built against aio …` on their
  // own indented lines under each app, so twelve installed apps was a
  // forty-line block in which nothing could be compared to anything.
  out(
    { root, apps },
    mode,
    () =>
      apps.length === 0
        ? stack(
          `${mark("note")} ${style.dim(`no installed apps in ${root}`)}`,
          hints([["am create <name>", "scaffold one"]]),
        )
        : stack(
          heading(count(apps.length, "app"), `installed in ${root}`),
          indent(table(
            apps.map((a) => ({
              APP: a.name,
              VERSION: a.version ?? style.dim("—"),
              AIO: a.aioVersion ?? style.dim("—"),
              KEPT: a.versions > 1 ? String(a.versions) : "",
              FROM: a.source ?? "",
            })),
            {
              columns: [
                "APP",
                "VERSION",
                "AIO",
                { key: "KEPT", align: "right" },
                "FROM",
              ],
            },
          )),
        ),
  );
}

/** `am upgrade <app>` — rebuild and reinstall an app from where it came from.
 *
 *  An installed app was a one-way door: the in-app updater only helps when its
 *  author configured `updates`, and otherwise the only way forward was to
 *  remember the repo URL and re-run the one-liner by hand. The install record
 *  knows the source, so this re-runs exactly that — same script, same install
 *  path, same pruning — and reports the version it moved between. */
/** Is this `am upgrade` argument a framework checkout DIRECTORY rather than
 *  an installed app's name? A path (has a separator, or starts with `.`/`~`)
 *  or an existing directory holding `mod.ts` — an app name is neither. */
export function isCheckoutArg(arg: string): boolean {
  if (/[\/\\]/.test(arg) || arg.startsWith(".") || arg.startsWith("~")) {
    return true;
  }
  try {
    return Deno.statSync(`${arg}/mod.ts`).isFile;
  } catch {
    return false;
  }
}

export async function cmdUpgrade(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const name = args[0] ?? flags.app;
  // ONE verb for "make it newer", and the OBJECT says what:
  //
  //   am upgrade              am itself
  //   am upgrade <app>        that installed app
  //   am upgrade <checkout>   the GLOBAL am → that checkout's (dev) am
  //
  // It used to be two words — `update` for am, `upgrade` for an app — which is
  // a distinction no one can guess from the words, only from having been told.
  // `am update` is gone (alpha70); the CLI names this verb when it is typed.
  if (!name) return await cmdUpdate([], flags);
  if (isCheckoutArg(name)) return await cmdUpdate([name], flags);
  // Same reason as `am remove`: this name reaches installedAppPaths/appDirs
  // and, through run.sh, an install path.
  const upNameErr = appNameError(name, "am upgrade");
  if (upNameErr) {
    outError(upNameErr, mode);
    Deno.exit(1);
  }
  const rec = await readRecord(name);
  if (!rec) {
    outError(
      `no install record for "${name}" in ${installRoot()}\n` +
        `  (installed before records existed? re-run the one-liner for it once)`,
      mode,
    );
    Deno.exit(1);
  }
  if (!rec.source) {
    outError(
      `"${name}" has no recorded source — nothing to re-run.\n` +
        `  Re-install it with: curl -fsSL <run.sh> | sh -s <repo>`,
      mode,
    );
    Deno.exit(1);
  }
  // TWO updaters, one artifact. `am upgrade` rebuilds and reinstalls from the
  // recorded source; the app's own updater may have swapped a release in
  // minutes ago and be waiting for the next boot to decide whether it worked.
  // Running both is how the version a rollback marker names as `previous` gets
  // pruned out from under it — the app then fails, tries to roll back, and
  // finds nothing to roll back TO. So: refuse, name the fix.
  const pending = readPending(appDirs(name).data);
  if (pending) {
    outError(
      `"${name}" has an in-app update in flight (${pending.from} → ` +
        `${pending.to}) that has not yet proven itself.\n` +
        `  Upgrading now could delete the version it would roll back to.\n` +
        `  Start the app once and let it confirm or roll back, then retry.\n` +
        `  (or, to force it: rm ${
          join(appDirs(name).data, "update-pending.json")
        })`,
      mode,
    );
    Deno.exit(1);
  }

  const running = (await instances()).find((i) => i.appId === name);
  if (running) {
    // Not a refusal: the swap is a symlink move, so it is safe. But the
    // process keeps running the OLD artifact until it restarts, and someone
    // who does not know that will report the upgrade as broken.
    out(
      mode === "json"
        ? { warning: "running", pid: running.pid }
        : `note: "${name}" is running (pid ${running.pid}) — it keeps the old ` +
          `version until you restart it`,
      mode,
    );
  }

  const runSh = join(
    Deno.env.get("AIO_HOME") ??
      join(Deno.env.get("HOME") ?? "", ".local/lib/aio"),
    "run.sh",
  );
  try {
    await Deno.stat(runSh);
  } catch {
    outError(`cannot find run.sh at ${runSh} (set AIO_HOME)`, mode);
    Deno.exit(1);
  }

  const before = rec.version;
  // `run.sh <arg>` CLONES its argument — right for a repo URL, wrong for a
  // local checkout, where it would clone the directory into itself and then
  // look for deno.json one level too deep. A local source is upgraded by
  // building IN it, which is what a person would do by hand.
  let local = false;
  try {
    local = (await Deno.stat(rec.source)).isDirectory;
  } catch { /* not a path — treat as a URL */ }
  const work = local ? rec.source : await Deno.makeTempDir({
    prefix: `aio-upgrade-${name}-`,
  });
  const p = await new Deno.Command("sh", {
    args: local ? [runSh, "--no-run"] : [runSh, rec.source, "--no-run"],
    cwd: work,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!p.success) {
    outError(`upgrade failed — the output above says why`, mode);
    Deno.exit(1);
  }
  const after = (await readRecord(name))?.version;
  out(
    mode === "json"
      ? { upgraded: name, from: before ?? null, to: after ?? null }
      : after && before && after !== before
      ? `✓ ${name} ${before} → ${after}`
      : `✓ ${name} reinstalled${after ? ` (${after})` : ""}`,
    mode,
  );
}
