/**
 * @module
 * `am publish` — build → ship → the channel directory a client actually fetches.
 *
 * Every piece of this already existed (`deno task build`, `aio ship`,
 * `--channel-dir`), and the LAYOUT that ties them together lived only in prose:
 * "copy these two files into <base>/<channel>/". Prose is not a decider, and
 * the two documented publish flows were both wrong in practice — one shipped a
 * manifest with no data contract, the other put the manifest at a path no
 * client requests. Both fail silently and permanently ("no updates available"),
 * on the users' machines, weeks later.
 *
 * So the layout becomes a command. Thin on purpose: it orchestrates, it does
 * not re-implement, and every refusal here is one the underlying tool would
 * have made too late to be useful.
 *
 *   am publish                        # build, sign nothing, stage ./release
 *   am publish --key=~/keys/app.json  # …signed (what users' clients require)
 *   am publish --dir=/srv/releases --channel=test --notes="fixes the sync bug"
 *   am publish --no-build             # ship what dist/ already holds
 */

import { join, resolve } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import { hostPlatform, PLATFORMS } from "../build/platforms.ts";
import { detectMode, fail, out, sayErr } from "./am-output.ts";
import { readDenoJson } from "../server/deno-json.ts";
import {
  artifactFormat,
  type DataContract,
  defaultKeyPath,
  kindManifestFileName,
  manifestFileName,
  probeArtifact,
  resolveSigningKey,
  type ShipManifest,
  shipRelease,
} from "../build/ship.ts";
import { appIdFromConfig } from "../server/single-instance-lock.ts";
import { count } from "../diagnostics/fmt.ts";

/** What `dist/manifest.json` records — the fleet build's own report. */
type BuildManifest = {
  app?: string;
  /** THE build version the fleet resolved — what every artifact is named
   *  with and reports; `am publish` publishes THAT, never a re-derivation. */
  version?: string;
  commit?: string | null;
  dirty?: boolean;
  buildNumber?: number;
  /** The platform the build ran on (`hostPlatform()` there). */
  builtOn?: string;
  targets?: {
    target: string;
    ok?: boolean;
    /** True when this artifact runs on the machine that built it. */
    host?: boolean;
    platform?: string;
    artifacts?: { file: string }[];
  }[];
};

/** A directory artifact? A missing path is not one — fileFormat reports it. */
function isDirectory(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false; // aio-ok: a missing file is fileFormat's to report
  }
}

/** What KIND of artifact this file is (`artifactFormat`), or null for a
 *  companion the build wrote beside one (a systemd unit, a checksum, a desktop
 *  entry).
 *
 *  Read from the file's own bytes, not from its name or its target: the set of
 *  companion files grows, and a rule keyed on extensions would have to grow
 *  with it silently. The first 8 bytes AND the last 512: a `.dmg` is known only
 *  by its `koly` trailer, so a head-only read put every DMG in `skipped` and a
 *  release shipped without macOS. An unreadable file answers "program" so the
 *  refusal comes from `shipApp`, which can say why.
 *
 *  @internal exported for tests. */
export function fileFormat(path: string): string | null {
  try {
    using f = Deno.openSync(path, { read: true });
    const size = f.statSync().size;
    const read = (at: number, len: number) => {
      const b = new Uint8Array(len);
      f.seekSync(at, Deno.SeekMode.Start);
      let n = 0;
      while (n < len) {
        const got = f.readSync(b.subarray(n));
        if (got === null) break;
        n += got;
      }
      return b.subarray(0, n);
    };
    // Head + tail laid end to end keeps the trailer exactly 512 bytes from
    // the end, which is where `artifactFormat` looks for it.
    const bytes = size <= 520
      ? read(0, size)
      : new Uint8Array([...read(0, 8), ...read(size - 512, 512)]);
    return artifactFormat(bytes);
  } catch {
    return "unreadable"; // aio-ok: unreadable here means shipApp reports it, with the path
  }
}

/** Of the programs ONE target built for ONE platform, the one the update
 *  manifest carries — the rest are published beside it for download only.
 *
 *  The manifest names one artifact, and an install accepts only its own shape
 *  (`installableTargets`). The Windows Electron target builds two: the
 *  self-contained `.exe` — the double-click download, which runs offline and
 *  installs as `binary` — and the `.zip` a user must unpack first. The one a
 *  user runs is the one that must update, so an archive loses to a program
 *  that runs as it is. Any other tie is refused by file name: guessing would
 *  sign the wrong install strategy. Pure. */
export function pickUpdateArtifact(
  files: string[],
): { file: string; downloads: string[] } | { error: string } {
  const runnable = files.filter((f) => !/\.zip$/i.test(f));
  const pool = runnable.length > 0 ? runnable : files;
  if (pool.length !== 1) {
    return {
      error: `it built ${choiceList(pool, (f) => f, "and")} for one ` +
        `platform, and an update manifest carries ONE artifact — build ` +
        `them as separate targets, then pick one with --target=`,
    };
  }
  return { file: pool[0]!, downloads: files.filter((f) => f !== pool[0]) };
}

/** `"a", "b" and "c"` — each value ONCE. A choice offered as the same string
 *  twice ("--target=electron (or --target=electron)") is no choice. Pure. */
export function choiceList(
  values: string[],
  show: (v: string) => string,
  last: "and" | "or",
): string {
  const u = [...new Set(values)].map(show);
  return u.length < 2
    ? u.join("")
    : `${u.slice(0, -1).join(", ")} ${last} ${u.at(-1)}`;
}

/** Run a command with the user's terminal attached — a build prints its own
 *  progress, and hiding it behind a spinner is how a 4-minute step looks hung. */
async function run(cmd: string, args: string[], cwd: string): Promise<boolean> {
  const p = await new Deno.Command(cmd, {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return p.success;
}

/** publish's flags that carry a value (read only as `--k=v`). */
const PUBLISH_VALUE_FLAGS: readonly string[] = [
  "--channel",
  "--dir",
  "--targets",
  "--target",
  "--key",
  "--notes",
  "--version",
  "--min-from",
];

/** Ask a Mac-built `.app.tar.gz` its data contract: unpack it and run the
 *  bundle's own executable (`CFBundleExecutable` — the aio server binary, see
 *  macos-app.ts) with `--aio-data-contract`, exactly as a host binary is
 *  asked. Only on a Mac: the executable is a Mach-O. Throws with the reason. */
async function probeMacApp(
  archive: string,
): Promise<{ contract: DataContract; appId?: string }> {
  const dir = await Deno.makeTempDir({ prefix: "aio-publish-app-" });
  try {
    const tar = await new Deno.Command("tar", {
      args: ["-xzf", archive, "-C", dir],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!tar.success) {
      throw new Error(
        `${archive} did not unpack (tar exit ${tar.code}): ${
          new TextDecoder().decode(tar.stderr).trim()
        }`,
      );
    }
    const app = [...Deno.readDirSync(dir)].find((e) =>
      e.isDirectory && e.name.endsWith(".app")
    );
    if (!app) throw new Error(`${archive} holds no top-level .app bundle`);
    const contents = join(dir, app.name, "Contents");
    const exe = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/
      .exec(await Deno.readTextFile(join(contents, "Info.plist")))?.[1];
    if (!exe) {
      throw new Error(
        `${archive}: ${app.name}/Contents/Info.plist names no CFBundleExecutable`,
      );
    }
    return await probeArtifact(join(contents, "MacOS", exe));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Why an artifact cannot be asked its data contract on THIS machine — the
 *  reason the no-contract warning prints, per file. Pure. */
export function notProbedHere(a: {
  file: string;
  format: string | null;
  platform: string;
  builtOn?: string;
  here: string;
}): string {
  if (/\.app\.tar\.gz$/i.test(a.file)) {
    return a.here.startsWith("macos")
      ? `a ${
        a.platform === "host"
          ? `.app built on ${a.builtOn ?? "another Mac"}`
          : `${a.platform} .app`
      }, and this Mac is ${a.here}`
      : `a signed .app packed as an archive — only a Mac can unpack and ` +
        `run it, and this machine is ${a.here}`;
  }
  if (a.format === "ZIP" || a.format === "gzip") {
    return `an archive, not a program`;
  }
  if (a.platform !== "host" && a.platform !== a.here) {
    return `built for ${a.platform}, and this machine is ${a.here}`;
  }
  if (a.builtOn && a.builtOn !== a.here) {
    return `built on ${a.builtOn}, and this machine is ${a.here}`;
  }
  return `the build recorded it as not runnable on the machine that built it`;
}

/** `am publish`. `deps.hostPlatform` is a test seam (a Mac publish on
 *  Linux); every real call takes the default. @internal */
export async function cmdPublish(
  args: string[],
  flags: GlobalFlags,
  deps: { hostPlatform?: () => string } = {},
): Promise<void> {
  const mode = detectMode(flags);
  const here = (deps.hostPlatform ?? hostPlatform)();
  const flag = (k: string) =>
    args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  // Every value is read as `--k=v` only, so `--channel beta` (space) left
  // `--channel` as a no-op and `beta` as a word nobody reads: the release
  // went to the PROD channel under a success line. Refused before the build.
  const bare = args.find((a) => PUBLISH_VALUE_FLAGS.includes(a));
  if (bare) {
    fail(`am publish: ${bare} takes its value with '=': ${bare}=<value>`, mode);
  }
  const stray = args.filter((a) => !a.startsWith("-"));
  if (stray.length > 0) {
    fail(
      `am publish takes no arguments (got ${
        stray.map((a) => JSON.stringify(a)).join(" ")
      }) — every setting is a --flag=value: --channel= --dir= --targets= ` +
        `--target= --key= --notes= --version= --min-from= --data= --no-data`,
      mode,
    );
  }
  const root = Deno.cwd();
  const cfg = ((await readDenoJson(root))?.config ?? {}) as {
    build?: { out?: string; channel?: string };
    version?: string;
    appId?: string;
    title?: string;
    name?: string;
  };
  const distDir = resolve(root, cfg.build?.out ?? "dist");
  const channel = flag("channel") ?? cfg.build?.channel ?? "prod";
  const outDir = resolve(root, flag("dir") ?? "release");
  const targetsArg = flag("targets");

  // ── 1. build ──
  if (!args.includes("--no-build")) {
    const ok = await run(
      "deno",
      ["task", "build", ...(targetsArg ? [`--targets=${targetsArg}`] : [])],
      root,
    );
    if (!ok) {
      fail(
        `the build failed — nothing was published. Fix the build (deno task ` +
          `build), or publish what dist/ already holds with --no-build.`,
        mode,
      );
    }
  }

  // ── 2. what did it produce? ──
  let build: BuildManifest;
  try {
    build = JSON.parse(
      await Deno.readTextFile(join(distDir, "manifest.json")),
    ) as BuildManifest;
  } catch {
    fail(
      `no ${join(distDir, "manifest.json")} — there is no build to publish. ` +
        `Run \`deno task build\` first (am publish does that for you unless ` +
        `you pass --no-build).`,
      mode,
    );
  }
  // The key: `--key`, else the file `ship keygen` writes for THIS app when it
  // exists, else unsigned — and which one it was is said in every mode.
  const key = await resolveSigningKey(
    flag("key"),
    build!.app ?? appIdFromConfig(cfg) ?? "app",
  );
  const built = (build!.targets ?? []).filter((t) =>
    t.ok !== false && (t.artifacts?.length ?? 0) > 0
  );
  if (built.length === 0) {
    fail(`${join(distDir, "manifest.json")} records no artifacts`, mode);
  }

  // ── 3. one artifact per platform ──
  //
  // The client fetches `<channel>/<os>-<arch>.json`, so two artifacts for the
  // same platform (a browser binary AND a cli binary, both linux-x86_64) would
  // publish to ONE name and the second would silently replace the first. That
  // is a decision only the publisher can make, so it is asked for rather than
  // guessed.
  const claims = new Map<string, string>(); // platform → target label
  const publishing: {
    target: string;
    file: string;
    /** How THIS machine asks it its data contract: run it (`exec`), unpack
     *  the `.app` and run its executable (`app`), or not at all (`null`). */
    probe: "exec" | "app" | null;
    /** Why `probe` is null — said in the no-contract warning. */
    why: string;
    platform?: { os: string; arch: string };
    /** A second install kind's own manifest name (the Windows `.zip`). */
    manifestName?: string;
  }[] = [];
  const skipped: string[] = [];
  /** Published beside the manifests for download only: first-install images
   *  (`.dmg`), which no update target installs, and a platform's other
   *  programs (see {@link pickUpdateArtifact}). */
  const downloads: { file: string; platform: string }[] = [];
  /** Directory artifacts (the `web` build, the iOS project): no manifest can
   *  name a directory, and a static site updates through its own service
   *  worker — deployed as it is, said so, never signed as a program. */
  const directories: string[] = [];
  const only = flag("target");
  /** An explicitly supplied data contract — see the spread in `shipApp` below. */
  const dataFlag = flag("data");
  /** Publish without a contract on purpose — `aio ship`'s own hatch. */
  const noData = args.includes("--no-data");
  for (const t of built) {
    if (only && t.target !== only) continue;
    // A fleet entry can produce COMPANION files beside its program — the
    // `server`/`server-app` targets emit a systemd `.service` unit next to
    // the binary. Only a runnable program is a release artifact: a companion
    // claiming a platform made the guard below read ONE target as two
    // competitors and refuse with a message suggesting the flag that was
    // already in effect ("both build for linux … --target=server (or
    // --target=server)"), which made `server` and `server-app` impossible to
    // publish at all. `artifactFormat` is the same decider `shipApp` uses to
    // refuse a non-program artifact, so the two cannot disagree about what a
    // program is.
    const programs: string[] = [];
    for (const a of t.artifacts ?? []) {
      if (isDirectory(join(distDir, a.file))) {
        directories.push(a.file);
        continue;
      }
      const format = fileFormat(join(distDir, a.file));
      if (format === null) skipped.push(a.file);
      else if (format === "DMG") {
        downloads.push({ file: a.file, platform: t.platform ?? "host" });
      } else programs.push(a.file);
    }
    if (programs.length === 0) continue;
    // …and ONE target can build two PROGRAMS for one platform: Windows
    // Electron is the self-contained `.exe` AND the `.zip`. Claiming the
    // platform per artifact read that as two targets and refused with
    // "--target=electron (or --target=electron)" — no Windows release at all.
    const pick = pickUpdateArtifact(programs);
    if ("error" in pick) fail(`target "${t.target}": ${pick.error}`, mode);
    const key = t.platform ?? "host";
    // `PLATFORMS` is the same table the build resolved this artifact from,
    // so the manifest cannot disagree with the binary about what it is for.
    // An unknown name yields undefined and `shipApp` falls back to the host
    // — which is right for a single-platform build and is what it did
    // before this existed.
    const platform = PLATFORMS[key]
      ? { os: PLATFORMS[key]!.os, arch: PLATFORMS[key]!.arch }
      : undefined;
    // A `.zip` beside a program (Windows Electron) is ANOTHER install kind of
    // the same platform: an install unpacked from it is `electron-zip` and
    // refuses the program's `binary` release. It gets its own manifest,
    // `<os>-<arch>.electron-zip.json`, which a zip install reads first.
    const zips = pick.downloads.filter((f) => /\.zip$/i.test(f));
    downloads.push(
      ...pick.downloads.filter((f) => !zips.includes(f)).map((file) => ({
        file,
        platform: key,
      })),
    );
    for (const file of zips) {
      publishing.push({
        target: t.target,
        file,
        probe: null,
        why: `an archive, not a program`,
        platform,
        manifestName: kindManifestFileName(
          platform ?? { os: Deno.build.os, arch: Deno.build.arch },
          "electron-zip",
        ),
      });
    }
    const owner = claims.get(key);
    if (owner !== undefined) {
      fail(
        `targets ${
          choiceList([owner, t.target], (x) => `"${x}"`, "and")
        } build for ${key}, and an update client fetches ONE manifest per ` +
          `platform (<channel>/<os>-<arch>.json) — publishing both would ` +
          `leave only the last one.\n` +
          (owner === t.target
            ? `dist/manifest.json records "${owner}" twice for ${key} — ` +
              `rebuild (deno task build) and publish that.`
            : `Pick which one this channel serves: am publish ${
              choiceList([t.target, owner], (x) => `--target=${x}`, "or")
            }.`),
        mode,
      );
    }
    claims.set(key, t.target);
    // Can THIS machine ask it its data contract? `host` is the build
    // machine's answer: a dist/ built on a Mac and published from Linux
    // claimed it, and an archive is not a program on any machine — both were
    // exec'd and refused as a "BROKEN BUILD" (measured: a native Mac build).
    // A Mac-built `.app.tar.gz` published ON a Mac of its platform is asked
    // through its unpacked bundle — it used to go out with no contract, and
    // every Mac install holding data refused every release.
    const format = fileFormat(join(distDir, pick.file));
    // `host` is the BUILD machine, which is this one only if it built it.
    const runsHere = key === here ||
      (key === "host" && (build!.builtOn ?? here) === here);
    const probe = /\.app\.tar\.gz$/i.test(pick.file)
      ? (runsHere && here.startsWith("macos") ? "app" : null)
      : t.host !== false && (build!.builtOn ?? here) === here &&
          !["gzip", "ZIP"].includes(format ?? "")
      ? "exec"
      : null;
    publishing.push({
      target: t.target,
      file: pick.file,
      probe,
      why: notProbedHere({
        file: pick.file,
        format,
        platform: key,
        builtOn: build!.builtOn,
        here,
      }),
      platform,
    });
  }
  if (publishing.length === 0) {
    fail(
      `no updatable artifact${only ? ` for --target=${only}` : ""} in ${
        join(distDir, "manifest.json")
      } — it holds: ${built.map((t) => t.target).join(", ")}` +
        (downloads.length > 0
          ? ` (only first-install images: ${
            downloads.map((d) => d.file).join(", ")
          } — build with a Mac host so the signed .app.tar.gz is made too)`
          : ""),
      mode,
    );
  }

  // ── 4. ship each one INTO the channel layout ──
  //
  // Host artifacts FIRST, so the contract one of them yields can be stamped
  // into the cross-compiled manifests too. The data contract is a property of
  // the SOURCE — the same `cell()` declarations compile into every artifact of
  // one build — so probing it once is not an approximation, it is the same
  // answer arrived at cheaply. Without this, publishing linux+windows+macos
  // from a Linux box gave the non-host manifests no contract at all, and every
  // Windows or macOS install holding data refused every release forever, with
  // a message telling the publisher to re-publish with `aio ship` — which is
  // what they had just done.
  //
  // A Mac `.app` nobody here can ask, with no other artifact to derive the
  // contract from, is refused the way `aio ship` refuses a binary it cannot
  // probe: without a contract every Mac install holding data refuses every
  // release. `--data` / `--no-data` are the explicit ways out.
  const macBlind = publishing.filter((p) =>
    p.probe === null && /\.app\.tar\.gz$/i.test(p.file)
  );
  if (
    macBlind.length > 0 && !dataFlag && !noData &&
    !publishing.some((p) => p.probe !== null)
  ) {
    fail(
      `${macBlind.map((p) => p.file).join(", ")}: ${
        macBlind[0]!.why
      } — so this release cannot say what it does with existing data, and ` +
        `no other artifact of this build runs here to answer for it.\n` +
        `       Publishing anyway is allowed but NOT the default: a manifest ` +
        `with no data contract is refused by every install that already has ` +
        `data, on every machine, silently.\n` +
        `       Fix: publish from a Mac, or run \`<X.app>/Contents/MacOS/<bin> ` +
        `--aio-data-contract > contract.json\` on one and pass ` +
        `--data=contract.json — or --no-data publishes without a contract on ` +
        `purpose.`,
      mode,
    );
  }
  await Deno.mkdir(join(outDir, channel), { recursive: true });
  // Manifest AND the spec that produced it, together — the two used to be
  // parallel arrays indexed by position, which the host-first ordering below
  // would silently misalign.
  const shipped: { m: ShipManifest; spec: typeof publishing[number] }[] = [];
  const ordered = [...publishing].sort((a, b) =>
    (a.probe === null) === (b.probe === null) ? 0 : a.probe !== null ? -1 : 1
  );
  let hostContract: DataContract | undefined;
  const stamped: string[] = [];
  for (const p of ordered) {
    const binaryPath = join(distDir, p.file);
    let m: ShipManifest;
    try {
      // An explicit --data / --no-data is the operator's answer: the bundle
      // is not asked over it.
      const probed = p.probe === "app" && !dataFlag && !noData
        ? await probeMacApp(binaryPath)
        : undefined;
      m = await shipRelease({
        binaryPath,
        // The version the BUILD resolved (dist/manifest.json), so the manifest
        // says what the artifact says. A pre-versioning dist/ has none; ship
        // then derives it from the tree.
        version: flag("version") ?? build!.version,
        buildNumber: build!.buildNumber,
        commit: build!.commit,
        allowDirty: args.includes("--allow-dirty"),
        keyPath: key.path,
        channel,
        notes: flag("notes"),
        minFrom: flag("min-from"),
        // The artifact sits beside its manifest, so its own file name resolves.
        url: p.file,
        channelDir: outDir,
        // THE platform this artifact is for — from the fleet's own record, not
        // from this machine. `shipApp` defaults it to `Deno.build.*`, so a
        // cross-compiled artifact published here claimed the HOST's platform:
        // every manifest of a multi-platform build was written to the same
        // `<host-os>-<host-arch>.json`, each overwriting the last, and a Windows
        // client asking for `windows-x86_64.json` got a 404. The client checks
        // the platform inside the signature too, so the wrong one is refused
        // even when the path happens to resolve.
        ...(p.platform ? { platform: p.platform } : {}),
        ...(p.manifestName ? { manifestName: p.manifestName } : {}),
        // A cross-compiled artifact cannot be asked what it does with data — it
        // does not run here. It does not have to be asked: a host artifact of the
        // SAME build already answered. Only when there is no host artifact at all
        // does the release go out without a contract, and that is said out loud
        // below rather than left to a message on the user's machine months later.
        // …and `--data=<contract.json>` is the hatch the warning below tells
        // people to use. It was named in that message and read by NOBODY:
        // `flag("data")` appears nowhere in this file, and `publish` was in
        // PASSTHROUGH so an unknown flag is not refused either. A publisher
        // did exactly what the message said, saw no error, and every install
        // holding data refused the release forever — the precise failure this
        // command exists to eliminate. An explicit contract outranks the
        // derived one: it is the operator stating the fact.
        // A directly-run artifact is asked by `shipRelease` itself — unless
        // --data / --no-data answered, as for a `.app`.
        ...(p.probe === "exec" && !dataFlag && !noData ? {} : probed
          // …and the id it runs as, so the release name is checked against it.
          ? { data: probed.contract, runsAs: probed.appId }
          : dataFlag
          ? { dataPath: dataFlag }
          : hostContract
          ? { data: hostContract }
          : { noData: true }),
      });
    } catch (e) {
      // A refusal (a dirty version, a non-program) is a written message with
      // the fix in it — print it, never a stack.
      fail(e instanceof Error ? e.message : String(e), mode);
    }
    if (p.probe !== null && m!.data && !hostContract) hostContract = m!.data;
    if (p.probe === null && hostContract) stamped.push(p.file);
    const mm = m!;
    // …and the artifact itself. A channel directory with a manifest and no
    // binary is a 404 at download time, which is the half-publish the docs'
    // "copy these two files" step produced whenever someone copied one.
    await Deno.copyFile(binaryPath, join(outDir, channel, p.file));
    shipped.push({ m: mm, spec: p });
  }
  for (const d of downloads) {
    await Deno.copyFile(join(distDir, d.file), join(outDir, channel, d.file));
  }
  // A download whose platform got NO manifest: those installs never update.
  const stranded = downloads.filter((d) => !claims.has(d.platform)).map((d) =>
    d.file
  );
  const manifests = shipped.map((x) => x.m);

  const rel = (p: string) => p.replace(root + "/", "");
  const unsigned = manifests.some((m) => !m.signature);
  // The warning is the same fact in both modes — a CI log used to get
  // `"signed":false` and nothing else, and an unsigned release is the one a
  // client refuses on someone else's machine.
  if (unsigned) sayErr(unsignedWarning(manifests[0]!.name));
  else if (key.source === "default") {
    sayErr(
      `am publish: ✓ signed with ${key.path} (the ship keygen default; --key=<path> picks another)`,
    );
  }
  // A platform whose installs can never update is said on stderr in every
  // mode — never only inside the JSON.
  if (stranded.length > 0) sayErr(strandedWarning(stranded));
  // …and so is a release with NO data contract, with the reason per file.
  const blind = shipped.filter((x) => !x.m.data).map((x) => x.spec);
  if (blind.length > 0) sayErr(noContractWarning(blind, noData));
  if (mode === "json") {
    out({
      channel,
      dir: outDir,
      signed: !unsigned,
      key: unsigned ? null : { path: key.path, source: key.source },
      /** Manifests given the host artifact's contract (same build, same cells). */
      contractStampedInto: stamped,
      /** Manifests published with NO data contract — refused by any install
       *  that already holds data. */
      noContract: shipped.filter((x) => !x.m.data).map((x) => x.spec.file),
      // The same fact the text output prints: a scripted publisher must be
      // able to see what was built and NOT published.
      skipped,
      /** Directory artifacts (a `web` build): deployed as they are. */
      directories,
      /** Copied beside the manifests for download only — no manifest names
       *  them (a `.dmg`, the Windows `.zip`). */
      downloads: downloads.map((d) => d.file),
      /** Downloads whose platform has no update manifest in this release. */
      stranded,
      /** Kind manifests (`<os>-<arch>.electron-zip.json`): read by zip
       *  installs on aio ≥ 1.0.13-beta. A zip install on an older aio reads
       *  only the platform manifest and cannot install it — stranded until
       *  updated by hand once. */
      kindManifests: shipped.flatMap((x) =>
        x.spec.manifestName ? [join(channel, x.spec.manifestName)] : []
      ),
      releases: manifests.map((m, i) => ({
        target: shipped[i]!.spec.target,
        name: m.name,
        version: m.version,
        platform: m.platform,
        /** What installs it: `binary`, `electron-zip`, `electron-app`, … */
        kind: m.target,
        manifest: join(
          channel,
          shipped[i]!.spec.manifestName ?? manifestFileName(m.platform),
        ),
        artifact: join(channel, shipped[i]!.spec.file),
        data: m.data ? Object.keys(m.data.cells).length : null,
      })),
    }, mode);
    return;
  }
  const lines = [
    ``,
    `  published ${manifests[0]!.name} ${manifests[0]!.version} → ${
      rel(outDir)
    }/${channel}/`,
    ...manifests.flatMap((m, i) => [
      `    ${shipped[i]!.spec.file}`,
      `    ${shipped[i]!.spec.manifestName ?? manifestFileName(m.platform)}  (${
        shipped[i]!.spec.target
      }, ${m.target}, ${
        m.data
          ? `${count(Object.keys(m.data.cells).length, "cell")} declared`
          : "data NOT declared"
      })`,
    ]),
    ``,
    unsigned
      ? `  UNSIGNED (see the warning above)`
      : `  signed (${
        key.source === "default" ? "keygen default: " : ""
      }${key.path})`,
    ``,
    // No silent caps: a file the publisher built and this command chose not
    // to publish is said out loud, or "published" reads as "published
    // everything".
    // Say which manifests carry a contract they did not probe for themselves,
    // and — the one that matters — which carry none at all.
    ...(stamped.length > 0
      ? [
        `  data contract derived from the host artifact and stamped into: ` +
        stamped.join(", "),
        ``,
      ]
      : []),
    // A second install kind's manifest is read only by clients that know to
    // ask for it (1.0.13-beta on); an older zip install still reads the
    // platform's own manifest and is offered nothing it can install.
    ...(shipped.some((x) => x.spec.manifestName)
      ? [
        `  zip installs update from ` +
        shipped.filter((x) => x.spec.manifestName).map((x) =>
          x.spec.manifestName
        ).join(", ") +
        ` — a zip install running aio older than 1.0.13-beta reads the ` +
        `platform's own manifest (the .exe, kind binary) and cannot install ` +
        `it: those installs are stranded until updated by hand once.`,
        ``,
      ]
      : []),
    ...(downloads.length > 0
      ? [
        `  download only (no manifest names these — an installed app updates ` +
        `from its platform's update artifact): ` +
        downloads.map((d) => d.file).join(", "),
        ``,
      ]
      : []),
    // Loud, not a footnote: a built file that went out with no manifest may
    // be a whole platform missing from this release.
    ...(directories.length > 0
      ? [
        `  not published (a directory — deploy it as it is; a web build ` +
        `updates through its own service worker): ${directories.join(", ")}`,
        ``,
      ]
      : []),
    ...(skipped.length > 0
      ? [
        `  ⚠ NOT published (not a program aio recognises — a companion file, ` +
        `or a platform this release is now missing): ${skipped.join(", ")}`,
        ``,
      ]
      : []),
    `  serve ${rel(outDir)}/ at a URL, then point the app at its BASE:`,
    `    updates: "https://…"      # NOT …/${channel}/, and not a file`,
    ``,
  ];
  out(lines.join("\n"), mode);
}

/** The no-contract warning, one text for both output modes, the reason per
 *  file. */
export function noContractWarning(
  files: { file: string; why: string }[],
  onPurpose: boolean,
): string {
  return `am publish: warning: published WITHOUT a data contract: ${
    files.map((f) => `${f.file} (${onPurpose ? "--no-data" : f.why})`).join(
      ", ",
    )
  } — every install that ALREADY HAS data will refuse ${
    files.length > 1 ? "these releases" : "this release"
  }. Publish from a machine that can run one of them, or pass ` +
    `--data=<contract.json>.`;
}

/** A first-install image published with no update artifact beside it. */
export function strandedWarning(files: string[]): string {
  return `am publish: warning: ${files.join(", ")} published as a download, ` +
    `but its platform has NO update manifest — those installs will never ` +
    `update. The signed .app.tar.gz is built only when a Mac signs the .app ` +
    `(build.macos.host or AIO_MACOS_SSH).`;
}

/** The unsigned warning, one text for both output modes. */
export function unsignedWarning(appName: string): string {
  // Name the command AND where its output lands. "keygen makes one" sent
  // readers looking for a file that keygen deliberately writes OUTSIDE the
  // repo, and the shape they reach for — `keygen > key.json` — captures the
  // printed SUMMARY (a public key and no private half), which signs nothing
  // and fails later with a WebCrypto error.
  return `am publish: warning: UNSIGNED — clients refuse this unless the app sets ` +
    `updates: { allowUnsigned: true }. Sign with --key=<path>.\n` +
    `           No key yet: \`deno task ship keygen\` writes one to ` +
    `${defaultKeyPath(appName)} — am publish uses that file automatically ` +
    `once it exists. Do NOT redirect keygen's output: that captures the ` +
    `printed summary (a public key, no private half), which signs nothing.`;
}
