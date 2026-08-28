// Build helpers — pure/extractable utilities used by build.ts
import { slugify as slugifyName } from "../server/single-instance-lock.ts";
// The digest that verifies a release verifies a downloaded tool too — one
// implementation, so they cannot drift into disagreeing about the same bytes.
import { sha256Hex } from "./ship.ts";
import { dirname, join, resolve } from "@std/path";
import { toolCacheDir } from "../electron/electron-runtime-fetch.ts";
export { toolCacheDir };
import { appIconPng, appIconSvg } from "./app-icon.ts";
import { APP_ICON } from "../server/app-files.ts";

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

/** `Deno.chmod`, on the platforms that have one.
 *
 *  THE spelling for this in the build. `Deno.chmod` is not implemented on
 *  Windows and THROWS `NotSupported` — so every launcher the build writes
 *  (`AppRun`, the macOS `run.sh`, the Android `gradlew`) killed a build that
 *  merely happened to be running on a Windows host, and the failure named a
 *  file the developer never wrote. Cross-building for Linux from Windows is a
 *  supported thing to want; a mode bit that platform cannot express is not a
 *  reason to refuse.
 *
 *  Only the guard was ever in doubt, so it lives in exactly one place: adding
 *  a fifth `await Deno.chmod(...)` reintroduces the bug, calling this cannot. */
export async function chmodIfSupported(
  path: string,
  mode: number,
): Promise<void> {
  if (Deno.build.os === "windows") return; // no POSIX mode bits to set
  await Deno.chmod(path, mode);
}

/** Slugify a string for use as binary/app name. The transform is THE one in
 *  `single-instance-lock.ts` — an app's binary name and its lock id must not be
 *  able to disagree about what its name reduces to. Only the fallback differs. */
export function slugify(s: string): string {
  return slugifyName(s, "myapp");
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
          await chmodIfSupported(dstPath, info.mode);
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

/** Where the app's `icon.png` is — and, when it is nowhere useful, whether it
 *  is sitting somewhere the build deliberately does NOT look.
 *
 *  Every target resolves the icon from THE app dir (the entry module's
 *  directory), the same place dev serves it from. The project ROOT is the
 *  obvious other candidate — it is where `deno.json` lives — and a field report
 *  put `icon.png` there, got no icon and no warning, and shipped a 158 MB
 *  AppImage wearing a generated placeholder. Nothing was wrong enough to fail:
 *  a missing icon is legal, and the framework draws a monogram for it.
 *
 *  So this is a HINT, not a refusal, and deliberately unlike the `style.css`
 *  rule beside it (which refuses): a root `icon.png` is frequently a repo logo
 *  for a README, and a build that dies over one would be wrong more often than
 *  right. `misplaced` is only ever set when the app dir has no icon at all —
 *  there is nothing to say when the app already has the icon it wants. */
export async function resolveAppIcon(
  root: string,
  appDir: string,
): Promise<{ icon: string | null; misplaced: string | null }> {
  const wanted = join(appDir, APP_ICON);
  try {
    await Deno.stat(wanted);
    return { icon: wanted, misplaced: null };
  } catch { /* no icon where the build looks — is one nearby? */ }
  if (resolve(root) === resolve(appDir)) return { icon: null, misplaced: null };
  const atRoot = join(root, APP_ICON);
  try {
    await Deno.stat(atRoot);
    return { icon: null, misplaced: atRoot };
  } catch { /* genuinely no icon — the monogram is the honest answer */ }
  return { icon: null, misplaced: null };
}

/** The one sentence a target prints when the app HAS an icon and the build
 *  cannot use it. One wording, four targets. */
export function misplacedIconHint(misplaced: string, appDir: string): string {
  return `found ${misplaced}, which the build does not read — the app dir is ` +
    `${appDir} (the entry's directory, the same place dev serves it from). ` +
    `Move it to ${join(appDir, APP_ICON)} to use it.`;
}

/** Write the app's DEFAULT icon (SVG + PNG) beside each other, named
 *  `<base>.svg` / `<base>.png`.
 *
 *  Every packaging path calls this when the app ships no `icon.png`, so an
 *  app the developer has not drawn an icon for still has one that identifies
 *  it — its initial, on a colour derived from its name (see app-icon.ts). The
 *  PNG is the one that matters in practice: window managers, taskbars and
 *  Android all rasterize, and none of them read SVG. */
export async function writeDefaultIcon(
  base: string,
  appName: string,
): Promise<void> {
  await Deno.writeTextFile(`${base}.svg`, appIconSvg(appName));
  await Deno.writeFile(`${base}.png`, await appIconPng(appName, 512));
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
 *  them (that regression only shows up on a FUSE-less machine — i.e. a user's).
 *
 *  `TMPDIR` then decides WHERE that unpack lands, and the default is not
 *  acceptable: extract-and-run names its directory after a digest of the
 *  AppImage and creates it 0755, so every build left a world-readable copy of
 *  the packaging tool at a path any other user on the host could predict — and
 *  pre-create. A private dir beside the cached tool keeps the whole thing in one
 *  place the build already owns. Same rule aio hands to a packaged APP at launch
 *  (`AppDirs.app`); a build host is not a lesser machine. */
export function appimageEnv(arch: string): Record<string, string> {
  const tmp = join(toolCacheDir(), "run");
  let priv = false;
  try {
    Deno.mkdirSync(tmp, { recursive: true });
    if (Deno.build.os !== "windows") Deno.chmodSync(tmp, 0o700);
    priv = true;
  } catch {
    /* unwritable cache — keep the OS default rather than break the build */
  }
  return {
    ...Deno.env.toObject(),
    ARCH: arch,
    APPIMAGE_EXTRACT_AND_RUN: "1",
    // Only when it exists: pointing TMPDIR at a directory we failed to create
    // trades a privacy nit for a dead build.
    ...(priv ? { TMPDIR: tmp } : {}),
  };
}

/** Where downloaded build tools are cached.
 *
 *  Deliberately OUTSIDE the project: cached under `<root>/node_modules/.cache`,
 *  the 15MB appimagetool was swept into `deno compile`'s file set and embedded
 *  in the shipped binary — every build after the first shipped the build tool
 *  inside the app (measured: 29MB → 43MB of embedded files). A user-level cache
 *  is also shared across projects, so the tool downloads once per machine. */

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
  await chmodIfSupported(toolPath, 0o755);
  console.log("[appimage] ✓ appimagetool cached");
  return toolPath;
}
