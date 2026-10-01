// Windows one-click exe is an SFX over a compressed payload (Task1), and since
// 1.0.16-beta that payload is a zstd tar packed by Deno, with a committed
// prebuilt stub — building it needs no Go toolchain (optimal-builds §6).
import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { UntarStream } from "@std/tar";
import zlib from "node:zlib";
import {
  appendSfxPayload,
  ensureWindowsSfxStub,
  packAppDirTarZstd,
  peEmbedsElectronRuntimeZip,
  readSfxTrailer,
  selfContainedExeName,
  SFX_MAGIC,
  windowsZipName,
  writeWindowsSfxExe,
} from "../src/build/build-windows-exe.ts";
import { sha256Hex } from "../src/build/ship.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("selfContainedExeName / windowsZipName stay paired", () => {
  assertEquals(selfContainedExeName("myapp", "x64"), "myapp-win-x64.exe");
  assertEquals(windowsZipName("myapp", "x64"), "myapp-win-x64.zip");
});

Deno.test("appendSfxPayload trailer round-trips, format included", async () => {
  const stub = new TextEncoder().encode("MZ-fake-stub-bytes-xxxxxxxxxx");
  const payload = new TextEncoder().encode("PK\x03\x04-fake-payload-yyyyyyyy");
  const sha256 = await sha256Hex(payload);
  const pe = appendSfxPayload(stub, payload, {
    sha256,
    binary: "demo",
    arch: "x64",
    format: "tar.zstd",
  });
  assertEquals(
    new TextDecoder().decode(pe.subarray(pe.length - SFX_MAGIC.length)),
    SFX_MAGIC,
  );
  const trail = readSfxTrailer(pe);
  assertExists(trail);
  assertEquals(trail.header.sha256, sha256);
  assertEquals(trail.header.binary, "demo");
  assertEquals(trail.header.arch, "x64");
  assertEquals(trail.header.format, "tar.zstd");
  assertEquals(trail.payloadLength, payload.length);
  assertEquals(
    [
      ...pe.subarray(
        trail.payloadOffset,
        trail.payloadOffset + trail.payloadLength,
      ),
    ],
    [...payload],
  );
  // Stub prefix intact
  assertEquals([...pe.subarray(0, stub.length)], [...stub]);
});

Deno.test("peEmbedsElectronRuntimeZip detects old fat VFS marker", () => {
  const fat = new TextEncoder().encode(
    'xxx{"File":{"n":"electron-runtime.zip","o":[1,2]}}yyy',
  );
  assert(peEmbedsElectronRuntimeZip(fat));
  const thin = new TextEncoder().encode("MZ stub + payload, no VFS name");
  assert(!peEmbedsElectronRuntimeZip(thin));
});

Deno.test({
  name: "writeWindowsSfxExe packs the prebuilt stub + a Deno zstd tar payload",
  async fn() {
    const tmp = await tempDir("windows-sfx-");
    try {
      // The stub is committed prebuilt — no Go — and must be a real PE.
      const stubPath = await ensureWindowsSfxStub();
      const stubStat = await Deno.stat(stubPath);
      assert(stubStat.size > 100_000, "stub PE should be a real linked binary");
      assert(stubStat.size < 8_000_000, "stub must stay tiny vs Deno PE");

      // A small AppDir → zstd tar, packed entirely in Deno.
      const stage = join(tmp, "app");
      await Deno.mkdir(join(stage, "electron"), { recursive: true });
      await Deno.writeTextFile(join(stage, "demo.exe"), "fake");
      await Deno.writeTextFile(join(stage, "electron", "electron.exe"), "e");
      const payloadPath = join(tmp, "payload.tar.zst");
      await packAppDirTarZstd(stage, payloadPath);
      const payload = await Deno.readFile(payloadPath);
      // zstd frame magic 28 B5 2F FD.
      assertEquals([...payload.subarray(0, 4)], [0x28, 0xb5, 0x2f, 0xfd]);

      // Round-trip: what the stub will decompress is a tar with our files.
      const names: string[] = [];
      const dec = zlib.zstdDecompressSync(payload);
      for await (
        const entry of ReadableStream.from([dec]).pipeThrough(new UntarStream())
      ) {
        names.push(entry.path);
        await entry.readable?.cancel();
      }
      assert(names.includes("demo.exe"), `tar held: ${names.join(", ")}`);
      assert(
        names.includes("electron/electron.exe"),
        `tar held: ${names.join(", ")}`,
      );

      const outPath = join(tmp, "demo-win-x64.exe");
      const result = await writeWindowsSfxExe({
        stubPath,
        payloadPath,
        payloadFormat: "tar.zstd",
        outPath,
        binaryName: "demo",
        archStr: "x64",
      });

      const pe = await Deno.readFile(outPath);
      assert(!peEmbedsElectronRuntimeZip(pe));
      assertEquals(pe[0], 0x4d); // 'M'
      assertEquals(pe[1], 0x5a); // 'Z'
      const trail = readSfxTrailer(pe);
      assertExists(trail);
      assertEquals(trail.header.sha256, result.sha256);
      assertEquals(trail.header.format, "tar.zstd");
      assertEquals(trail.payloadLength, payload.length);
      assertEquals(result.size, pe.length);
      // Download class: stub + payload + tiny trailer, nothing double-copied.
      assertEquals(
        result.size,
        stubStat.size + payload.length +
          JSON.stringify({
            sha256: result.sha256,
            binary: "demo",
            arch: "x64",
            format: "tar.zstd",
          }).length + 4 + 8 + SFX_MAGIC.length,
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});
