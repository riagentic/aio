/**
 * @module
 * macOS `.dmg` finalization — the one step that genuinely needs macOS.
 *
 * A `.dmg` is a disk image, not an archive. Making a canonical compressed one
 * (UDZO) is `hdiutil`, an Apple tool; there is no supported equivalent on
 * Linux. That is a TOOL constraint, exactly like `appimagetool` for a Linux
 * AppImage — and it is the only one, because the `.app` itself is assembled on
 * any host (see `macos-app.ts`) and `scp` moves a directory.
 *
 * Three strategies, chosen by what is available and never guessed:
 *
 *  1. **native** — the build host IS macOS: run `hdiutil` directly.
 *  2. **remote** — `AIO_MACOS_SSH=<host>` (or `[build.macos] host` in
 *     deno.json) names a Mac reachable over SSH: ship the `.app` there, run
 *     `hdiutil`, fetch the `.dmg` back. This is the documented, scriptable way
 *     to produce a real DMG from Linux/Windows CI, and the reason a Linux
 *     developer with one Mac (or a macOS runner) is not blocked.
 *  3. **refusal** — neither: a loud, actionable error. It never falls back to
 *     a zip renamed `.dmg`, because a file that will not mount on the target is
 *     exactly the class of silent wrongness this framework refuses.
 *
 * The remote path deliberately uses only `tar` + `ssh` + `hdiutil`: no daemon,
 * no shared filesystem, no assumption about the Mac beyond OpenSSH (default on
 * every macOS since 10.7) and the key being authorised.
 */
import { dirname, join } from "@std/path";
import { NO, OK } from "../diagnostics/fmt.ts";

/** Single-quote `s` for bash — the one quoting rule every script here uses. */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Where a Mac that can run `hdiutil` lives, from the environment. */
export const MACOS_HOST_ENV = "AIO_MACOS_SSH";

/** A `ssh`/`scp` destination: `[user@]host` (an `~/.ssh/config` alias works
 *  too, which is the recommended way to pin a key and port). */
export interface MacHost {
  /** The `[user@]host` ssh target. */
  target: string;
  /** Optional remote scratch directory (defaults to `$TMPDIR` on the Mac). */
  remoteDir?: string;
}

/** Resolve the configured Mac, or null. `declared` (deno.json) outranks the
 *  environment, so a repo can pin its runner without every developer having to
 *  export a variable. Pure over its inputs. */
export function resolveMacHost(
  declared?: string | null,
  env: string | undefined = Deno.env.get(MACOS_HOST_ENV),
): MacHost | null {
  const raw = (declared ?? "").trim() || (env ?? "").trim();
  if (!raw) return null;
  return { target: raw };
}

/** The shared tail of BOTH DMG paths (on a Mac, and on a Mac over SSH): seal
 *  the staged `.app`, add the `/Applications` link users drag onto, and image
 *  the stage. One tail, so a DMG built on a Mac and one built from Linux are
 *  the same file — the native path used to image the bare `.app`, with no
 *  drag-to-Applications target.
 *
 *  `-srcfolder` is the supported way to build a folder-based image; `UDZO` is
 *  zlib compression, the format every shipped `.dmg` uses; `-ov` overwrites a
 *  stale image. Pure, so the argv is a unit test. */
export function stageToDmgLines(opts: {
  /** The directory being imaged; holds the `.app` and nothing else yet. */
  stage: string;
  /** The `.app` inside the stage. */
  app: string;
  binaryName: string;
  volumeName: string;
  outPath: string;
  sign: boolean;
}): string[] {
  return [
    ...(opts.sign ? [codesignScript(opts.app, opts.binaryName)] : []),
    `ln -s /Applications ${q(opts.stage)}/Applications`,
    `hdiutil create -volname ${q(opts.volumeName)} ` +
    `-srcfolder ${q(opts.stage)} -ov -format UDZO ${q(opts.outPath)}`,
  ];
}

/** The `codesign` lines that seal an assembled `.app`, deepest component
 *  FIRST. Pure, so the ORDER — the only part that is easy to get wrong — is a
 *  test rather than a fact learned from a failed build.
 *
 *  Ad-hoc (`-s -`) is the right signature here: it is what makes the app
 *  runnable on the machine that built it and keeps the bundle internally
 *  consistent (macOS refuses a modified, unsealed nested Electron and exits it
 *  with status 1 and no message). It is NOT a Developer ID signature, so a
 *  DOWNLOADED copy still meets Gatekeeper — that is a distribution decision
 *  (notarization), not a packaging one, exactly as the docs say.
 *
 *  Order matters because a signature covers the files it contains: signing the
 *  outer bundle first, then a framework inside it, invalidates the outer seal. */
export function codesignScript(
  appPath: string,
  binaryName = "counter",
): string {
  // Quote ONCE, at each point of use. Pre-quoting `appPath` and then embedding
  // it in a path that is quoted again produces nested `''\''…'\''` that bash
  // reads as an empty argument followed by a bare path — which codesign
  // reports as "not signed at all", a long way from the quoting bug.
  const app = q(appPath);
  const e = q(`${appPath}/Contents/MacOS/electron/Electron.app/Contents`);
  const fwVers = q(
    `${appPath}/Contents/MacOS/electron/Electron.app/Contents/Frameworks/` +
      `Electron Framework.framework/Versions/A`,
  );
  return [
    "set -euo pipefail",
    // Sign EVERY component whose signature is nested inside another; `-f`
    // replaces Electron's upstream signature, which the identity/plist edits
    // already invalidated.
    `sign() { codesign --force -s - "$@" >/dev/null; }`,
    // 1. helper app binaries, the crashpad handler, and the dylibs
    `for h in ${e}/Frameworks/*.app; do for b in "$h/Contents/MacOS/"*; do sign "$b"; done; done`,
    `sign ${fwVers}/Helpers/chrome_crashpad_handler`,
    `for d in ${fwVers}/Libraries/*.dylib; do sign "$d"; done`,
    // 2. each framework, then 3. each helper app
    `for fw in ${e}/Frameworks/*.framework; do sign "$fw"; done`,
    `for h in ${e}/Frameworks/*.app; do sign "$h"; done`,
    // 4. the nested Electron.app itself
    `sign ${e}/..`,
    // 5. the Deno binary — by NAME, not `MacOS/*`: that directory also holds
    //    the `electron/` runtime, and passing a directory to codesign fails
    //    with "bundle format unrecognized".
    `sign ${app}/Contents/MacOS/${q(binaryName)}`,
    // 6. the outer bundle
    `sign ${app}`,
    `codesign -v --deep --strict ${app}`,
  ].join("\n");
}

/** A shell snippet that prepares a staging dir with the `.app` plus the
 *  `/Applications` symlink users expect, makes the DMG, and (given `sign`)
 *  seals the app first. Run on the Mac. Pure over the values, so it is
 *  readable in a test and reviewable by the developer whose Mac it runs on. */
export function remoteDmgScript(opts: {
  workDir: string;
  appName: string;
  /** The executable inside `Contents/MacOS/` — signed by name. */
  binaryName: string;
  volumeName: string;
  outFile: string;
  /** Seal the app before imaging it — required for it to RUN. */
  sign: boolean;
}): string {
  const stage = `${opts.workDir}/stage`;
  const app = `${stage}/${opts.appName}`;
  return [
    "set -euo pipefail",
    // Only the STAGE is cleared — `payload.tgz` sits in workDir beside it and
    // must survive (it is the file this script is about to unpack).
    `rm -rf ${q(stage)}`,
    `mkdir -p ${q(stage)}`,
    `tar -xzf ${q(`${opts.workDir}/payload.tgz`)} -C ${q(stage)}`,
    ...stageToDmgLines({
      stage,
      app,
      binaryName: opts.binaryName,
      volumeName: opts.volumeName,
      outPath: `${opts.workDir}/${opts.outFile}`,
      sign: opts.sign,
    }),
  ].join("\n");
}

/** The same image, made on THIS Mac: copy the `.app` into a stage with
 *  `ditto` (it keeps Electron's framework symlinks and extended attributes),
 *  then run the shared tail. Pure over the values, like the remote script. */
export function localDmgScript(opts: {
  appPath: string;
  workDir: string;
  binaryName: string;
  volumeName: string;
  outPath: string;
  sign: boolean;
}): string {
  const stage = `${opts.workDir}/stage`;
  const app = `${stage}/${
    opts.appPath.slice(opts.appPath.lastIndexOf("/") + 1)
  }`;
  return [
    "set -euo pipefail",
    `rm -rf ${q(stage)}`,
    `mkdir -p ${q(stage)}`,
    `ditto ${q(opts.appPath)} ${q(app)}`,
    ...stageToDmgLines({
      stage,
      app,
      binaryName: opts.binaryName,
      volumeName: opts.volumeName,
      outPath: opts.outPath,
      sign: opts.sign,
    }),
  ].join("\n");
}

/** The outcome of one external command. */
export interface RunResult {
  success: boolean;
  stderr: string;
  stdout: string;
}

/** Run a command and capture its outcome. `stdin` lets a shell script be piped
 *  to `bash -s`, which is how the remote Mac runs one. */
async function run(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<RunResult> {
  const child = new Deno.Command(cmd, {
    args,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const out = await child.output();
  return {
    success: out.success,
    stderr: new TextDecoder().decode(out.stderr),
    stdout: new TextDecoder().decode(out.stdout),
  };
}

/** The three remote operations the DMG path needs, as injectable seams so the
 *  whole flow is unit-testable without a Mac. */
export interface RemoteSeams {
  /** Run a shell command on the Mac, returning its result. */
  ssh: (command: string) => Promise<RunResult>;
  /** Copy a local file to `<target>:<remotePath>`. */
  up: (localPath: string, remotePath: string) => Promise<RunResult>;
  /** Copy `<target>:<remotePath>` to `localPath`. */
  down: (remotePath: string, localPath: string) => Promise<RunResult>;
}

/** The real seams: `ssh`/`scp` against `host.target`, non-interactive so a
 *  missing key fails fast instead of hanging a CI job on a password prompt. */
export function realRemoteSeams(host: MacHost): RemoteSeams {
  const opts = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  return {
    // Piped through `bash -s`, NOT run as a remote command string: macOS's
    // default login shell is zsh, whose nomatch option makes an unmatched glob
    // (`Libraries/*.dylib`) abort the whole script. bash is the shell these
    // scripts are written for, and piping them is what pins that.
    ssh: (command) => run("ssh", [...opts, host.target, "bash -s"], command),
    up: (local, remote) =>
      run("scp", [...opts, "-q", local, `${host.target}:${remote}`]),
    down: (remote, local) =>
      run("scp", [...opts, "-q", `${host.target}:${remote}`, local]),
  };
}

/** Refuse with every actionable option, rather than producing a file that will
 *  not mount. */
export function dmgRefusal(): string {
  return `${NO} a macOS .dmg needs \`hdiutil\`, which exists only on macOS — ` +
    `this build produced the .app but cannot make the disk image.\n` +
    `      Three ways forward, in order of preference:\n` +
    `        • build on a Mac (the .app is ready; only hdiutil is missing)\n` +
    `        • set ${MACOS_HOST_ENV}=[user@]mac-host and aio will ship the ` +
    `.app there, make the .dmg, and fetch it back:\n` +
    `            ${MACOS_HOST_ENV}=dev@mac-mini deno task build --targets=electron\n` +
    `        • publish the .app (it is the real artifact — a .dmg only wraps it)`;
}

/** The prefix of every scratch directory a DMG build makes, here and on the
 *  Mac. Deliberately NOT `aio-…`: `/tmp/aio*` is the namespace the repo's temp
 *  sweepers walk (`check-orphans --clean-stale` at the start of every suite,
 *  `clean:tmp`), and a build staging its `payload.tgz` there lost it between
 *  `tar` and `scp` once while a suite started beside it (a field report, #7).
 *  The sweep no longer takes a name as proof; this keeps the build out of
 *  reach of any sweeper that still does. */
const DMG_SCRATCH_PREFIX = "dmgstage-";

/** Make a `.dmg` from an assembled `.app`, on this host or a remote Mac.
 *
 *  Returns the DMG path. Throws with {@link dmgRefusal} when no strategy is
 *  available — never silently writes a different file. */
export async function finalizeMacDmg(opts: {
  /** The assembled `<name>.app`. */
  appPath: string;
  /** Where `<…>.dmg` lands. */
  outPath: string;
  volumeName: string;
  /** deno.json `[build.macos] host`, if any. */
  declaredHost?: string | null;
  /** Injected for tests: the host OS. */
  os?: string;
  /** Injected for tests: the remote Mac operations. */
  remote?: RemoteSeams;
  /** The executable inside the bundle's `Contents/MacOS/`. */
  binaryName: string;
  /** Seal the app before imaging it. Default true — an unsealed nested
   *  Electron is killed by macOS with no message. */
  sign?: boolean;
}): Promise<string> {
  const os = opts.os ?? Deno.build.os;
  const sign = opts.sign ?? true;
  if (os === "darwin") {
    // `bash`, not `sh`: the script is written for bash (pipefail, the glob
    // loops), exactly as the remote path pins it with `bash -s`.
    const work = await Deno.makeTempDir({ prefix: DMG_SCRATCH_PREFIX });
    try {
      const r = await run("bash", [
        "-c",
        localDmgScript({
          appPath: opts.appPath,
          workDir: work,
          binaryName: opts.binaryName,
          volumeName: opts.volumeName,
          outPath: opts.outPath,
          sign,
        }),
      ]);
      if (!r.success) {
        throw new Error(
          `${NO} could not sign and image the .app:\n${
            r.stderr.trim().split("\n").slice(0, 6).join("\n")
          }`,
        );
      }
    } finally {
      await Deno.remove(work, { recursive: true }).catch(() => {
        // aio-ok(silent-catch): temp cleanup.
      });
    }
    return opts.outPath;
  }

  const host = resolveMacHost(opts.declaredHost);
  if (host === null) throw new Error(dmgRefusal());
  const seams = opts.remote ?? realRemoteSeams(host);

  // ── remote: tar the .app, ship it, run hdiutil, fetch the .dmg ──
  // Unique per BUILD, not per process: `/tmp/aio-dmg-<pid>` was shared by
  // two builds from two hosts with the same pid, and by a later build that
  // reused the pid of one whose failure left the dir behind (`rm -rf` below
  // runs on success only).
  const work = `/tmp/${DMG_SCRATCH_PREFIX}${crypto.randomUUID()}`;
  const appName = opts.appPath.slice(dirname(opts.appPath).length + 1);
  const staging = await Deno.makeTempDir({ prefix: DMG_SCRATCH_PREFIX });
  const payload = join(staging, "payload.tgz");

  try {
    // tar preserves the symlinks Electron.app is full of, and the exec bits.
    const tar = await run("tar", [
      "-czf",
      payload,
      "-C",
      dirname(opts.appPath),
      appName,
    ]);
    if (!tar.success) {
      throw new Error(`${NO} could not pack ${opts.appPath}: ${tar.stderr}`);
    }
    // Prepare the Mac's scratch dir, then copy the payload into it.
    const mk = await seams.ssh(`mkdir -p '${work}'`);
    if (!mk.success) {
      throw new Error(
        `${NO} cannot reach the macOS host "${host.target}" over SSH ` +
          `(${MACOS_HOST_ENV}).\n${mk.stderr.trim()}\n` +
          `      Check: ssh ${host.target} true`,
      );
    }
    const up = await seams.up(payload, `${work}/payload.tgz`);
    if (!up.success) {
      throw new Error(
        `${NO} could not copy the .app to ${host.target}:\n${up.stderr.trim()}`,
      );
    }
    // A FIXED remote file name: the display name may contain spaces, and it is
    // passed through `scp`'s argv (not a shell) on the way back, where a space
    // would split into two arguments.
    const remoteDmg = "app.dmg";
    const script = remoteDmgScript({
      workDir: work,
      appName,
      binaryName: opts.binaryName,
      volumeName: opts.volumeName,
      outFile: remoteDmg,
      sign,
    });
    const made = await seams.ssh(script);
    if (!made.success) {
      throw new Error(
        `${NO} hdiutil failed on ${host.target}:\n${made.stderr.trim()}`,
      );
    }
    const down = await seams.down(`${work}/${remoteDmg}`, opts.outPath);
    if (!down.success) {
      throw new Error(
        `${NO} could not fetch the .dmg from ${host.target}:\n${down.stderr}`,
      );
    }
    await seams.ssh(`rm -rf '${work}'`).catch(() => {
      // aio-ok(silent-catch): best-effort remote cleanup; leaking a temp dir
      // on a build Mac is not worth failing a successful build.
    });
    return opts.outPath;
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {
      // aio-ok(silent-catch): temp cleanup.
    });
  }
}

/** True when a real DMG can be produced here or via a configured Mac. Lets the
 *  packager warn EARLY (before a 100 MB fetch and a 300 MB copy) instead of
 *  after all the work. Pure over its inputs. */
export function canFinalizeDmg(
  declaredHost?: string | null,
  os: string = Deno.build.os,
  env?: string,
): boolean {
  return os === "darwin" || resolveMacHost(declaredHost, env) !== null;
}

/** The warning to print when {@link canFinalizeDmg} is false but the build
 *  continues far enough to produce the `.app` anyway. Names the escape.
 *
 *  Carries NO leading glyph: the call site adds it (`${HEY} …`), so the
 *  source-level marker a reader (and the "every message has a level" gate)
 *  sees is at the point of printing, in the same form as every other
 *  diagnostic in the build. */
export function noDmgWarning(): string {
  return `no macOS host configured — the .app will be assembled and ` +
    `shipped, but no .dmg. Set ${MACOS_HOST_ENV}=[user@]mac-host to produce ` +
    `one (see docs/build/targets.md), or build on a Mac.`;
}

/** Log line for a finished DMG. */
export function dmgDone(path: string, mb: string): string {
  return `${OK} ${path} (${mb} MB)`;
}
