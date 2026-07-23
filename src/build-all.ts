/**
 * @module
 * Multi-target build orchestrator — one command builds a whole fleet.
 *
 * A single `deno task build` reads the target list from `deno.json`
 * (`"build": { "targets": [...] }`, or `--targets=a,b,c`), builds each target
 * by invoking the single-target pipeline ({@link build} in `build.ts`) as a
 * subprocess, and collects every artifact into a predictable `dist/` with a
 * `manifest.json`. The per-target builds are unchanged — this only orchestrates
 * and gathers, so the existing `compile:*` tasks keep working exactly as before.
 *
 * ```sh
 * deno run -A jsr:@riagentic/aio/build-all               # build.targets
 * deno run -A jsr:@riagentic/aio/build-all --targets=server,electron-client
 * deno run -A jsr:@riagentic/aio/build-all --list        # show target names
 * ```
 */
import {
  basename,
  extname,
  fromFileUrl,
  join,
  resolve,
  SEPARATOR,
} from "@std/path";
import { slugify } from "./build/build-helpers.ts";

/** A build target → the single-target `build.ts` flags that produce it, its
 *  network role, and a one-line description. Client targets connect to a
 *  separately-built (or already-running) aio server. */
interface TargetSpec {
  flags: string[];
  role: "server" | "client" | "app";
  desc: string;
}
export const TARGETS: Record<string, TargetSpec> = {
  server: {
    flags: ["--compile", "--service", "--headless", "--remote"],
    role: "server",
    desc: "headless LAN/remote server binary + systemd unit (--expose)",
  },
  browser: {
    flags: ["--compile"],
    role: "app",
    desc: "self-contained binary serving the browser app",
  },
  electron: {
    flags: ["--compile", "--electron"],
    role: "app",
    desc: "Electron desktop app (AppImage / zip)",
  },
  android: {
    flags: ["--android"],
    role: "app",
    desc: "Android APK (bundled assets)",
  },
  cli: {
    flags: ["--compile", "--cli"],
    role: "app",
    desc: "headless CLI binary",
  },
  "electron-client": {
    flags: ["--client"],
    role: "client",
    desc: "standalone Electron connect-page client (AppImage)",
  },
  "android-client": {
    flags: ["--android", "--remote"],
    role: "client",
    desc: "Android client that connects to a server",
  },
  "cli-client": {
    flags: ["--compile", "--cli", "--remote"],
    role: "client",
    desc: "CLI client binary that connects to a server",
  },
};

interface BuildBlock {
  targets?: string[];
  out?: string;
  server?: string; // LAN/remote server address (recorded in the manifest)
}
interface ArtifactRec {
  file: string;
  bytes: number;
}
interface TargetResult {
  target: string;
  role: string;
  ok: boolean;
  error?: string;
  artifacts: ArtifactRec[];
}

const C = {
  b: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  blue: "\x1b[36m",
  yellow: "\x1b[33m",
  r: "\x1b[0m",
};

const flag = (name: string): string | undefined =>
  Deno.args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** Human byte size. */
function human(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`;
}

const ARTIFACT_EXTS = new Set([
  ".AppImage",
  ".apk",
  ".zip",
  ".service",
  ".exe",
]);

/** Is `name` a build artifact for `binaryName`? Per-target builds emit
 *  arch-suffixed names we can't fully predict, so we recognize by prefix+ext
 *  (the bare binary has no extension; the aio-client AppImage has its own). */
export function isArtifactName(name: string, binaryName: string): boolean {
  const ext = extname(name);
  if (ARTIFACT_EXTS.has(ext)) {
    return name.startsWith(binaryName) || name.startsWith("aio-client-");
  }
  if (ext === "") {
    return name === binaryName || name === `${binaryName}-client` ||
      name.startsWith("aio-client-");
  }
  return false;
}

/** Pick the flat-layout name for `file`, disambiguating a cross-target
 *  collision (e.g. browser + server both emit the bare binary) by appending the
 *  target before the extension. Does not mutate `used`. */
export function placedName(
  file: string,
  used: Set<string>,
  target: string,
): string {
  if (!used.has(file)) return file;
  const ext = extname(file);
  return `${file.slice(0, file.length - ext.length)}-${target}${ext}`;
}

/** True if `outDir` is unsafe to wipe+recreate: the `out` dir is assembled by
 *  removing it recursively, so it MUST be a dedicated subdir of the project —
 *  never the root, an ancestor (`out: ".."`), `.aio` (our staging parent), or a
 *  source dir. `out: ""` / `"."` resolve to the root and are caught here. */
export function unsafeOutDir(outDir: string, root: string): boolean {
  const forbidden = new Set([
    root,
    join(root, ".aio"),
    join(root, "src"),
    join(root, ".git"),
  ]);
  return !outDir.startsWith(root + SEPARATOR) || forbidden.has(outDir);
}

/** Move a file, falling back to copy+delete across filesystem boundaries — a
 *  dist/ or .aio on a tmpfs/overlay mount makes a bare rename throw EXDEV. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await Deno.rename(from, to);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) throw e;
    // EXDEV (cross-device) or any rename failure → copy then remove.
    await Deno.copyFile(from, to);
    await Deno.remove(from);
  }
}

function printTargets(): void {
  console.log(`${C.b}Available build targets:${C.r}`);
  for (const [name, spec] of Object.entries(TARGETS)) {
    console.log(
      `  ${C.blue}${name.padEnd(16)}${C.r}${C.dim}${
        spec.role.padEnd(8)
      }${C.r}${spec.desc}`,
    );
  }
  console.log(
    `\n${C.dim}Declare them in deno.json → "build": { "targets": [...] }, or pass --targets=a,b${C.r}`,
  );
}

/** Run the multi-target build. Returns the process exit code (0 = all ok). */
export async function buildAll(): Promise<number> {
  if (Deno.args.includes("--list") || Deno.args.includes("--help")) {
    printTargets();
    return 0;
  }

  const root = Deno.cwd();
  let denoJson: { title?: string; build?: BuildBlock };
  try {
    denoJson = JSON.parse(await Deno.readTextFile(join(root, "deno.json")));
  } catch {
    console.error(`${C.red}✗ no readable deno.json in ${root}${C.r}`);
    return 1;
  }
  const block: BuildBlock = denoJson.build ?? {};
  const title = denoJson.title ?? basename(root);
  const binaryName = slugify(title);

  // Target list: --targets= overrides deno.json build.targets.
  const argTargets = flag("targets");
  const targetList = (argTargets ? argTargets.split(",") : block.targets ?? [])
    .map((t) => t.trim())
    .filter(Boolean);
  if (targetList.length === 0) {
    console.error(
      `${C.red}✗ no targets to build.${C.r} Add ${C.blue}"build": { "targets": [...] }${C.r} to deno.json, or pass ${C.blue}--targets=server,electron-client${C.r}\n`,
    );
    printTargets();
    return 1;
  }
  const unknown = targetList.filter((t) => !(t in TARGETS));
  if (unknown.length > 0) {
    console.error(
      `${C.red}✗ unknown target(s): ${unknown.join(", ")}${C.r}\n`,
    );
    printTargets();
    return 1;
  }

  const outDir = resolve(join(root, flag("out") ?? block.out ?? "dist"));
  if (unsafeOutDir(outDir, root)) {
    console.error(
      `${C.red}✗ refusing to build into ${outDir}${C.r} — "out" must be a dedicated subdirectory of the project (not the root, src, .git, or .aio)`,
    );
    return 1;
  }
  const release = Deno.args.includes("--release");
  const force = Deno.args.includes("--force");

  // Resolve the single-target build entry. Prefer the caller-supplied
  // `--build-spec` (the generated task passes the framework's own build path /
  // jsr specifier, so JSR resolution is preserved); fall back to this module's
  // sibling for a direct `deno run build-all.ts`.
  const buildUrl = new URL("./build.ts", import.meta.url);
  const buildScript = flag("build-spec") ??
    (buildUrl.protocol === "file:" ? fromFileUrl(buildUrl) : buildUrl.href);

  // ── artifact detection ──────────────────────────────────────────────────
  // Per-target builds emit arch-suffixed names we can't fully predict, so we
  // diff the root dir before/after each build and gather what appeared/changed.
  // Key by mtime AND size: on a coarse-mtime filesystem a rebuild that
  // overwrites a same-named artifact within the same second keeps the mtime but
  // changes the size, so size closes the "missed artifact" gap.
  const snapshot = async (): Promise<Map<string, string>> => {
    const m = new Map<string, string>();
    for await (const e of Deno.readDir(root)) {
      if (!e.isFile || !isArtifactName(e.name, binaryName)) continue;
      try {
        const st = await Deno.stat(join(root, e.name));
        m.set(e.name, `${st.mtime?.getTime() ?? 0}:${st.size}`);
      } catch { /* vanished — ignore */ }
    }
    return m;
  };

  // Same-filesystem staging (survives each build's dist/ clean; rename is safe).
  const staging = join(root, ".aio", `build-staging-${crypto.randomUUID()}`);
  await Deno.mkdir(staging, { recursive: true });

  console.log(
    `${C.b}Building ${targetList.length} target(s) for ${C.blue}${title}${C.r}${C.b} → ${
      outDir.replace(root + "/", "")
    }/${C.r}${release ? ` ${C.dim}(release)${C.r}` : ""}`,
  );

  const results: TargetResult[] = [];
  try {
    for (const target of targetList) {
      const spec = TARGETS[target]!;
      console.log(`\n${C.b}▶ ${target}${C.r} ${C.dim}— ${spec.desc}${C.r}`);
      const before = await snapshot();
      const args = ["run", "-A", buildScript, ...spec.flags, `--name=${title}`];
      if (release) args.push("--release");
      if (force) args.push("--force");
      const { code } = await new Deno.Command("deno", {
        args,
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
      }).output();

      if (code !== 0) {
        results.push({
          target,
          role: spec.role,
          ok: false,
          error: `build exited ${code}`,
          artifacts: [],
        });
        console.error(`${C.red}✗ ${target} failed (exit ${code})${C.r}`);
        continue;
      }

      // Gather artifacts that appeared or changed, move them to staging.
      const after = await snapshot();
      const fresh = [...after].filter(([n, sig]) =>
        !before.has(n) || sig !== before.get(n)
      ).map(([n]) => n);
      const tdir = join(staging, target);
      await Deno.mkdir(tdir, { recursive: true });
      const artifacts: ArtifactRec[] = [];
      for (const name of fresh) {
        await moveFile(join(root, name), join(tdir, name));
        artifacts.push({
          file: name,
          bytes: (await Deno.stat(join(tdir, name))).size,
        });
      }
      if (artifacts.length === 0) {
        console.warn(
          `${C.yellow}⚠ ${target} built but produced no recognized artifact${C.r}`,
        );
      }
      results.push({ target, role: spec.role, ok: true, artifacts });
    }

    // ── assemble a clean dist/ (flat) + manifest ────────────────────────────
    // Never destroy a prior good dist/ for a build that produced nothing (every
    // target failed) — leave the previous artifacts in place and just report.
    const totalArtifacts = results.reduce(
      (n, r) => n + (r.ok ? r.artifacts.length : 0),
      0,
    );
    if (totalArtifacts === 0) {
      console.error(
        `\n${C.red}✗ no artifacts produced — leaving ${
          outDir.replace(root + SEPARATOR, "")
        }/ untouched${C.r}`,
      );
      return 1;
    }
    await Deno.remove(outDir, { recursive: true }).catch(() => {});
    await Deno.mkdir(outDir, { recursive: true });
    const used = new Set<string>();
    const manifestTargets = [];
    for (const r of results) {
      const placed: ArtifactRec[] = [];
      if (r.ok) {
        for (const a of r.artifacts) {
          // Flat layout: on a cross-target name collision, disambiguate with the
          // target so nothing silently overwrites (e.g. browser + server binary).
          const name = placedName(a.file, used, r.target);
          used.add(name);
          await moveFile(
            join(staging, r.target, a.file),
            join(outDir, name),
          );
          placed.push({ file: name, bytes: a.bytes });
        }
      }
      manifestTargets.push({
        target: r.target,
        role: r.role,
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
        artifacts: placed,
      });
    }
    const manifest = {
      app: binaryName,
      title,
      builtAt: new Date().toISOString(),
      release,
      server: block.server ?? null,
      targets: manifestTargets,
    };
    await Deno.writeTextFile(
      join(outDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }

  // ── summary ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  const rel = (p: string) => p.replace(root + "/", "");
  console.log(`\n${C.b}── build summary ──${C.r}`);
  for (const t of results) {
    if (!t.ok) {
      console.log(`  ${C.red}✗ ${t.target}${C.r} ${C.dim}${t.error}${C.r}`);
      continue;
    }
    const files = t.artifacts.map((a) =>
      `${a.file} ${C.dim}(${human(a.bytes)})${C.r}`
    );
    console.log(
      `  ${C.green}✓ ${t.target}${C.r} ${C.dim}→${C.r} ${
        files.join(", ") || C.dim + "no artifact" + C.r
      }`,
    );
  }
  if (block.server) {
    console.log(
      `\n  ${C.dim}clients connect to server:${C.r} ${C.blue}${block.server}${C.r}`,
    );
  }
  console.log(
    `\n${failed.length ? C.red : C.green}${failed.length ? "✗" : "✓"} ${
      results.length - failed.length
    }/${results.length} target(s) built → ${C.blue}${rel(outDir)}/${C.r}`,
  );
  return failed.length ? 1 : 0;
}

if (import.meta.main) Deno.exit(await buildAll());
