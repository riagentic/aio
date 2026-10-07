// A zip entry is named with `/`, whatever host packed it — and one that is
// not is still unpacked where it belongs.
//
// Found by running the suite on a real Windows 11: `zipDir`'s PowerShell
// fallback (.NET Framework's `ZipFile`) wrote `sub\big.txt` and `empty\`, and
// the reader — which knows a directory by its trailing `/` — unpacked the
// empty directory as an empty FILE.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { zipDir } from "../src/build/build-electron.ts";
import {
  crc32Update,
  extractZip,
  readZipDirectory,
} from "../src/server/zip-extract.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** A stored (uncompressed) zip of `entries`, named exactly as given, marked
 *  as made on `madeBy` (0 = FAT/Windows, 3 = Unix). */
function storedZip(
  entries: [name: string, data: string][],
  madeBy = 0,
): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const n = enc.encode(name), data = enc.encode(text);
    const local = new Uint8Array(30 + n.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(14, crc32Update(0, data), true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(data, 30 + n.length);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, madeBy << 8, true);
    cv.setUint32(16, crc32Update(0, data), true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    central.set(n, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const dirSize = centrals.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + dirSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// On Windows this is the PowerShell fallback (there is no `zip`); elsewhere
// `zip` itself. The same archive is asked of both.
Deno.test("zipDir: entries are /-separated on every host, and an empty directory unpacks as one", async () => {
  const tmp = await tempDir("zip-names-");
  try {
    const stage = join(tmp, "stage");
    await Deno.mkdir(join(stage, "sub"), { recursive: true });
    await Deno.mkdir(join(stage, "empty"));
    await Deno.writeTextFile(join(stage, "sub", "big.txt"), "x".repeat(4096));
    const out = join(tmp, "out.zip");
    assertEquals(await zipDir(stage, out), true);
    const bytes = await Deno.readFile(out);
    const names = readZipDirectory(bytes).map((e) => e.name);
    assertEquals(names.filter((n) => n.includes("\\")), []);
    assert(names.includes("sub/big.txt"), names.join(" "));
    assert(names.includes("empty/"), names.join(" "));
    const dest = join(tmp, "out");
    await extractZip(bytes, dest);
    assert((await Deno.stat(join(dest, "empty"))).isDirectory);
    assertEquals(
      (await Deno.readTextFile(join(dest, "sub", "big.txt"))).length,
      4096,
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("zip: a foreign archive with \\ names unpacks into directories, never past the destination", async () => {
  const tmp = await tempDir("zip-names-");
  try {
    const dest = join(tmp, "out");
    await extractZip(
      storedZip([["sub\\big.txt", "big"], ["empty\\", ""], ["a\\b\\", ""]]),
      dest,
    );
    assertEquals(await Deno.readTextFile(join(dest, "sub", "big.txt")), "big");
    assert((await Deno.stat(join(dest, "empty"))).isDirectory);
    assert((await Deno.stat(join(dest, "a", "b"))).isDirectory);

    // The same names that climb out are refused — file or directory.
    for (const bad of ["..\\evil.txt", "..\\evil\\", "ok\\..\\..\\evil.txt"]) {
      const jail = join(tmp, "jail", "in");
      await assertRejects(
        () => extractZip(storedZip([[bad, "x"]]), jail),
        Error,
        "outside the destination",
      );
      for (const leaked of ["evil.txt", "evil"]) {
        await assertRejects(
          () => Deno.stat(join(tmp, "jail", leaked)),
          Deno.errors.NotFound,
        );
        await assertRejects(
          () => Deno.stat(join(tmp, leaked)),
          Deno.errors.NotFound,
        );
      }
    }
  } finally {
    await dropTempDir(tmp);
  }
});

// Made on Unix, `\` is a character of the name: `x\` with bytes in it is a
// file, and reading it as a directory would drop those bytes.
Deno.test("zip: a Unix archive's entry ending in \\ is still a file", () => {
  const [e] = readZipDirectory(storedZip([["x\\", "kept"]], 3));
  assertEquals(e!.isDir, false);
  assertEquals(readZipDirectory(storedZip([["x\\", ""]], 0))[0]!.isDir, true);
});
