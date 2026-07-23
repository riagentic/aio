/**
 * @module
 * Build compile — withDevExcluded symlink manager + deno compile step + systemd service file.
 */
import { dirname, fromFileUrl, join, relative } from "@std/path";
import type { BuildConfig } from "./build-config.ts";

// Dev-only packages excluded from all compile targets
const _devTopLevel = ["electron", "esbuild"];
const _devDenoPrefixes = [
  "electron@",
  "esbuild@",
  "@esbuild+",
  "@electron+",
];

type SavedLink = { path: string; target: string; isDir: boolean };

/** Temporarily remove dev symlinks, run compile callback, restore symlinks. Returns callback result. */
export async function withDevExcluded(
  tag: string,
  nmDir: string,
  fn: (excludes: string[]) => Promise<boolean>,
): Promise<boolean> {
  const denoDir = join(nmDir, ".deno");
  const excludes: string[] = [];
  try {
    for await (const e of Deno.readDir(denoDir)) {
      if (
        e.isDirectory && _devDenoPrefixes.some((p) => e.name.startsWith(p))
      ) {
        excludes.push(join(denoDir, e.name));
      }
    }
  } catch { /* no .deno dir */ }

  const saved: SavedLink[] = [];
  async function _rm(path: string): Promise<void> {
    try {
      const t = await Deno.readLink(path);
      saved.push({ path, target: t, isDir: false });
      await Deno.remove(path);
    } catch { /* symlink missing */ }
  }
  async function _rmDir(path: string): Promise<void> {
    try {
      const inner: Array<{ name: string; target: string }> = [];
      for await (const e of Deno.readDir(path)) {
        try {
          inner.push({
            name: e.name,
            target: await Deno.readLink(join(path, e.name)),
          });
        } catch { /* not a symlink */ }
      }
      saved.push({ path, target: JSON.stringify(inner), isDir: true });
      await Deno.remove(path, { recursive: true });
    } catch { /* dir missing */ }
  }

  let ok = false;
  try {
    // AIO-226: removal inside try so finally always restores on error
    for (const name of _devTopLevel) await _rm(join(nmDir, name));
    for (const scope of ["@electron", "@esbuild"]) {
      await _rmDir(join(denoDir, "node_modules", scope));
    }
    await _rm(join(nmDir, ".bin", "esbuild"));

    console.log(
      `[${tag}] excluding ${excludes.length} dev dirs, removed ${saved.length} symlinks`,
    );

    ok = await fn(excludes);
  } finally {
    for (const { path, target, isDir } of saved) {
      try {
        if (isDir) {
          await Deno.mkdir(path, { recursive: true });
          for (
            const { name, target: t } of JSON.parse(target) as Array<
              { name: string; target: string }
            >
          ) await Deno.symlink(t, join(path, name));
        } else {
          await Deno.mkdir(dirname(path), { recursive: true });
          try {
            await Deno.remove(path);
          } catch { /* already gone */ }
          await Deno.symlink(target, path);
        }
      } catch (e) {
        console.warn(`[${tag}] failed to restore symlink ${path}: ${e}`);
      }
    }
    if (saved.length) console.log(`[${tag}] restored ${saved.length} symlinks`);
  }
  return ok;
}

/** `--include` args embedding the SQLite worker. It's loaded via
 *  `new Worker(new URL(...))` — deno compile can't trace that statically —
 *  and EVERY compiled binary needs it since B4a (persistence always opens
 *  the worker-thread DB for the aio_kv store). */
export function dbWorkerInclude(): string[] {
  const dbWorker = new URL("../db/db-worker.ts", import.meta.url);
  // fromFileUrl, not .pathname: pathname keeps percent-encoding (a space in
  // the path becomes %20) and on Windows yields "/C:/…" — either way deno
  // compile cannot find the worker and every build ships without it.
  return dbWorker.protocol === "file:"
    ? ["--include", fromFileUrl(dbWorker)]
    : [];
}

// Dirs never scanned for app assets (deps / build output / VCS / vendored fw).
const ASSET_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dep",
  "target", // Rust/Cargo build output (rust/target/…)
  ".git",
  ".aio",
  ".cache",
]);

/** `--include` args for the app's runtime DATA ASSETS that `deno compile` can't
 *  trace — anything loaded via `Deno.readFile(new URL("./x", import.meta.url))`
 *  is invisible to the module graph, so it's missing from the binary/AppImage
 *  unless explicitly embedded. WITHOUT this a WASM app compiles fine but shows
 *  "wasm not available" at runtime (the #1 report). Covers:
 *   1. every `.wasm` in the project (zero-config — WASM is a first-class case);
 *   2. any extra paths the app declares in deno.json `compile.include`
 *      (files or dirs, relative to the project root — for data files, models…).
 *  Returns flat `["--include", "&lt;relpath&gt;", …]` args (deduped, root-relative). */
export async function assetIncludes(root: string): Promise<string[]> {
  const rels: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    const norm = rel.split("\\").join("/");
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      rels.push(norm);
    }
  };

  // 1) auto-discover every .wasm (bounded walk, skipping deps/build/VCS dirs).
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 10) return;
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(dir);
    } catch {
      return;
    }
    for await (const e of entries) {
      if (e.isDirectory) {
        if (ASSET_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile && e.name.endsWith(".wasm")) {
        add(relative(root, join(dir, e.name)));
      }
    }
  };
  await walk(root, 0);

  // 2) declarative deno.json `compile.include` — files/dirs the app wants
  //    embedded (any asset kind). Kept inside the project (no traversal out).
  try {
    const cfg = JSON.parse(await Deno.readTextFile(join(root, "deno.json")));
    const decl = (cfg as { compile?: { include?: unknown } })?.compile?.include;
    if (Array.isArray(decl)) {
      for (const p of decl) {
        if (typeof p !== "string" || !p.trim()) continue;
        const rel = relative(root, join(root, p.trim()));
        if (rel.startsWith("..") || rel.startsWith("/")) continue; // stay in-project
        add(rel);
      }
    }
  } catch { /* no deno.json / no compile.include — fine */ }

  return rels.flatMap((r) => ["--include", r]);
}

/** The exact `deno compile` argv for a target — pure, so the WIRING is testable.
 *  Every include here is a runtime dependency that `deno compile` cannot trace
 *  on its own (the embedded `dist/`, the SQLite worker, the app's data assets);
 *  if one silently stops being passed, the binary still builds and only fails
 *  in the user's hands. Assembling the argv separately lets a unit test assert
 *  each one is present without running a real compile. */
export function compileArgs(opts: {
  hasDist: boolean;
  workerInclude: string[];
  assets: string[];
  excludes: string[];
  out: string;
  entry: string;
}): string[] {
  return [
    "compile",
    "-A",
    ...(opts.hasDist ? ["--include", "dist/"] : []),
    ...opts.workerInclude,
    ...opts.assets,
    ...opts.excludes.flatMap((e) => ["--exclude", e]),
    "-o",
    opts.out,
    opts.entry,
  ];
}

/** Run deno compile. Returns true on success. */
export async function runDenoCompile(cfg: BuildConfig): Promise<boolean> {
  const { root, dist, binaryName, configEntry, doElectron } = cfg;
  const nmDir = join(root, "node_modules");

  const compileTarget = doElectron
    ? join(dist, "AppDir", binaryName)
    : binaryName;
  if (doElectron) await Deno.mkdir(join(dist, "AppDir"), { recursive: true });

  let hasDist = false;
  try {
    hasDist = (await Deno.stat(dist)).isDirectory;
  } catch { /* no dist */ }

  const workerInclude = dbWorkerInclude();
  // Embed the app's runtime data assets (.wasm + declared compile.include) —
  // deno compile can't trace `Deno.readFile(new URL(…, import.meta.url))`, so
  // without this a WASM app runs degraded in the binary/AppImage.
  const assets = await assetIncludes(root);
  if (assets.length) {
    console.log(
      `[compile] embedding ${assets.length / 2} data asset(s): ${
        assets.filter((a) => a !== "--include").join(", ")
      }`,
    );
  }

  const ok = await withDevExcluded("compile", nmDir, async (excludes) => {
    const result = await new Deno.Command("deno", {
      args: compileArgs({
        hasDist,
        workerInclude,
        assets,
        excludes,
        out: compileTarget,
        entry: configEntry,
      }),
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (result.code === 0) console.log(`[compile] \u2713 ${compileTarget}`);
    return result.code === 0;
  });

  return ok;
}

/** Runtime flags for the generated systemd unit.
 *
 *  These MUST be flags the compiled binary actually parses — a unit is copied
 *  verbatim into /etc/systemd/system, so a wrong flag is only discovered as a
 *  crash loop on the user's server. `--headless` is a BUILD flag with no
 *  runtime counterpart; the runtime spelling for "server, no UI" is
 *  `--client=server-only`. Shipping `--headless` meant the service started in
 *  the default (electron) client mode instead. Pure, so the unit's contract is
 *  unit-testable against the CLI's known flags. */
export function serviceExecFlags(
  opts: { doRemote: boolean; doHeadless: boolean; port?: number },
): string[] {
  const flags = [`--port=${opts.port ?? 3000}`];
  if (opts.doRemote) flags.push("--expose");
  if (opts.doHeadless) flags.push("--client=server-only");
  return flags;
}

/** Write a systemd .service unit file for the compiled binary. */
export async function writeServiceFile(cfg: BuildConfig): Promise<void> {
  const { binaryName, appTitle, doRemote, doHeadless } = cfg;
  const user = Deno.env.get("USER") ?? "root";
  const home = Deno.env.get("HOME") ?? `/home/${user}`;
  const serviceFile = `${binaryName}.service`;
  const execFlags = serviceExecFlags({ doRemote, doHeadless });
  const unit = `[Unit]
Description=${appTitle ?? binaryName} (aio)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/${binaryName} ${
    execFlags.join(" ")
  }  # adjust path after install
Restart=on-failure
RestartSec=5
User=${user}
Environment=HOME=${home}

[Install]
WantedBy=multi-user.target
`;
  await Deno.writeTextFile(serviceFile, unit);
  console.log(`[service] \u2713 ${serviceFile}`);
  console.log(`
  Install:
    sudo cp ${binaryName} /usr/local/bin/
    sudo cp ${serviceFile} /etc/systemd/system/
    sudo systemctl enable --now ${binaryName}

  Manage:
    sudo systemctl status ${binaryName}
    journalctl -u ${binaryName} -f
`);
}
