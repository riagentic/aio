// Build helpers — pure/extractable utilities used by build.ts
import { dirname, join } from "@std/path";

/** Known SHA-256 hashes for appimagetool builds (continuous release).
 *  Update when upgrading — run: `curl -sL <url> | sha256sum` */
const APPIMAGETOOL_HASHES: Record<string, string> = {
  // x86_64: "sha256:<hash>", // Uncomment and fill when pinning a specific build
  // aarch64: "sha256:<hash>",
};

/** Slugify a string for use as binary/app name */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "myapp";
}

/** Recursively copy a directory (preserves symlinks + executable bits) */
export async function copyDir(src: string, dst: string): Promise<void> {
  await Deno.mkdir(dst, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory) {
      await copyDir(srcPath, dstPath);
    } else if (entry.isSymlink) {
      const target = await Deno.readLink(srcPath);
      await Deno.symlink(target, dstPath);
    } else {
      await Deno.copyFile(srcPath, dstPath);
      // Preserve executable bit
      try {
        const info = await Deno.stat(srcPath);
        if (info.mode !== null && info.mode & 0o111) {
          await Deno.chmod(dstPath, info.mode);
        }
      } catch { /* no mode — skip chmod */ }
    }
  }
}

/** Find gradle binary — checks PATH then common install locations */
export function findGradle(): string | null {
  const home = Deno.env.get("HOME") ?? "/tmp";
  const candidates = [
    "gradle",
    "/usr/bin/gradle",
    "/usr/local/bin/gradle",
    "/snap/bin/gradle",
    "/opt/gradle/bin/gradle",
    `${home}/.sdkman/candidates/gradle/current/bin/gradle`,
  ];
  for (const cmd of candidates) {
    try {
      const r = new Deno.Command(cmd, {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).outputSync();
      if (r.code === 0) return cmd;
    } catch { /* not found — try next */ }
  }
  return null;
}

/** Highest Java major version the pinned Gradle (8.12.1) can RUN on. Gradle's
 *  own daemon JVM must be ≤ this — a newer JDK (e.g. 25) crashes Gradle at
 *  startup with a bare version string. (Bump alongside the wrapper version.) */
export const GRADLE_MAX_JDK = 23;
/** Preferred ceiling — AGP 8.7's blessed LTS range (17/21). Pick the newest JDK
 *  at or below this before falling back to any other Gradle-runnable JDK. */
const PREFERRED_MAX_JDK = 21;

export interface JdkResult {
  /** JAVA_HOME of the chosen JDK (has javac, major ≤ GRADLE_MAX_JDK), or null. */
  home: string | null;
  /** Highest major of ANY JDK-with-javac found, even if too new (0 = none).
   *  Lets the caller say "found JDK 25, too new" vs "no JDK at all". */
  newestFound: number;
}

/** Find a JDK to hand Gradle. A JRE is NOT enough (needs `javac`), and the JDK
 *  must be Gradle-runnable (major ≤ GRADLE_MAX_JDK) — the newest LTS in range
 *  wins. Scans JAVA_HOME, system JVM dirs, Android Studio's JBR, and PATH.
 *  An explicit, in-range JAVA_HOME always wins; a too-new JAVA_HOME is skipped
 *  in favour of a supported one found elsewhere. */
export function findJdk(): JdkResult {
  const home = Deno.env.get("HOME") ?? "/tmp";
  const exe = Deno.build.os === "windows" ? "javac.exe" : "javac";
  const found: { home: string; major: number }[] = [];
  const seen = new Set<string>();
  const probe = (dir: string) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    const major = javacMajor(join(dir, "bin", exe));
    if (major !== null) found.push({ home: dir, major });
  };

  // Explicit JAVA_HOME: if it's a usable in-range JDK, respect it outright.
  const javaHome = Deno.env.get("JAVA_HOME");
  if (javaHome) {
    probe(javaHome);
    const pick = found.find((j) =>
      j.home === javaHome && j.major <= GRADLE_MAX_JDK
    );
    if (pick) return { home: pick.home, newestFound: pick.major };
  }

  // System JVM dirs — scan one level deep for */bin/javac.
  // macOS nests the JDK under <ver>/Contents/Home, so probe that layout too.
  const jvmRoots = [
    "/usr/lib/jvm",
    "/usr/java",
    "/Library/Java/JavaVirtualMachines",
    `${home}/.sdkman/candidates/java`,
  ];
  for (const root of jvmRoots) {
    try {
      for (const entry of Deno.readDirSync(root)) {
        if (!entry.isDirectory && !entry.isSymlink) continue;
        probe(join(root, entry.name));
        probe(join(root, entry.name, "Contents", "Home"));
      }
    } catch { /* root absent — skip */ }
  }

  // Android Studio bundles a JBR that ships javac — ideal for android builds.
  for (
    const dir of [
      "/opt/android-studio/jbr",
      `${home}/android-studio/jbr`,
      "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
      `${home}/.local/share/JetBrains/Toolbox/apps/AndroidStudio/ch-0/jbr`,
    ]
  ) probe(dir);

  // Last resort: javac on PATH → derive JAVA_HOME as <dir>/.. (strip /bin/javac),
  // resolving symlinks first (sdkman/alternatives shims point into the real JDK).
  const onPath = javacOnPath();
  if (onPath) probe(onPath);

  const newestFound = found.reduce((m, j) => Math.max(m, j.major), 0);
  const usable = found.filter((j) => j.major <= GRADLE_MAX_JDK);
  if (usable.length === 0) return { home: null, newestFound };
  // Prefer the LTS sweet spot (≤21); fall back to any Gradle-runnable JDK.
  const preferred = usable.filter((j) => j.major <= PREFERRED_MAX_JDK);
  const pool = preferred.length ? preferred : usable;
  const best = pool.reduce((a, b) => (b.major > a.major ? b : a));
  return { home: best.home, newestFound };
}

/** Run `javac -version` at the given path → Java major version, or null if it
 *  doesn't exist / isn't runnable. Handles legacy `1.8` (→ 8) and modern `21`. */
function javacMajor(javacPath: string): number | null {
  try {
    const r = new Deno.Command(javacPath, {
      args: ["-version"],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (r.code !== 0) return null;
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    const m = out.match(/javac\s+(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    let major = parseInt(m[1] ?? "", 10);
    if (major === 1 && m[2]) major = parseInt(m[2], 10); // 1.8 → 8
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

/** Resolve `javac` on PATH to its JAVA_HOME (<dir>/.. after stripping /bin/javac). */
function javacOnPath(): string | null {
  try {
    const whichCmd = Deno.build.os === "windows" ? "where" : "which";
    const w = new Deno.Command(whichCmd, {
      args: ["javac"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (w.code !== 0) return null;
    let p = (new TextDecoder().decode(w.stdout).split(/\r?\n/)[0] ?? "").trim();
    if (!p) return null;
    try {
      p = Deno.realPathSync(p);
    } catch { /* keep unresolved path */ }
    return dirname(dirname(p)); // <home>/bin/javac → <home>
  } catch {
    return null;
  }
}

/** Write a placeholder SVG icon */
export async function writePlaceholderIcon(
  path: string,
  label: string,
): Promise<void> {
  const letter = (label[0] ?? "A").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">
  <rect width="48" height="48" rx="8" fill="#4a9eff"/>
  <text x="24" y="34" font-size="28" font-family="sans-serif" fill="white" text-anchor="middle">${letter}</text>
</svg>`;
  await Deno.writeTextFile(path, svg);
}

/** Format bytes as MB string with one decimal place */
export function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** Download + cache appimagetool for the given arch. Returns the cached binary path. */
export async function ensureAppimagetool(
  arch: string,
  cacheDir: string,
): Promise<string> {
  await Deno.mkdir(cacheDir, { recursive: true });
  const toolPath = join(cacheDir, "appimagetool");
  try {
    await Deno.stat(toolPath);
    return toolPath;
  } catch { /* not cached — download */ }

  console.log("[appimage] downloading appimagetool...");
  const url =
    `https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${arch}.AppImage`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(
      `[appimage] \u2717 failed to download appimagetool: ${resp.status}`,
    );
    Deno.exit(1);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  // Sanity check — verify downloaded file is a valid ELF binary
  if (
    bytes.length < 4 || bytes[0] !== 0x7f || bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c || bytes[3] !== 0x46
  ) {
    console.error(
      "[appimage] \u2717 downloaded file is not a valid ELF binary",
    );
    Deno.exit(1);
  }
  // Integrity check — verify SHA-256 hash if known for this arch
  const expectedHash = APPIMAGETOOL_HASHES[arch];
  if (expectedHash) {
    const hashBytes = await crypto.subtle.digest("SHA-256", bytes);
    const hashHex = Array.from(new Uint8Array(hashBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hashHex !== expectedHash) {
      console.error(
        `[appimage] ✗ integrity check failed: expected ${expectedHash}, got ${hashHex}`,
      );
      try {
        await Deno.remove(toolPath);
      } catch { /* ignore */ }
      Deno.exit(1);
    }
    console.log("[appimage] ✓ integrity check passed");
  } else {
    // No pinned hash — refuse release builds. Dev builds can opt out via AIO_DEV=1.
    // Prevents supply-chain compromise of downloaded appimagetool from slipping
    // into shipped AppImages.
    const devBypass = Deno.env.get("AIO_DEV") === "1";
    if (!devBypass) {
      console.error(
        `[appimage] ✗ no pinned SHA-256 hash for arch "${arch}" — refusing to build.\n` +
          `         Pin a hash in APPIMAGETOOL_HASHES (src/build-helpers.ts).\n` +
          `         For local experiments only, set AIO_DEV=1 to bypass.`,
      );
      try {
        await Deno.remove(toolPath);
      } catch { /* ignore */ }
      Deno.exit(1);
    }
    console.warn(
      "[appimage] ⚠ AIO_DEV=1 — skipping integrity check. DO NOT use for releases.",
    );
  }
  await Deno.writeFile(toolPath, bytes);
  await Deno.chmod(toolPath, 0o755);
  console.log("[appimage] \u2713 appimagetool cached");
  return toolPath;
}
