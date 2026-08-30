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
import { PLATFORMS } from "../build/platforms.ts";
import { detectMode, fail, out } from "./am-output.ts";
import { readDenoJson } from "../server/deno-json.ts";
import {
  artifactFormat,
  type DataContract,
  defaultKeyPath,
  manifestFileName,
  resolveSigningKey,
  shipApp,
  type ShipManifest,
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
  targets?: {
    target: string;
    ok?: boolean;
    /** True when this artifact runs on the machine that built it. */
    host?: boolean;
    platform?: string;
    artifacts?: { file: string }[];
  }[];
};

/** Is this file a runnable program, rather than a companion the build wrote
 *  beside one (a systemd unit, a checksum, a desktop entry)?
 *
 *  Read from the file's own first bytes, not from its name or its target: the
 *  set of companion files grows, and a rule keyed on extensions would have to
 *  grow with it silently. An unreadable file is treated as a program so the
 *  refusal comes from `shipApp`, which can say why. */
function isProgram(path: string): boolean {
  let head: Uint8Array;
  try {
    using f = Deno.openSync(path, { read: true });
    head = new Uint8Array(8);
    const n = f.readSync(head) ?? 0;
    head = head.subarray(0, n);
  } catch {
    return true; // aio-ok: unreadable here means shipApp reports it, with the path
  }
  return artifactFormat(head) !== null;
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

export async function cmdPublish(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const flag = (k: string) =>
    args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
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
    host: boolean;
    platform?: { os: string; arch: string };
  }[] = [];
  const skipped: string[] = [];
  const only = flag("target");
  for (const t of built) {
    if (only && t.target !== only) continue;
    for (const a of t.artifacts ?? []) {
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
      if (!isProgram(join(distDir, a.file))) {
        skipped.push(a.file);
        continue;
      }
      const key = t.platform ?? "host";
      const owner = claims.get(key);
      if (owner !== undefined) {
        fail(
          `targets "${owner}" and "${t.target}" both build for ${key}, and an ` +
            `update client fetches ONE manifest per platform ` +
            `(<channel>/<os>-<arch>.json) — publishing both would leave only ` +
            `the last one.\n` +
            `Pick which one this channel serves: am publish --target=${t.target}` +
            ` (or --target=${owner}).`,
          mode,
        );
      }
      claims.set(key, t.target);
      publishing.push({
        target: t.target,
        file: a.file,
        host: t.host !== false,
        // `PLATFORMS` is the same table the build resolved this artifact from,
        // so the manifest cannot disagree with the binary about what it is for.
        // An unknown name yields undefined and `shipApp` falls back to the host
        // — which is right for a single-platform build and is what it did
        // before this existed.
        platform: PLATFORMS[t.platform ?? ""]
          ? {
            os: PLATFORMS[t.platform!]!.os,
            arch: PLATFORMS[t.platform!]!.arch,
          }
          : undefined,
      });
    }
  }
  if (publishing.length === 0) {
    fail(
      `no artifact for --target=${only} in ${join(distDir, "manifest.json")} ` +
        `— it holds: ${built.map((t) => t.target).join(", ")}`,
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
  await Deno.mkdir(join(outDir, channel), { recursive: true });
  // Manifest AND the spec that produced it, together — the two used to be
  // parallel arrays indexed by position, which the host-first ordering below
  // would silently misalign.
  const shipped: { m: ShipManifest; spec: typeof publishing[number] }[] = [];
  const ordered = [...publishing].sort((a, b) =>
    a.host === b.host ? 0 : a.host ? -1 : 1
  );
  let hostContract: DataContract | undefined;
  const stamped: string[] = [];
  for (const p of ordered) {
    const binaryPath = join(distDir, p.file);
    let m: ShipManifest;
    try {
      m = await shipApp({
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
        // A cross-compiled artifact cannot be asked what it does with data — it
        // does not run here. It does not have to be asked: a host artifact of the
        // SAME build already answered. Only when there is no host artifact at all
        // does the release go out without a contract, and that is said out loud
        // below rather than left to a message on the user's machine months later.
        ...(p.host
          ? {}
          : hostContract
          ? { data: hostContract }
          : { noData: true }),
      });
    } catch (e) {
      // A refusal (a dirty version, a non-program) is a written message with
      // the fix in it — print it, never a stack.
      fail(e instanceof Error ? e.message : String(e), mode);
    }
    if (p.host && m!.data && !hostContract) hostContract = m!.data;
    if (!p.host && hostContract) stamped.push(p.file);
    const mm = m!;
    // …and the artifact itself. A channel directory with a manifest and no
    // binary is a 404 at download time, which is the half-publish the docs'
    // "copy these two files" step produced whenever someone copied one.
    await Deno.copyFile(binaryPath, join(outDir, channel, p.file));
    shipped.push({ m: mm, spec: p });
  }
  const manifests = shipped.map((x) => x.m);

  const rel = (p: string) => p.replace(root + "/", "");
  const unsigned = manifests.some((m) => !m.signature);
  // The warning is the same fact in both modes — a CI log used to get
  // `"signed":false` and nothing else, and an unsigned release is the one a
  // client refuses on someone else's machine.
  if (unsigned) console.error(unsignedWarning(manifests[0]!.name));
  else if (key.source === "default") {
    console.error(
      `am publish: ✓ signed with ${key.path} (the ship keygen default; --key=<path> picks another)`,
    );
  }
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
      releases: manifests.map((m, i) => ({
        target: shipped[i]!.spec.target,
        name: m.name,
        version: m.version,
        platform: m.platform,
        manifest: join(channel, manifestFileName(m.platform)),
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
      `    ${manifestFileName(m.platform)}  (${shipped[i]!.spec.target}, ${
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
    ...(manifests.some((m) => !m.data)
      ? [
        `  ⚠ published WITHOUT a data contract: ` +
        shipped.filter((x) => !x.m.data).map((x) => x.spec.file).join(", ") +
        ` — no artifact of this build runs on this machine, so nothing could ` +
        `be asked what it does with persisted data. Every install that ALREADY ` +
        `HAS data will refuse these releases. Publish from a machine that can ` +
        `run one of them, or pass --data=<contract.json>.`,
        ``,
      ]
      : []),
    ...(skipped.length > 0
      ? [
        `  not published (not a program — a companion file beside one): ` +
        skipped.join(", "),
        ``,
      ]
      : []),
    `  serve ${rel(outDir)}/ at a URL, then point the app at its BASE:`,
    `    updates: "https://…"      # NOT …/${channel}/, and not a file`,
    ``,
  ];
  out(lines.join("\n"), mode);
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
