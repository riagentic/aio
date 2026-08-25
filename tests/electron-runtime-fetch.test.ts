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
  electronRuntimeDir,
  electronSlug,
  electronZipUrlFor,
  ensureElectronRuntime,
  toolCacheDir,
} from "../src/electron/electron-runtime-fetch.ts";
import { findElectronBin } from "../src/electron/electron-spawn.ts";
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

/** A zip holding one executable file named `electron` — what the release
 *  asset looks like, at 1 KB instead of 100 MB. */
async function tinyElectronZip(dir: string): Promise<Uint8Array> {
  const zip = join(dir, "fake.zip");
  const src = join(dir, "electron");
  await Deno.writeTextFile(src, "#!/bin/sh\necho fake electron\n");
  await Deno.chmod(src, 0o755);
  const p = await new Deno.Command("zip", {
    args: ["-q", "-j", zip, src],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!p.success) {
    // `zip` missing on this box: python builds the same archive.
    const py = await new Deno.Command("python3", {
      args: [
        "-c",
        `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.write(sys.argv[2],'electron'); z.close()`,
        zip,
        src,
      ],
      stderr: "piped",
    }).output();
    if (!py.success) {
      throw new Error(
        "neither zip nor python3 available to build a test archive",
      );
    }
  }
  return await Deno.readFile(zip);
}

Deno.test("ensureElectronRuntime: downloads once into the cache, stamps completion, reuses", async () => {
  await isolated(async (tmp) => {
    const bytes = await tinyElectronZip(tmp);
    let fetches = 0;
    const fakeFetch = ((_url: string | URL | Request) => {
      fetches++;
      return Promise.resolve(
        new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
          status: 200,
        }),
      );
    }) as typeof fetch;
    const lines: string[] = [];
    const dir = await ensureElectronRuntime("9.9.9", "linux-x64", {
      fetch: fakeFetch,
      log: (m) => lines.push(m),
    });
    assertEquals(dir, electronRuntimeDir("9.9.9", "linux-x64"));
    assertEquals(fetches, 1);
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
    assertEquals(fetches, 1, "a cached runtime is never re-downloaded");
    // A missing stamp (interrupted unpack) re-downloads rather than trusting
    // the half-written directory.
    await Deno.remove(join(dir, ".aio-complete"));
    await ensureElectronRuntime("9.9.9", "linux-x64", {
      fetch: fakeFetch,
      log: () => {},
    });
    assertEquals(fetches, 2);
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
