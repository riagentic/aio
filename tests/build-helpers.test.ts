import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  copyDir,
  findJdk,
  formatMb,
  gradleCandidates,
  gradlewPath,
  jdkPlaces,
  resolveSdk,
  slugify,
  symlinkRefusal,
  writeDefaultIcon,
} from "../src/build/build-helpers.ts";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { writeDenoProgram } from "./fake-program-helper.ts";
import { linkFile } from "./symlink-helper.ts";

// ── resolveSdk (ANDROID_HOME may point at the SDK OR its parent) ──

/** Lay down a fake SDK (just platform-tools/adb) under `dir`. */
async function fakeSdk(dir: string): Promise<void> {
  await Deno.mkdir(join(dir, "platform-tools"), { recursive: true });
  // The SDK's adb is `adb.exe` on Windows, and that is the file looked for.
  const adb = Deno.build.os === "windows" ? "adb.exe" : "adb";
  await Deno.writeTextFile(join(dir, "platform-tools", adb), "#!/bin/sh\n");
}

async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, Deno.env.get(k));
    Deno.env.set(k, v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("resolveSdk: ANDROID_HOME points at the SDK dir", async () => {
  const root = await tempDir("aio-buildhelp-");
  try {
    await fakeSdk(root);
    await withEnv({ ANDROID_HOME: root, ANDROID_SDK_ROOT: "" }, () => {
      assertEquals(resolveSdk(), root);
    });
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("resolveSdk: ANDROID_HOME points at the PARENT (…/Sdk subdir)", async () => {
  // The reported bug: ANDROID_HOME=~/Android, SDK actually in ~/Android/Sdk.
  const root = await tempDir("aio-buildhelp-");
  const sdk = join(root, "Sdk");
  try {
    await fakeSdk(sdk);
    await withEnv({ ANDROID_HOME: root, ANDROID_SDK_ROOT: "" }, () => {
      assertEquals(resolveSdk(), sdk);
    });
  } finally {
    await dropTempDir(root);
  }
});

// ── findJdk (android build needs a Gradle-runnable JDK with javac) ──

/** Make a temp dir with a fake `bin/javac` that reports `javac <version>` AND
 *  "compiles" (`javac Foo.java` → touches Foo.class) — findJdk compile-verifies. */
async function stubJdk(version: string): Promise<string> {
  const home = await tempDir("aio-buildhelp-");
  await Deno.mkdir(join(home, "bin"));
  // A program on every OS (`javac.exe` on Windows), one body.
  await writeDenoProgram(
    join(home, "bin", "javac"),
    `for (const a of Deno.args) {
  if (a === "-version") console.error("javac ${version}");
  else if (a.endsWith(".java")) {
    Deno.writeTextFileSync(a.slice(0, -5) + ".class", "");
  }
}
`,
  );
  return home;
}

async function withJavaHome<T>(dir: string, fn: () => T): Promise<T> {
  const prev = Deno.env.get("JAVA_HOME");
  Deno.env.set("JAVA_HOME", dir);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete("JAVA_HOME");
    else Deno.env.set("JAVA_HOME", prev);
  }
}

Deno.test("findJdk: picks an in-range JAVA_HOME (javac 21)", async () => {
  const home = await stubJdk("21.0.0");
  try {
    await withJavaHome(home, () => assertEquals(findJdk().home, home));
  } finally {
    await dropTempDir(home);
  }
});

Deno.test("findJdk: never picks a too-new JDK (javac 25)", async () => {
  const home = await stubJdk("25.0.3");
  try {
    await withJavaHome(home, () => {
      const r = findJdk();
      assertEquals(r.home === home, false); // Gradle can't run on 25
      assertEquals(r.newestFound >= 25, true); // but it was seen (diagnostic)
    });
  } finally {
    await dropTempDir(home);
  }
});

Deno.test("findJdk: never picks a too-old JDK (javac 11) — AGP 8.7 needs 17", async () => {
  // It used to: JAVA_HOME=JDK 11 was honoured as the pick, and Gradle then
  // failed with "Android Gradle plugin requires Java 17 to run" after aio had
  // printed "✓ JDK … (Java 11)" against its own "version 17-23" rule.
  const home = await stubJdk("11.0.2");
  try {
    await withJavaHome(
      home,
      () => assertEquals(findJdk().home === home, false),
    );
  } finally {
    await dropTempDir(home);
  }
});

Deno.test("findJdk: ignores a JAVA_HOME whose javac is missing", async () => {
  // A JRE-only JAVA_HOME (no bin/javac) must not be accepted as a JDK.
  const home = await tempDir("aio-buildhelp-"); // empty — no bin/javac
  try {
    await withJavaHome(home, () => {
      // May still find a real system JDK, but never the javac-less temp dir.
      assertEquals(findJdk().home === home, false);
    });
  } finally {
    await dropTempDir(home);
  }
});

Deno.test("jdkPlaces: Windows looks where Windows JDKs are — Android Studio's jbr first of all", () => {
  const env: Record<string, string> = {
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  };
  const w = jdkPlaces("windows", "C:\\Users\\u", (k) => env[k]);
  const has = (list: string[], re: RegExp) => list.some((p) => re.test(p));
  assert(
    has(w.homes, /^C:\\Program Files[\\/]Android[\\/]Android Studio[\\/]jbr$/),
  );
  assert(
    has(w.homes, /AppData\\Local[\\/]Programs[\\/]Android Studio[\\/]jbr$/),
  );
  assert(has(w.roots, /^C:\\Program Files[\\/]Eclipse Adoptium$/));
  assertEquals(
    new Set(w.roots).size,
    w.roots.length,
    "ProgramFiles twice is one root",
  );
  assert(!has([...w.roots, ...w.homes], /^\/(usr|opt|Applications)\//));
  const l = jdkPlaces("linux", "/home/u", () => undefined);
  assert(l.roots.includes("/usr/lib/jvm"));
});

Deno.test("gradleCandidates: Windows also looks for gradle.bat on PATH", () => {
  assert(gradleCandidates("windows", "C:\\Users\\u").includes("gradle.bat"));
  assert(!gradleCandidates("linux", "/home/u").includes("gradle.bat"));
});

// ── slugify ──

Deno.test("slugify: basic string", () => {
  assertEquals(slugify("My App"), "my-app");
});

Deno.test("slugify: preserves lowercase alphanumeric", () => {
  assertEquals(slugify("hello123"), "hello123");
});

Deno.test("slugify: strips special chars", () => {
  assertEquals(slugify("My App! @v2"), "my-app-v2");
});

Deno.test("slugify: collapses multiple separators", () => {
  assertEquals(slugify("a---b___c"), "a-b-c");
});

Deno.test("slugify: trims leading/trailing hyphens", () => {
  assertEquals(slugify("---hello---"), "hello");
});

Deno.test("slugify: empty string returns myapp", () => {
  assertEquals(slugify(""), "myapp");
});

Deno.test("slugify: all special chars returns myapp", () => {
  assertEquals(slugify("!!!"), "myapp");
});

Deno.test("slugify: a unicode name is disambiguated, not collapsed", () => {
  // It used to strip the letter and return `caf`, which made "café" and
  // "cafe" — and "Über" and "Ber", and any two apps named in CJK — ONE
  // identity: one data directory, one lock, one UDS socket, one binary name
  // and one shared-key cookie. A name carrying a character this alphabet
  // cannot spell now keeps a short hash of the original.
  const cafe = slugify("café");
  assert(cafe.startsWith("caf-"), `kept the spellable part: ${cafe}`);
  assert(cafe !== slugify("cafe"), "…and is not the ASCII spelling");
  assertEquals(slugify("café"), cafe, "stable across calls");
  // An ASCII name is untouched.
  assertEquals(slugify("My App"), "my-app");
});

// ── formatMb ──

Deno.test("formatMb: 1 MiB", () => {
  assertEquals(formatMb(1024 * 1024), "1.0");
});

Deno.test("formatMb: fractional", () => {
  assertEquals(formatMb(1.5 * 1024 * 1024), "1.5");
});

Deno.test("formatMb: zero", () => {
  assertEquals(formatMb(0), "0.0");
});

Deno.test("formatMb: small bytes", () => {
  assertEquals(formatMb(512), "0.0");
});

// ── writeDefaultIcon ──

Deno.test("writeDefaultIcon: writes an SVG and a PNG side by side", async () => {
  const dir = await tempDir("aio-buildhelp-");
  try {
    await writeDefaultIcon(join(dir, "myapp"), "zebra");
    const svg = await Deno.readTextFile(join(dir, "myapp.svg"));
    assertEquals(svg.startsWith("<svg"), true);
    const png = await Deno.readFile(join(dir, "myapp.png"));
    // PNG magic — the packagers hand this straight to Electron/Android, so
    // "it wrote a file" is not the assertion that matters.
    assertEquals([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await dropTempDir(dir);
  }
});

// ── copyDir ──

Deno.test("copyDir: copies files recursively", async () => {
  const src = await tempDir("aio-buildhelp-");
  const dst = await tempDir("aio-buildhelp-");
  const dstCopy = join(dst, "copy");
  try {
    await Deno.writeTextFile(join(src, "a.txt"), "hello");
    await Deno.mkdir(join(src, "sub"));
    await Deno.writeTextFile(join(src, "sub", "b.txt"), "world");
    await copyDir(src, dstCopy);
    assertEquals(await Deno.readTextFile(join(dstCopy, "a.txt")), "hello");
    assertEquals(
      await Deno.readTextFile(join(dstCopy, "sub", "b.txt")),
      "world",
    );
  } finally {
    await dropTempDir(src);
    await dropTempDir(dst);
  }
});

// A stale symlink from a previous platform pass must not fail the next one.
//
// The scratch AppDir is shared by every platform of one `--platforms=…` run.
// `Deno.symlink` refuses an existing path, so a macOS x64 pass left its
// `Electron.app` behind and the arm64 pass died copying its own runtime over
// it — `AlreadyExists: File exists (os error 17): symlink 'A' -> …/Versions/
// Current`. Only .app bundles carry symlinks at those paths, so only the
// macOS→macOS-arm64 order hit it: a build that fails on the FOURTH platform and
// nowhere else reads as a macOS problem rather than a copy bug.
Deno.test("copyDir: a second pass REPLACES a stale symlink, not fails on it", async () => {
  const a = await tempDir("aio-copydir-a-");
  const b = await tempDir("aio-copydir-b-");
  const dst = await tempDir("aio-copydir-dst-");
  try {
    // Two "runtimes", each with a link of the same name pointing elsewhere.
    await Deno.writeTextFile(join(a, "real-a"), "a");
    await linkFile("real-a", join(a, "Current"));
    await Deno.writeTextFile(join(b, "real-b"), "b");
    await linkFile("real-b", join(b, "Current"));

    await copyDir(a, dst);
    assertEquals(await Deno.readLink(join(dst, "Current")), "real-a");

    // The second platform pass over the SAME scratch dir.
    await copyDir(b, dst);
    assertEquals(
      await Deno.readLink(join(dst, "Current")),
      "real-b",
      "the second pass must win — a stale link from the previous platform is " +
        "not what this build is packaging",
    );
  } finally {
    await dropTempDir(a);
    await dropTempDir(b);
    await dropTempDir(dst);
  }
});

// ── Android build on a Windows host ──
//
// `gradle wrapper` writes `gradlew` (a shell script) and `gradlew.bat`. The
// build started the first on every host; on Windows that is `NotFound`, so
// the build generated its wrapper and died starting it.

Deno.test("gradle: the wrapper's name is per host — gradlew.bat on Windows", () => {
  const dir = join("my app", ".aio", "android");
  assertEquals(gradlewPath("linux", dir), join(dir, "gradlew"));
  assertEquals(gradlewPath("darwin", dir), join(dir, "gradlew"));
  assertEquals(gradlewPath("windows", dir), join(dir, "gradlew.bat"));
});

Deno.test("gradle: the wrapper really starts on THIS host — from a project path with a space, arguments and exit code intact", async () => {
  const tmp = await tempDir("aio-gradlew-");
  try {
    const dir = join(tmp, "my app", "android");
    await Deno.mkdir(dir, { recursive: true });
    // Both files, as `gradle wrapper` writes them: print $1, exit 3.
    await Deno.writeTextFile(
      join(dir, "gradlew"),
      '#!/bin/sh\necho "ran $1"\nexit 3\n',
      { mode: 0o755 },
    );
    await Deno.writeTextFile(
      join(dir, "gradlew.bat"),
      "@echo off\r\necho ran %~1\r\nexit /b 3\r\n",
    );
    const r = await new Deno.Command(gradlewPath(Deno.build.os, dir), {
      args: ["assembleDebug"],
      cwd: dir,
    }).output();
    assertEquals(
      new TextDecoder().decode(r.stdout).trim(),
      "ran assembleDebug",
      new TextDecoder().decode(r.stderr),
    );
    assertEquals(r.code, 3);
    // …and what the build did before, on Windows: the shell script by name.
    if (Deno.build.os === "windows") {
      assertThrows(
        () => new Deno.Command(join(dir, "gradlew")).outputSync(),
        Deno.errors.NotFound,
      );
    }
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("resolveSdk: the default location on a Windows host hangs off USERPROFILE (HOME is not set there)", async () => {
  const home = await tempDir("aio-buildhelp-");
  const sdk = join(home, "AppData", "Local", "Android", "Sdk");
  try {
    await fakeSdk(sdk);
    await withEnv(
      { ANDROID_HOME: "", ANDROID_SDK_ROOT: "", HOME: "", USERPROFILE: home },
      () => assertEquals(resolveSdk(), sdk),
    );
  } finally {
    await dropTempDir(home);
  }
});

// A macOS bundle built on Windows without Developer Mode or elevation: the
// refusal was a bare "A required privilege is not held by the client. (os
// error 1314): symlink …" (measured, Windows 11). It says what to do.
Deno.test("symlinkRefusal: Windows' privilege refusal names Developer Mode and an elevated shell; anything else is left as it was", () => {
  const refused = new Deno.errors.PermissionDenied(
    "A required privilege is not held by the client. (os error 1314): symlink",
  );
  const said = symlinkRefusal(refused, "L", "T", "windows") as Error;
  assert(said instanceof Error && said !== refused);
  assert(said.message.includes("Developer Mode"), said.message);
  assert(said.message.includes("elevated"), said.message);
  assert(said.message.includes("L → T"), said.message);
  assertEquals(said.cause, refused);
  assertEquals(symlinkRefusal(refused, "L", "T", "linux"), refused);
  const other = new Deno.errors.NotFound("x");
  assertEquals(symlinkRefusal(other, "L", "T", "windows"), other);
});
