/**
 * @module
 * aio decides an app's Electron — `am pin` and `am fix` keep the app's copies
 * in line with it.
 *
 * aio is tested with ONE Electron (`DEFAULT_ELECTRON_VERSION`), and a build
 * ships exactly that one. An app holds two copies of the choice: the
 * `"electron": "npm:electron@x.y.z"` line `am create` wrote, and the runtime
 * in node_modules. Nothing moved them when the app moved to a newer aio, so an
 * app scaffolded a year ago kept that year's Chromium under every later
 * framework — a combination no aio release had ever run.
 *
 * The version a copy must match is the one the app's PINNED aio is tested
 * with, read from that aio's own source (`dep/aio` or the version install) —
 * not this `am`'s, which may be another release. The runtime is read and
 * installed through THIS `am`'s `electron-install.ts` (`--version`,
 * `--install=<v>`): an older aio's installer may not know those flags, and
 * the one reader of "which Electron is installed" lives there.
 */
import { fromFileUrl, join } from "@std/path";
import { DEFAULT_ELECTRON_VERSION } from "../build/electron-runtime.ts";

/** The Electron `frameworkRoot`'s aio is tested with, or null when that tree
 *  does not say (an aio from before the constant existed). */
export async function testedElectronOf(
  frameworkRoot: string,
): Promise<string | null> {
  try {
    const src = await Deno.readTextFile(
      join(frameworkRoot, "src", "electron", "electron-runtime-fetch.ts"),
    );
    return /DEFAULT_ELECTRON_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/.exec(src)?.[1] ??
      null;
  } catch {
    return null; // not an aio tree, or an old one — the caller falls back
  }
}

/** The tested Electron for the app at `appDir`: its `dep/aio`'s, else this
 *  `am`'s own. */
export async function testedElectronFor(appDir: string): Promise<string> {
  return (await testedElectronOf(join(appDir, "dep", "aio"))) ??
    DEFAULT_ELECTRON_VERSION;
}

/** The import-map value that pins `version`. Pure. */
export function electronSpec(version: string): string {
  return `npm:electron@${version}`;
}

const INSTALLER = fromFileUrl(
  new URL("../electron-install.ts", import.meta.url),
);

async function installer(
  appDir: string,
  args: string[],
  quiet: boolean,
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    // `deno`, as `am fix`'s other installer calls: `am` itself may be an
    // installed script or a compiled binary, and only deno runs the installer.
    const o = await new Deno.Command("deno", {
      args: ["run", "-A", INSTALLER, ...args],
      cwd: appDir,
      stdin: "null",
      stdout: "piped",
      stderr: quiet ? "piped" : "inherit",
    }).output();
    const dec = new TextDecoder();
    return {
      ok: o.code === 0,
      out: dec.decode(o.stdout).trim(),
      err: quiet ? dec.decode(o.stderr).trim().split("\n").pop() ?? "" : "",
    };
  } catch (e) {
    return {
      ok: false,
      out: "",
      err: e instanceof Error ? e.message : String(e),
    };
  }
}

/** The unpacked Electron runtime in `appDir`'s node_modules, or null. */
export async function installedElectronIn(
  appDir: string,
): Promise<string | null> {
  const r = await installer(appDir, ["--version"], true);
  return r.ok && /^\d+\.\d+\.\d+/.test(r.out) ? r.out : null;
}

/** Install exactly `version` into `appDir` (a ~100 MB download the first
 *  time). Throws with the installer's last line when it did not land. */
export async function installElectronIn(
  appDir: string,
  version: string,
): Promise<void> {
  const r = await installer(appDir, [`--install=${version}`], false);
  if (!r.ok) throw new Error(`the Electron ${version} install failed`);
  const now = await installedElectronIn(appDir);
  if (now !== version) {
    throw new Error(
      `the installer exited 0 but node_modules has ${now ?? "no Electron"}, ` +
        `not ${version}`,
    );
  }
}

/** What aligning an app's Electron runtime did. */
export type ElectronAlign = {
  from: string;
  to: string;
  /** "installed" · "skipped" (--no-download) · "failed" (with `error`). */
  outcome: "installed" | "skipped" | "failed";
  error?: string;
};

/** Move the Electron runtime in `appDir`'s node_modules to the version
 *  `frameworkRoot`'s aio is tested with. Only an app that HAS a runtime
 *  installed (it uses Electron — never a 100 MB surprise for a browser app),
 *  and only when it differs. Null: nothing to do. Never throws — the pin or
 *  fix around it stands, and the outcome says what did not happen. */
export async function alignElectronRuntime(
  appDir: string,
  frameworkRoot: string,
  noDownload: boolean,
): Promise<ElectronAlign | null> {
  const to = (await testedElectronOf(frameworkRoot)) ??
    DEFAULT_ELECTRON_VERSION;
  const from = await installedElectronIn(appDir);
  if (from === null || from === to) return null;
  if (noDownload) return { from, to, outcome: "skipped" };
  try {
    await installElectronIn(appDir, to);
    return { from, to, outcome: "installed" };
  } catch (e) {
    return {
      from,
      to,
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** One line for an `ElectronAlign`. Pure. */
export function electronLine(a: ElectronAlign): string {
  const what =
    `Electron ${a.from} → ${a.to} (the version this aio is tested with)`;
  switch (a.outcome) {
    case "installed":
      return `${what}: installed`;
    case "skipped":
      return `${what}: NOT installed (--no-download) — run \`am fix\` when online`;
    case "failed":
      return `${what}: install FAILED (${a.error}) — run \`am fix\` to retry; ` +
        `a build ships ${a.to} regardless`;
  }
}
