/**
 * @module
 * macOS: offer to move the app into Applications.
 *
 * A `.app` opened from the mounted `.dmg`, or from Downloads, runs where an
 * update cannot replace it — a read-only image, or the random read-only copy
 * macOS makes of a quarantined app (App Translocation; see
 * `macAppUpdateBlocker`). On Windows the one-click `.exe` installs the app as
 * it opens it; on macOS the user is expected to drag the icon first, and one
 * who double-clicks instead gets an app that works and can never update.
 *
 * So the app asks, once, AFTER it is up: a boot is never held by a question,
 * and the pending-update judgement has long been made. "Move" copies the
 * bundle into Applications, clears the quarantine mark from THAT copy (the
 * user approved this very code a moment ago; with the mark left on, macOS
 * would translocate the copy too), shuts the app down the ordinary way and
 * opens the copy. "Not Now" is remembered in the data directory.
 *
 * Nothing here replaces a bundle: an app of the same name already in
 * Applications means no offer at all.
 */
import { basename, dirname, join } from "@std/path";
import type { Log } from "../diagnostics/logger-api.ts";
import { macAppDir, RELAUNCH_FLAG } from "./updates-apply.ts";
import { neutralCwd, outlivingParent } from "./no-console.ts";
import { moveFile } from "../diagnostics/rename-over.ts";

/** `AIO_MOVE_TO_APPLICATIONS`: `never` — no offer; `move` — move without
 *  asking (an unattended install, and how a test drives it); anything else,
 *  or unset — ask. */
export const MOVE_ENV = "AIO_MOVE_TO_APPLICATIONS";

/** The data-directory file that says the user answered "Not Now". */
export const MOVE_DECLINED_FILE = "macos-move-declined";

const OFF = new Set(["never", "0", "false", "off", "no"]);

/** Where the running bundle would be moved, or null when there is nothing to
 *  offer. Pure — every fact is handed in, so each row is a test on any host. */
export function moveOffer(f: {
  os: string;
  execPath: string;
  home: string | undefined;
  /** `AIO_MOVE_TO_APPLICATIONS`. */
  env: string | undefined;
  /** The user said "Not Now" before. */
  declined: boolean;
  exists: (path: string) => boolean;
  canWrite: (dir: string) => boolean;
}): { app: string; dest: string } | null {
  if (f.os !== "darwin") return null;
  const mode = (f.env ?? "").trim().toLowerCase();
  if (OFF.has(mode)) return null;
  const app = macAppDir(f.execPath);
  if (!app) return null;
  const home = f.home?.replace(/\/+$/, "");
  const userApps = home ? `${home}/Applications` : null;
  if (app.startsWith("/Applications/")) return null;
  if (userApps && app.startsWith(`${userApps}/`)) return null;
  const name = basename(app);
  // A copy of that name is already installed: which of the two the user means
  // to keep is theirs to decide, and nothing here replaces a bundle.
  if (f.exists(`/Applications/${name}`)) return null;
  if (userApps && f.exists(`${userApps}/${name}`)) return null;
  if (f.declined && mode !== "move") return null;
  const dir = f.canWrite("/Applications") ? "/Applications" : userApps;
  if (!dir) return null;
  return { app, dest: `${dir}/${name}` };
}

/** The question, as an `osascript` argv. The text travels as ARGUMENTS, never
 *  inside the script, so a title holding a quote is a title. Pure. */
export function moveDialogArgs(
  title: string,
  icon: string | null,
): string[] {
  const withIcon = icon ? " with icon POSIX file (item 3 of argv)" : "";
  return [
    "-e",
    "on run argv",
    "-e",
    "tell me to activate",
    "-e",
    `set r to display dialog (item 1 of argv) with title (item 2 of argv) ` +
    `buttons {"Not Now", "Move to Applications"} default button 2 ` +
    `cancel button 1${withIcon} giving up after 600`,
    "-e",
    'if gave up of r then return "gave up"',
    "-e",
    "return button returned of r",
    "-e",
    "end run",
    `Move ${title} to your Applications folder?\n\n` +
    `It was opened from where it was downloaded. There it cannot update ` +
    `itself. Moving copies it into Applications and reopens it from there.`,
    title,
    ...(icon ? [icon] : []),
  ];
}

/** What the user answered. `unanswered`: the dialog could not be shown, was
 *  left alone, or failed — nothing is remembered, the next start asks again. */
export type MoveAnswer = "move" | "later" | "unanswered";

/** Read `osascript`'s result. A pressed cancel button ("Not Now") is exit 1
 *  with "User canceled" (-128) on stderr. Pure. */
export function moveAnswer(
  r: { code: number; stdout: string; stderr: string },
): MoveAnswer {
  if (r.code === 0) {
    return r.stdout.trim() === "Move to Applications" ? "move" : "unanswered";
  }
  return /-128|User canceled/i.test(r.stderr) ? "later" : "unanswered";
}

type Run = (
  cmd: string,
  args: string[],
  /** Aborted → the child is ended (SIGTERM). */
  signal?: AbortSignal,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const run: Run = async (cmd, args, signal) => {
  const o = await new Deno.Command(cmd, {
    args,
    signal,
    cwd: neutralCwd(),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return {
    code: o.code,
    stdout: d.decode(o.stdout),
    stderr: d.decode(o.stderr),
  };
};

/** Copy `app` to `dest`, whole, and clear the quarantine mark from the copy.
 *  Made beside `dest` under another name and renamed into place, so a copy cut
 *  short is never a bundle named like the app. Throws with what failed; what
 *  it made is removed. */
export async function copyToApplications(
  app: string,
  dest: string,
  deps: { run?: Run; log?: Log; pid?: number } = {},
): Promise<void> {
  const exec = deps.run ?? run;
  const staged = `${dest}.moving-${deps.pid ?? Deno.pid}`;
  await Deno.mkdir(dirname(dest), { recursive: true });
  try {
    // `ditto`, not a recursive copy: symlinks stay links and the signature's
    // extended attributes come along — a sealed bundle stays sealed.
    const copy = await exec("/usr/bin/ditto", [app, staged]);
    if (copy.code !== 0) {
      throw new Error(`ditto exited ${copy.code}: ${copy.stderr.trim()}`);
    }
    const mark = await exec("/usr/bin/xattr", [
      "-dr",
      "com.apple.quarantine",
      staged,
    ]);
    if (mark.code !== 0) {
      // Not fatal: the copy is whole. macOS may run it translocated, and the
      // updater then says so by name.
      deps.log?.warn(
        "macos",
        `the quarantine mark could not be cleared from ${staged} ` +
          `(${mark.stderr.trim() || `xattr exited ${mark.code}`}) — the ` +
          `moved app may still be unable to update itself`,
      );
    }
    await moveFile(staged, dest);
  } catch (e) {
    try {
      await Deno.remove(staged, { recursive: true });
    } catch (gone) {
      if (!(gone instanceof Deno.errors.NotFound)) {
        deps.log?.warn("macos", `left behind: ${staged} (${gone})`);
      }
    }
    throw e;
  }
}

/** The command that opens the moved app once this process is gone: through
 *  LaunchServices, like a Dock click, carrying the relaunch flag so the
 *  successor waits for this pid before it asks for the single-instance lock.
 *  Pure. */
export function openMovedCommand(
  dest: string,
  args: string[],
  pid: number,
): [string, string[]] {
  return ["/usr/bin/open", [
    "-n",
    dest,
    "--args",
    ...args.filter((a) => !a.startsWith(RELAUNCH_FLAG)),
    `${RELAUNCH_FLAG}=${pid}`,
  ]];
}

function isThere(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (e) {
    // Unreadable is "there": the question is whether the name is taken.
    return !(e instanceof Deno.errors.NotFound);
  }
}

function dirWritable(dir: string): boolean {
  const probe = join(dir, `.aio-move-probe-${Deno.pid}`);
  try {
    Deno.mkdirSync(probe);
    Deno.removeSync(probe);
    return true;
  } catch {
    // aio-ok: a probe — "cannot write here" is the answer, not a failure.
    return false;
  }
}

/** Ask, and on "Move" copy, shut down, and open the copy. Never throws and
 *  never holds the boot: call it un-awaited once the app is up. Resolves to
 *  what happened, for the log line and the tests. */
export async function offerMoveToApplications(deps: {
  title: string;
  dataDir: string;
  argv: string[];
  log: Log;
  /** The app's one shutdown; the process exits after it. */
  shutdown: () => Promise<void>;
  /** Resolves true once the app's WINDOW is up, false when it never came.
   *  Measured on macOS 14: asked while the window was still starting, the
   *  dialog's process checked in with the window server first and took the
   *  launch's entry in the system's application list — the entry the Dock
   *  and "quit" address — and the window got a second one. */
  windowUp: () => Promise<boolean>;
  /** Aborted when the app's shutdown begins: the question goes with the app.
   *  Measured on macOS 26: without it the dialog stayed on screen, for up to
   *  its ten minutes, after the app that asked had quit. */
  stopSignal?: AbortSignal;
  /** Test seams. */
  os?: string;
  execPath?: string;
  home?: string;
  env?: string;
  run?: Run;
  exists?: (path: string) => boolean;
  canWrite?: (dir: string) => boolean;
  spawn?: (cmd: string, args: string[]) => void;
  exit?: (code: number) => void;
  pid?: number;
}): Promise<"none" | "moved" | "later" | "unanswered" | "failed"> {
  const log = deps.log;
  try {
    const declinedFile = join(deps.dataDir, MOVE_DECLINED_FILE);
    const env = deps.env ?? Deno.env.get(MOVE_ENV);
    const offer = moveOffer({
      os: deps.os ?? Deno.build.os,
      execPath: deps.execPath ?? Deno.execPath(),
      home: deps.home ?? Deno.env.get("HOME"),
      env,
      declined: isThere(declinedFile),
      exists: deps.exists ?? isThere,
      canWrite: deps.canWrite ?? dirWritable,
    });
    if (!offer) return "none";
    if (!await deps.windowUp()) return "none";
    // Checked here too: a child spawned on an already-aborted signal is not
    // promised to be ended by it.
    if (deps.stopSignal?.aborted) return "none";
    const exec = deps.run ?? run;
    let answer: MoveAnswer = "move";
    if ((env ?? "").trim().toLowerCase() !== "move") {
      const icon = join(offer.app, "Contents", "Resources", "AppIcon.icns");
      answer = moveAnswer(
        await exec(
          "/usr/bin/osascript",
          moveDialogArgs(deps.title, isThere(icon) ? icon : null),
          deps.stopSignal,
        ),
      );
    }
    if (answer === "later") {
      await Deno.writeTextFile(declinedFile, `${new Date().toISOString()}\n`);
      log.info(
        "macos",
        `not moved to Applications ("Not Now") — not asked again; delete ` +
          `${declinedFile} to be asked`,
      );
      return "later";
    }
    if (answer !== "move") return "unanswered";
    await copyToApplications(offer.app, offer.dest, {
      run: exec,
      log,
      pid: deps.pid,
    });
    log.info(
      "macos",
      `copied ${offer.app} to ${offer.dest}; closing this copy and ` +
        `opening that one`,
    );
    const pid = deps.pid ?? Deno.pid;
    const [cmd, args] = openMovedCommand(offer.dest, deps.argv, pid);
    try {
      await deps.shutdown();
    } catch (e) {
      // The copy stays where it is — it is a whole, working app. This one
      // goes on rather than exit half-stopped onto a successor.
      log.error(
        "macos",
        `the app is in ${offer.dest}, but this copy could not shut down ` +
          `(${e}) — quit it and open the one in Applications`,
      );
      return "failed";
    }
    (deps.spawn ?? ((c, a) => {
      new Deno.Command(c, {
        args: a,
        cwd: neutralCwd(),
        stdin: "null",
        stdout: "null",
        stderr: "null",
        ...outlivingParent(),
      }).spawn().unref();
    }))(cmd, args);
    (deps.exit ?? Deno.exit)(0);
    return "moved";
  } catch (e) {
    log.warn(
      "macos",
      `could not move the app to Applications (${
        e instanceof Error ? e.message : e
      }) — it runs on from where it is; drag it to Applications by hand`,
    );
    return "failed";
  }
}
