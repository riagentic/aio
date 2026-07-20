import { assertEquals } from "@std/assert";
import {
  copyDir,
  findJdk,
  formatMb,
  slugify,
  writePlaceholderIcon,
} from "../src/build/build-helpers.ts";
import { join } from "@std/path";

// ── findJdk (android build needs a Gradle-runnable JDK with javac) ──

/** Make a temp dir with a fake `bin/javac` that reports `javac <version>` AND
 *  "compiles" (`javac Foo.java` → touches Foo.class) — findJdk compile-verifies. */
async function stubJdk(version: string): Promise<string> {
  const home = await Deno.makeTempDir();
  await Deno.mkdir(join(home, "bin"));
  const javac = join(home, "bin", "javac");
  await Deno.writeTextFile(
    javac,
    `#!/bin/sh\nfor a in "$@"; do\n` +
      `  case "$a" in\n` +
      `    -version) echo 'javac ${version}' >&2 ;;\n` +
      `    *.java) touch "\${a%.java}.class" ;;\n` +
      `  esac\ndone\nexit 0\n`,
  );
  await Deno.chmod(javac, 0o755);
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
  if (Deno.build.os === "windows") return; // stub is a POSIX shell script
  const home = await stubJdk("21.0.0");
  try {
    await withJavaHome(home, () => assertEquals(findJdk().home, home));
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("findJdk: never picks a too-new JDK (javac 25)", async () => {
  if (Deno.build.os === "windows") return;
  const home = await stubJdk("25.0.3");
  try {
    await withJavaHome(home, () => {
      const r = findJdk();
      assertEquals(r.home === home, false); // Gradle can't run on 25
      assertEquals(r.newestFound >= 25, true); // but it was seen (diagnostic)
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("findJdk: ignores a JAVA_HOME whose javac is missing", async () => {
  // A JRE-only JAVA_HOME (no bin/javac) must not be accepted as a JDK.
  const home = await Deno.makeTempDir(); // empty — no bin/javac
  try {
    await withJavaHome(home, () => {
      // May still find a real system JDK, but never the javac-less temp dir.
      assertEquals(findJdk().home === home, false);
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
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

Deno.test("slugify: unicode stripped", () => {
  assertEquals(slugify("café"), "caf");
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

// ── writePlaceholderIcon ──

Deno.test("writePlaceholderIcon: writes valid SVG", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".svg" });
  try {
    await writePlaceholderIcon(tmp, "Test");
    const content = await Deno.readTextFile(tmp);
    assertEquals(content.includes("<svg"), true);
    assertEquals(content.includes(">T<"), true); // first letter uppercase
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("writePlaceholderIcon: uses first letter", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".svg" });
  try {
    await writePlaceholderIcon(tmp, "zebra");
    const content = await Deno.readTextFile(tmp);
    assertEquals(content.includes(">Z<"), true);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("writePlaceholderIcon: empty label defaults to A", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".svg" });
  try {
    await writePlaceholderIcon(tmp, "");
    const content = await Deno.readTextFile(tmp);
    assertEquals(content.includes(">A<"), true);
  } finally {
    await Deno.remove(tmp);
  }
});

// ── copyDir ──

Deno.test("copyDir: copies files recursively", async () => {
  const src = await Deno.makeTempDir();
  const dst = await Deno.makeTempDir();
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
    await Deno.remove(src, { recursive: true });
    await Deno.remove(dst, { recursive: true });
  }
});
