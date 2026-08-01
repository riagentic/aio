// Build helpers — pure/extractable utilities used by build.ts
import { dirname, join } from "@std/path";

/** The appimagetool release this build pins to.
 *
 *  Deliberately a VERSION tag, not `continuous`. The guard below refuses to
 *  build without a pinned hash, and `continuous` is a rolling tag whose bytes
 *  change on every upstream rebuild — so pointing at it made the pin expire by
 *  construction and left AppImage packaging permanently unbuildable on every
 *  arch. A version tag is immutable, so the pin stays valid. */
const APPIMAGETOOL_VERSION = "1.9.1";

/** Publisher SHA-256 hashes for {@linkcode APPIMAGETOOL_VERSION}, taken from
 *  GitHub's per-asset `digest` field (not computed from our own download, which
 *  would only be trust-on-first-use) and re-verified against the bytes.
 *
 *  RAW lowercase hex, NO `sha256:` prefix — compared against the digest hex
 *  directly. To bump: pick the new tag, then
 *  `curl -sL https://api.github.com/repos/AppImage/appimagetool/releases/tags/<tag>`
 *  and copy each asset's `digest`. */
const APPIMAGETOOL_HASHES: Record<string, string> = {
  x86_64: "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0",
  aarch64: "f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158",
  armhf: "42b61cba5495d8aaf418a5c9a015a49b85ad92efabcbd3c341f1540440e4e23d",
  i686: "7ad9ff47c203aae0149b18f6df9e3018b2e2f470ea644a0413e3ded39e9e3bdb",
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

/** Resolve the Android SDK root — the dir that actually contains
 *  `platform-tools/adb`. Robust to `ANDROID_HOME`/`ANDROID_SDK_ROOT` pointing at
 *  the SDK OR its parent (a common setup is `~/Android` with the SDK in
 *  `~/Android/Sdk`), and falls back to the platform's default install locations.
 *  Returns null when no SDK is found. */
export function resolveSdk(): string | null {
  const home = Deno.env.get("HOME") ?? "";
  const exe = Deno.build.os === "windows" ? ".exe" : "";
  const candidates: string[] = [];
  const add = (d?: string | null) => {
    if (!d) return;
    candidates.push(d, join(d, "Sdk"), join(d, "sdk")); // dir, or its Sdk subdir
  };
  add(Deno.env.get("ANDROID_HOME"));
  add(Deno.env.get("ANDROID_SDK_ROOT"));
  candidates.push(
    join(home, "Android", "Sdk"),
    join(home, "Android", "sdk"),
    join(home, "Library", "Android", "sdk"), // macOS
    join(home, "AppData", "Local", "Android", "Sdk"), // Windows
  );
  for (const c of candidates) {
    try {
      if (Deno.statSync(join(c, "platform-tools", `adb${exe}`)).isFile) {
        return c;
      }
    } catch { /* not an SDK here — next */ }
  }
  return null;
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

/** Highest Java major version the pinned Gradle (8.14.3 — see the wrapper pin
 *  in build-android.ts) can RUN on. Gradle's
 *  own daemon JVM must be ≤ this — a newer JDK (e.g. 25) crashes Gradle at
 *  startup with a bare version string. (Bump alongside the wrapper version.) */
export const GRADLE_MAX_JDK = 23;
/** Preferred ceiling — AGP 8.7's blessed LTS range (17/21). Pick the newest JDK
 *  at or below this before falling back to any other Gradle-runnable JDK. */
const PREFERRED_MAX_JDK = 21;

export interface JdkResult {
  /** Primary JDK to hand Gradle (JAVA_HOME) — a canonical, compile-verified
   *  path with major ≤ GRADLE_MAX_JDK. null when none is usable. */
  home: string | null;
  /** Major version of `home` (0 when home is null). */
  major: number;
  /** Highest major of ANY compiling JDK found, even too-new (0 = none).
   *  Distinguishes "no JDK" from "only a too-new JDK" for diagnostics. */
  newestFound: number;
  /** Every distinct in-range compiling JDK home — fed to Gradle as
   *  `org.gradle.java.installations.paths` so its toolchain resolver can only
   *  choose a real, compiler-capable JDK (never a JRE it mis-detected). */
  all: string[];
}

/** Find a JDK to build Android with — robust to machine/packaging quirks:
 *  - resolves `javac` symlinks (update-alternatives, JRE→JDK redirects) to the
 *    REAL JDK dir Gradle will accept;
 *  - proves each candidate by actually COMPILING a trivial program — a JRE or a
 *    broken install fails here, which is exactly Gradle's JAVA_COMPILER test, so
 *    "our probe passed but Gradle says no compiler" can no longer happen;
 *  - keeps only Gradle-runnable versions (≤ GRADLE_MAX_JDK), preferring LTS.
 *  Scans JAVA_HOME, system JVM dirs, Android Studio's JBR, Homebrew, SDKMAN and
 *  PATH. An explicit, usable JAVA_HOME is honoured as the primary pick. */
export function findJdk(): JdkResult {
  const home = Deno.env.get("HOME") ?? "/tmp";
  const exe = Deno.build.os === "windows" ? "javac.exe" : "javac";

  // Gather candidate javac paths from everywhere a JDK tends to live.
  const javacPaths = new Set<string>();
  const addHome = (dir?: string | null) => {
    if (dir) javacPaths.add(join(dir, "bin", exe));
  };
  addHome(Deno.env.get("JAVA_HOME"));
  for (
    const root of [
      "/usr/lib/jvm",
      "/usr/java",
      "/Library/Java/JavaVirtualMachines",
      "/opt/homebrew/opt",
      "/usr/local/opt",
      `${home}/.sdkman/candidates/java`,
    ]
  ) {
    try {
      for (const entry of Deno.readDirSync(root)) {
        if (!entry.isDirectory && !entry.isSymlink) continue;
        addHome(join(root, entry.name));
        addHome(join(root, entry.name, "Contents", "Home")); // macOS
        addHome(
          join(root, entry.name, "libexec", "openjdk.jdk", "Contents", "Home"),
        ); // homebrew keg
      }
    } catch { /* root absent — skip */ }
  }
  for (
    const dir of [
      "/opt/android-studio/jbr",
      `${home}/android-studio/jbr`,
      "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
      `${home}/.local/share/JetBrains/Toolbox/apps/AndroidStudio/ch-0/jbr`,
    ]
  ) addHome(dir);
  const onPath = whichJavac();
  if (onPath) javacPaths.add(onPath);

  // Canonicalize (follow symlinks to the true JDK) + compile-verify; dedupe.
  const byHome = new Map<string, number>();
  for (const javac of javacPaths) {
    let real: string;
    try {
      real = Deno.realPathSync(javac); // resolve alternatives/JRE→JDK redirects
    } catch {
      continue; // no javac here
    }
    const jdkHome = dirname(dirname(real)); // <home>/bin/javac → <home>
    if (byHome.has(jdkHome)) continue;
    const major = jdkMajorIfCompiles(jdkHome, exe);
    if (major !== null) byHome.set(jdkHome, major);
  }

  const compiling = [...byHome].map(([h, major]) => ({ home: h, major }));
  const newestFound = compiling.reduce((m, j) => Math.max(m, j.major), 0);
  const usable = compiling.filter((j) => j.major <= GRADLE_MAX_JDK);
  const all = usable.map((j) => j.home).sort();
  if (usable.length === 0) return { home: null, major: 0, newestFound, all };

  // Honour an explicit, usable JAVA_HOME (canonicalized) as the primary pick.
  const jhRaw = Deno.env.get("JAVA_HOME");
  if (jhRaw) {
    try {
      const jh = dirname(dirname(Deno.realPathSync(join(jhRaw, "bin", exe))));
      const hit = usable.find((j) => j.home === jh);
      if (hit) return { home: hit.home, major: hit.major, newestFound, all };
    } catch { /* JAVA_HOME has no javac — fall through */ }
  }

  // Otherwise the newest LTS in range (≤21), else any Gradle-runnable JDK.
  const preferred = usable.filter((j) => j.major <= PREFERRED_MAX_JDK);
  const pool = preferred.length ? preferred : usable;
  const best = pool.reduce((a, b) => (b.major > a.major ? b : a));
  return { home: best.home, major: best.major, newestFound, all };
}

/** A JDK home's major version IFF it can actually compile — writes a trivial
 *  program and runs `<home>/bin/javac` on it, requiring a `.class` out. This is
 *  the ground truth for Gradle's JAVA_COMPILER capability (a JRE fails). Returns
 *  null for JRE / broken / absent. Handles legacy `1.8` (→ 8) and modern `21`. */
function jdkMajorIfCompiles(jdkHome: string, exe: string): number | null {
  const javac = join(jdkHome, "bin", exe);
  const major = parseJavacVersion(javac);
  if (major === null) return null;
  let tmp: string;
  try {
    tmp = Deno.makeTempDirSync({ prefix: "aio-jdk-" });
  } catch {
    return null;
  }
  try {
    Deno.writeTextFileSync(
      join(tmp, "AioJdkCheck.java"),
      "class AioJdkCheck { public static void main(String[] a) {} }",
    );
    const r = new Deno.Command(javac, {
      args: ["AioJdkCheck.java"],
      cwd: tmp,
      stdout: "null",
      stderr: "null",
    }).outputSync();
    if (r.code !== 0) return null;
    Deno.statSync(join(tmp, "AioJdkCheck.class")); // bytecode produced?
    return major;
  } catch {
    return null;
  } finally {
    try {
      Deno.removeSync(tmp, { recursive: true });
    } catch { /* ignore */ }
  }
}

/** Parse `javac -version` → Java major version (null if it won't run). */
function parseJavacVersion(javacPath: string): number | null {
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

/** The first `javac` on PATH (its raw path — the caller canonicalizes). */
function whichJavac(): string | null {
  try {
    const whichCmd = Deno.build.os === "windows" ? "where" : "which";
    const w = new Deno.Command(whichCmd, {
      args: ["javac"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (w.code !== 0) return null;
    const p = (new TextDecoder().decode(w.stdout).split(/\r?\n/)[0] ?? "")
      .trim();
    return p || null;
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

/** Environment for an `appimagetool` invocation.
 *
 *  `APPIMAGE_EXTRACT_AND_RUN=1` is load-bearing: appimagetool is ITSELF an
 *  AppImage, so running it normally needs FUSE — which modern Ubuntu (22.04+
 *  dropped libfuse2), containers, WSL and CI routinely lack, giving "cannot
 *  mount AppImage" and a dead build. Extract-and-run unpacks the tool to a temp
 *  dir instead, so packaging works with OR without FUSE on the host.
 *
 *  Pure + shared by every packaging site so the flag can't be lost from one of
 *  them (that regression only shows up on a FUSE-less machine — i.e. a user's). */
export function appimageEnv(arch: string): Record<string, string> {
  return {
    ...Deno.env.toObject(),
    ARCH: arch,
    APPIMAGE_EXTRACT_AND_RUN: "1",
  };
}

/** Where downloaded build tools are cached.
 *
 *  Deliberately OUTSIDE the project: cached under `<root>/node_modules/.cache`,
 *  the 15MB appimagetool was swept into `deno compile`'s file set and embedded
 *  in the shipped binary — every build after the first shipped the build tool
 *  inside the app (measured: 29MB → 43MB of embedded files). A user-level cache
 *  is also shared across projects, so the tool downloads once per machine. */
export function toolCacheDir(): string {
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return join(
    xdg && xdg.length > 0 ? xdg : join(home, ".cache"),
    "aio",
    "tools",
  );
}

/** Lowercase hex SHA-256 of `bytes`. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isElf(bytes: Uint8Array<ArrayBuffer>): boolean {
  return bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 &&
    bytes[2] === 0x4c && bytes[3] === 0x46;
}

/** Download + cache appimagetool for the given arch. Returns the cached binary path.
 *
 *  The cache key carries the arch AND the pinned version, and a cache HIT is
 *  re-verified rather than trusted: the integrity check exists to keep a
 *  tampered appimagetool out of shipped AppImages, and a check that the cache
 *  can skip protects nothing. (It previously cached to a bare `appimagetool`
 *  path and returned it unverified — so one `AIO_DEV=1` run left an unchecked
 *  binary that every later release build silently reused.) */
export async function ensureAppimagetool(
  arch: string,
  cacheDir: string,
): Promise<string> {
  await Deno.mkdir(cacheDir, { recursive: true });
  const expectedHash = APPIMAGETOOL_HASHES[arch];
  const devBypass = Deno.env.get("AIO_DEV") === "1";

  if (!expectedHash && !devBypass) {
    console.error(
      `[appimage] ✗ no pinned SHA-256 hash for arch "${arch}" — refusing to build.\n` +
        `         Known arches: ${
          Object.keys(APPIMAGETOOL_HASHES).join(", ")
        }.\n` +
        `         Pin one in APPIMAGETOOL_HASHES (src/build/build-helpers.ts):\n` +
        `         curl -sL https://api.github.com/repos/AppImage/appimagetool/releases/tags/${APPIMAGETOOL_VERSION}\n` +
        `         and copy the asset's \`digest\` (drop the "sha256:" prefix).\n` +
        `         For local experiments only, set AIO_DEV=1 to bypass.`,
    );
    Deno.exit(1);
  }

  // Unverified (dev-bypassed) binaries get their own cache key so they can
  // never be picked up by a later verified build.
  const suffix = expectedHash
    ? APPIMAGETOOL_VERSION
    : `${APPIMAGETOOL_VERSION}-unverified`;
  const toolPath = join(cacheDir, `appimagetool-${arch}-${suffix}`);

  try {
    const cached = await Deno.readFile(toolPath);
    if (!expectedHash) return toolPath; // dev bypass, own key
    if (await sha256Hex(cached) === expectedHash) {
      console.log("[appimage] ✓ cached appimagetool verified");
      return toolPath;
    }
    console.warn(
      "[appimage] ⚠ cached appimagetool failed verification — re-downloading",
    );
    await Deno.remove(toolPath).catch(() => {});
  } catch { /* not cached — download */ }

  console.log(
    `[appimage] downloading appimagetool ${APPIMAGETOOL_VERSION} (${arch})...`,
  );
  const url =
    `https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-${arch}.AppImage`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(
      `[appimage] ✗ failed to download appimagetool: ${resp.status} ${url}`,
    );
    Deno.exit(1);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());

  if (!isElf(bytes)) {
    console.error("[appimage] ✗ downloaded file is not a valid ELF binary");
    Deno.exit(1);
  }

  if (expectedHash) {
    const hashHex = await sha256Hex(bytes);
    if (hashHex !== expectedHash) {
      console.error(
        `[appimage] ✗ integrity check failed: expected ${expectedHash}, got ${hashHex}`,
      );
      Deno.exit(1);
    }
    console.log("[appimage] ✓ integrity check passed");
  } else {
    console.warn(
      "[appimage] ⚠ AIO_DEV=1 — skipping integrity check. DO NOT use for releases.",
    );
  }

  await Deno.writeFile(toolPath, bytes);
  await Deno.chmod(toolPath, 0o755);
  console.log("[appimage] ✓ appimagetool cached");
  return toolPath;
}
