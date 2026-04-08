/**
 * @module
 * Build compile — withDevExcluded symlink manager + deno compile step + systemd service file.
 */
import { dirname, join } from "@std/path";
import type { BuildConfig } from "./build-config.ts";

// Dev-only packages excluded from all compile targets
const _devTopLevel = ["electron", "esbuild", "react", "react-dom"];
const _devDenoPrefixes = [
  "electron@",
  "esbuild@",
  "@esbuild+",
  "@electron+",
  "react@",
  "react-dom@",
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

  const ok = await withDevExcluded("compile", nmDir, async (excludes) => {
    const result = await new Deno.Command("deno", {
      args: [
        "compile",
        "-A",
        ...(hasDist ? ["--include", "dist/"] : []),
        ...excludes.flatMap((e) => ["--exclude", e]),
        "-o",
        compileTarget,
        configEntry,
      ],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (result.code === 0) console.log(`[compile] \u2713 ${compileTarget}`);
    return result.code === 0;
  });

  return ok;
}

/** Write a systemd .service unit file for the compiled binary. */
export async function writeServiceFile(cfg: BuildConfig): Promise<void> {
  const { binaryName, appTitle, doRemote, doHeadless } = cfg;
  const user = Deno.env.get("USER") ?? "root";
  const home = Deno.env.get("HOME") ?? `/home/${user}`;
  const serviceFile = `${binaryName}.service`;
  const execFlags = ["--port=3000"];
  if (doRemote) execFlags.push("--expose");
  if (doHeadless) execFlags.push("--headless");
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
