// A `.zip` (directory) install updates from a TREE patch: the new release's
// file list with, per changed file, a zstd frame against the installed file —
// measured on an Electron app with one UI line changed: 27 KB, where a patch
// of the whole zip was 33.3 MB of 174.8 MB. Every file made is checked against
// the patch's list (whose digest the signed manifest carries); any miss
// downloads the whole release, said in one line.
import "./store-sandbox.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { writeProgram } from "./fake-program-helper.ts";
import { zipTree } from "./zip-helper.ts";
import { hasZstd, patchOf } from "./zstd-patch-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  buildShipManifest,
  generateSigningKey,
  type ReleasePatch,
  withPatches,
} from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { fileSha256, writeTrust } from "../src/server/updates-check.ts";
import { readOwned } from "../src/server/updates-owned.ts";
import { unpackArchive } from "../src/server/updates-apply.ts";
import {
  decodeTreePatch,
  encodeTreePatch,
  makeTreePatch,
  type TreeFile,
} from "../src/server/updates-tree.ts";
import { makePatches } from "../src/am/am-cmd-publish.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const WIN = Deno.build.os === "windows";
const MANIFEST = `${platform.os}-${platform.arch}.json`;

/** `zstd` as `makeTreePatch` calls it, made by the plain test encoder. */
const fakeZstd = async (args: string[]) => {
  const from = args.find((a) => a.startsWith("--patch-from="));
  const input = args.find((a, i) =>
    i > 0 && !a.startsWith("-") && args[i - 1] !== "-o"
  )!;
  const out = args[args.indexOf("-o") + 1]!;
  await Deno.writeFile(
    out,
    patchOf(
      from ? await Deno.readFile(from.slice(13)) : new Uint8Array(0),
      await Deno.readFile(input),
    ),
  );
};

/** One release's unpacked tree, as `aio build` lays a zip out: a launcher
 *  the swap smoke-tests, an `electron/`, a large binary that changes by a
 *  few bytes, a file only one side has, an empty folder. */
async function stage(dir: string, v: string): Promise<void> {
  await Deno.mkdir(join(dir, "electron", "locales"), { recursive: true });
  if (WIN) {
    await Deno.writeTextFile(join(dir, "run.bat"), `@echo ${v}\r\n`);
    await writeProgram(join(dir, "app.exe"), `#!/bin/sh\necho ${v}\n`);
  } else {
    await Deno.writeTextFile(join(dir, "run.sh"), `#!/bin/sh\necho ${v}\n`);
    await Deno.chmod(join(dir, "run.sh"), 0o755);
  }
  await Deno.writeTextFile(join(dir, "electron", "electron"), "runtime");
  // An executable the swap never runs: its bit comes from the patch alone.
  await Deno.writeTextFile(
    join(dir, "electron", "helper"),
    `#!/bin/sh\n# ${v}\n`,
  );
  if (!WIN) await Deno.chmod(join(dir, "electron", "helper"), 0o755);
  // Incompressible, and the same in both releases: a patch can only be
  // small by matching the installed file.
  let x = 2463534242;
  const big = new Uint8Array(300_000).map(() => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x & 255;
  });
  if (v !== "1.0.0") big.set([1, 2, 3], 150_000);
  await Deno.writeFile(join(dir, "server.bin"), big);
  await Deno.writeTextFile(join(dir, "VERSION"), v);
  await Deno.writeTextFile(
    join(dir, v === "1.0.0" ? "gone.txt" : "added.txt"),
    v,
  );
}

/** Every file under `dir`, path → bytes. */
async function tree(dir: string, at: string[] = []) {
  const out: Record<string, string> = {};
  for (const e of Deno.readDirSync(join(dir, ...at))) {
    const p = [...at, e.name];
    if (e.isDirectory) Object.assign(out, await tree(dir, p));
    else out[p.join("/")] = await fileSha256(join(dir, ...p));
  }
  return out;
}

type Rig = {
  root: string;
  data: string;
  install: string;
  releases: string;
  newZip: string;
  oldZipSha: string;
  said: string[];
  /** Publish 2.0.0 with `patches`; `full: false` leaves the whole release
   *  OUT of the channel, so an install proves it was not downloaded. */
  publish: (patches: ReleasePatch[], full: boolean) => Promise<void>;
};

/** 1.0.0 published (into `old/`) and installed (unpacked); 2.0.0 built. */
async function rig(): Promise<Rig> {
  const root = await tempDir("aio-tree-upd-");
  const releases = join(root, "releases");
  for (const v of ["1.0.0", "2.0.0"]) await stage(join(root, `s-${v}`), v);
  await Deno.mkdir(join(releases, "old"), { recursive: true });
  await Deno.mkdir(join(releases, "prod"), { recursive: true });
  const oldZip = join(releases, "old", "app-1.0.0.zip");
  await zipTree(join(root, "s-1.0.0"), oldZip);
  const newZip = join(root, "app-2.0.0.zip");
  await zipTree(join(root, "s-2.0.0"), newZip);
  const keys = await generateSigningKey();
  const manifest = (v: string, bytes: Uint8Array) =>
    buildShipManifest({
      name: "app",
      version: v,
      binary: bytes,
      sources: [],
      sign: keys,
      channel: "prod",
      target: "electron-zip",
      platform,
      url: `app-${v}.zip`,
      data: { schema: 1, cells: { todos: { version: 1, migratesFrom: 1 } } },
    });
  await Deno.writeTextFile(
    join(releases, "old", MANIFEST),
    JSON.stringify(await manifest("1.0.0", await Deno.readFile(oldZip))),
  );
  const install = join(root, "MyApp");
  const got = await unpackArchive(oldZip, install);
  assert(got.ok, "unpack 1.0.0");
  const data = join(root, "data");
  await Deno.mkdir(data);
  return {
    root,
    data,
    install,
    releases,
    newZip,
    oldZipSha: await fileSha256(oldZip),
    said: [],
    publish: async (patches, full) => {
      const m = await withPatches(
        await manifest("2.0.0", await Deno.readFile(newZip)),
        patches,
        keys.privateKey,
      );
      if (full) {
        await Deno.copyFile(newZip, join(releases, "prod", "app-2.0.0.zip"));
      }
      await Deno.writeTextFile(
        join(releases, "prod", MANIFEST),
        JSON.stringify(m),
      );
    },
  };
}

/** The patch of 2.0.0 from the published 1.0.0, as `am publish
 *  --patch-from=` makes it — `zstd` itself when installed, else the same tree
 *  made with the plain test encoder. */
async function patches(r: Rig, real: boolean): Promise<ReleasePatch[]> {
  if (real) {
    const made = await makePatches({
      dirs: [join(r.releases, "old")],
      channel: "prod",
      manifestName: MANIFEST,
      file: r.newZip,
      into: join(r.releases, "prod"),
    });
    assertEquals(made.patches.length, 1, made.notes.join("\n"));
    assert(made.patches[0]!.url.endsWith(".tree"), made.patches[0]!.url);
    return made.patches;
  }
  const a = join(r.root, "u-old"), b = join(r.root, "u-new");
  assert((await unpackArchive(join(r.releases, "old", "app-1.0.0.zip"), a)).ok);
  assert((await unpackArchive(r.newZip, b)).ok);
  const out = join(r.releases, "prod", "app-2.0.0.zip.tree");
  await makeTreePatch(a, b, out, fakeZstd);
  return [{
    from: r.oldZipSha,
    url: "app-2.0.0.zip.tree",
    size: (await Deno.stat(out)).size,
    sha256: await fileSha256(out),
  }];
}

async function update(r: Rig) {
  const swaps: { staged: string }[] = [];
  const say = (...a: unknown[]) => void r.said.push(a.map(String).join(" "));
  const rt = createUpdatesRuntime({
    config: resolveUpdates({ source: `file://${r.releases}`, channel: "prod" }),
    dataDir: r.data,
    appVersion: "1.0.0",
    local: { schema: 1, cells: { todos: 1 } },
    exposed: false,
    log: {
      info: say,
      warn: say,
      error: say,
      debug: () => {},
    } as unknown as Log,
    argv: [],
    artifact: r.install,
    canInstall: ["electron-zip"],
    exit: () => {},
    swapDirectory: ({ current, staged }) => {
      swaps.push({ staged });
      return { previous: `${current}.old-1.0.0` };
    },
    shutdown: () => Promise.resolve(),
  });
  assertEquals((await rt.check({ dismissed: null })).kind, "offer");
  await rt.apply();
  await (rt as { handover?: Promise<void> | null }).handover;
  return swaps;
}

const patchLines = (r: Rig) => r.said.filter((l) => l.includes("patch"));

for (const real of [false, true]) {
  Deno.test({
    name: `tree patch e2e${
      real ? " (zstd)" : ""
    }: a .zip install is made from its own files and a patch — the release's every file, the whole release never fetched`,
    ignore: real && !hasZstd(),
    fn: async () => {
      const r = await rig();
      try {
        writeTrust(r.data, { installedSha256: r.oldZipSha });
        const p = await patches(r, real);
        // The patch is a small part of the release.
        assert(
          p[0]!.size * 5 < (await Deno.stat(r.newZip)).size,
          `${p[0]!.size}`,
        );
        await r.publish(p, false); // no whole release in the channel
        const swaps = await update(r);
        assertEquals(swaps.length, 1, r.said.join("\n"));
        assertEquals(
          await tree(swaps[0]!.staged),
          await tree(join(r.root, "s-2.0.0")),
        );
        if (!WIN) {
          assertEquals(
            (await Deno.stat(join(swaps[0]!.staged, "electron", "helper")))
              .mode! & 0o111,
            0o111,
          );
        }
        assertEquals(patchLines(r).length, 1, r.said.join("\n"));
        assert(
          patchLines(r)[0]!.includes("from the installed files"),
          patchLines(r)[0],
        );
        // No archive was downloaded, so none stays on the record.
        assertEquals(
          readOwned(r.data).filter((e) =>
            e.path.includes(".zip-") || e.path.includes(".patch-")
          ),
          [],
        );
      } finally {
        await dropTempDir(r.root);
      }
    },
  });
}

Deno.test("tree patch e2e: an install with no digest on record uses the release's one patch — checked file by file", async () => {
  const r = await rig();
  try {
    await r.publish(await patches(r, false), false);
    const swaps = await update(r);
    assertEquals(
      await tree(swaps[0]!.staged),
      await tree(join(r.root, "s-2.0.0")),
    );
  } finally {
    await dropTempDir(r.root);
  }
});

Deno.test("tree patch e2e: an installed file changed since → the whole release is downloaded, said in one line", async () => {
  const r = await rig();
  try {
    writeTrust(r.data, { installedSha256: r.oldZipSha });
    await r.publish(await patches(r, false), true);
    const big = await Deno.readFile(join(r.install, "server.bin"));
    big[10] = big[10]! ^ 0xff;
    await Deno.writeFile(join(r.install, "server.bin"), big);
    const swaps = await update(r);
    assertEquals(
      await tree(swaps[0]!.staged),
      await tree(join(r.root, "s-2.0.0")),
    );
    assertEquals(patchLines(r).length, 1, r.said.join("\n"));
    const line = patchLines(r)[0]!;
    assert(line.includes("is not installed from a patch"), line);
    assert(line.includes("server.bin made from the patch is not"), line);
    assert(line.includes("downloading the whole release"), line);
  } finally {
    await dropTempDir(r.root);
  }
});

Deno.test("tree patch: a list that names a file outside the install, or one file twice, is refused", () => {
  const f = (path: string): TreeFile => ({
    path,
    size: 0,
    sha256: "0".repeat(64),
    op: "same",
  });
  for (
    const path of [
      "../x",
      "a/../../x",
      "/etc/x",
      "a\\b",
      "C:x",
      "a//b",
      "./a",
      "",
    ]
  ) {
    assertThrows(
      () =>
        decodeTreePatch(encodeTreePatch({ files: [f(path)], dirs: [] }, [])),
      Error,
      "names",
      path,
    );
  }
  assertThrows(
    () =>
      decodeTreePatch(
        encodeTreePatch({ files: [f("App.exe"), f("app.exe")], dirs: [] }, []),
      ),
    Error,
    "twice",
  );
  assertThrows(
    () =>
      decodeTreePatch(
        encodeTreePatch({ files: [], dirs: [] }, [new Uint8Array([1])]),
      ),
    Error,
    "bytes follow",
  );
  assertThrows(
    () =>
      decodeTreePatch(encodeTreePatch({
        files: [{ ...f("a"), op: "new", len: 9 }],
        dirs: [],
      }, [new Uint8Array(3)])),
    Error,
    "cut short",
  );
});
