// The one-click Windows `.exe` wears the app's icon. It is the prebuilt stub
// with a payload after it, and the stub has no resources: every app's
// download showed Windows' blank default icon in Explorer. The build now
// writes the staged `.ico` into the copy of the stub it packs — and packs the
// stub as it is, saying so, when that copy cannot be made safely.
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  appendSfxPayload,
  buildSelfContainedWindowsExe,
  prebuiltStubPath,
  readSfxTrailer,
  readSfxTrailerOfFile,
  selfContainedExeName,
  SFX_STUB_SHA256,
  windowsZipName,
} from "../src/build/build-windows-exe.ts";
import type { BuildConfig } from "../src/build/build-config.ts";
import { electronStagingDir } from "../src/build/build-electron.ts";
import { WINDOWS_ICON_FILE } from "../src/build/build-helpers.ts";
import { _freezeDeps } from "../src/build/freeze-guard.ts";
import { appIconIco, ICO_SIZES } from "../src/build/app-icon.ts";
import {
  icoImages,
  peIcon,
  peIconMismatch,
  peWithIcon,
} from "../src/build/pe-icon.ts";
import { sha256Hex } from "../src/build/ship.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fakeSigned } from "./sfx-sign-helper.ts";

// The pack declines on a machine out of memory headroom (build-windows-sfx.test.ts).
_freezeDeps.readMemory = () =>
  Promise.resolve({
    totalBytes: 100,
    availableBytes: 50,
    swapUsedBytes: 0,
    swapTotalBytes: 0,
  });

const STUB = await Deno.readFile(prebuiltStubPath());
const ICO = await appIconIco("My App", "myapp");
const OTHER_ICO = await appIconIco("Zebra", "zebra");

function iconed(pe: Uint8Array = STUB, ico: Uint8Array = ICO): Uint8Array {
  const made = peWithIcon(pe, ico);
  if ("refused" in made) throw new Error(`refused: ${made.refused}`);
  return made.pe;
}

const refusal = (pe: Uint8Array, ico: Uint8Array = ICO): string => {
  const made = peWithIcon(pe, ico);
  return "refused" in made ? made.refused : "";
};

/** Offsets into the stub's headers. */
function layout(pe: Uint8Array) {
  const v = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
  const sig = v.getUint32(0x3c, true);
  const opt = sig + 24;
  const sections = opt + v.getUint16(sig + 20, true);
  return { v, sig, opt, sections, dirs: opt + 112 };
}

Deno.test("peWithIcon appends one .rsrc section to the prebuilt stub and changes only the header fields a section moves", async () => {
  const before = STUB.slice();
  const out = iconed();
  assertEquals([...STUB], [...before], "the input was modified");
  assertEquals(await sha256Hex(STUB), SFX_STUB_SHA256, "the pinned stub");

  const a = layout(STUB), b = layout(out);
  const count = a.v.getUint16(a.sig + 6, true);
  const header = a.sections + count * 40;
  // Every byte of the stub is where it was — but these.
  const changed: [number, number][] = [
    [a.sig + 6, 2], // NumberOfSections
    [a.opt + 8, 4], // SizeOfInitializedData
    [a.opt + 56, 4], // SizeOfImage
    [a.opt + 64, 4], // CheckSum
    [a.dirs + 2 * 8, 8], // the resource data directory
    [header, 40], // the new section header
  ];
  const expected = STUB.slice();
  for (const [at, n] of changed) expected.set(out.subarray(at, at + n), at);
  assertEquals(
    await sha256Hex(out.subarray(0, STUB.length)),
    await sha256Hex(expected),
    "a byte outside the listed header fields changed",
  );

  const fileAlign = a.v.getUint32(a.opt + 36, true);
  const sectionAlign = a.v.getUint32(a.opt + 32, true);
  const last = a.sections + (count - 1) * 40;
  const rva = b.v.getUint32(header + 12, true);
  const virtualSize = b.v.getUint32(header + 8, true);
  const rawSize = b.v.getUint32(header + 16, true);
  assertEquals(b.v.getUint16(b.sig + 6, true), count + 1);
  assertEquals(
    new TextDecoder().decode(out.subarray(header, header + 8)),
    ".rsrc\0\0\0",
  );
  assertEquals(b.v.getUint32(header + 36, true), 0x40000040);
  assertEquals(b.v.getUint32(header + 20, true), STUB.length, "raw pointer");
  assertEquals(rawSize % fileAlign, 0);
  assertEquals(out.length, STUB.length + rawSize);
  assert(virtualSize <= rawSize && virtualSize > rawSize - fileAlign);
  assertEquals(rva % sectionAlign, 0);
  assertEquals(
    rva,
    Math.ceil(
      (a.v.getUint32(last + 12, true) + a.v.getUint32(last + 8, true)) /
        sectionAlign,
    ) * sectionAlign,
    "the section starts on the first page after the last one",
  );
  assertEquals(
    b.v.getUint32(b.opt + 56, true),
    Math.ceil((rva + virtualSize) / sectionAlign) * sectionAlign,
    "SizeOfImage",
  );
  assertEquals(
    b.v.getUint32(b.opt + 8, true),
    a.v.getUint32(a.opt + 8, true) + rawSize,
    "SizeOfInitializedData",
  );
  assertEquals(b.v.getUint32(b.opt + 64, true), 0, "CheckSum");
  assertEquals(
    [b.v.getUint32(b.dirs + 16, true), b.v.getUint32(b.dirs + 20, true)],
    [rva, virtualSize],
    "resource data directory",
  );
});

Deno.test("the icon read back out of the exe is the .ico that went in: one group, every image byte for byte", () => {
  assertEquals(peIcon(STUB), { groups: 0, ico: null });
  const out = iconed();
  const found = peIcon(out);
  assertEquals(found?.groups, 1);
  assertEquals([...found!.ico!], [...ICO]);
  assertEquals(peIconMismatch(out, ICO), null);
  assertStringIncludes(peIconMismatch(out, OTHER_ICO)!, "is not the icon's");
  assertStringIncludes(peIconMismatch(STUB, ICO)!, "0 icon groups");
  assertEquals(peIcon(new Uint8Array(64)), null);
  // The 256 px image is the first, as Windows and `deno compile` expect.
  const images = icoImages(found!.ico!) as { entry: Uint8Array }[];
  assertEquals(images.map((i) => i.entry[0] || 256), [...ICO_SIZES]);
});

Deno.test("peWithIcon refuses, with the reason, every exe it could break — and never throws", () => {
  const edit = (fn: (pe: Uint8Array, l: ReturnType<typeof layout>) => void) => {
    const pe = STUB.slice();
    fn(pe, layout(pe));
    return pe;
  };
  const l = layout(STUB);
  const header = l.sections + l.v.getUint16(l.sig + 6, true) * 40;

  assertEquals(refusal(iconed()), "the exe already has resources");
  assertEquals(
    refusal(appendSfxPayload(STUB, new Uint8Array(9), {
      sha256: "0",
      binary: "b",
      arch: "x64",
      format: "zip",
    })),
    "the exe has data after its last section",
  );
  assertEquals(refusal(fakeSigned(STUB)), "the exe is signed");
  assertEquals(
    refusal(edit((_, e) => e.v.setUint16(e.opt, 0x10b, true))),
    "not a PE32+ exe",
  );
  // No header room: the slot after the last section header is in use…
  assertEquals(
    refusal(edit((pe) => pe[header + 39] = 1)),
    "no room for one more section header",
  );
  // …or the headers end before it does.
  assertEquals(
    refusal(edit((_, e) => e.v.setUint32(e.opt + 60, header + 39, true))),
    "no room for one more section header",
  );
  assertEquals(refusal(new Uint8Array(0)), "not a PE file");
  assertEquals(
    refusal(new TextEncoder().encode("MZ, but no more")),
    "not a PE file",
  );
  assertEquals(
    refusal(edit((pe) => pe.fill(0, l.sig, l.sig + 4))),
    "not a PE file",
  );

  assertEquals(
    refusal(STUB, new Uint8Array(0)),
    "the icon is not an .ico file",
  );
  assertEquals(
    refusal(STUB, ICO.subarray(0, ICO.length - 1)),
    "image 3 of the .ico lies outside the file",
  );
  assertStringIncludes(
    refusal(STUB, new Uint8Array(8 * 1024 * 1024 + 1)),
    "at most 8388608 fit",
  );

  // Any cut of the stub, and any one header byte set to anything: a refusal
  // or an exe that reads back — never a throw.
  for (let cut = 0; cut < 1024; cut += 7) {
    assert(refusal(STUB.subarray(0, cut)) !== "", `cut at ${cut}`);
  }
  for (let at = 0; at < 1024; at++) {
    for (const value of [0, 1, 0x7f, 0xff]) {
      if (STUB[at] === value) continue;
      const made = peWithIcon(edit((pe) => pe[at] = value), ICO);
      if ("pe" in made) {
        assert(made.pe.length > STUB.length, `byte ${at}=${value}`);
      }
    }
  }
});

/** A staged Windows AppDir + its zip, as `buildElectron` leaves them — and
 *  the `.ico` the compile step leaves beside the AppDir, when given. */
async function stagedBuild(
  tmp: string,
  ico: Uint8Array | null,
): Promise<BuildConfig> {
  const appDir = electronStagingDir(tmp);
  await Deno.mkdir(join(appDir, "electron"), { recursive: true });
  await Deno.writeTextFile(join(appDir, "myapp.exe"), "inner");
  await Deno.writeTextFile(join(appDir, "electron", "electron.exe"), "e");
  if (ico) await Deno.writeFile(join(appDir, "..", WINDOWS_ICON_FILE), ico);
  await Deno.writeFile(
    join(tmp, windowsZipName("myapp", "x64")),
    new Uint8Array(26 * 1024 * 1024),
  );
  return {
    root: tmp,
    outDir: tmp,
    binaryName: "myapp",
    archStr: "x64",
    version: { version: "1.2.3" },
    appTitle: "My App",
    windowsShortcut: true,
  } as BuildConfig;
}

/** Build the one-click exe in `tmp`; its bytes before the payload, and what
 *  the build warned. */
async function built(
  cfg: BuildConfig,
  stub?: string,
): Promise<{ head: Uint8Array; warned: string; exe: string }> {
  const fat = Deno.env.get("AIO_WINDOWS_FAT_EXE");
  Deno.env.delete("AIO_WINDOWS_FAT_EXE");
  const realLog = console.log, realWarn = console.warn;
  const warned: string[] = [];
  console.log = () => {};
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    await buildSelfContainedWindowsExe(
      cfg,
      stub ? { stub: () => Promise.resolve({ path: stub, temp: false }) } : {},
    );
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    if (fat !== undefined) Deno.env.set("AIO_WINDOWS_FAT_EXE", fat);
  }
  const exe = join(cfg.root, selfContainedExeName("myapp", "x64"));
  const trailer = await readSfxTrailerOfFile(exe);
  assertExists(trailer, "the payload is no longer found");
  assertEquals(trailer.header.version, "1.2.3");
  const bytes = await Deno.readFile(exe);
  // Scratch holds what it held before the step: no stub copy left behind.
  const scratch: string[] = [];
  for await (const e of Deno.readDir(join(cfg.root, ".aio", "build"))) {
    scratch.push(e.name);
  }
  assertEquals(
    scratch.filter((n) => n !== "AppDir" && n !== WINDOWS_ICON_FILE),
    [],
  );
  return {
    head: bytes.subarray(0, trailer.payloadOffset),
    warned: warned.join("\n"),
    exe,
  };
}

Deno.test("the one-click exe wears the staged app.ico, and its payload is found as before — signed too", async () => {
  const tmp = await tempDir("aio-sfx-icon-");
  try {
    const { head, warned, exe } = await built(await stagedBuild(tmp, ICO));
    assertEquals(warned, "");
    assertEquals(peIconMismatch(head, ICO), null);
    assertEquals([...head], [...iconed()], "the stub, plus the icon section");
    // icon → payload → sign: every reader finds the trailer before the
    // certificate table, in an exe whose stub grew.
    const unsigned = await Deno.readFile(exe);
    const signed = fakeSigned(unsigned);
    assertEquals(readSfxTrailer(signed), readSfxTrailer(unsigned));
    assertEquals(peIconMismatch(signed, ICO), null);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("a stub that cannot take an icon is packed untouched, and the build says so in one line", async () => {
  const tmp = await tempDir("aio-sfx-icon-");
  try {
    // A stub that already has resources (a later stub may ship its own).
    const own = join(tmp, "own-stub.exe");
    await Deno.writeFile(own, iconed(STUB, OTHER_ICO));
    const refused = await built(await stagedBuild(tmp, ICO), own);
    assertEquals([...refused.head], [...iconed(STUB, OTHER_ICO)]);
    assertEquals(refused.warned.split("\n").length, 1);
    assertStringIncludes(
      refused.warned,
      "myapp-win-x64.exe has no icon of its own (the exe already has resources)",
    );
  } finally {
    await dropTempDir(tmp);
  }
  const bare = await tempDir("aio-sfx-icon-");
  try {
    // No staged icon at all, and one that is not an .ico: the pinned stub.
    const none = await built(await stagedBuild(bare, null));
    assertEquals(await sha256Hex(none.head), SFX_STUB_SHA256);
    assertStringIncludes(none.warned, "has no icon of its own (");
    const junk = await built(
      await stagedBuild(bare, new TextEncoder().encode("not an icon")),
    );
    assertEquals(await sha256Hex(junk.head), SFX_STUB_SHA256);
    assertStringIncludes(junk.warned, "(the icon is not an .ico file)");
  } finally {
    await dropTempDir(bare);
  }
});
