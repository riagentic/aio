// A compiled desktop binary fetches its own Electron — the field report:
// an app installed by the one-liner opened nothing because its launcher
// looked for `node_modules/.bin/electron` under the CURRENT DIRECTORY and then
// "auto-installed" by running `Deno.execPath() install npm:electron`, which in
// a compiled binary is the app itself. The user had to go back to the source
// tree, run `deno task install:electron` by hand, and start the binary from
// there. These tests pin the resolution order and the fetch, without a
// display and without a 100 MB download.
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { basename, dirname, fromFileUrl, join, resolve } from "@std/path";
import {
  _withRuntimeLock,
  bakedElectronVersion,
  DEFAULT_ELECTRON_VERSION,
  electronBinIn,
  electronOsFromSlug,
  electronRuntimeDir,
  electronShasumsUrlFor,
  electronSlug,
  electronZipName,
  electronZipUrlFor,
  ensureElectronRuntime,
  renameWithRetry,
  shasumFor,
  toolCacheDir,
} from "../src/electron/electron-runtime-fetch.ts";
import {
  electronSource,
  findElectronBin,
  FRAMEWORK_CHECKOUT,
  installRefusal,
  isInvalidHandleError,
  packagedElectronCandidates,
} from "../src/electron/electron-spawn.ts";
import { MAC_WINDOW_LINK } from "../src/electron/electron-runtime-fetch.ts";
import {
  electronCacheDir,
  electronDrift,
  electronDriftNote,
  localElectronDistFor,
  resolveElectronVersion,
} from "../src/build/electron-runtime.ts";
import type { Log } from "../src/electron/electron-shared.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  _lockTiming,
  holderAlive,
  keepFresh,
  ownPidNs,
  releasePidLock,
  tryPidLock,
} from "../src/server/pid-lock.ts";
import {
  STAGE_STALE_MS,
  stageTag,
} from "../src/electron/electron-runtime-fetch.ts";
import { cacheEntryKind } from "../src/build/electron-cache.ts";
import { zipTree } from "./zip-helper.ts";
import { sleeper } from "./proc-helper.ts";

const silent: Log = { info: () => {}, error: () => {} };

/** An empty stand-in for the Electron executable of a runtime at `dir` — three
 *  folders deep on macOS (`Electron.app/Contents/MacOS`), so made with them. */
async function touchElectronBin(dir: string): Promise<void> {
  const bin = electronBinIn(dir);
  await Deno.mkdir(join(bin, ".."), { recursive: true });
  await Deno.writeTextFile(bin, "");
}

/** Run `fn` in an empty cwd with a private cache — steps 2/3 of the launcher
 *  stat RELATIVE paths, and this repo has a node_modules/.bin/electron. */
async function isolated<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = await tempDir("electron-fetch-");
  const cwd = Deno.cwd();
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  const ep = Deno.env.get("ELECTRON_PATH");
  Deno.chdir(tmp);
  Deno.env.set("XDG_CACHE_HOME", join(tmp, "cache"));
  Deno.env.delete("ELECTRON_PATH");
  try {
    return await fn(tmp);
  } finally {
    Deno.chdir(cwd);
    if (xdg === undefined) Deno.env.delete("XDG_CACHE_HOME");
    else Deno.env.set("XDG_CACHE_HOME", xdg);
    if (ep !== undefined) Deno.env.set("ELECTRON_PATH", ep);
    await dropTempDir(tmp);
  }
}

Deno.test("electron-runtime-fetch: pure mapping — slug, url, cache dir, binary", () => {
  assertEquals(electronSlug({ os: "linux", arch: "x86_64" }), "linux-x64");
  assertEquals(electronSlug({ os: "linux", arch: "aarch64" }), "linux-arm64");
  assertEquals(electronSlug({ os: "darwin", arch: "aarch64" }), "darwin-arm64");
  assertEquals(electronSlug({ os: "windows", arch: "x86_64" }), "win32-x64");
  assertEquals(
    electronZipUrlFor("28.3.3", "linux-x64"),
    "https://github.com/electron/electron/releases/download/v28.3.3/electron-v28.3.3-linux-x64.zip",
  );
  assertEquals(
    electronZipUrlFor("v28.3.3", "win32-x64"),
    electronZipUrlFor("28.3.3", "win32-x64"),
    "a leading v is normalised, never doubled",
  );
  // One cache directory whether the version came with a `v` or not, and the
  // BUILD's cross-compile cache is the same directory the launcher uses —
  // one download per version per machine.
  assertEquals(
    electronRuntimeDir("v1.2.3", "linux-x64"),
    electronRuntimeDir("1.2.3", "linux-x64"),
  );
  assertEquals(
    electronCacheDir("1.2.3", "linux"),
    electronRuntimeDir("1.2.3", "linux-x64"),
  );
  assert(electronRuntimeDir("1.2.3", "linux-x64").startsWith(toolCacheDir()));
  // A path on THIS host (where the runtime is unpacked), whatever the target.
  assertEquals(electronBinIn("/r", "linux"), join("/r", "electron"));
  assertEquals(electronBinIn("/r", "windows"), join("/r", "electron.exe"));
  assertEquals(
    electronBinIn("/r", "darwin"),
    join("/r", "Electron.app", "Contents", "MacOS", "Electron"),
  );
});

Deno.test("bakedElectronVersion: reads dist/electron.json, null for anything else", async () => {
  const tmp = await tempDir("electron-fetch-");
  assertEquals(await bakedElectronVersion(undefined), null);
  assertEquals(await bakedElectronVersion(tmp), null, "no file");
  await Deno.writeTextFile(join(tmp, "electron.json"), '{"version":""}');
  assertEquals(await bakedElectronVersion(tmp), null, "empty is not a version");
  await Deno.writeTextFile(join(tmp, "electron.json"), '{"version":"43.4.1"}');
  assertEquals(await bakedElectronVersion(tmp), "43.4.1");
  await dropTempDir(tmp);
});

Deno.test("resolveElectronVersion: aio's tested version, whatever the app's copies say", async () => {
  // aio decides the Electron (it is tested with ONE, and a build ships that
  // one). This used to be installed > import-map spec > default, so an app
  // scaffolded by an older aio shipped that aio's Electron under every later
  // framework. The app's copies are now REPORTED when they disagree.
  const tmp = await tempDir("electron-fetch-");
  try {
    assertEquals(await resolveElectronVersion(tmp), DEFAULT_ELECTRON_VERSION);
    assertEquals(
      electronDriftNote(await electronDrift(tmp)),
      null,
      "no copies",
    );
    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      '{"imports":{"electron":"npm:electron@^43.4.1"}}',
    );
    await Deno.mkdir(join(tmp, "node_modules", "electron", "dist"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(tmp, "node_modules", "electron", "package.json"),
      '{"version":"42.0.0"}',
    );
    assertEquals(await resolveElectronVersion(tmp), DEFAULT_ELECTRON_VERSION);
    const d = await electronDrift(tmp);
    assertEquals(d, {
      tested: DEFAULT_ELECTRON_VERSION,
      declared: "npm:electron@^43.4.1",
      installed: "42.0.0",
    });
    const note = electronDriftNote(d)!;
    assertStringIncludes(note, `Electron ${DEFAULT_ELECTRON_VERSION} ships`);
    assertStringIncludes(note, '"npm:electron@^43.4.1"');
    assertStringIncludes(note, "node_modules has 42.0.0");
    assertStringIncludes(note, "am fix");
    // Installed means UNPACKED: a package.json without dist/ is no runtime.
    await Deno.remove(join(tmp, "node_modules", "electron", "dist"));
    assertEquals((await electronDrift(tmp)).installed, null);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("electronDriftNote: copies that agree say nothing", () => {
  const tested = DEFAULT_ELECTRON_VERSION;
  assertEquals(
    electronDriftNote({
      tested,
      declared: `npm:electron@${tested}`,
      installed: tested,
    }),
    null,
  );
  assertEquals(
    electronDriftNote({ tested, declared: null, installed: null }),
    null,
  );
});

Deno.test("localElectronDistFor: a stale node_modules runtime is NOT used for another version", async () => {
  // The second half of the same field report: the PACKAGE step copied the host
  // runtime whenever one existed, so a `node_modules/electron` left over from a
  // previous install shipped one Electron in the zip while the self-contained
  // exe carried the version the build baked. The fix is that a local runtime is
  // reused ONLY for the exact version — an offline build still works, and a
  // stale one can never slip in beside the baked version.
  const tmp = await tempDir("electron-fetch-");
  try {
    const dist = join(tmp, "node_modules", "electron", "dist");
    await Deno.mkdir(dist, { recursive: true });
    await Deno.writeTextFile(
      join(tmp, "node_modules", "electron", "package.json"),
      '{"version":"42.0.0"}',
    );
    assertEquals(
      resolve(await localElectronDistFor("42.0.0", tmp) ?? ""),
      dist,
    );
    assertEquals(
      await localElectronDistFor("44.4.1", tmp),
      null,
      "a runtime of a different version is never handed back",
    );
    // No dist/ at all → nothing to reuse, whatever the package.json says.
    await Deno.remove(dist, { recursive: true });
    assertEquals(await localElectronDistFor("42.0.0", tmp), null);
  } finally {
    await dropTempDir(tmp);
  }
});

/** A zip holding one executable at `entryName` — what the release asset looks
 *  like, at 1 KB instead of 100 MB. The name is a PARAMETER because that is
 *  the whole bug this file now pins: Electron's win32 asset holds
 *  `electron.exe` and its darwin asset holds `Electron.app/…/Electron`, and
 *  the fetcher used to look for the HOST's spelling in every one of them. */
async function tinyElectronZip(
  dir: string,
  entryName = "electron",
): Promise<Uint8Array> {
  const zip = join(dir, `fake-${entryName.replace(/[^A-Za-z0-9]/g, "_")}.zip`);
  const src = join(dir, "payload");
  await Deno.writeTextFile(src, "#!/bin/sh\necho fake electron\n");
  await Deno.chmod(src, 0o755);
  // python3 writes exactly one entry under the given name. Where there is
  // none (every Windows), the host's archiver packs a tree whose layout
  // already carries the entry name.
  let py = false;
  try {
    py = (await new Deno.Command("python3", {
      args: [
        "-c",
        `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.write(sys.argv[2],sys.argv[3]); z.close()`,
        zip,
        src,
        entryName,
      ],
      stderr: "piped",
    }).output()).success;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  if (!py) {
    const stage = join(dir, `stage-${entryName.replace(/[^A-Za-z0-9]/g, "_")}`);
    const target = join(stage, entryName);
    await Deno.mkdir(join(target, ".."), { recursive: true });
    await Deno.copyFile(src, target);
    await zipTree(stage, zip);
  }
  return await Deno.readFile(zip);
}

/** Lowercase hex SHA-256 — the same digest `SHASUMS256.txt` publishes. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(d)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/** A stand-in for Electron's release host: the zip, and the SHASUMS256.txt that
 *  matches it. `corrupt` serves a zip whose bytes do not match the manifest —
 *  the tampered-download case. */
async function fakeRelease(
  bytes: Uint8Array,
  version: string,
  slug: string,
  opts: { corrupt?: boolean; noSums?: boolean } = {},
): Promise<{ fetch: typeof fetch; zipFetches: () => number }> {
  const name = electronZipName(version, slug);
  const sums = `${await sha256Hex(bytes)} *${name}\n`;
  const served = opts.corrupt ? new Uint8Array([...bytes, 0x00]) : bytes;
  let zipFetches = 0;
  const f = ((url: string | URL | Request) => {
    const href = String(url);
    if (href.endsWith("SHASUMS256.txt")) {
      return Promise.resolve(
        opts.noSums
          ? new Response("no", { status: 404, statusText: "Not Found" })
          : new Response(sums, { status: 200 }),
      );
    }
    zipFetches++;
    return Promise.resolve(
      new Response(served.slice().buffer as ArrayBuffer, { status: 200 }),
    );
  }) as typeof fetch;
  return { fetch: f, zipFetches: () => zipFetches };
}

Deno.test("shasumFor: parses SHASUMS256.txt, both spellings, and only an exact name", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const txt = `${a} *electron-v9.9.9-linux-x64.zip\n` +
    `${b}  electron-v9.9.9-win32-x64.zip\n`;
  assertEquals(shasumFor(txt, "electron-v9.9.9-linux-x64.zip"), a);
  assertEquals(shasumFor(txt, "electron-v9.9.9-win32-x64.zip"), b);
  assertEquals(shasumFor(txt, "electron-v9.9.9-darwin-x64.zip"), null);
  // A prefix of a listed name is NOT a match.
  assertEquals(shasumFor(txt, "electron-v9.9.9-linux-x64.zi"), null);
});

Deno.test("ELECTRON_MIRROR: advised in two error messages, and now actually read", () => {
  assertEquals(
    electronZipUrlFor("9.9.9", "linux-x64", "https://mirror.example/e"),
    "https://mirror.example/e/v9.9.9/electron-v9.9.9-linux-x64.zip",
  );
  // A trailing slash is accepted either way.
  assertEquals(
    electronShasumsUrlFor("9.9.9", "https://mirror.example/e/"),
    "https://mirror.example/e/v9.9.9/SHASUMS256.txt",
  );
  assertEquals(
    electronShasumsUrlFor("9.9.9"),
    "https://github.com/electron/electron/releases/download/v9.9.9/SHASUMS256.txt",
  );
});

Deno.test("ensureElectronRuntime: downloads once into the cache, stamps completion, reuses", async () => {
  await isolated(async (tmp) => {
    const bytes = await tinyElectronZip(tmp);
    const rel = await fakeRelease(bytes, "9.9.9", "linux-x64");
    const fakeFetch = rel.fetch;
    const fetches = rel.zipFetches;
    const lines: string[] = [];
    const dir = await ensureElectronRuntime("9.9.9", "linux-x64", {
      fetch: fakeFetch,
      log: (m) => lines.push(m),
    });
    assertEquals(dir, electronRuntimeDir("9.9.9", "linux-x64"));
    assertEquals(fetches(), 1);
    const bin = electronBinIn(dir, "linux");
    assert((await Deno.stat(bin)).isFile, "the runtime binary is unpacked");
    assert(
      await Deno.stat(join(dir, ".aio-complete")).then(() => true),
      "completion stamp written",
    );
    assert(lines.some((l) => l.includes("downloading")), lines.join("\n"));
    // Second call: cached, no fetch.
    await ensureElectronRuntime("9.9.9", "linux-x64", {
      fetch: fakeFetch,
      log: () => {},
    });
    assertEquals(fetches(), 1, "a cached runtime is never re-downloaded");
    // A missing stamp (interrupted unpack) re-downloads rather than trusting
    // the half-written directory.
    await Deno.remove(join(dir, ".aio-complete"));
    await ensureElectronRuntime("9.9.9", "linux-x64", {
      fetch: fakeFetch,
      log: () => {},
    });
    assertEquals(fetches(), 2);
    // A stamp with the EXECUTABLE missing is not a cache hit either — that is
    // the state a concurrent `Deno.remove` used to leave behind, after which
    // every launch said "cached" and opened nothing, forever.
    await Deno.remove(bin);
    await ensureElectronRuntime("9.9.9", "linux-x64", {
      fetch: fakeFetch,
      log: () => {},
    });
    assertEquals(fetches(), 3);
    assert((await Deno.stat(bin)).isFile, "the runtime was repaired");
  });
});

Deno.test("ensureElectronRuntime: a killed unpack's stage is removed; a LIVE one is not", async () => {
  await isolated(async (tmp) => {
    const bytes = await tinyElectronZip(tmp);
    const rel = await fakeRelease(bytes, "9.9.8", "linux-x64");
    const dir = electronRuntimeDir("9.9.8", "linux-x64");
    // A pid no process has (the max pid on Linux is < 2^22; a Windows pid is
    // a multiple of 4) and a live one, both in OUR pid namespace (no start
    // stamp). Not pid 1: Windows has none.
    const alive = sleeper({ stdout: "null", stderr: "null" });
    try {
      const ns = ownPidNs();
      const hex = (n: number) => n.toString(16).padStart(8, "0");
      const here = ns === undefined ? "" : `d${hex(ns)}`;
      const dead = `${dir}.incoming.4194303-0badf00d${here}`;
      const live = `${dir}.incoming.${alive.pid}-0badf00d${here}`;
      // Where pid namespaces exist, a name without one (an older aio's) or
      // with another (a container's pid 7 under tini, heartbeating its stage)
      // proves nothing by its pid: fresh, it is kept.
      const unknownNs = `${dir}.incoming.4194303-cafe0123`;
      const otherNs = `${dir}.incoming.4194303-cafe0123d${hex((ns ?? 0) + 1)}`;
      for (const d of [dead, live, unknownNs, otherNs]) {
        await Deno.mkdir(d, { recursive: true });
        await Deno.writeTextFile(join(d, "partial"), "x");
      }
      await ensureElectronRuntime("9.9.8", "linux-x64", {
        fetch: rel.fetch,
        log: () => {},
      });
      assertEquals(
        await Deno.stat(dead).then(() => "kept", () => "removed"),
        "removed",
        "a dead launch's ~250 MB stage must not live forever",
      );
      assertEquals(
        await Deno.stat(live).then(() => "kept", () => "removed"),
        "kept",
        "a stage whose process is alive is never touched",
      );
      assertEquals(
        await Deno.stat(otherNs).then(() => "kept", () => "removed"),
        "kept",
        "another pid namespace's live unpack lost its stage",
      );
      assertEquals(
        await Deno.stat(unknownNs).then(() => "kept", () => "removed"),
        ns === undefined ? "removed" : "kept",
      );
    } finally {
      alive.kill("SIGKILL");
      await alive.status;
    }
  });
});

Deno.test("renameWithRetry: rides out a transient lock, throws anything else at once", async () => {
  let calls = 0;
  const flaky = (failures: number, err: () => Error) =>
    (() => {
      calls++;
      if (calls <= failures) return Promise.reject(err());
      return Promise.resolve();
    }) as typeof Deno.rename;
  // Antivirus holding the fresh electron.exe for a moment: retried, succeeds.
  calls = 0;
  await renameWithRetry("a", "b", {
    delayMs: 1,
    rename: flaky(3, () => new Deno.errors.PermissionDenied("in use")),
  });
  assertEquals(calls, 4);
  // A lock that never lets go: bounded, and the real error surfaces.
  calls = 0;
  await assertRejects(
    () =>
      renameWithRetry("a", "b", {
        delayMs: 1,
        tries: 5,
        rename: flaky(99, () => new Deno.errors.PermissionDenied("in use")),
      }),
    Deno.errors.PermissionDenied,
  );
  assertEquals(calls, 5);
  // Not a transient error: no retry.
  calls = 0;
  await assertRejects(
    () =>
      renameWithRetry("a", "b", {
        delayMs: 1,
        rename: flaky(99, () => new Deno.errors.NotFound("gone")),
      }),
    Deno.errors.NotFound,
  );
  assertEquals(calls, 1);
});

Deno.test("ensureElectronRuntime: a tampered zip is REFUSED, and nothing is cached", async () => {
  await isolated(async (tmp) => {
    const bytes = await tinyElectronZip(tmp);
    const rel = await fakeRelease(bytes, "9.9.9", "linux-x64", {
      corrupt: true,
    });
    await assertRejects(
      () =>
        ensureElectronRuntime("9.9.9", "linux-x64", {
          fetch: rel.fetch,
          log: () => {},
        }),
      Error,
      "integrity check FAILED",
    );
    const dir = electronRuntimeDir("9.9.9", "linux-x64");
    let stamped = true;
    try {
      await Deno.stat(join(dir, ".aio-complete"));
    } catch {
      stamped = false;
    }
    assertEquals(stamped, false, "a failed check leaves no usable runtime");
  });
});

Deno.test("ensureElectronRuntime: no checksums published → refuse, never run unverified native code", async () => {
  await isolated(async (tmp) => {
    const bytes = await tinyElectronZip(tmp);
    const rel = await fakeRelease(bytes, "9.9.9", "linux-x64", {
      noSums: true,
    });
    await assertRejects(
      () =>
        ensureElectronRuntime("9.9.9", "linux-x64", {
          fetch: rel.fetch,
          log: () => {},
        }),
      Error,
      "unverified",
    );
  });
});

Deno.test("ensureElectronRuntime: two concurrent installs download once and both get a working runtime", async () => {
  await isolated(async (tmp) => {
    const bytes = await tinyElectronZip(tmp);
    const rel = await fakeRelease(bytes, "9.9.9", "linux-x64");
    // A slow response widens the window the old code raced in: B's
    // `Deno.remove(dir, {recursive:true})` used to delete A's half-unpacked
    // tree, after which A stamped the wreckage as complete.
    const slow = ((url: string | URL | Request) =>
      new Promise<Response>((r) =>
        setTimeout(() =>
          r(rel.fetch(url) as unknown as Response), 120)
      ).then((x) => x)) as typeof fetch;
    const [a, b] = await Promise.all([
      ensureElectronRuntime("9.9.9", "linux-x64", {
        fetch: slow,
        log: () => {},
      }),
      ensureElectronRuntime("9.9.9", "linux-x64", {
        fetch: slow,
        log: () => {},
      }),
    ]);
    assertEquals(a, b);
    assertEquals(rel.zipFetches(), 1, "the loser of the race waits, not races");
    assert(
      (await Deno.stat(electronBinIn(a, "linux"))).isFile,
      "both callers got a runtime with its executable in place",
    );
    assert(
      await Deno.stat(join(a, ".aio-complete")).then(() => true),
      "…and a completion stamp",
    );
  });
});

Deno.test("ensureElectronRuntime: a failed download is a named error, not a half-cache", async () => {
  await isolated(async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response("nope", { status: 404, statusText: "Not Found" }),
      )) as typeof fetch;
    await assertRejects(
      () =>
        ensureElectronRuntime("0.0.0", "linux-x64", {
          fetch: fakeFetch,
          log: () => {},
        }),
      Error,
      "404",
    );
    let stamped = true;
    try {
      await Deno.stat(
        join(electronRuntimeDir("0.0.0", "linux-x64"), ".aio-complete"),
      );
    } catch {
      stamped = false;
    }
    assertEquals(stamped, false, "no completion stamp after a failure");
  });
});

Deno.test("findElectronBin (compiled): never runs deno install; fetches the BAKED version into the cache", async () => {
  await isolated(async (tmp) => {
    const dist = join(tmp, "dist");
    await Deno.mkdir(dist);
    await Deno.writeTextFile(
      join(dist, "electron.json"),
      '{"version":"41.2.3"}\n',
    );
    const runtime = join(tmp, "runtime");
    await touchElectronBin(runtime);
    let denoInstalls = 0;
    const fetched: [string, string][] = [];
    const bin = await findElectronBin(silent, {
      compiled: true,
      distDir: dist,
      denoInstall: () => {
        denoInstalls++;
        return Promise.resolve(true);
      },
      fetchRuntime: (v, slug) => {
        fetched.push([v, slug]);
        return Promise.resolve(runtime);
      },
    });
    assertEquals(bin, electronBinIn(runtime));
    assertEquals(denoInstalls, 0, "a compiled binary has no deno to run");
    assertEquals(fetched, [["41.2.3", electronSlug()]]);
  });
});

Deno.test("findElectronBin (compiled): no baked version → the framework default, and a failed fetch is null + a real error", async () => {
  await isolated(async () => {
    const errors: string[] = [];
    const log: Log = { info: () => {}, error: (m) => errors.push(m) };
    const fetched: string[] = [];
    const bin = await findElectronBin(log, {
      compiled: true,
      denoInstall: () => Promise.resolve(true),
      fetchRuntime: (v) => {
        fetched.push(v);
        return Promise.reject(new Error("offline"));
      },
    });
    assertEquals(bin, null);
    assertEquals(fetched, [DEFAULT_ELECTRON_VERSION]);
    assert(errors.some((e) => e.includes("offline")), errors.join("\n"));
    assert(
      errors.some((e) => e.includes("ELECTRON_PATH")),
      "names the escape hatch",
    );
    assert(
      !errors.some((e) => e.includes("install:electron")),
      "a compiled binary is never told to run a deno task",
    );
  });
});

Deno.test("findElectronBin (dev): deno install first, the fetched runtime as the last resort", async () => {
  await isolated(async (tmp) => {
    const runtime = join(tmp, "runtime");
    await touchElectronBin(runtime);
    await Deno.writeTextFile(join(tmp, "deno.json"), "{}");
    const order: string[] = [];
    const bin = await findElectronBin(silent, {
      compiled: false,
      denoInstall: () => {
        order.push("deno-install");
        return Promise.resolve(false); // npm unreachable
      },
      fetchRuntime: () => {
        order.push("fetch");
        return Promise.resolve(runtime);
      },
    });
    assertEquals(order, ["deno-install", "fetch"]);
    assertEquals(bin, electronBinIn(runtime));
  });
});

Deno.test("findElectronBin: a shipped package finds the Electron it ALREADY carries", async () => {
  // The zips build-electron.ts writes put the runtime in ./electron/ beside the
  // executable, and the README says to double-click the .exe — which skips the
  // run.bat that exports $ELECTRON_PATH. Nothing looked there, so a package
  // with a 100 MB runtime inside it downloaded a second one, and offline it
  // said "Electron is not available on this machine".
  const exe = join("/opt/myapp", "myapp.exe");
  assertEquals(packagedElectronCandidates(exe, "windows"), [
    join("/opt/myapp", "electron", "electron.exe"),
  ]);
  assertEquals(packagedElectronCandidates("/opt/myapp/myapp", "linux"), [
    join("/opt/myapp", "electron", "electron"),
  ]);
  // macOS: the bundle's own link first (tests/electron-mac-bundle-window.test.ts
  // says why), then the runtime it points at.
  assertEquals(packagedElectronCandidates("/opt/myapp/myapp", "darwin"), [
    join("/opt/myapp", MAC_WINDOW_LINK),
    join(
      "/opt/myapp",
      "electron",
      "Electron.app",
      "Contents",
      "MacOS",
      "Electron",
    ),
  ]);

  await isolated(async (tmp) => {
    // A packaged layout: the executable, and the runtime beside it.
    const shipped = join(tmp, "electron");
    const bin = electronBinIn(shipped, Deno.build.os);
    await Deno.mkdir(join(bin, ".."), { recursive: true });
    await Deno.writeTextFile(bin, "#!/bin/sh\nexit 0\n");
    if (Deno.build.os !== "windows") await Deno.chmod(bin, 0o755);
    // A fetch here would be the bug: it must never be reached.
    const found = await findElectronBin(silent, {
      compiled: true,
      execPath: join(tmp, "myapp"),
      fetchRuntime: () => {
        throw new Error("must not download — the package ships one");
      },
    });
    assertEquals(found, bin);
  });
});

Deno.test("launch label: names the rung the binary came from, not what its path looks like", () => {
  // A macOS bundle and a double-clicked Windows exe set no $ELECTRON_PATH and
  // run the runtime they ship. Both used to log "$ELECTRON_PATH", because the
  // label was read off the path: no "dist" in it, so not "packaged".
  const mac = "/Applications/Counter.app/Contents/MacOS/counter";
  const macBin = packagedElectronCandidates(mac, "darwin")[0]!;
  assertEquals(
    electronSource(
      macBin,
      undefined,
      packagedElectronCandidates(mac, "darwin"),
    ),
    "packaged",
  );
  const win = join("C:", "Apps", "counter", "counter.exe");
  const winBin = packagedElectronCandidates(win, "windows")[0]!;
  assertEquals(
    electronSource(
      winBin,
      undefined,
      packagedElectronCandidates(win, "windows"),
    ),
    "packaged",
  );
  // The Linux AppRun really does export the variable — at the same file.
  const lin = packagedElectronCandidates("/tmp/.mount_x/counter", "linux");
  assertEquals(electronSource(lin[0]!, lin[0], lin), "$ELECTRON_PATH");
  // An override somewhere else entirely — a directory called dist included,
  // which used to read as "packaged".
  assertEquals(
    electronSource("/srv/dist/electron", "/srv/dist/electron", lin),
    "$ELECTRON_PATH",
  );
  // A variable that is set but was NOT the binary taken names nothing.
  assertEquals(electronSource(lin[0]!, "/missing/electron", lin), "packaged");
  // Dev: the npm shim, both spellings.
  assertEquals(
    electronSource("node_modules/.bin/electron", undefined, lin),
    "dev",
  );
  assertEquals(
    electronSource("node_modules\\.bin\\electron.cmd", undefined, []),
    "dev",
  );
  // The per-user cache — a fetched or carried runtime; a path with "dist" or
  // "node_modules" above it changes nothing.
  assertEquals(
    electronSource(
      "/home/u/dist/node_modules/.cache/aio/tools/electron/44.4.1-linux-x64/electron",
      undefined,
      lin,
    ),
    "cache",
  );
});

// ── the CROSS-PLATFORM runtime: whose executable name? ───────────────────────
//
// `platforms.ts` says, in as many words, that "Windows and macOS packages
// cross-build fine from here", and `build/electron-runtime.ts` exists entirely
// to fetch the OTHER platform's runtime. Neither could work: every check in
// the fetcher asked `electronBinIn(dir)`, which defaults to the HOST's os. So
// a Linux box downloading `win32-x64` verified the bytes, unpacked
// `electron.exe`, looked for `electron`, and threw
//   "electron-v…-win32-x64.zip unpacked without <runtime>/electron in it —
//    the archive is not an Electron runtime for win32-x64"
// — the build blaming Electron's release for its own host assumption, and
// `deno task build --targets=electron --platforms=windows` dead on every host.
//
// Every existing test here fetched `linux-x64` on a Linux CI box, i.e. the
// host slug, which is precisely the one case the bug does not touch.

Deno.test("electronOsFromSlug: the exact inverse of electronSlug, for every platform", () => {
  for (
    const build of [
      { os: "linux", arch: "x86_64" },
      { os: "linux", arch: "aarch64" },
      { os: "darwin", arch: "x86_64" },
      { os: "darwin", arch: "aarch64" },
      { os: "windows", arch: "x86_64" },
    ]
  ) {
    assertEquals(
      electronOsFromSlug(electronSlug(build)),
      build.os,
      `${build.os}/${build.arch} must round-trip through its release slug`,
    );
  }
  // Anything unrecognized falls to linux, matching electronSlug's own default.
  assertEquals(electronOsFromSlug("freebsd-x64"), "linux");
});

Deno.test("ensureElectronRuntime: a FOREIGN platform's runtime unpacks, verifies and caches", async () => {
  // Both non-host shapes, together, because they fail differently: Windows
  // renames the binary and macOS buries it inside a bundle.
  for (
    const [slug, entry] of [
      ["win32-x64", "electron.exe"],
      ["darwin-arm64", "Electron.app/Contents/MacOS/Electron"],
    ] as const
  ) {
    await isolated(async (tmp) => {
      const bytes = await tinyElectronZip(tmp, entry);
      const rel = await fakeRelease(bytes, "9.9.9", slug);
      const dir = await ensureElectronRuntime("9.9.9", slug, {
        fetch: rel.fetch,
        log: () => {},
      });
      assertEquals(dir, electronRuntimeDir("9.9.9", slug));
      const bin = electronBinIn(dir, electronOsFromSlug(slug));
      assert(
        (await Deno.stat(bin)).isFile,
        `${slug}: the runtime's own executable (${entry}) must be found`,
      );
      // …and the CACHE check has to agree, or every build re-downloads 100 MB
      // (and, worse, races itself doing so).
      await ensureElectronRuntime("9.9.9", slug, {
        fetch: rel.fetch,
        log: () => {},
      });
      assertEquals(rel.zipFetches(), 1, `${slug}: a cached runtime is reused`);
    });
  }
});

Deno.test("ensureElectronRuntime: an archive missing the TARGET's binary is still refused", async () => {
  // The guard must stay a guard: a linux zip served for the windows slug is
  // not a windows runtime, and saying so is the whole reason the check exists.
  await isolated(async (tmp) => {
    const bytes = await tinyElectronZip(tmp, "electron");
    const rel = await fakeRelease(bytes, "9.9.9", "win32-x64");
    const e = await assertRejects(() =>
      ensureElectronRuntime("9.9.9", "win32-x64", {
        fetch: rel.fetch,
        log: () => {},
      })
    );
    assert(
      String(e).includes("electron.exe"),
      `the refusal must name the file it looked for: ${e}`,
    );
  });
});

// ── the spawn-handle retry (real Windows 11, 2026-09-17) ─────────────────────
//
// A `deno compile --no-terminal` GUI exe double-clicked has NO console, so the
// inherited stdout handle is invalid and `Deno.Command(...).spawn()` throws
// `TypeError: Failed to spawn 'electron.exe': Invalid handle` — before Electron
// is ever reached, so the window never opened. The retry (spawn with the std
// handles discarded) is the fix; these pin the predicate that gates it, so an
// unrelated failure is never retried into silence.

Deno.test("isInvalidHandleError: only Windows' no-console inherit failure", () => {
  const thrown = () =>
    new TypeError(
      "Failed to spawn 'C:\\app\\electron.exe': Invalid handle",
    );
  assertEquals(isInvalidHandleError(thrown(), "windows"), true);
  // Off Windows the same message is a different problem: never retried.
  assertEquals(isInvalidHandleError(thrown(), "linux"), false);
  assertEquals(isInvalidHandleError(thrown(), "darwin"), false);
  // A non-TypeError, or a TypeError without the phrase, is not this bug.
  assertEquals(
    isInvalidHandleError(new Error("Invalid handle"), "windows"),
    false,
  );
  assertEquals(
    isInvalidHandleError(
      new TypeError("Failed to spawn: access denied"),
      "windows",
    ),
    false,
  );
  assertEquals(isInvalidHandleError("Invalid handle", "windows"), false);
  assertEquals(isInvalidHandleError(null, "windows"), false);
});

/** A pid that WAS a process and is not any more, and one that is alive
 *  until `stop()`. */
async function deadAndLivePids(): Promise<
  { dead: number; live: number; stop: () => Promise<void> }
> {
  const exe = Deno.execPath();
  const gone = new Deno.Command(exe, { args: ["eval", ""], stdout: "null" })
    .spawn();
  await gone.status;
  const child = new Deno.Command(exe, {
    args: ["eval", "setTimeout(() => {}, 60_000)"],
    stdout: "null",
    stderr: "null",
  }).spawn();
  return {
    dead: gone.pid,
    live: child.pid,
    stop: async () => {
      child.kill();
      await child.status;
    },
  };
}

Deno.test("runtime lock: a waiter never deletes a lock taken after it judged the old one dead", async () => {
  // Two launches wait on a dead download's lock. A judges it dead, removes
  // it, takes it; B judged the SAME dead owner a moment before, and its
  // removal used to land on A's fresh lock — two downloads unpacking into
  // one runtime dir. Simulated: the lock changes hands right after B's read.
  const tmp = await tempDir("electron-lock-");
  const { dead, live, stop } = await deadAndLivePids();
  const lock = join(tmp, "rt.lock");
  await Deno.writeTextFile(lock, `${dead}`);
  const sync = Deno.readTextFileSync, async_ = Deno.readTextFile;
  let swapped = false;
  const swap = (p: string | URL, was: string) => {
    if (!swapped && String(p) === lock) {
      swapped = true;
      Deno.removeSync(lock); // A: took over the dead lock …
      Deno.writeTextFileSync(lock, `${live}`, { createNew: true }); // … holds it
    }
    return was;
  };
  Deno.readTextFileSync = (p) => swap(p, sync(p));
  Deno.readTextFile = async (p, o) => swap(p, await async_(p, o));
  try {
    const held = await _withRuntimeLock(lock, (h) => {
      assertEquals(sync(lock), `${live}`, "the live holder's lock survives");
      return Promise.resolve(h);
    }, 600);
    assertEquals(held, false, "B never believes it holds A's lock");
    assertEquals(sync(lock), `${live}`);
  } finally {
    Deno.readTextFileSync = sync;
    Deno.readTextFile = async_;
    await stop();
    await dropTempDir(tmp);
  }
});

Deno.test("runtime lock: a dead holder's lock is taken over at once and released after", async () => {
  const tmp = await tempDir("electron-lock-");
  const { dead, stop } = await deadAndLivePids();
  await stop();
  const lock = join(tmp, "rt.lock");
  await Deno.writeTextFile(lock, `${dead}`);
  try {
    const t0 = Date.now();
    const held = await _withRuntimeLock(lock, (h) => {
      assertEquals(Deno.readTextFileSync(lock), `${Deno.pid}`);
      return Promise.resolve(h);
    }, 60_000);
    assertEquals(held, true);
    assert(Date.now() - t0 < 5_000, "taken over, not waited out");
    assertEquals(await Deno.stat(lock).then(() => true, () => false), false);
  } finally {
    await dropTempDir(tmp);
  }
});

// A new container or flatpak sandbox (bwrap --unshare-pid) has a NEW pid
// namespace: a launch killed mid-download left a lock every later launch
// waited 15 min on, then threw. Watched untouched for `staleMs` (2 min), it
// is taken over; one a live holder heartbeats is still waited on.
Deno.test({
  name:
    "runtime lock: another namespace's lock untouched for 2 min is taken over",
  ignore: ownPidNs() === undefined,
  fn: async () => {
    const tmp = await tempDir("electron-lock-");
    const lock = join(tmp, "rt.lock");
    const ns = ((ownPidNs()! ^ 1) >>> 0).toString(16).padStart(8, "0");
    const was = { ..._lockTiming };
    _lockTiming.staleMs = 1_000;
    try {
      await Deno.writeTextFile(lock, "1");
      await Deno.writeTextFile(`${lock}.id`, `1-d${ns}a10`);
      assertEquals(
        await _withRuntimeLock(lock, (h) => Promise.resolve(h), 600),
        false,
      );
      const old = new Date(Date.now() - 3 * 60_000);
      await Deno.utime(lock, old, old);
      const t0 = Date.now();
      const held = await _withRuntimeLock(lock, (h) => {
        assertEquals(Deno.readTextFileSync(lock), `${Deno.pid}`);
        return Promise.resolve(h);
      }, 60_000);
      assertEquals(held, true);
      assert(Date.now() - t0 < 5_000, "taken over, not waited out");
      assertEquals(await Deno.stat(lock).then(() => true, () => false), false);
    } finally {
      Object.assign(_lockTiming, was);
      await dropTempDir(tmp);
    }
  },
});

Deno.test("runtime lock: the give-up error names the lock file to delete", async () => {
  const { live, stop } = await deadAndLivePids();
  try {
    await isolated(async () => {
      const dir = electronRuntimeDir("9.9.9", "linux-x64");
      await Deno.mkdir(join(dir, ".."), { recursive: true });
      await Deno.writeTextFile(`${dir}.lock`, `${live}`); // a live downloader
      const err = await assertRejects(
        () =>
          ensureElectronRuntime("9.9.9", "linux-x64", {
            fetch: () => Promise.reject(new Error("never fetched")),
            log: () => {},
            lockWaitMs: 300,
          }),
        Error,
        "is still alive",
      );
      assertStringIncludes(err.message, `delete ${dir}.lock`);
    });
  } finally {
    await stop();
  }
});

// A live holder in another pid namespace heartbeats its lock, so a waiter
// there never takes it however long the hold; the heartbeat stops on release.
Deno.test({
  name:
    "pid lock: a live holder's heartbeat keeps a foreign waiter off; it stops on release",
  ignore: ownPidNs() === undefined,
  fn: async () => {
    const tmp = await tempDir("electron-lock-");
    const lock = join(tmp, "rt.lock");
    const was = { ..._lockTiming };
    Object.assign(_lockTiming, { heartbeatMs: 50, staleMs: 300 });
    const ns = ((ownPidNs()! ^ 1) >>> 0).toString(16).padStart(8, "0");
    let idWas = "";
    const warn = console.warn;
    console.warn = () => {}; // our own heartbeat: "taken over" — by design
    try {
      await _withRuntimeLock(lock, async (held) => {
        assertEquals(held, true);
        idWas = await Deno.readTextFile(`${lock}.id`);
        // As a waiter in another namespace sees it: pid 1 over there.
        await Deno.writeTextFile(lock, "1");
        await Deno.writeTextFile(`${lock}.id`, `1-d${ns}a10`);
        const beat = keepFresh(lock); // that holder's heartbeat, not ours
        const until = Date.now() + 1_000;
        while (Date.now() < until) {
          const r = tryPidLock(lock);
          assertEquals(r.held || r.retry, false, "took a live holder's lock");
          await new Promise((r) => setTimeout(r, 20));
        }
        beat();
        assertEquals(await Deno.readTextFile(lock), "1");
        await Deno.writeTextFile(lock, String(Deno.pid)); // ours again
        await Deno.writeTextFile(`${lock}.id`, idWas);
      }, 5_000);
      console.warn = warn;
      assertEquals(await Deno.stat(lock).then(() => true, () => false), false);
      // Released: nothing touches a new file at that path any more.
      await Deno.writeTextFile(lock, "x");
      const old = new Date(Date.now() - 60_000);
      await Deno.utime(lock, old, old);
      await new Promise((r) => setTimeout(r, 250));
      assertEquals((await Deno.stat(lock)).mtime!.getTime(), old.getTime());
    } finally {
      console.warn = warn;
      Object.assign(_lockTiming, was);
      await dropTempDir(tmp);
    }
  },
});

Deno.test("pid lock: holderAlive — dead, live, recycled, our own pid, another namespace", async () => {
  const { dead, live, stop } = await deadAndLivePids();
  try {
    assertEquals(holderAlive({ pid: dead }, false), false);
    assertEquals(holderAlive({ pid: live }, false), true);
    // Our own pid is alive only while THIS process holds the lock.
    assertEquals(holderAlive({ pid: Deno.pid }, true), true);
    assertEquals(holderAlive({ pid: Deno.pid }, false), false);
    // A live pid whose recorded start differs: recycled, so dead.
    if (Deno.build.os === "linux") {
      assertEquals(holderAlive({ pid: live, startToken: "1" }, false), false);
    }
    // Written in another pid namespace: never judged dead from here.
    const ns = ownPidNs();
    if (ns !== undefined) {
      assertEquals(holderAlive({ pid: dead, ns: ns ^ 1 }, false), true);
      assertEquals(holderAlive({ pid: dead, ns }, false), false);
      // …until THIS process watched the file it holds sit untouched for
      // `staleMs` — an old mtime alone (a suspend, a lagging host clock) is
      // no evidence.
      const tmp = await tempDir("electron-lock-");
      const was = { ..._lockTiming };
      _lockTiming.staleMs = 200;
      try {
        const f = join(tmp, "held");
        await Deno.writeTextFile(f, "1");
        const old = new Date(Date.now() - 3 * 60_000);
        await Deno.utime(f, old, old);
        assertEquals(holderAlive({ pid: dead, ns: ns ^ 1 }, false, f), true);
        await new Promise((r) => setTimeout(r, 250));
        assertEquals(holderAlive({ pid: dead, ns: ns ^ 1 }, false, f), false);
      } finally {
        Object.assign(_lockTiming, was);
        await dropTempDir(tmp);
      }
    }
  } finally {
    await stop();
  }
});

// Host suspend / `docker pause` / a lagging clock on a shared NFS volume: a
// LIVE holder's lock in another namespace carries an mtime far older than
// `staleMs` by the waiter's wall clock, and the waiter took it at once — both
// then ran. Staleness is only what this waiter watched on its own monotonic
// clock; a heartbeat starts the watch over.
Deno.test({
  name:
    "pid lock: an old mtime is never stale to a waiter that has not watched it that long",
  ignore: ownPidNs() === undefined,
  fn: async () => {
    const tmp = await tempDir("electron-lock-");
    const lock = join(tmp, "rt.lock");
    const was = { ..._lockTiming };
    _lockTiming.staleMs = 400;
    const ns = ((ownPidNs()! ^ 1) >>> 0).toString(16).padStart(8, "0");
    const hour = new Date(Date.now() - 3_600_000);
    const tries = async (ms: number) => {
      const until = performance.now() + ms;
      while (performance.now() < until) {
        const r = tryPidLock(lock);
        if (r.held || r.retry) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    };
    try {
      await Deno.writeTextFile(lock, "1");
      await Deno.writeTextFile(`${lock}.id`, `1-d${ns}a10`);
      await Deno.utime(lock, hour, hour);
      assertEquals(await tries(300), false, "took a suspended holder's lock");
      // The holder resumes and heartbeats: the watch starts over.
      const now = new Date();
      await Deno.utime(lock, now, now);
      assertEquals(await tries(300), false, "a heartbeat did not reset it");
      // Untouched for staleMs of OUR watching: dead, taken over.
      assertEquals(await tries(1_000), true);
    } finally {
      releasePidLock(lock);
      Object.assign(_lockTiming, was);
      await dropTempDir(tmp);
    }
  },
});

// A holder whose lock was taken over (it looked dead: paused, suspended)
// deleted the NEW holder's lock on release — and a third process got in.
Deno.test("pid lock: a release after a take-over leaves the new holder's lock", async () => {
  const tmp = await tempDir("electron-lock-");
  const lock = join(tmp, "rt.lock");
  const warn = console.warn, said: string[] = [];
  console.warn = (m: string) => said.push(m);
  try {
    assertEquals(tryPidLock(lock).held, true);
    // B took it over: pid 1 in another namespace (or any other owner).
    await Deno.writeTextFile(lock, "1");
    await Deno.writeTextFile(`${lock}.id`, "1-d0badf00da10");
    releasePidLock(lock);
    assertEquals(await Deno.readTextFile(lock), "1");
    assertEquals(await Deno.readTextFile(`${lock}.id`), "1-d0badf00da10");
    assertStringIncludes(said.join("\n"), "taken over");
    // Same pid, another stamp (two containers' pid 1): still not ours.
    await Deno.remove(`${lock}.id`);
    await Deno.remove(lock);
    assertEquals(tryPidLock(lock).held, true);
    await Deno.writeTextFile(`${lock}.id`, `${Deno.pid}-d0badf00da10`);
    releasePidLock(lock);
    assertEquals(await Deno.readTextFile(lock), String(Deno.pid));
    // Our own lock, untouched: released.
    await Deno.remove(`${lock}.id`);
    await Deno.remove(lock);
    assertEquals(tryPidLock(lock).held, true);
    said.length = 0;
    releasePidLock(lock);
    assertEquals(await Deno.stat(lock).then(() => true, () => false), false);
    assertEquals(
      await Deno.stat(`${lock}.id`).then(() => true, () => false),
      false,
    );
    assertEquals(said, []);
  } finally {
    console.warn = warn;
    await dropTempDir(tmp);
  }
});

// Two containers sharing one cache are both pid 1: `<dir>.incoming.<pid>`
// was the SAME stage for both, so one unpack wiped the other's.
Deno.test("electron runtime: a stage name is unique per unpack, and still a stage", () => {
  const a = stageTag(), b = stageTag();
  assert(a !== b, "two unpackers with one pid share a stage");
  assert(a.startsWith(`${Deno.pid}-`));
  assertEquals(cacheEntryKind(`44.4.1-linux-x64.incoming.${a}`), "stage");
  assertEquals(cacheEntryKind("44.4.1-linux-x64.incoming.31337"), "stage");
});

// A holder whose lock was taken over kept heartbeating it — the NEW holder's
// lock — so once that one died its lock looked alive for as long as the old
// holder ran. The heartbeat stops at the first tick that finds it not ours.
Deno.test("pid lock: the heartbeat never refreshes a lock that is no longer ours", async () => {
  const tmp = await tempDir("electron-lock-");
  const lock = join(tmp, "rt.lock");
  const was = { ..._lockTiming };
  _lockTiming.heartbeatMs = 30;
  const warn = console.warn, said: string[] = [];
  console.warn = (m: string) => said.push(m);
  try {
    assertEquals(tryPidLock(lock).held, true);
    await Deno.writeTextFile(lock, "1");
    await Deno.writeTextFile(`${lock}.id`, "1-d0badf00da10");
    const old = new Date(Date.now() - 60_000);
    await Deno.utime(lock, old, old);
    await new Promise((r) => setTimeout(r, 200));
    assertEquals((await Deno.stat(lock)).mtime!.getTime(), old.getTime());
    releasePidLock(lock);
    assertEquals(await Deno.readTextFile(lock), "1");
    assertEquals(said.filter((m) => m.includes("taken over")).length, 1);
  } finally {
    console.warn = warn;
    Object.assign(_lockTiming, was);
    await dropTempDir(tmp);
  }
});

// A stage whose pid proves nothing — pid 1 in another container, or our own
// pid left by a previous run in one — lived forever (~250 MB each). Untouched
// for STAGE_STALE_MS it is a dead unpack's; a heartbeated one is kept.
Deno.test("ensureElectronRuntime: an old stage whose pid proves nothing is removed; a fresh one is not", async () => {
  await isolated(async (tmp) => {
    const bytes = await tinyElectronZip(tmp);
    const rel = await fakeRelease(bytes, "9.9.7", "linux-x64");
    const dir = electronRuntimeDir("9.9.7", "linux-x64");
    // A live process that is not this one (not pid 1: Windows has none).
    const alive = sleeper({ stdout: "null", stderr: "null" });
    try {
      const oldForeign = `${dir}.incoming.${alive.pid}-0badf00d`;
      const oldOwnPid = `${dir}.incoming.${Deno.pid}-0badf00d`;
      const fresh = `${dir}.incoming.${alive.pid}-cafe0123`;
      const old = new Date(Date.now() - STAGE_STALE_MS - 60_000);
      for (const d of [oldForeign, oldOwnPid, fresh]) {
        await Deno.mkdir(d, { recursive: true });
        await Deno.writeTextFile(join(d, "partial"), "x");
      }
      await Deno.utime(oldForeign, old, old);
      await Deno.utime(oldOwnPid, old, old);
      await ensureElectronRuntime("9.9.7", "linux-x64", {
        fetch: rel.fetch,
        log: () => {},
      });
      const there = (p: string) =>
        Deno.stat(p).then(() => "kept", () => "removed");
      assertEquals(await there(oldForeign), "removed");
      assertEquals(await there(oldOwnPid), "removed");
      assertEquals(await there(fresh), "kept", "a live unpack's stage");
    } finally {
      alive.kill("SIGKILL");
      await alive.status;
    }
  });
});

// Another unpacker judges a stage whose pid proves nothing by its mtime: a
// long unpack (a slow link, a 250 MB zip) must keep refreshing its own, or
// after STAGE_STALE_MS it reads as a dead unpack's and is deleted under it.
Deno.test("ensureElectronRuntime: a long unpack heartbeats its stage", async () => {
  await isolated(async (tmp) => {
    const bytes = await tinyElectronZip(tmp);
    const rel = await fakeRelease(bytes, "9.9.6", "linux-x64");
    const dir = electronRuntimeDir("9.9.6", "linux-x64");
    const was = { ..._lockTiming };
    _lockTiming.heartbeatMs = 30;
    let release!: () => void;
    const gate = new Promise<void>((r) => release = r);
    const slow = (async (url: string | URL | Request) => {
      if (String(url).endsWith(".zip")) await gate; // the download stalls
      return rel.fetch(url);
    }) as typeof fetch;
    try {
      const run = ensureElectronRuntime("9.9.6", "linux-x64", {
        fetch: slow,
        log: () => {},
      });
      const prefix = `${basename(dir)}.incoming.`;
      let stage: string | undefined;
      for (let i = 0; i < 200 && !stage; i++) {
        await new Promise((r) => setTimeout(r, 10));
        const ls = await Array.fromAsync(Deno.readDir(dirname(dir))).catch(
          () => [],
        );
        for (const e of ls) {
          if (e.isDirectory && e.name.startsWith(prefix)) {
            stage = join(dirname(dir), e.name);
          }
        }
      }
      assert(stage, "the unpack never staged");
      const old = new Date(Date.now() - STAGE_STALE_MS - 60_000);
      await Deno.utime(stage, old, old);
      await new Promise((r) => setTimeout(r, 200)); // several beats
      const m = (await Deno.stat(stage)).mtime!.getTime();
      release();
      await run;
      assert(
        Date.now() - m < STAGE_STALE_MS,
        "a live unpack's stage went stale — the next unpacker deletes it",
      );
    } finally {
      release?.();
      Object.assign(_lockTiming, was);
    }
  });
});

Deno.test("findElectronBin (dev): a directory that is not a project is never installed into — the cached runtime, and it says so", async () => {
  // `deno install npm:electron` creates a deno.json where it runs. An app
  // started from a directory that is not its project (a login item starts in
  // the home directory) left one there on every launch.
  for (const config of ["deno.json", "deno.jsonc", "package.json", null]) {
    await isolated(async (tmp) => {
      const runtime = join(tmp, "runtime");
      await touchElectronBin(runtime);
      if (config) await Deno.writeTextFile(join(tmp, config), "{}");
      const order: string[] = [];
      const said: string[] = [];
      const bin = await findElectronBin(
        { info: (m) => said.push(m), error: () => {} },
        {
          compiled: false,
          denoInstall: () => {
            order.push("deno-install");
            return Promise.resolve(false);
          },
          fetchRuntime: () => {
            order.push("fetch");
            return Promise.resolve(runtime);
          },
        },
      );
      assertEquals(bin, electronBinIn(runtime));
      assertEquals(
        order,
        config ? ["deno-install", "fetch"] : ["fetch"],
        `${config}`,
      );
      assertEquals(
        said.some((m) => m.includes("is not a project")),
        config === null,
        `${config}`,
      );
    });
  }
});

// ── The launcher never installs into the framework's own checkout ───────────
//
// `deno install npm:electron@…` run with the cwd in a clean checkout of the
// framework added an `electron` import to its tracked deno.json and rewrote
// deno.lock — reached by `deno task amui` or an Electron test from the
// checkout — and a dirty tree is what `am upgrade` refuses to run over.

Deno.test("installRefusal: an app project installs; a non-project and the framework's own checkout do not — and an app that vendors the framework still does", async () => {
  const tmp = await tempDir("install-refusal-");
  try {
    const dir = async (name: string, files: Record<string, string>) => {
      const d = join(tmp, name);
      await Deno.mkdir(d, { recursive: true });
      for (const [f, text] of Object.entries(files)) {
        await Deno.mkdir(dirname(join(d, f)), { recursive: true });
        await Deno.writeTextFile(join(d, f), text);
      }
      return d;
    };
    const elsewhere = await dir("elsewhere", {});
    const FRAMEWORK = /^is the aio framework's own checkout/;
    const NOT_PROJECT = "is not a project (no deno.json or package.json)";
    // An app: any of the configs `deno install` adds a dependency to.
    for (const cfg of ["deno.json", "deno.jsonc", "package.json"]) {
      const app = await dir(`app-${cfg}`, { [cfg]: '{ "name": "my-app" }' });
      assertEquals(await installRefusal(app, elsewhere), null, cfg);
    }
    // A config that cannot be parsed is still a project (the install says so).
    const broken = await dir("broken", { "deno.json": "{ not json" });
    assertEquals(await installRefusal(broken, elsewhere), null);
    // No config at all.
    assertEquals(await installRefusal(elsewhere, null), NOT_PROJECT);
    // The framework's own checkout, known by its package name — whichever
    // copy of the framework is doing the asking…
    const named = await dir("checkout", {
      "deno.jsonc": '{\n  // the framework\n  "name": "@riagentic/aio"\n}',
    });
    assertMatch((await installRefusal(named, elsewhere))!, FRAMEWORK);
    assertMatch((await installRefusal(named, null))!, FRAMEWORK);
    // …and by being the directory this module was loaded from, whatever its
    // config is called (a fork that renamed the package) — through a link too.
    const fork = await dir("fork", { "deno.json": '{ "name": "@me/fork" }' });
    assertMatch((await installRefusal(fork, fork))!, FRAMEWORK);
    if (Deno.build.os !== "windows") {
      await Deno.symlink(fork, join(tmp, "fork-link"));
      assertMatch(
        (await installRefusal(join(tmp, "fork-link"), fork))!,
        FRAMEWORK,
      );
    }
    // An app that VENDORS the framework under dep/aio, started from the app:
    // the cwd is the app's — it installs into the app as before.
    const vendoring = await dir("vendoring", {
      "deno.json": '{ "name": "my-app" }',
      "dep/aio/deno.json": '{ "name": "@riagentic/aio" }',
    });
    assertEquals(
      await installRefusal(vendoring, join(vendoring, "dep", "aio")),
      null,
    );
    // …and the real thing: this very checkout is refused.
    assertEquals(
      await installRefusal(fromFileUrl(new URL("../", import.meta.url))),
      FRAMEWORK_CHECKOUT,
    );
    // A BUILD asks about the root it builds, whatever the cwd is (this test
    // runs with its cwd in the framework's checkout): root = the checkout is
    // refused, root = an app is not.
    assertEquals(await installRefusal(named, null), FRAMEWORK_CHECKOUT);
    assertEquals(await installRefusal(vendoring, null), null);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("findElectronBin (dev): from the framework's own checkout nothing is installed — the cached runtime, and the line says which case it is", async () => {
  // Both install rungs: no node_modules at all, and a node_modules that
  // holds another Electron than the tested one.
  for (const stale of [false, true]) {
    await isolated(async (tmp) => {
      await Deno.writeTextFile(
        join(tmp, "deno.json"),
        '{ "name": "@riagentic/aio" }',
      );
      if (stale) {
        const pkg = join(tmp, "node_modules", "electron");
        await Deno.mkdir(join(pkg, "dist"), { recursive: true });
        await Deno.mkdir(join(tmp, "node_modules", ".bin"));
        await Deno.writeTextFile(join(pkg, "dist", "electron"), "");
        await Deno.writeTextFile(join(pkg, "dist", "version"), "1.2.3");
        await Deno.writeTextFile(join(pkg, "path.txt"), "electron");
        await Deno.writeTextFile(
          join(pkg, "package.json"),
          '{ "name": "electron", "version": "1.2.3" }',
        );
        await Deno.writeTextFile(
          join(tmp, "node_modules", ".bin", "electron"),
          "",
        );
      }
      const runtime = join(tmp, "runtime");
      await touchElectronBin(runtime);
      const order: string[] = [];
      const said: string[] = [];
      const bin = await findElectronBin(
        { info: (m) => said.push(m), error: (m) => said.push(m) },
        {
          compiled: false,
          denoInstall: () => {
            order.push("deno-install");
            return Promise.resolve(false);
          },
          fetchRuntime: () => {
            order.push("fetch");
            return Promise.resolve(runtime);
          },
        },
      );
      assertEquals(order, ["fetch"], `stale=${stale}: ${said.join(" | ")}`);
      assertEquals(bin, electronBinIn(runtime));
      const line = said.find((m) => m.includes("not installing into it"));
      assert(line, said.join(" | "));
      assertStringIncludes(line, "is the aio framework's own checkout");
      assert(!line.includes("is not a project"), line);
      assertEquals(
        [...Deno.readDirSync(tmp)].map((e) => e.name).filter((n) =>
          n !== "runtime" && n !== "cache" && n !== "node_modules"
        ),
        ["deno.json"],
      );
    });
  }
});
