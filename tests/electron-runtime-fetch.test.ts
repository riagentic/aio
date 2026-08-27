// A compiled desktop binary fetches its own Electron — the field report:
// an app installed by the one-liner opened nothing because its launcher
// looked for `node_modules/.bin/electron` under the CURRENT DIRECTORY and then
// "auto-installed" by running `Deno.execPath() install npm:electron`, which in
// a compiled binary is the app itself. The user had to go back to the source
// tree, run `deno task install:electron` by hand, and start the binary from
// there. These tests pin the resolution order and the fetch, without a
// display and without a 100 MB download.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
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
  shasumFor,
  toolCacheDir,
} from "../src/electron/electron-runtime-fetch.ts";
import {
  findElectronBin,
  packagedElectronCandidates,
} from "../src/electron/electron-spawn.ts";
import {
  electronCacheDir,
  resolveElectronVersion,
} from "../src/build/electron-runtime.ts";
import type { Log } from "../src/electron/electron-shared.ts";

const silent: Log = { info: () => {}, error: () => {} };

/** Run `fn` in an empty cwd with a private cache — steps 2/3 of the launcher
 *  stat RELATIVE paths, and this repo has a node_modules/.bin/electron. */
async function isolated<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = await Deno.makeTempDir({ prefix: "electron-fetch-" });
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
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
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
  assertEquals(electronBinIn("/r", "linux"), "/r/electron");
  assertEquals(electronBinIn("/r", "windows"), "/r/electron.exe");
  assertEquals(
    electronBinIn("/r", "darwin"),
    "/r/Electron.app/Contents/MacOS/Electron",
  );
});

Deno.test("bakedElectronVersion: reads dist/electron.json, null for anything else", async () => {
  const tmp = await Deno.makeTempDir();
  assertEquals(await bakedElectronVersion(undefined), null);
  assertEquals(await bakedElectronVersion(tmp), null, "no file");
  await Deno.writeTextFile(join(tmp, "electron.json"), '{"version":""}');
  assertEquals(await bakedElectronVersion(tmp), null, "empty is not a version");
  await Deno.writeTextFile(join(tmp, "electron.json"), '{"version":"43.4.1"}');
  assertEquals(await bakedElectronVersion(tmp), "43.4.1");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("resolveElectronVersion: installed > import-map spec > default — never null", async () => {
  const tmp = await Deno.makeTempDir();
  assertEquals(await resolveElectronVersion(tmp), DEFAULT_ELECTRON_VERSION);
  await Deno.writeTextFile(
    join(tmp, "deno.json"),
    '{"imports":{"electron":"npm:electron"}}',
  );
  assertEquals(
    await resolveElectronVersion(tmp),
    DEFAULT_ELECTRON_VERSION,
    "a bare npm:electron pins nothing",
  );
  await Deno.writeTextFile(
    join(tmp, "deno.json"),
    '{"imports":{"electron":"npm:electron@^43.4.1"}}',
  );
  assertEquals(await resolveElectronVersion(tmp), "43.4.1");
  // An installed runtime wins over the spec: what dev runs is what ships.
  await Deno.mkdir(join(tmp, "node_modules", "electron"), { recursive: true });
  await Deno.writeTextFile(
    join(tmp, "node_modules", "electron", "package.json"),
    '{"version":"42.0.0"}',
  );
  assertEquals(await resolveElectronVersion(tmp), "42.0.0");
  await Deno.remove(tmp, { recursive: true });
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
  const py = await new Deno.Command("python3", {
    args: [
      "-c",
      `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.write(sys.argv[2],sys.argv[3]); z.close()`,
      zip,
      src,
      entryName,
    ],
    stderr: "piped",
  }).output();
  if (!py.success) {
    // python3 missing on this box: `zip` builds the same archive, via a tree
    // whose layout already carries the entry name.
    const stage = join(dir, `stage-${entryName.replace(/[^A-Za-z0-9]/g, "_")}`);
    const target = join(stage, entryName);
    await Deno.mkdir(join(target, ".."), { recursive: true });
    await Deno.copyFile(src, target);
    const p = await new Deno.Command("zip", {
      args: ["-q", "-r", zip, "."],
      cwd: stage,
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!p.success) {
      throw new Error(
        "neither python3 nor zip available to build a test archive",
      );
    }
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
    await Deno.mkdir(runtime);
    await Deno.writeTextFile(electronBinIn(runtime), "");
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
    await Deno.mkdir(runtime);
    await Deno.writeTextFile(electronBinIn(runtime), "");
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
  assertEquals(packagedElectronCandidates("/opt/myapp/myapp", "darwin"), [
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
    await Deno.mkdir(shipped, { recursive: true });
    const bin = electronBinIn(shipped, Deno.build.os);
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
