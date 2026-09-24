// The built-in zip reader — the one step a desktop app's first launch depends
// on, with no outside tool to be missing.
//
// Field reports (2026-09-17): a clean Windows 11 has no `unzip`/`bsdtar`/
// `python3`; under Wine `powershell.exe` exited 0 having unpacked nothing.
// Archives here are made by the real `zip` tool, so the reader is checked
// against what Electron and aio's own packaging actually produce.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  crc32Update,
  extractZip,
  readZipDirectory,
  safeZipPath,
} from "../src/server/zip-extract.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const unix = Deno.build.os !== "windows";

async function zipOf(
  stage: string,
  args: string[] = ["-q", "-r", "-y"],
): Promise<Uint8Array> {
  const out = `${stage}.zip`;
  const p = await new Deno.Command("zip", {
    args: [...args, out, "."],
    cwd: stage,
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(p.success, new TextDecoder().decode(p.stderr));
  return await Deno.readFile(out);
}

Deno.test("zip: unpacks stored and deflated files, directories, exec bits and in-tree symlinks", async () => {
  const tmp = await tempDir("zip-extract-");
  try {
    const stage = join(tmp, "stage");
    await Deno.mkdir(join(stage, "App.app/Contents/MacOS"), {
      recursive: true,
    });
    await Deno.mkdir(join(stage, "empty"));
    const big = new TextEncoder().encode("electron ".repeat(200_000)); // deflates
    await Deno.writeFile(join(stage, "App.app/Contents/MacOS/Electron"), big);
    await Deno.writeFile(join(stage, "tiny.bin"), new Uint8Array([0, 1, 2])); // stored
    if (unix) {
      await Deno.chmod(join(stage, "App.app/Contents/MacOS/Electron"), 0o755);
      await Deno.symlink(
        "Contents/MacOS/Electron",
        join(stage, "App.app/Current"),
      );
    }
    const bytes = await zipOf(stage);
    const methods = new Set(readZipDirectory(bytes).map((e) => e.method));
    assert(methods.has(8), "the archive has a deflated entry");

    const dest = join(tmp, "out");
    await extractZip(bytes, dest);
    const exe = join(dest, "App.app/Contents/MacOS/Electron");
    assertEquals(await Deno.readFile(exe), big);
    assertEquals(
      await Deno.readFile(join(dest, "tiny.bin")),
      new Uint8Array([0, 1, 2]),
    );
    assert((await Deno.stat(join(dest, "empty"))).isDirectory);
    if (unix) {
      // aio-ok(umask): asserts bits PRESENT (0755); a restrictive umask can only make this fail, never hide a missing mode.
      assertEquals((await Deno.stat(exe)).mode! & 0o777, 0o755);
      const link = join(dest, "App.app/Current");
      assert((await Deno.lstat(link)).isSymlink, "symlinks stay symlinks");
      assertEquals(await Deno.readLink(link), "Contents/MacOS/Electron");
    }
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("zip: a corrupted entry is refused, never written as good", async () => {
  const tmp = await tempDir("zip-extract-");
  try {
    const stage = join(tmp, "stage");
    await Deno.mkdir(stage);
    await Deno.writeFile(join(stage, "a.bin"), new Uint8Array([1, 2, 3, 4, 5]));
    const bytes = await zipOf(stage, ["-q", "-r", "-0"]); // stored: bytes are plain
    const e = readZipDirectory(bytes)[0]!;
    const v = new DataView(bytes.buffer);
    const data = e.localOffset + 30 + v.getUint16(e.localOffset + 26, true) +
      v.getUint16(e.localOffset + 28, true);
    assertEquals(bytes[data], 1, "stored data starts here");
    bytes[data + 2] = bytes[data + 2]! ^ 0xff;
    await assertRejects(
      () => extractZip(bytes, join(tmp, "out")),
      Error,
      "corrupt zip",
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("zip: entries that would escape the destination are refused", () => {
  const dest = "/d";
  assertEquals(safeZipPath(dest, "a/b.txt"), join("/d", "a", "b.txt"));
  for (
    const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\..\\..\\x"]
  ) {
    assertThrows(
      () => safeZipPath(dest, bad),
      Error,
      "outside the destination",
    );
  }
});

Deno.test({
  name: "zip: a symlink that points outside the destination is refused",
  ignore: !unix,
  async fn() {
    const tmp = await tempDir("zip-extract-");
    try {
      const stage = join(tmp, "stage");
      await Deno.mkdir(stage);
      await Deno.symlink("../../../etc/passwd", join(stage, "evil"));
      const bytes = await zipOf(stage);
      await assertRejects(
        () => extractZip(bytes, join(tmp, "out")),
        Error,
        "points outside the destination",
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});

Deno.test("zip: not-a-zip is a clear error", () => {
  assertThrows(
    () => readZipDirectory(new TextEncoder().encode("hello, not a zip")),
    Error,
    "not a zip archive",
  );
});

Deno.test("zip: crc32 matches the published check value", () => {
  assertEquals(
    crc32Update(0, new TextEncoder().encode("123456789")),
    0xcbf43926,
  );
  // Incremental == one-shot.
  const a = crc32Update(0, new TextEncoder().encode("12345"));
  assertEquals(crc32Update(a, new TextEncoder().encode("6789")), 0xcbf43926);
});
