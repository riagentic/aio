// An Electron package holds ONE platform's executables.
//
// Field report (real Windows 11, 2026-09-17): the Windows zip was 350 MB, and
// half of it was the LINUX Electron and the LINUX app binary. Every platform
// staged into one `.aio/build/AppDir` that was only ever `mkdir -p`'d, so each
// package carried the previous platform's tree. All Linux-host gates were
// green because none of them looked inside the zip. Two pins: the staging dir
// is emptied per build, and the finished tree is checked by executable format.
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  binaryFormat,
  electronStagingDir,
  foreignBinaries,
  freshElectronStaging,
} from "../src/build/build-electron.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const bytes = (...b: number[]) => new Uint8Array(b);
const ELF = bytes(0x7f, 0x45, 0x4c, 0x46);
const PE = bytes(0x4d, 0x5a, 0x90, 0x00);
const MACHO64 = bytes(0xcf, 0xfa, 0xed, 0xfe);
const FAT = bytes(0xca, 0xfe, 0xba, 0xbe);

Deno.test("package: binaryFormat reads the container from the magic", () => {
  assertEquals(binaryFormat(ELF), "elf");
  assertEquals(binaryFormat(PE), "pe");
  assertEquals(binaryFormat(bytes(0x4d, 0x5a)), "pe"); // a 2-byte stub
  assertEquals(binaryFormat(MACHO64), "macho");
  assertEquals(binaryFormat(bytes(0xfe, 0xed, 0xfa, 0xcf)), "macho");
  assertEquals(binaryFormat(bytes(0xce, 0xfa, 0xed, 0xfe)), "macho");
  assertEquals(binaryFormat(FAT), "macho");
  assertEquals(binaryFormat(new TextEncoder().encode("<!DOCTYPE")), null);
  assertEquals(binaryFormat(new Uint8Array(0)), null);
  assertEquals(binaryFormat(bytes(0x7f)), null);
});

Deno.test("package: foreignBinaries names every other platform's executable", async () => {
  const dir = await tempDir("electron-pkg-");
  try {
    await Deno.mkdir(join(dir, "electron/locales"), { recursive: true });
    await Deno.writeFile(join(dir, "app.exe"), PE);
    await Deno.writeFile(join(dir, "electron/electron.exe"), PE);
    await Deno.writeFile(join(dir, "electron/electron"), ELF); // the report
    await Deno.writeFile(join(dir, "app"), ELF);
    await Deno.writeFile(join(dir, "electron/locales/x.dylib"), MACHO64);
    await Deno.writeTextFile(join(dir, "run.bat"), "@echo off\n");
    await Deno.writeFile(join(dir, "empty"), new Uint8Array(0));
    await Deno.symlink("electron/electron", join(dir, "link"));

    assertEquals(await foreignBinaries(dir, "windows"), [
      { path: "app", format: "elf" },
      { path: "electron/electron", format: "elf" },
      { path: "electron/locales/x.dylib", format: "macho" },
    ]);
    assertEquals(
      (await foreignBinaries(dir, "linux")).map((f) => f.path),
      ["app.exe", "electron/electron.exe", "electron/locales/x.dylib"],
    );
    assertEquals(
      (await foreignBinaries(dir, "darwin")).map((f) => f.format),
      ["elf", "pe", "elf", "pe"],
    );
    await assertRejects(() => foreignBinaries(dir, "plan9"), Error, "plan9");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("package: the staging dir starts empty on every build", async () => {
  const root = await tempDir("electron-pkg-");
  try {
    // First build ever: nothing to remove, still a usable dir.
    const dir = await freshElectronStaging(root);
    assertEquals(dir, electronStagingDir(root));
    // A previous platform's tree…
    await Deno.mkdir(join(dir, "electron"), { recursive: true });
    await Deno.writeFile(join(dir, "electron/electron"), ELF);
    await Deno.writeFile(join(dir, "app"), ELF);
    // …is gone before the next one is staged.
    await freshElectronStaging(root);
    const left = [];
    for await (const e of Deno.readDir(dir)) left.push(e.name);
    assertEquals(left, []);
  } finally {
    await dropTempDir(root);
  }
});
