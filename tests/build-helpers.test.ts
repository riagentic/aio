import { assertEquals } from "@std/assert";
import {
  copyDir,
  findJdk,
  formatMb,
  slugify,
  writePlaceholderIcon,
} from "../src/build/build-helpers.ts";
import { join } from "@std/path";

// ── findJdk (android build needs a JDK with javac, not a JRE) ──

Deno.test("findJdk: picks JAVA_HOME when its bin/javac runs", async () => {
  if (Deno.build.os === "windows") return; // stub is a POSIX shell script
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(home, "bin"));
    const javac = join(home, "bin", "javac");
    await Deno.writeTextFile(javac, "#!/bin/sh\necho 'javac 21.0.0' >&2\n");
    await Deno.chmod(javac, 0o755);
    const prev = Deno.env.get("JAVA_HOME");
    Deno.env.set("JAVA_HOME", home);
    try {
      assertEquals(findJdk(), home); // JAVA_HOME wins — probed first
    } finally {
      if (prev === undefined) Deno.env.delete("JAVA_HOME");
      else Deno.env.set("JAVA_HOME", prev);
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("findJdk: ignores a JAVA_HOME whose javac is missing", async () => {
  // A JRE-only JAVA_HOME (no bin/javac) must not be accepted as a JDK.
  const home = await Deno.makeTempDir(); // empty — no bin/javac
  try {
    const prev = Deno.env.get("JAVA_HOME");
    Deno.env.set("JAVA_HOME", home);
    try {
      // May still find a real system JDK, but never the javac-less temp dir.
      const found = findJdk();
      assertEquals(found === home, false);
    } finally {
      if (prev === undefined) Deno.env.delete("JAVA_HOME");
      else Deno.env.set("JAVA_HOME", prev);
    }
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
