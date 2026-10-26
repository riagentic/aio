// The built-in zip reader — the one step a desktop app's first launch depends
// on, with no outside tool to be missing.
//
// Field reports (2026-09-17): a clean Windows 11 has no `unzip`/`bsdtar`/
// `python3`; under Wine `powershell.exe` exited 0 having unpacked nothing.
// Archives here are made by the host's real archiver (`zip`; bsdtar `tar.exe`
// on Windows — tests/zip-helper.ts), so the reader is checked against what
// Electron and aio's own packaging actually produce.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  crc32Update,
  extractZip,
  readZipDirectory,
  safeZipPath,
} from "../src/server/zip-extract.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { zipTree } from "./zip-helper.ts";

const unix = Deno.build.os !== "windows";

async function zipOf(
  stage: string,
  opts: { store?: boolean } = {},
): Promise<Uint8Array> {
  const out = `${stage}.zip`;
  await zipTree(stage, out, opts);
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
    const bytes = await zipOf(stage, { store: true }); // stored: bytes are plain
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

/** A stored zip of Unix symlink entries `[name, target]`, written by hand:
 *  no archiver puts a link under another link. */
function linkZip(links: [string, string][]): Uint8Array {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const u16 = (a: number[], n: number) => a.push(n & 0xff, n >>> 8 & 0xff);
  const u32 = (a: number[], n: number) => {
    u16(a, n & 0xffff);
    u16(a, n >>> 16);
  };
  for (const [name, target] of links) {
    const nm = enc.encode(name);
    const data = enc.encode(target);
    const crc = crc32Update(0, data);
    const at = local.length;
    u32(local, 0x04034b50);
    for (const n of [10, 0, 0, 0, 0]) u16(local, n);
    for (const n of [crc, data.length, data.length]) u32(local, n);
    u16(local, nm.length);
    u16(local, 0);
    local.push(...nm, ...data);
    u32(central, 0x02014b50);
    for (const n of [3 << 8 | 20, 10, 0, 0, 0, 0]) u16(central, n);
    for (const n of [crc, data.length, data.length]) u32(central, n);
    for (const n of [nm.length, 0, 0, 0, 0]) u16(central, n);
    u32(central, (0o120777 << 16) >>> 0);
    u32(central, at);
    central.push(...nm);
  }
  const end: number[] = [];
  u32(end, 0x06054b50);
  for (const n of [0, 0, links.length, links.length]) u16(end, n);
  u32(end, central.length);
  u32(end, local.length);
  u16(end, 0);
  return new Uint8Array([...local, ...central, ...end]);
}

Deno.test({
  name: "zip: chained symlinks cannot escape the destination",
  ignore: !unix,
  async fn() {
    const tmp = await tempDir("zip-extract-");
    try {
      // An entry under an archive link would be created through it.
      await assertRejects(
        () =>
          extractZip(
            linkZip([["sub/l", ".."], ["sub/l/m", "../.."]]),
            join(tmp, "a"),
          ),
        Error,
        "is a symlink in the same archive",
      );
      // A target that runs through another archive link.
      await assertRejects(
        () =>
          extractZip(
            linkZip([["sub/x", ".."], ["sub/y", "x/../.."]]),
            join(tmp, "b"),
          ),
        Error,
        "resolves outside the destination",
      );
      // ...even when the escaping target does not exist (yet).
      await assertRejects(
        () =>
          extractZip(
            linkZip([["d/x", ".."], ["y", "d/x/../../nonexistent"]]),
            join(tmp, "b2"),
          ),
        Error,
        "resolves outside the destination",
      );
      // In-tree chains still unpack.
      await extractZip(
        linkZip([["sub/x", ".."], ["sub/y", "x/sub"]]),
        join(tmp, "c"),
      );
      assertEquals(
        await Deno.realPath(join(tmp, "c", "sub", "y")),
        await Deno.realPath(join(tmp, "c", "sub")),
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});
