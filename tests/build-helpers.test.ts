import { assertEquals } from "@std/assert";
import {
  copyDir,
  formatMb,
  slugify,
  writePlaceholderIcon,
} from "../src/build-helpers.ts";
import { join } from "@std/path";

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
