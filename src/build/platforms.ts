// platforms.ts — the OS/arch axis of the build.
//
// One codebase → every target has always meant the SHELL (server, browser,
// electron, android, cli). It stopped at the machine you were sitting at:
// every binary was compiled for the host, so shipping Linux + Windows + macOS
// meant three machines or three CI runners.
//
// `deno compile --target <triple>` cross-compiles, so the same `deno task
// build` can emit all of them from one machine. This module is the pure part:
// the platform table, host detection, validation, and the rules for which
// shells can cross-compile at all. Kept free of I/O so the WIRING is unit
// testable — a build that silently produces the wrong platform's binary is the
// kind of failure only a user discovers.
//
// There is deliberately NO "one binary for all three OSes" option, because
// there is no such thing: Linux, Windows and macOS use different executable
// container formats (ELF / PE / Mach-O) and different syscall ABIs, and the
// kernel selects the loader from the file's magic bytes. Polyglot files that
// satisfy two formats at once exist as a curiosity; they break code signing,
// trip antivirus heuristics, and cannot survive macOS notarization. One
// artifact per platform, built in one command, is the honest version of that
// wish.

/** A cross-compilation target: what to pass `deno compile --target`, plus how
 *  the artifact is named on that platform. */
export interface PlatformSpec {
  /** Rust-style target triple `deno compile --target` accepts. */
  triple: string;
  os: "linux" | "windows" | "darwin";
  arch: "x86_64" | "aarch64";
  /** Executable suffix, "" everywhere but Windows. */
  exeExt: string;
  desc: string;
}

/** Every platform `deno compile` can target, keyed by the name you pass to
 *  `--platforms=` / `"build": { "platforms": [...] }`. */
export const PLATFORMS: Record<string, PlatformSpec> = {
  linux: {
    triple: "x86_64-unknown-linux-gnu",
    os: "linux",
    arch: "x86_64",
    exeExt: "",
    desc: "Linux x86_64",
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-gnu",
    os: "linux",
    arch: "aarch64",
    exeExt: "",
    desc: "Linux arm64 (Raspberry Pi, Graviton)",
  },
  windows: {
    triple: "x86_64-pc-windows-msvc",
    os: "windows",
    arch: "x86_64",
    exeExt: ".exe",
    desc: "Windows x86_64",
  },
  macos: {
    triple: "x86_64-apple-darwin",
    os: "darwin",
    arch: "x86_64",
    exeExt: "",
    desc: "macOS Intel",
  },
  "macos-arm64": {
    triple: "aarch64-apple-darwin",
    os: "darwin",
    arch: "aarch64",
    exeExt: "",
    desc: "macOS Apple Silicon",
  },
};

/** The platform name for the machine running the build. */
export function hostPlatform(
  build: { os: string; arch: string } = Deno.build,
): string {
  const arm = build.arch === "aarch64";
  if (build.os === "windows") return "windows";
  if (build.os === "darwin") return arm ? "macos-arm64" : "macos";
  return arm ? "linux-arm64" : "linux";
}

/** True when `name` names the machine we are building on — the only platform
 *  whose artifact can also be RUN here. */
export function isHostPlatform(name: string): boolean {
  return name === hostPlatform();
}

/** Build targets whose artifact is produced by `deno compile`, and can
 *  therefore be cross-compiled.
 *
 *  The rest are packaged by platform-specific tooling: Electron targets bundle
 *  a per-OS Electron runtime and package an AppImage, and Android drives
 *  Gradle. Cross-building those needs that platform's toolchain, not a Deno
 *  flag — so asking for them on another platform is refused with a reason
 *  rather than silently emitting a host-shaped artifact under a foreign name. */
export const CROSS_COMPILABLE = new Set([
  "server",
  "browser",
  "cli",
  "cli-client",
]);

/** Why `target` cannot be built for a non-host platform, or null when it can. */
export function crossCompileBlocker(target: string): string | null {
  if (CROSS_COMPILABLE.has(target)) return null;
  if (target.startsWith("electron")) {
    return "Electron targets bundle a per-OS Electron runtime and package an " +
      "AppImage/zip — build them on that OS (or in its CI runner)";
  }
  if (target.startsWith("android")) {
    return "Android builds drive Gradle and produce a platform-independent " +
      "APK — build it once, on any host";
  }
  return `no cross-compilation path for target "${target}"`;
}

/** Validate a platform list. Returns the resolved names, or a message naming
 *  the unknown ones — never a silent drop. `host` resolves to this machine. */
export function resolvePlatforms(
  names: string[],
): { ok: true; platforms: string[] } | { ok: false; error: string } {
  const resolved: string[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!n) continue;
    const name = n === "host" ? hostPlatform() : n;
    if (!(name in PLATFORMS)) {
      unknown.push(n);
      continue;
    }
    if (!resolved.includes(name)) resolved.push(name);
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown platform(s): ${unknown.join(", ")} — known: ${
        Object.keys(PLATFORMS).join(", ")
      }, or "host"`,
    };
  }
  return { ok: true, platforms: resolved };
}

/** The artifact name for `binaryName` on `platform`.
 *
 *  The HOST platform keeps the bare name: that is what every existing task,
 *  script and test already expects, and a build that only targets this machine
 *  must not suddenly rename its output. Cross-built artifacts carry the
 *  platform so a `dist/` holding all of them is unambiguous. */
export function artifactName(binaryName: string, platform: string): string {
  const spec = PLATFORMS[platform];
  if (!spec) return binaryName;
  return isHostPlatform(platform)
    ? `${binaryName}${spec.exeExt}`
    : `${binaryName}-${platform}${spec.exeExt}`;
}
