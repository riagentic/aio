/**
 * @module
 * `deno task install:android` — put the built APK on a REAL, connected phone.
 *
 * `dev:android` already installs, but it is the DEV flow: it boots an emulator
 * when nothing is attached, builds a dev APK pointed at a dev server, and holds
 * that server in the foreground with an `adb reverse` tunnel. None of that is
 * what someone wants when they have a phone on the desk and a finished build —
 * they want the artifact they are about to ship, on the device, running.
 *
 * So this is the other half:
 *
 *   deno task install:android                 # newest .apk → the attached phone
 *   deno task install:android --build         # build it first (debug APK)
 *   deno task install:android --build --release   # …a release build instead
 *   deno task install:android --emulator      # a running emulator, not a phone
 *   deno task install:android --apk=x.apk     # a specific artifact
 *   deno task install:android --device=SERIAL # when several are attached
 *   deno task install:android --no-launch     # install, do not start it
 *
 * It REFUSES an emulator unless asked (`--emulator`): "install to my phone"
 * silently landing on a virtual device is the kind of helpfulness that costs an
 * hour, and the emulator already has `dev:android`.
 *
 * It also refuses an APK OLDER than the app's sources (`staleApkRefusal`), for
 * the same reason spelled differently: a field report edited its app, ran this,
 * read `✓`, and tested the previous build on the phone for a while — same
 * version number on screen, so nothing disagreed. `--build` builds first;
 * `--apk=<file>` installs a named artifact regardless.
 */
import { isAbsolute, join } from "@std/path";
import { resolveSdk } from "./build/build-helpers.ts";
import { androidApplicationId } from "./build/build-android.ts";
import { stripVersionToken } from "./build/build-version.ts";
import { outDirOf } from "./build/build-manifest.ts";
import { APP_STYLE } from "./server/app-files.ts";

const dec = new TextDecoder();

function fail(msg: string, ...lines: string[]): never {
  console.error(`[install:android] ✗ ${msg}`);
  for (const l of lines) console.error(`  ${l}`);
  Deno.exit(1);
}

async function run(
  cmd: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: dec.decode(p.stdout),
    err: dec.decode(p.stderr),
  };
}

/** One attached device, as `adb devices -l` sees it. */
export type Device = {
  serial: string;
  state: string;
  /** `emulator-5554` is an AVD; anything else is hardware. */
  emulator: boolean;
  model: string;
};

/** Parse `adb devices -l`. Pure, so the states that matter — `unauthorized`,
 *  `offline`, a phone still showing the RSA dialog — are a unit test rather
 *  than a thing we hope the code handles.
 *
 *  @internal alpha70 — a build/tooling internal reachable for tests via
 *  src/testing/internal.ts; not app-facing API. */
export function parseDevices(stdout: string): Device[] {
  const out: Device[] = [];
  for (const raw of stdout.split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const [serial, state, ...rest] = line.split(/\s+/);
    if (!serial || !state) continue;
    const model = rest.find((f) => f.startsWith("model:"))?.slice(6) ?? "";
    out.push({
      serial,
      state,
      emulator: serial.startsWith("emulator-"),
      model: model.replace(/_/g, " "),
    });
  }
  return out;
}

/** Which device to install on — or the reason there is none.
 *
 *  Every refusal names what IS attached, because "no device found" while a
 *  phone is plugged in and showing an authorization dialog is the single most
 *  common way this wastes someone's afternoon. */
export function pickDevice(
  devices: readonly Device[],
  opts: { serial?: string; allowEmulator?: boolean },
): { device: Device } | { error: string; hint?: string } {
  if (opts.serial) {
    const d = devices.find((x) => x.serial === opts.serial);
    if (!d) {
      return {
        error: `no device with serial "${opts.serial}" is attached`,
        hint: devices.length
          ? `attached: ${devices.map((x) => x.serial).join(", ")}`
          : "nothing is attached at all",
      };
    }
    if (d.state !== "device") {
      return {
        error: `device ${d.serial} is "${d.state}"`,
        hint: stateHint(d),
      };
    }
    return { device: d };
  }

  const usable = devices.filter((d) => opts.allowEmulator || !d.emulator);
  const ready = usable.filter((d) => d.state === "device");

  if (ready.length === 1) return { device: ready[0]! };
  if (ready.length > 1) {
    return {
      error: `${ready.length} devices are attached — name the one you mean`,
      hint: ready.map((d) =>
        `--device=${d.serial}${d.model ? ` (${d.model})` : ""}`
      )
        .join("\n  "),
    };
  }
  // Nothing ready: say WHY, using what is actually attached.
  const blocked = usable.find((d) => d.state !== "device");
  if (blocked) {
    return {
      error: `the only attached device is "${blocked.state}"`,
      hint: stateHint(blocked),
    };
  }
  if (devices.some((d) => d.emulator) && !opts.allowEmulator) {
    return {
      error: "only an emulator is attached, and this installs to a PHONE",
      hint: "`deno task dev` is the emulator flow for an android app; " +
        "`--emulator` forces this one",
    };
  }
  return {
    error: "no Android device is attached",
    hint: opts.allowEmulator
      ? "start one first (`emulator -avd <name>`, or `deno task dev` in an " +
        "android app, which boots an AVD for you)"
      : "enable Developer options → USB debugging, plug the phone in, and " +
        "check `adb devices` lists it",
  };
}

function stateHint(d: Device): string {
  if (d.state === "unauthorized") {
    return `unlock ${d.serial} and tap "Allow USB debugging" — the phone is ` +
      "waiting for you, not broken";
  }
  if (d.state === "offline") {
    return `${d.serial} is offline — unplug/replug, or \`adb kill-server\``;
  }
  return `${d.serial} is in state "${d.state}"`;
}

/** The APK to install: the newest one in the project root, unless named. */
export function pickApk(
  files: readonly { name: string; mtime: number }[],
  named?: string,
): { apk: string } | { error: string; hint?: string } {
  if (named) return { apk: named };
  const apks = files.filter((f) => f.name.endsWith(".apk"))
    .sort((a, b) => b.mtime - a.mtime);
  if (apks.length === 0) {
    return {
      error: "no .apk in the build output or this directory",
      hint: "`deno task build --targets=android` builds one into dist/ " +
        "(or pass --build to do it here)",
    };
  }
  const newest = apks[0]!;
  // An unsigned APK cannot be installed by anything — refusing here names the
  // reason, instead of letting `adb` answer with INSTALL_PARSE_FAILED_NO_
  // CERTIFICATES, which sends people to look for a broken build.
  if (newest.name.endsWith("-unsigned.apk")) {
    return {
      error: `${newest.name} is UNSIGNED — Android will not install it`,
      hint: "sign it, or build the debug APK " +
        "(`deno task build --targets=android`), which is signed with the " +
        "debug key",
    };
  }
  return { apk: newest.name };
}

/** Files that decide whether an APK is current. Everything the build READS,
 *  and nothing it WRITES — `dist/` holds the APK itself, so counting it would
 *  compare the artifact to itself and always answer "fresh". */
const SOURCE_DIRS = ["src", "assets", "public", "static"];
const SOURCE_FILES = ["deno.json", "deno.jsonc", APP_STYLE, "index.html"];
const SKIP_DIRS = new Set([
  "dist",
  "dep",
  "node_modules",
  ".git",
  "build",
  ".gradle",
]);

/** The newest source file under `root`, or null when there is none.
 *  Walks with `Deno.readDirSync` rather than a glob so one unreadable
 *  directory cannot decide the answer by being skipped silently — it throws,
 *  and the caller says so. */
export function newestSource(
  root: string,
  readDir: (p: string) => Iterable<Deno.DirEntry> = Deno.readDirSync,
  stat: (p: string) => { mtime: Date | null } = Deno.statSync,
): { path: string; mtime: number } | null {
  let best: { path: string; mtime: number } | null = null;
  const consider = (path: string) => {
    const mtime = stat(path).mtime?.getTime() ?? 0;
    if (!best || mtime > best.mtime) best = { path, mtime };
  };
  const walk = (dir: string) => {
    for (const e of readDir(dir)) {
      if (e.isDirectory) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(dir, e.name));
      } else if (e.isFile) consider(join(dir, e.name));
    }
  };
  for (const d of SOURCE_DIRS) {
    try {
      walk(join(root, d));
    } catch { /* aio-ok: an app need not have every one of these dirs */ }
  }
  for (const f of SOURCE_FILES) {
    try {
      consider(join(root, f));
    } catch { /* aio-ok: same — deno.jsonc exists xor deno.json does */ }
  }
  return best;
}

/** Why installing this APK would put OLD code on the phone, or null.
 *
 *  The reported failure, and the worst kind: `install:android` picked the
 *  newest `.apk` by mtime, installed it, and printed `✓`. Edit the app, run
 *  install, and the phone runs the previous build — with the same version
 *  number, so nothing on screen disagrees. The tool reported success for the
 *  opposite of what was asked.
 *
 *  `--build` is the answer rather than building implicitly: one decider. The
 *  command whose name is "install" installs; asking it to build is a word you
 *  type. Pure, so both answers are testable without a phone or a build. */
export function staleApkRefusal(
  apk: { name: string; mtime: number },
  newest: { path: string; mtime: number } | null,
): string | null {
  if (!newest || newest.mtime <= apk.mtime) return null;
  const ago = Math.round((newest.mtime - apk.mtime) / 1000);
  const age = ago < 90
    ? `${ago}s`
    : ago < 5400
    ? `${Math.round(ago / 60)}min`
    : `${Math.round(ago / 3600)}h`;
  return `${apk.name} is OLDER than your sources — ${newest.path} changed ` +
    `${age} after it was built.\n` +
    `  Installing it would put the PREVIOUS build on the phone, under the ` +
    `same version number, and report success.\n` +
    `  fix: \`deno task install:android --build\` (builds, then installs), ` +
    `or \`deno task build --targets=android\` first.\n` +
    `  To install this exact artifact anyway, name it: ` +
    `\`--apk=${apk.name}\`.`;
}

async function main(): Promise<void> {
  const args = Deno.args;
  const flag = (n: string) =>
    args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
  const has = (n: string) => args.includes(`--${n}`);

  const sdk = resolveSdk();
  if (!sdk) {
    fail(
      "Android SDK not found — set ANDROID_HOME to your SDK dir",
      "ANDROID_HOME may point at the SDK or its parent (e.g. ~/Android → ~/Android/Sdk)",
    );
  }
  const exe = Deno.build.os === "windows" ? ".exe" : "";
  const adb = join(sdk, "platform-tools", `adb${exe}`);
  try {
    await Deno.stat(adb);
  } catch {
    fail(`adb not found at ${adb}`, "install the SDK's platform-tools");
  }

  if (has("build")) {
    // DEBUG by default — the same flags `compile:android` uses, because they
    // are the same act and two spellings drift. It also has to be: a `--release`
    // build with no signing config produces `<app>-unsigned.apk`, which Android
    // will not install and which pickApk (rightly) refuses — so `--build`
    // building a release would have built something and then rejected its own
    // output. `--release` stays available for anyone who HAS signing set up.
    const release = has("release");
    console.log(
      `[install:android] building the ${release ? "release" : "debug"} APK...`,
    );
    const buildTs = new URL("./build.ts", import.meta.url).href;
    const b = await run("deno", [
      "run",
      "-A",
      buildTs,
      "--android",
      ...(release ? ["--release"] : []),
    ]);
    if (b.code !== 0) {
      console.error(b.out + b.err);
      fail("APK build failed (see above)");
    }
  }

  // WHERE the APK is. Since "one path, one name, one dist/" the fleet places
  // every artifact in the out dir and leaves nothing in the project root — so
  // that is looked at first. The cwd is still a fallback: `--apk=` may name a
  // file anywhere, and an APK someone dropped beside the project should still
  // install rather than be reported as absent.
  const outDir = await outDirOf(Deno.cwd());
  const listDir = (dir: string): { name: string; mtime: number }[] => {
    const out: { name: string; mtime: number }[] = [];
    try {
      for (const e of Deno.readDirSync(dir)) {
        if (!e.isFile) continue;
        const st = Deno.statSync(join(dir, e.name));
        out.push({ name: e.name, mtime: st.mtime?.getTime() ?? 0 });
      }
    } catch {
      // aio-ok: no out dir yet — the cwd fallback below is the answer, and an
      // empty result is reported by pickApk with the command that fills it.
    }
    return out;
  };
  const fromOut = listDir(outDir);
  const apkDir = fromOut.some((f) => f.name.endsWith(".apk"))
    ? outDir
    : Deno.cwd();
  const files = apkDir === outDir ? fromOut : listDir(Deno.cwd());
  const chosenApk = pickApk(files, flag("apk"));
  if ("error" in chosenApk) {
    fail(chosenApk.error, ...(chosenApk.hint ? [chosenApk.hint] : []));
  }
  const apk = chosenApk.apk;

  // Is this APK still the app? Skipped after `--build` (it was just built) and
  // when `--apk=` named this exact file — an explicit artifact is a choice,
  // not an accident, and the refusal itself offers that escape hatch.
  if (!has("build") && !flag("apk")) {
    const chosen = files.find((f) => f.name === apk);
    const refusal = chosen
      ? staleApkRefusal(chosen, newestSource(Deno.cwd()))
      : null;
    if (refusal) {
      const [head, ...rest] = refusal.split("\n");
      fail(head!, ...rest.map((l) => l.trim()));
    }
  }

  const listed = await run(adb, ["devices", "-l"]);
  if (listed.code !== 0) {
    console.error(listed.out + listed.err);
    fail("`adb devices` failed");
  }
  const picked = pickDevice(parseDevices(listed.out), {
    serial: flag("device"),
    allowEmulator: has("emulator"),
  });
  if ("error" in picked) {
    fail(picked.error, ...(picked.hint ? [picked.hint] : []));
  }
  const dev = picked.device;
  const label = dev.model || dev.serial;

  console.log(`[install:android] ${apk} → ${label} (${dev.serial})`);
  const inst = await run(adb, [
    "-s",
    dev.serial,
    "install",
    "-r",
    isAbsolute(apk) ? apk : join(apkDir, apk),
  ]);
  if (inst.code !== 0 || /Failure|Error/.test(inst.out + inst.err)) {
    console.error(inst.out + inst.err);
    fail(
      `adb install failed on ${label}`,
      "INSTALL_FAILED_UPDATE_INCOMPATIBLE means a build signed with a " +
        "different key is already installed — uninstall it on the phone first",
    );
  }

  // The label the build derived the application id from — the file name
  // minus `.apk` and minus THE build version the fleet placed in it
  // (`myapp-1.2.345-client.apk` was built as `myapp-client`).
  const appId = androidApplicationId(
    stripVersionToken(apk.replace(/\.apk$/, "")),
  );
  if (!has("no-launch") && appId) {
    const start = await run(adb, [
      "-s",
      dev.serial,
      "shell",
      "am",
      "start",
      "-n",
      `${appId}/aio.app.MainActivity`,
    ]);
    // A launch that did not launch is reported, not swallowed — the install
    // still succeeded, and saying so keeps the two facts apart.
    if (start.code !== 0 || /Error/.test(start.out + start.err)) {
      console.log(`[install:android] ⚠ installed, but could not start it`);
      console.log(`  ${(start.out + start.err).trim().split("\n")[0] ?? ""}`);
      console.log(`  open it from the phone's launcher`);
      Deno.exit(0);
    }
  }
  console.log(
    `[install:android] ✓ ${apk} installed${
      has("no-launch") ? "" : " and started"
    } on ${label}`,
  );
}

if (import.meta.main) await main();
