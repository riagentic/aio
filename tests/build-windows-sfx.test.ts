// Windows one-click exe is an SFX over a compressed payload (Task1), and since
// 1.0.16-beta that payload is a zstd tar packed by Deno, with a committed
// prebuilt stub — building it needs no compiler (optimal-builds §6).
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { UntarStream } from "@std/tar";
import zlib from "node:zlib";
import { existsSync } from "node:fs";
import {
  appDirEntries,
  appendSfxPayload,
  buildSelfContainedWindowsExe,
  ensureWindowsSfxStub,
  packAppDirTarZstd,
  parseSfxTrailer,
  peEmbedsElectronRuntimeZip,
  prebuiltStubPath,
  readSfxTrailer,
  readSfxTrailerOfFile,
  resolveWindowsSfxStub,
  selfContainedExeName,
  SFX_MAGIC,
  SFX_STUB_SHA256,
  sfxTrailer,
  tarEntryName,
  windowsZipName,
  writeWindowsSfxExe,
} from "../src/build/build-windows-exe.ts";
import {
  type BuildConfig,
  resolveWindowsShortcut,
} from "../src/build/build-config.ts";
import { electronStagingDir } from "../src/build/build-electron.ts";
import { sha256Hex } from "../src/build/ship.ts";
import { extractZip } from "../src/server/zip-extract.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { linkDir, linkFile } from "./symlink-helper.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

/** Run `fn` with `console.warn` captured; returns what was warned. */
async function warnings(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = real;
  }
  return lines.join("\n");
}

/** Run `fn` with `Deno.exit` and `console.error` captured: the exit code it
 *  asked for (null: none) and what it said. `atExit` runs at the call — a real
 *  exit runs nothing after it, so that is where "already done" is observed. */
async function exits(
  fn: () => Promise<void>,
  atExit: () => void = () => {},
): Promise<{ code: number | null; said: string }> {
  const realExit = Deno.exit, realError = console.error;
  const lines: string[] = [];
  let code: number | null = null;
  Deno.exit = ((c?: number) => {
    code = c ?? 0;
    atExit();
    throw new Error("exit");
  }) as typeof Deno.exit;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn();
  } catch (e) {
    if (code === null) throw e;
  } finally {
    Deno.exit = realExit;
    console.error = realError;
  }
  return { code, said: lines.join("\n") };
}

/** Run `fn` with `console.log` silenced. */
async function hushed<T>(fn: () => Promise<T>): Promise<T> {
  const real = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = real;
  }
}

/** Path → text of every file in a zstd tar payload ("/" for a directory). */
async function tarFiles(payload: Uint8Array): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (
    // A copy: the reader hands its chunk's buffer on, and Node's is pooled.
    const entry of ReadableStream.from([
      new Uint8Array(zlib.zstdDecompressSync(payload)),
    ]).pipeThrough(new UntarStream())
  ) {
    if (!entry.readable) {
      out[entry.path] = "/";
      continue;
    }
    const text = new TextDecoder();
    out[entry.path] = "";
    for await (const chunk of entry.readable) {
      out[entry.path] += text.decode(chunk, { stream: true });
    }
  }
  return out;
}

/** A name the tar format cannot hold (over 100 bytes), so the zstd pack
 *  throws — the same way it does for a real over-long path. */
const UNPACKABLE = "z".repeat(120);

/** A staged Windows AppDir + its zip, as `buildElectron` leaves them. The zip
 *  is opaque to the SFX step; 26 MB keeps stub + zip under the size gate. */
async function stagedBuild(tmp: string): Promise<BuildConfig> {
  const appDir = electronStagingDir(tmp);
  await Deno.mkdir(join(appDir, "electron"), { recursive: true });
  await Deno.writeTextFile(join(appDir, "myapp.exe"), "inner");
  await Deno.writeTextFile(join(appDir, "electron", "electron.exe"), "e");
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

// The length is a u64: a payload over 4 GB needs its HIGH word. Built and
// parsed without allocating the payload — the parser takes only the file's
// tail and its size.
Deno.test("the trailer carries a payload length over 4 GB", () => {
  const header = {
    sha256: "ab".repeat(32),
    binary: "demo",
    arch: "x64",
    format: "tar.zstd",
  } as const;
  const length = 5 * 0x100000000 + 123;
  const tail = sfxTrailer(header, length);
  const at = tail.length - SFX_MAGIC.length - 8;
  const view = new DataView(tail.buffer);
  assertEquals(view.getUint32(at, true), 123);
  assertEquals(view.getUint32(at + 4, true), 5);
  assertEquals(view.getBigUint64(at, true), BigInt(length));
  const stub = 3_712_000;
  assertEquals(parseSfxTrailer(tail, stub + length + tail.length), {
    header,
    payloadOffset: stub,
    payloadLength: length,
  });
  // A file too short to hold that payload is not an SFX.
  assertEquals(parseSfxTrailer(tail, length), null);
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
      // The stub is committed prebuilt — no compiler — and must be a real PE.
      const stubPath = await ensureWindowsSfxStub();
      const stubStat = await Deno.stat(stubPath);
      assert(stubStat.size > 100_000, "stub PE should be a real linked binary");
      // 3.7 MB as a Go program (through 1.0.17-beta); every `.exe` starts with it.
      assert(stubStat.size < 1_000_000, "the stub must stay under 1 MB");

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
      // Streamed to disk, byte for byte what the pure packer builds — and the
      // tail-only reader agrees with the whole-file one.
      assertEquals(
        await sha256Hex(pe),
        await sha256Hex(
          appendSfxPayload(
            await Deno.readFile(stubPath),
            payload,
            trail.header,
          ),
        ),
      );
      assertEquals(await readSfxTrailerOfFile(outPath), trail);
      assertEquals(
        await Deno.stat(`${outPath}.incoming`).catch(() => null),
        null,
      );
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

// R6: `new URL(import.meta.url).pathname` keeps `%20` and percent-encoded
// non-ASCII, so the stub was "missing" from any such checkout. Imported for
// real through such a path (a symlink to src/ — Deno keeps the specifier's
// path in import.meta.url).
Deno.test("the stub is found when aio is imported through a path with a space and non-ASCII", async () => {
  const tmp = await tempDir("windows-sfx-");
  try {
    const dir = join(tmp, "sp ace é");
    await Deno.mkdir(dir);
    await linkDir(join(REPO, "src"), join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "probe.ts"),
      `import { ensureWindowsSfxStub, prebuiltStubPath } from "./src/build/build-windows-exe.ts";
console.log(JSON.stringify([prebuiltStubPath(), await ensureWindowsSfxStub()]));`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--no-lock",
        `--config=${join(REPO, "deno.json")}`,
        join(dir, "probe.ts"),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(out.stderr);
    assert(out.success, stderr);
    const want = join(
      dir,
      "src/build/windows-sfx-stub/prebuilt/aio-windows-sfx-stub-amd64.exe",
    );
    assertEquals(JSON.parse(new TextDecoder().decode(out.stdout)), [
      want,
      want,
    ]);
  } finally {
    await dropTempDir(tmp);
  }
});

// R6: aio imported from a registry has an `https:` module URL and no file
// beside it. The stub comes from the module's own origin and is used only
// when it is the pinned build.
Deno.test("the stub of a remotely imported aio is fetched from the module's origin and verified", async () => {
  const stub = await Deno.readFile(prebuiltStubPath());
  const hits: string[] = [];
  const server = Deno.serve(
    { port: freePort(), hostname: "127.0.0.1", onListen() {} },
    (req) => {
      const path = new URL(req.url).pathname;
      hits.push(path);
      const rel =
        "/build/windows-sfx-stub/prebuilt/aio-windows-sfx-stub-amd64.exe";
      if (path === `/good/src${rel}`) return new Response(stub);
      if (path === `/bad/src${rel}`) {
        return new Response(stub.map((b, i) => i === 4096 ? b ^ 1 : b));
      }
      return new Response("no", { status: 404 });
    },
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  try {
    const path = await ensureWindowsSfxStub(
      `${base}/good/src/build/build-windows-exe.ts`,
    );
    try {
      assert(path !== prebuiltStubPath(), "a temp copy, not the checkout's");
      assertEquals(await sha256Hex(await Deno.readFile(path)), SFX_STUB_SHA256);
    } finally {
      await Deno.remove(path);
    }
    // The same answer with who owns the file: a fetched stub is a temp copy
    // the caller removes, the checkout's is not.
    const fetched = await resolveWindowsSfxStub(
      `${base}/good/src/build/build-windows-exe.ts`,
    );
    await Deno.remove(fetched.path);
    assertEquals(fetched.temp, true);
    // Given the build's scratch folder, the copy goes there under one name —
    // an interrupted build leaves it for the next one to write over.
    const scratch = await tempDir("windows-sfx-");
    try {
      const url = `${base}/good/src/build/build-windows-exe.ts`;
      const dir = join(scratch, ".aio", "build");
      for (const _ of [1, 2]) {
        assertEquals(await resolveWindowsSfxStub(url, undefined, dir), {
          path: join(dir, "aio-sfx-stub.exe"),
          temp: true,
        });
      }
      assertEquals(
        await sha256Hex(await Deno.readFile(join(dir, "aio-sfx-stub.exe"))),
        SFX_STUB_SHA256,
      );
    } finally {
      await dropTempDir(scratch);
    }
    assertEquals(await resolveWindowsSfxStub(), {
      path: prebuiltStubPath(),
      temp: false,
    });
    // One flipped bit: refused, with both digests.
    const bad = await assertRejects(
      () => ensureWindowsSfxStub(`${base}/bad/src/build/build-windows-exe.ts`),
      Error,
      "not the pinned build",
    );
    assertStringIncludes(bad.message, SFX_STUB_SHA256);
    await assertRejects(
      () => ensureWindowsSfxStub(`${base}/gone/src/build/build-windows-exe.ts`),
      Error,
      "could not be fetched",
    );
    assertEquals(hits.length, 6);
  } finally {
    await server.shutdown();
  }
});

Deno.test("a registry that accepts and never answers is given up on, not waited for", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: freePort() });
  const accepted = listener.accept(); // accepted, never answered
  try {
    const port = (listener.addr as Deno.NetAddr).port;
    const started = Date.now();
    const e = await assertRejects(
      () =>
        resolveWindowsSfxStub(
          `http://127.0.0.1:${port}/src/build/build-windows-exe.ts`,
          300,
        ),
      Error,
      "could not be fetched",
    );
    assertStringIncludes(e.message, "timeout");
    assert(Date.now() - started < 10_000, "gave up only after 10 s");
    (await accepted).close(); // the request did arrive
  } finally {
    listener.close();
  }
});

// A stub fetched for a registry-imported aio is a copy, and it is removed on
// every way out the SFX step takes itself — the failure that exits the
// process too (`Deno.exit` runs no `finally`). A build that is killed leaves
// it in the build's scratch folder, where the next build writes over it.
Deno.test("a temp stub is removed after the build, and when the build fails", async () => {
  const tmp = await tempDir("windows-sfx-");
  const fat = Deno.env.get("AIO_WINDOWS_FAT_EXE");
  Deno.env.delete("AIO_WINDOWS_FAT_EXE");
  try {
    const cfg = await stagedBuild(tmp);
    const copy = async () => {
      const path = join(tmp, "fetched-stub.exe");
      await Deno.copyFile(prebuiltStubPath(), path);
      return path;
    };
    const there = (p: string) => Deno.stat(p).then(() => true, () => false);

    let path = await copy();
    await hushed(() =>
      buildSelfContainedWindowsExe(cfg, {
        stub: () => Promise.resolve({ path, temp: true }),
      })
    );
    assertExists(
      await readSfxTrailerOfFile(
        join(tmp, selfContainedExeName("myapp", "x64")),
      ),
    );
    assertEquals(await there(path), false);

    // Not a temp copy (aio on disk): the committed stub is never removed.
    path = await copy();
    await hushed(() =>
      buildSelfContainedWindowsExe(cfg, {
        stub: () => Promise.resolve({ path, temp: false }),
      })
    );
    assertEquals(await there(path), true);

    // The step fails (no zip beside it): exit 1, said, and the copy is gone.
    await Deno.remove(join(tmp, windowsZipName("myapp", "x64")));
    let thereAtExit: boolean | null = null;
    const out = await exits(
      () =>
        buildSelfContainedWindowsExe(cfg, {
          stub: () => Promise.resolve({ path, temp: true }),
        }),
      () => thereAtExit = existsSync(path),
    );
    assertEquals(out.code, 1);
    assertStringIncludes(out.said, "myapp-win-x64.zip is missing");
    assertEquals(thereAtExit, false);
  } finally {
    if (fat !== undefined) Deno.env.set("AIO_WINDOWS_FAT_EXE", fat);
    await dropTempDir(tmp);
  }
});

Deno.test("a write that fails leaves no .incoming beside the exe", async () => {
  const tmp = await tempDir("windows-sfx-");
  try {
    await assertRejects(
      () =>
        writeWindowsSfxExe({
          stubPath: prebuiltStubPath(),
          payloadPath: join(tmp, "no-such-payload.tar.zst"),
          payloadFormat: "tar.zstd",
          outPath: join(tmp, "out", "demo-win-x64.exe"),
          binaryName: "demo",
          archStr: "x64",
        }),
      Deno.errors.NotFound,
    );
    const left: string[] = [];
    for await (const e of Deno.readDir(join(tmp, "out"))) left.push(e.name);
    assertEquals(left, []);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("no stub → the build falls back, loudly, to the fat exe instead of stopping", async () => {
  const cfg = { root: "/nowhere", binaryName: "myapp" } as BuildConfig;
  const built: BuildConfig[] = [];
  const said = await warnings(() =>
    buildSelfContainedWindowsExe(cfg, {
      stub: () => Promise.reject(new Error("the stub could not be fetched")),
      fat: (c) => Promise.resolve(void built.push(c)),
    })
  );
  assertEquals(built, [cfg]);
  assertStringIncludes(said, "the stub could not be fetched");
  assertStringIncludes(said, "FALLING BACK to the legacy fat exe");
});

Deno.test("AIO_WINDOWS_FAT_EXE=1 builds the fat exe and never touches the stub", async () => {
  const cfg = { root: "/nowhere", binaryName: "myapp" } as BuildConfig;
  const built: BuildConfig[] = [];
  const before = Deno.env.get("AIO_WINDOWS_FAT_EXE");
  Deno.env.set("AIO_WINDOWS_FAT_EXE", "1");
  try {
    const said = await warnings(() =>
      buildSelfContainedWindowsExe(cfg, {
        stub: () => {
          throw new Error("the SFX path must not run");
        },
        fat: (c) => Promise.resolve(void built.push(c)),
      })
    );
    assertEquals(built, [cfg]);
    assertStringIncludes(said, "AIO_WINDOWS_FAT_EXE=1");
  } finally {
    if (before === undefined) Deno.env.delete("AIO_WINDOWS_FAT_EXE");
    else Deno.env.set("AIO_WINDOWS_FAT_EXE", before);
  }
});

Deno.test({
  name: "a zstd pack that throws falls back, loudly, to the zip payload",
  async fn() {
    const tmp = await tempDir("windows-sfx-");
    // The rollback switch in the environment would route around the SFX.
    const fat = Deno.env.get("AIO_WINDOWS_FAT_EXE");
    Deno.env.delete("AIO_WINDOWS_FAT_EXE");
    try {
      const cfg = await stagedBuild(tmp);
      await Deno.writeTextFile(join(electronStagingDir(tmp), UNPACKABLE), "x");
      const said = await hushed(() =>
        warnings(() => buildSelfContainedWindowsExe(cfg))
      );
      assertStringIncludes(said, "cannot exceed 100 bytes");
      assertStringIncludes(said, "falling back to the zip payload");
      const exe = join(tmp, selfContainedExeName("myapp", "x64"));
      const trail = await readSfxTrailerOfFile(exe);
      assertExists(trail);
      assertEquals(trail.header.format, "zip");
      assertEquals(trail.payloadLength, 26 * 1024 * 1024);
      // The failed pack left nothing behind in the build scratch.
      const scratch: string[] = [];
      for await (const e of Deno.readDir(join(tmp, ".aio", "build"))) {
        scratch.push(e.name);
      }
      assertEquals(scratch, ["AppDir"]);
    } finally {
      if (fat !== undefined) Deno.env.set("AIO_WINDOWS_FAT_EXE", fat);
      await dropTempDir(tmp);
    }
  },
});

Deno.test("the payload is deterministic: sorted entries, fixed mtime", async () => {
  const tmp = await tempDir("windows-sfx-");
  try {
    // The same tree written in opposite orders, at different times.
    const files = ["b/2.txt", "a.exe", "b/1.txt", "c/d/e.bin"];
    for (
      const [name, order] of [["one", files], [
        "two",
        files.toReversed(),
      ]] as const
    ) {
      for (const f of order) {
        const p = join(tmp, name, f);
        await Deno.mkdir(join(p, ".."), { recursive: true });
        await Deno.writeTextFile(p, `content of ${f}`);
        await Deno.utime(p, name === "one" ? 1_000_000 : 2_000_000, 1_500_000);
      }
      if (Deno.build.os !== "windows") {
        const [dir, file] = name === "one" ? [0o700, 0o600] : [0o777, 0o777];
        for (const d of ["", "b", "c", "c/d"]) {
          await Deno.chmod(join(tmp, name, d), dir);
        }
        for (const f of ["a.exe", "b/1.txt", "b/2.txt", "c/d/e.bin"]) {
          await Deno.chmod(join(tmp, name, f), file);
        }
      }
      await packAppDirTarZstd(join(tmp, name), join(tmp, `${name}.tar.zst`));
    }
    assertEquals(
      await sha256Hex(await Deno.readFile(join(tmp, "one.tar.zst"))),
      await sha256Hex(await Deno.readFile(join(tmp, "two.tar.zst"))),
    );
    const names: string[] = [];
    const modes: Record<string, string> = {};
    const mtimes: (number | undefined)[] = [];
    const dec = zlib.zstdDecompressSync(
      await Deno.readFile(join(tmp, "one.tar.zst")),
    );
    for await (
      const entry of ReadableStream.from([dec]).pipeThrough(new UntarStream())
    ) {
      names.push(entry.path);
      modes[entry.path] = (entry.header.mode ?? -1).toString(8);
      mtimes.push(entry.header.mtime);
      await entry.readable?.cancel();
    }
    assertEquals(mtimes, names.map(() => 0));
    // Stated modes, not the staged tree's (one was staged closed, one wide
    // open): folders and what Windows runs by name are 0755, the rest 0644.
    assertEquals(modes, {
      "a.exe": "755",
      "b": "755",
      "b/1.txt": "644",
      "b/2.txt": "644",
      "c": "755",
      "c/d": "755",
      "c/d/e.bin": "644",
    });
    assertEquals(names, [
      "a.exe",
      "b",
      "b/1.txt",
      "b/2.txt",
      "c",
      "c/d",
      "c/d/e.bin",
    ]);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("tar entry names use / on every build host", () => {
  assertEquals(
    tarEntryName("electron\\resources\\app.asar", "\\"),
    "electron/resources/app.asar",
  );
  // On POSIX a backslash is part of a file name, not a separator.
  assertEquals(tarEntryName("a\\b", "/"), "a\\b");
});

Deno.test("a failed pack leaves no .incoming behind", async () => {
  const tmp = await tempDir("windows-sfx-");
  try {
    await Deno.mkdir(join(tmp, "app"));
    await Deno.writeTextFile(join(tmp, "app", "a.exe"), "x");
    await Deno.writeTextFile(join(tmp, "app", UNPACKABLE), "x");
    await assertRejects(
      () => packAppDirTarZstd(join(tmp, "app"), join(tmp, "p.tar.zst")),
      Error,
      "cannot exceed 100 bytes",
    );
    const left: string[] = [];
    for await (const e of Deno.readDir(tmp)) left.push(e.name);
    assertEquals(left, ["app"]);
  } finally {
    await dropTempDir(tmp);
  }
});

// What opening a FOLDER for writing fails with: Windows has no EISDIR.
const OPEN_FOLDER_ERROR = Deno.build.os === "windows" ? "EINVAL" : "EISDIR";

// A pack that stops while it is reading a file closes that file itself: the
// resource sanitizer fails this test, and the one after it, when the handle is
// left for the garbage collector.
Deno.test("a pack whose output cannot be written leaves no file open", async () => {
  const tmp = await tempDir("windows-sfx-");
  try {
    await Deno.mkdir(join(tmp, "app"));
    await Deno.writeFile(join(tmp, "app", "a.bin"), new Uint8Array(1 << 20));
    await Deno.writeFile(join(tmp, "app", "b.bin"), new Uint8Array(1 << 20));
    // The pack writes to `<out>.incoming`: a folder there cannot be opened.
    await Deno.mkdir(join(tmp, "p.tar.zst.incoming"));
    await assertRejects(
      () => packAppDirTarZstd(join(tmp, "app"), join(tmp, "p.tar.zst")),
      Error,
      OPEN_FOLDER_ERROR,
    );
    const left: string[] = [];
    for await (const e of Deno.readDir(join(tmp, "app"))) left.push(e.name);
    assertEquals(left.sort(), ["a.bin", "b.bin"]);
  } finally {
    await dropTempDir(tmp);
  }
});

// The pack can fail while the open of its next file is still on its way. It
// does not return before that open has landed, and the file is closed unread.
// The file's own stat is held here until the pack is cleaning up after the
// failure (its `Deno.remove` of the half-written output), and its open is
// slow — so that open is the late one.
Deno.test("a pack that fails while a file is being opened returns with it closed, unread", async () => {
  const tmp = await tempDir("windows-sfx-");
  const real = { stat: Deno.stat, open: Deno.open, remove: Deno.remove };
  try {
    const slow = join(tmp, "app", "a.bin");
    await Deno.mkdir(join(tmp, "app"));
    await Deno.writeFile(slow, new Uint8Array(1 << 20));
    const entries = await appDirEntries(join(tmp, "app"));
    // The pack writes to `<out>.incoming`: a folder there cannot be opened.
    await Deno.mkdir(join(tmp, "p.tar.zst.incoming"));
    const failing = Promise.withResolvers<void>();
    let asked = false, read = false;
    let opened: Deno.FsFile | undefined;
    Deno.stat = (async (path) => {
      if (path === slow) {
        asked = true;
        await failing.promise;
      }
      return await real.stat(path);
    }) as typeof Deno.stat;
    Deno.remove = ((path, options) => {
      failing.resolve();
      return real.remove(path, options);
    }) as typeof Deno.remove;
    Deno.open = (async (path, options) => {
      if (path !== slow) return await real.open(path, options);
      await new Promise((r) => setTimeout(r, 50));
      const file = await real.open(path, options);
      const { readable } = file;
      Object.defineProperty(file, "readable", {
        get: () => (read = true, readable),
      });
      return opened = file;
    }) as typeof Deno.open;
    await assertRejects(
      () =>
        packAppDirTarZstd(join(tmp, "app"), join(tmp, "p.tar.zst"), entries),
      Error,
      OPEN_FOLDER_ERROR,
    );
    assert(asked, "the pack failed before it reached the file");
    assertExists(opened, "the pack returned before the open had landed");
    assertEquals(read, false);
    // Closed: its handle answers nothing any more.
    await assertRejects(() => opened!.stat(), Deno.errors.BadResource);
  } finally {
    Object.assign(Deno, real);
    await dropTempDir(tmp);
  }
});

// The app is listed before the pack begins, so a file can change under it. The
// pack stops and names the file: the tar's own complaint names none, and
// opening what has become a pipe would wait for ever.
for (
  const [label, change, want] of [
    [
      "grew",
      (f: string) => Deno.writeFile(f, new Uint8Array(25180)),
      "dist/b.txt changed while the app was being packed: 180 bytes when it was listed, 25180 now",
    ],
    [
      "shrank",
      (f: string) => Deno.writeFile(f, new Uint8Array(10)),
      "dist/b.txt changed while the app was being packed: 180 bytes when it was listed, 10 now",
    ],
    [
      "became a folder",
      async (f: string) => {
        await Deno.remove(f);
        await Deno.mkdir(f);
      },
      "dist/b.txt was a file when the app was listed and is not one now",
    ],
    [
      "became a pipe",
      async (f: string) => {
        await Deno.remove(f);
        const made = await new Deno.Command("mkfifo", { args: [f] }).output();
        assert(made.success, "mkfifo");
      },
      "dist/b.txt was a file when the app was listed and is not one now",
    ],
  ] as const
) {
  Deno.test({
    name:
      `a file that ${label} after the app was listed stops the pack, by name`,
    ignore: label === "became a pipe" && Deno.build.os !== "linux", // mkfifo
    async fn() {
      const tmp = await tempDir("windows-sfx-");
      const file = join(tmp, "app", "dist", "b.txt");
      try {
        await Deno.mkdir(join(tmp, "app", "dist"), { recursive: true });
        await Deno.writeFile(join(tmp, "app", "a.bin"), new Uint8Array(4096));
        await Deno.writeFile(file, new Uint8Array(180));
        const entries = await appDirEntries(join(tmp, "app"));
        await change(file);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const said = await Promise.race([
          packAppDirTarZstd(join(tmp, "app"), join(tmp, "p.tar.zst"), entries)
            .then(() => "packed", (e: Error) => e.message),
          new Promise<string>((r) => timer = setTimeout(() => r("hung"), 5000)),
        ]);
        clearTimeout(timer);
        assertEquals(said, want);
        const left: string[] = [];
        for await (const e of Deno.readDir(tmp)) left.push(e.name);
        assertEquals(left, ["app"]);
      } finally {
        if (label === "became a pipe") {
          // Lets go an open that is still waiting on the pipe (a failing run).
          (await Deno.open(file, { read: true, write: true })).close();
        }
        await dropTempDir(tmp);
      }
    },
  });
}

// A Windows install has no symlinks and the stub refuses one, so a symlink in
// the staged app is packed as what it points at. Before, the pack refused it,
// the build fell back to the zip (which stores the link) and printed success
// for an exe that could not install.
Deno.test("a symlink in the app is packed as a copy of its target", async () => {
  const tmp = await tempDir("windows-sfx-");
  try {
    const app = join(tmp, "app");
    await Deno.mkdir(join(app, "dist", "img"), { recursive: true });
    await Deno.writeTextFile(join(app, "dist", "logo.png"), "PNG-BYTES");
    await Deno.writeTextFile(join(app, "dist", "img", "a.svg"), "<svg/>");
    await linkFile("logo.png", join(app, "dist", "icon.png"));
    await linkDir("dist/img", join(app, "assets")); // a folder
    await linkFile("icon.png", join(app, "dist", "tray.png")); // a chain

    assertEquals(
      (await appDirEntries(app)).map((e) => [e.path, e.size, e.linked]),
      [
        ["assets", null, true],
        ["assets/a.svg", 6, true],
        ["dist", null, false],
        ["dist/icon.png", 9, true],
        ["dist/img", null, false],
        ["dist/img/a.svg", 6, false],
        ["dist/logo.png", 9, false],
        ["dist/tray.png", 9, true],
      ],
    );
    await packAppDirTarZstd(app, join(tmp, "p.tar.zst"));
    assertEquals(await tarFiles(await Deno.readFile(join(tmp, "p.tar.zst"))), {
      "assets": "/",
      "assets/a.svg": "<svg/>",
      "dist": "/",
      "dist/icon.png": "PNG-BYTES",
      "dist/img": "/",
      "dist/img/a.svg": "<svg/>",
      "dist/logo.png": "PNG-BYTES",
      "dist/tray.png": "PNG-BYTES",
    });
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("a symlink that cannot be packed as a copy is refused, by name", async () => {
  const tmp = await tempDir("windows-sfx-");
  try {
    await Deno.writeTextFile(join(tmp, "secret.txt"), "not the app's");
    await Deno.mkdir(join(tmp, "app-x"));
    await Deno.writeTextFile(join(tmp, "app-x", "secret.txt"), "nor this");
    const cases: [string, string, string][] = [
      ["../../secret.txt", "points outside it: dist/link", "secret.txt"],
      // A sibling whose name starts with the app folder's is outside it too.
      ["../../app-x/secret.txt", "points outside it: dist/link", "app-x"],
      ["gone.png", "points at nothing: dist/link", "gone.png"],
      ["..", "points at a folder it is inside: dist/link", "app"],
      ["../..", "points at a folder it is inside: dist/link", ""],
    ];
    for (const [target, want, also] of cases) {
      const app = join(tmp, "app");
      await Deno.mkdir(join(app, "dist"), { recursive: true });
      // `..` and `../..` are folders; the rest are (or would be) files.
      const link = target.endsWith("..") ? linkDir : linkFile;
      await link(target, join(app, "dist", "link"));
      const e = await assertRejects(
        () => packAppDirTarZstd(app, join(tmp, "p.tar.zst")),
        Error,
        want,
      );
      assertStringIncludes(e.message, also);
      await Deno.remove(join(app, "dist", "link"));
    }
    // Two folders linking into each other: neither is an ancestor of its link.
    const app = join(tmp, "app");
    await Deno.mkdir(join(app, "a"));
    await Deno.mkdir(join(app, "b"));
    await linkDir("../b", join(app, "a", "to-b"));
    await linkDir("../a", join(app, "b", "to-a"));
    await assertRejects(
      () => appDirEntries(app),
      Error,
      "points at a folder it is inside: a/to-b/to-a",
    );
    // Nothing was written for any of them.
    const left: string[] = [];
    for await (const e of Deno.readDir(tmp)) left.push(e.name);
    assertEquals(left.sort(), ["app", "app-x", "secret.txt"]);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("an app with a symlink builds a zstd exe that carries the target; one pointing outside stops the build", async () => {
  const tmp = await tempDir("windows-sfx-");
  const fat = Deno.env.get("AIO_WINDOWS_FAT_EXE");
  Deno.env.delete("AIO_WINDOWS_FAT_EXE");
  try {
    const cfg = await stagedBuild(tmp);
    const appDir = electronStagingDir(tmp);
    await linkFile("myapp.exe", join(appDir, "link.exe"));
    // A linked file big enough that its copy takes the exe past the zip it is
    // gated against (which holds the file once): the gate counts the copy.
    // 5 MB: zstd packs the copy to almost nothing, and the stub is under 1 MB,
    // so the file alone has to be larger than the 4 MB zip plus its margin.
    const big = new Uint8Array(5 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 65536) {
      crypto.getRandomValues(big.subarray(at, at + 65536));
    }
    await Deno.writeFile(join(appDir, "big.bin"), big);
    await linkFile("big.bin", join(appDir, "big-link.bin"));
    await Deno.writeFile(
      join(tmp, windowsZipName("myapp", "x64")),
      new Uint8Array(4 * 1024 * 1024),
    );
    const said = await hushed(() =>
      warnings(() => buildSelfContainedWindowsExe(cfg))
    );
    assertStringIncludes(
      said,
      "big-link.bin and 1 more are reached through a symlink",
    );
    assertStringIncludes(said, "(5.0 MB)");
    assert(!said.includes("falling back"), said);
    const exe = join(tmp, selfContainedExeName("myapp", "x64"));
    const trail = await readSfxTrailerOfFile(exe);
    assertExists(trail);
    assertEquals(trail.header.format, "tar.zstd");
    // What the stub needs to keep a newer install and to name its shortcut.
    assertEquals(
      [trail.header.version, trail.header.title, trail.header.shortcut],
      ["1.2.3", "My App", true],
    );
    const pe = await Deno.readFile(exe);
    const files = await tarFiles(
      pe.subarray(
        trail.payloadOffset,
        trail.payloadOffset + trail.payloadLength,
      ),
    );
    assertEquals(files["link.exe"], "inner");
    assertEquals(files["big-link.bin"]!.length, files["big.bin"]!.length);
    assert(pe.length > 1.15 * 4 * 1024 * 1024, "past the gate without it");

    // Outside the app: no exe, exit 1, the path said.
    await Deno.remove(exe);
    await Deno.writeTextFile(join(tmp, "host-file"), "x");
    await linkFile(join(tmp, "host-file"), join(appDir, "out.txt"));
    const out = await hushed(() =>
      exits(() => buildSelfContainedWindowsExe(cfg))
    );
    assertEquals(out.code, 1);
    assertStringIncludes(out.said, "points outside it: out.txt");
    assertEquals(await Deno.stat(exe).catch(() => null), null);
  } finally {
    if (fat !== undefined) Deno.env.set("AIO_WINDOWS_FAT_EXE", fat);
    await dropTempDir(tmp);
  }
});

// The zip beside the exe stores a symlink as a symlink. When the zstd pack
// fails and the app has one, the payload is a zip of its own with the links
// followed — the real `zip`, read back with the updater's zip reader.
Deno.test("the zip fallback of an app with a symlink carries the target, not the link", async () => {
  const tmp = await tempDir("windows-sfx-");
  const fat = Deno.env.get("AIO_WINDOWS_FAT_EXE");
  Deno.env.delete("AIO_WINDOWS_FAT_EXE");
  try {
    const cfg = await stagedBuild(tmp);
    const appDir = electronStagingDir(tmp);
    await Deno.writeTextFile(join(appDir, UNPACKABLE), "x");
    await linkFile("myapp.exe", join(appDir, "link.exe"));
    const said = await hushed(() =>
      warnings(() => buildSelfContainedWindowsExe(cfg))
    );
    assertStringIncludes(said, "falling back to the zip payload");
    const exe = join(tmp, selfContainedExeName("myapp", "x64"));
    const trail = await readSfxTrailerOfFile(exe);
    assertExists(trail);
    assertEquals(trail.header.format, "zip");
    const pe = await Deno.readFile(exe);
    const dest = join(tmp, "unzipped");
    await extractZip(
      pe.subarray(
        trail.payloadOffset,
        trail.payloadOffset + trail.payloadLength,
      ),
      dest,
    );
    const link = await Deno.lstat(join(dest, "link.exe"));
    assert(link.isFile && !link.isSymlink, "link.exe must be a regular file");
    assertEquals(await Deno.readTextFile(join(dest, "link.exe")), "inner");
    assertEquals(await Deno.readTextFile(join(dest, "myapp.exe")), "inner");
    // Its own zip was build scratch.
    const scratch: string[] = [];
    for await (const e of Deno.readDir(join(tmp, ".aio", "build"))) {
      scratch.push(e.name);
    }
    assertEquals(scratch, ["AppDir"]);
  } finally {
    if (fat !== undefined) Deno.env.set("AIO_WINDOWS_FAT_EXE", fat);
    await dropTempDir(tmp);
  }
});

/** A minimal PE32+ header — enough for the security directory to be found —
 *  and the offset of that directory's entry. */
function fakePe(): { stub: Uint8Array; securityEntry: number } {
  const lfanew = 0x80;
  const stub = new Uint8Array(0x200);
  const view = new DataView(stub.buffer);
  stub.set(new TextEncoder().encode("MZ"));
  view.setUint32(0x3c, lfanew, true);
  stub.set(new TextEncoder().encode("PE\0\0"), lfanew);
  const opt = lfanew + 4 + 20;
  view.setUint16(opt, 0x20b, true);
  view.setUint32(opt + 108, 16, true); // NumberOfRvaAndSizes
  return { stub, securityEntry: opt + 112 + 4 * 8 };
}

/** `exe` with an Authenticode-shaped certificate table appended: the file
 *  padded to 8 bytes, the table after it, the security directory naming it. */
function signedPe(exe: Uint8Array, securityEntry: number): Uint8Array {
  const padded = Math.ceil(exe.length / 8) * 8;
  const out = new Uint8Array(padded + 4096).fill(0xc5, padded);
  out.set(exe);
  out.fill(0, exe.length, padded);
  const view = new DataView(out.buffer);
  view.setUint32(securityEntry, padded, true);
  view.setUint32(securityEntry + 4, 4096, true);
  return out;
}

// `am publish` asks this reader whether an `.exe` is a one-click installer. A
// signature puts the certificate table AFTER the trailer, so a reader that
// only looked at the end of the file called every signed installer "not one".
Deno.test("a signed exe's trailer is read from before its certificate table, at every padding", async () => {
  const tmp = await tempDir("windows-sfx-");
  try {
    const { stub, securityEntry } = fakePe();
    const header = {
      sha256: "ab",
      binary: "myapp",
      arch: "x64",
      format: "tar.zstd" as const,
    };
    for (let pad = 0; pad < 8; pad++) {
      const payload = new TextEncoder().encode("PAYLOAD" + "x".repeat(pad));
      const exe = appendSfxPayload(stub, payload, header);
      const signed = signedPe(exe, securityEntry);
      assert(
        new TextDecoder().decode(signed.subarray(-SFX_MAGIC.length)) !==
          SFX_MAGIC,
        "fixture: the magic must not be at the end of the file",
      );
      const want = {
        header,
        payloadOffset: stub.length,
        payloadLength: payload.length,
      };
      assertEquals(readSfxTrailer(exe), want);
      assertEquals(readSfxTrailer(signed), want, `padding ${pad}`);
      const path = join(tmp, `signed-${pad}.exe`);
      await Deno.writeFile(path, signed);
      assertEquals(await readSfxTrailerOfFile(path), want, `padding ${pad}`);
    }
    // Bytes after the trailer that no security directory accounts for are not
    // a signature: not an installer this reader may vouch for.
    const exe = appendSfxPayload(stub, new Uint8Array([1, 2, 3]), header);
    const trailing = new Uint8Array(exe.length + 4096);
    trailing.set(exe);
    assertEquals(readSfxTrailer(trailing), null);
    const path = join(tmp, "trailing.exe");
    await Deno.writeFile(path, trailing);
    assertEquals(await readSfxTrailerOfFile(path), null);
    // …and a file that is no PE at all, shorter than a PE header.
    await Deno.writeTextFile(path, "MZ fake exe");
    assertEquals(await readSfxTrailerOfFile(path), null);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("build.windows.shortcut: on unless it says false; anything else is refused", async () => {
  assertEquals(resolveWindowsShortcut({}), true);
  assertEquals(resolveWindowsShortcut({ build: {} }), true);
  assertEquals(resolveWindowsShortcut({ build: { windows: {} } }), true);
  assertEquals(
    resolveWindowsShortcut({ build: { windows: { shortcut: true } } }),
    true,
  );
  assertEquals(
    resolveWindowsShortcut({ build: { windows: { shortcut: false } } }),
    false,
  );
  assertThrows(
    () => resolveWindowsShortcut({ build: { windows: { shortcut: "no" } } }),
    Error,
    "build.windows",
  );
  assertThrows(
    () => resolveWindowsShortcut({ build: { windows: false } }),
    Error,
    "build.windows",
  );
  // Off: the header says nothing, and the stub adds none.
  const tmp = await tempDir("windows-sfx-");
  try {
    const cfg = { ...await stagedBuild(tmp), windowsShortcut: false };
    await hushed(() => buildSelfContainedWindowsExe(cfg));
    const trail = await readSfxTrailerOfFile(
      join(tmp, selfContainedExeName("myapp", "x64")),
    );
    assertExists(trail);
    assertEquals(trail.header.shortcut, undefined);
    assertEquals(trail.header.version, "1.2.3");
  } finally {
    await dropTempDir(tmp);
  }
});
