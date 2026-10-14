// `installed.json` is never there half-written.
//
// Both writers (the installer's `writeRecord`, the updater's
// `reconcileInstalledVersion`) truncated the record and then filled it. A
// reader in between got an empty or cut file, and every reader takes that for
// "no record": `am installed` drops the app, the next boot's check takes the
// install for one `am` does not manage — and a process killed in that instant
// left it so for good. Found on macOS, where a test reading the record while
// a boot corrected it got `Unexpected end of JSON input`.
//
// The record is replaced whole now (a temp beside it, renamed over it). Held
// here by watching the file's SIZE for the whole write: it is the old
// record's or the new one's, never anything between — with a record large
// enough that an in-place write takes many looks to finish.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  _recordDeps,
  readRecord,
  reconcileInstalledVersion,
  repairedRecord,
  writeRecord,
} from "../src/server/install-record.ts";
import { ownPidNs, ownPidTag } from "../src/server/single-instance-lock.ts";
import {
  _renameDeps,
  RENAME_BACKOFF_MS,
} from "../src/diagnostics/rename-over.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { permissiveUmask } from "./permissive-umask.ts";
import { linkFile } from "./symlink-helper.ts";

/** Every size `path` had while `write` ran, the missing file as -1. */
async function sizesDuring(
  path: string,
  write: () => Promise<unknown>,
): Promise<Set<number>> {
  const seen = new Set<number>();
  const look = () => {
    try {
      seen.add(Deno.statSync(path).size);
    } catch {
      seen.add(-1);
    }
  };
  let done = false;
  const writing = write().finally(() => done = true);
  while (!done) {
    for (const until = performance.now() + 2; performance.now() < until;) {
      look();
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  await writing;
  look();
  return seen;
}

const BIG = "x".repeat(16 << 20);

Deno.test("installed.json: a version the updater puts on it replaces the record whole", async () => {
  const dir = await tempDir("aio-record-whole-");
  try {
    const path = join(dir, "installed.json");
    const before = JSON.stringify({
      name: "notes",
      version: "1.0.0",
      source: BIG,
    });
    await Deno.writeTextFile(path, before);
    const seen = await sizesDuring(
      path,
      async () =>
        assertEquals(
          await reconcileInstalledVersion(dir, { version: "2.0.0" }),
          true,
        ),
    );
    const after = await Deno.readTextFile(path);
    assertEquals(JSON.parse(after).version, "2.0.0");
    assertEquals(
      [...seen].filter((n) => n !== before.length && n !== after.length),
      [],
      "the record was seen cut short while it was being written",
    );
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name),
      ["installed.json"],
      "the temp it was written through is gone",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("installed.json: an install over an install replaces the record whole", async () => {
  const apps = await tempDir("aio-record-whole-root-");
  const was = Deno.env.get("AIO_INSTALL_ROOT");
  Deno.env.set("AIO_INSTALL_ROOT", apps);
  try {
    const name = "record-whole";
    const path = await writeRecord({ name, version: "1.0.0", source: BIG });
    const before = Deno.statSync(path).size;
    const seen = await sizesDuring(
      path,
      () => writeRecord({ name, version: "1.0.10", source: BIG }),
    );
    const after = await Deno.readTextFile(path);
    assertEquals(JSON.parse(after).version, "1.0.10");
    assert(after.length !== before, "the two records differ in size");
    assertEquals(
      [...seen].filter((n) => n !== before && n !== after.length),
      [],
      "the record was seen cut short while it was being written",
    );
  } finally {
    if (was === undefined) Deno.env.delete("AIO_INSTALL_ROOT");
    else Deno.env.set("AIO_INSTALL_ROOT", was);
    await dropTempDir(apps);
  }
});

// Two writes of one record that overlap in a process shared one temp name
// (`.tmp-<pid>`, opened truncating): the second emptied what the first had
// filled, and the first renamed that into place — an EMPTY record, which
// every reader takes for none. A boot's un-awaited correction beside the
// updater's own write is that overlap.
Deno.test("installed.json: writes that overlap in one process each put a whole record", async () => {
  const dir = await tempDir("aio-record-overlap-");
  try {
    const path = join(dir, "installed.json");
    await Deno.writeTextFile(
      path,
      JSON.stringify({ name: "notes", version: "1.0.0", source: BIG }),
    );
    for (let round = 0; round < 5; round++) {
      const all = await Promise.all(
        Array.from(
          { length: 4 },
          (_, i) => reconcileInstalledVersion(dir, { version: `2.0.${i}` }),
        ),
      );
      assertEquals(all, [true, true, true, true], "a write was refused");
      const rec = JSON.parse(await Deno.readTextFile(path));
      assert(/^2\.0\.[0-3]$/.test(rec.version), `a cut record: ${rec.version}`);
      assertEquals(rec.source.length, BIG.length);
    }
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name),
      ["installed.json"],
      "every temp is gone",
    );
  } finally {
    await dropTempDir(dir);
  }
});

// A writer killed between the temp and the rename left the temp for good.
//
// A pid is judged in the pid namespace that wrote it (the name's `d<ns>`): a
// container and its host share `~/app/<name>` through a bind mount, and the
// host took the container's write in flight — pid 7 there, nobody here — for
// a dead writer's and removed it under the rename. Another namespace's temp,
// or one naming none where there is one (what 1.0.19 wrote), goes by age.
Deno.test("installed.json: the next write removes a dead writer's temp, and no live one's", async () => {
  const dir = await tempDir("aio-record-sweep-");
  try {
    const path = join(dir, "installed.json");
    await Deno.writeTextFile(
      path,
      JSON.stringify({ name: "notes", version: "1.0.0" }),
    );
    // A pid that is certainly dead: a child that has exited.
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", ""],
      stdout: "null",
      stderr: "null",
    }).spawn();
    const dead = child.pid;
    await child.status;
    const ns = ownPidNs(); // Linux; elsewhere a pid is the whole name
    const tag = ownPidTag().slice(String(Deno.pid).length);
    const elsewhere = ns === undefined
      ? null
      : `d${(ns + 1).toString(16).padStart(8, "0")}`;
    const t = (rest: string) => `installed.json.tmp-${rest}`;
    const goes = [
      t(`${dead}${tag}`), // the oldest shape, `.tmp-<pid>`
      t(`${dead}${tag}-0a1b2c3d`),
      t(`${Deno.pid}${tag}`), // an earlier run's: this build never writes it
    ];
    const stays = [
      t(`${Deno.pid}${tag}-0a1b2c3d`), // a write in flight
      t(`${Deno.ppid}${tag}-0a1b2c3d`), // another live writer
      t("notes"), // not a temp of this writer's
    ];
    // Not this namespace's: the pid says nothing — kept until it is OLD.
    const byAge = elsewhere === null ? [] : [
      t(`${dead}${elsewhere}-0a1b2c3d`), // a container's write in flight
      t(`${dead}-0a1b2c3d`), // 1.0.19's name: no namespace recorded
      t(`${dead}`),
    ];
    for (const n of [...goes, ...stays, ...byAge]) {
      await Deno.writeTextFile(join(dir, n), "{");
    }
    const left = () => [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(
      await reconcileInstalledVersion(dir, { version: "2.0.0" }),
      true,
    );
    assertEquals(left(), ["installed.json", ...stays, ...byAge].sort());
    const old = new Date(Date.now() - 11 * 60_000);
    for (const n of byAge) await Deno.utime(join(dir, n), old, old);
    assertEquals(
      await reconcileInstalledVersion(dir, { version: "2.0.1" }),
      true,
    );
    assertEquals(left(), ["installed.json", ...stays].sort());
  } finally {
    await dropTempDir(dir);
  }
});

// The sweep ended at the first remove that failed (a sibling's sweep got
// there first), leaving every dead temp after it.
Deno.test("installed.json: the sweep tries every dead temp, whatever one remove says", async () => {
  const dir = await tempDir("aio-record-sweep-each-");
  const realRemove = Deno.removeSync;
  try {
    await Deno.writeTextFile(
      join(dir, "installed.json"),
      JSON.stringify({ name: "notes", version: "1.0.0" }),
    );
    const tag = ownPidTag().slice(String(Deno.pid).length);
    const child = new Deno.Command(Deno.execPath(), { args: ["eval", ""] })
      .spawn();
    await child.status;
    for (let n = 0; n < 4; n++) {
      await Deno.writeTextFile(
        join(dir, `installed.json.tmp-${child.pid}${tag}-0a1b2c3${n}`),
        "{",
      );
    }
    let removes = 0;
    Deno.removeSync = (path, o) => {
      if (++removes === 1) {
        realRemove(path, o); // the sibling got there first
        throw new Deno.errors.NotFound(`No such file or directory: ${path}`);
      }
      realRemove(path, o);
    };
    const ok = await reconcileInstalledVersion(dir, { version: "2.0.0" });
    Deno.removeSync = realRemove;
    assertEquals(ok, true);
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name),
      ["installed.json"],
    );
  } finally {
    Deno.removeSync = realRemove;
    await dropTempDir(dir);
  }
});

// ── what a write does to the FILE ────────────────────────────────────────
//
// Replacing the record by rename changed two things the in-place write never
// touched: a record that is a symbolic link became a regular file (the link
// gone, its target left stale), and the file took the temp's mode.

Deno.test({
  name: "installed.json: the record keeps its mode across a write",
  ignore: Deno.build.os === "windows", // no POSIX mode there
  fn: () =>
    permissiveUmask(async () => {
      const dir = await tempDir("aio-record-mode-");
      try {
        const path = join(dir, "installed.json");
        await Deno.writeTextFile(path, JSON.stringify({ name: "notes" }));
        for (const mode of [0o600, 0o664]) {
          await Deno.chmod(path, mode);
          assertEquals(
            await reconcileInstalledVersion(dir, { version: "2.0.0" }),
            true,
          );
          assertEquals(Deno.statSync(path).mode! & 0o777, mode);
        }
      } finally {
        await dropTempDir(dir);
      }
    }),
});

Deno.test("installed.json: a record that is a symbolic link is written through it", async () => {
  const dir = await tempDir("aio-record-link-");
  try {
    const install = join(dir, "app");
    const kept = join(dir, "dotfiles");
    await Deno.mkdir(install);
    await Deno.mkdir(kept);
    const target = join(kept, "notes.json");
    await Deno.writeTextFile(
      target,
      JSON.stringify({ name: "notes", version: "1.0.0" }),
    );
    const path = join(install, "installed.json");
    await linkFile(target, path);
    assertEquals(
      await reconcileInstalledVersion(install, { version: "2.0.0" }),
      true,
    );
    assert(Deno.lstatSync(path).isSymlink, "the link was replaced by a file");
    assertEquals(JSON.parse(await Deno.readTextFile(target)).version, "2.0.0");
    const names = (d: string) => [...Deno.readDirSync(d)].map((e) => e.name);
    assertEquals(names(install), ["installed.json"]);
    assertEquals(
      names(kept),
      ["notes.json"],
      "the temp went beside the target",
    );
  } finally {
    await dropTempDir(dir);
  }
});

// Windows: a program that has the record open without delete sharing refuses
// the rename for as long as it looks. The update that came to write the new
// version down must not fail on that — it is written in place, as before
// 1.0.19, and said. Windows's answer is handed in, so every OS holds it.
Deno.test("installed.json: a record held open on Windows is written in place, said once, and no temp is left", async () => {
  const dir = await tempDir("aio-record-held-");
  const real = { ..._renameDeps };
  const prev = getLogger();
  const warns: string[] = [];
  setLogger(
    {
      ...(prev ?? {}),
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") warns.push(msg);
      },
    } as unknown as Parameters<typeof setLogger>[0],
  );
  try {
    const path = join(dir, "installed.json");
    await Deno.writeTextFile(
      path,
      JSON.stringify({ name: "notes", version: "1.0.0" }),
    );
    _renameDeps.reset();
    _renameDeps.windows = () => true;
    _renameDeps.sleep = () => Promise.resolve();
    _renameDeps.warn = () => {};
    let renames = 0;
    _renameDeps.renameAsync = () => {
      renames++;
      return Promise.reject(
        new Deno.errors.PermissionDenied("Access is denied. (os error 5)"),
      );
    };
    const names = () => [...Deno.readDirSync(dir)].map((e) => e.name);
    assertEquals(
      await reconcileInstalledVersion(dir, { version: "2.0.0" }),
      true,
    );
    assertEquals(JSON.parse(await Deno.readTextFile(path)).version, "2.0.0");
    assertEquals(renames, RENAME_BACKOFF_MS.length + 1, "the bounded wait");
    assertEquals(names(), ["installed.json"]);
    // Still held: one try (the helper's cool-down), in place again, not said
    // a second time.
    assertEquals(
      await reconcileInstalledVersion(dir, { version: "2.0.1" }),
      true,
    );
    assertEquals(JSON.parse(await Deno.readTextFile(path)).version, "2.0.1");
    assertEquals(renames, RENAME_BACKOFF_MS.length + 2);
    const said = warns.filter((w) => w.includes("written in place"));
    assertEquals(said.length, 1, warns.join("\n"));
    assert(said[0]!.includes(path), said[0]);
    // A rename refused for another reason is a failure, as it was: the old
    // record whole, no temp, and the updater's line.
    _renameDeps.windows = () => false;
    assertEquals(
      await reconcileInstalledVersion(dir, { version: "3.0.0" }),
      false,
    );
    assertEquals(JSON.parse(await Deno.readTextFile(path)).version, "2.0.1");
    assertEquals(names(), ["installed.json"]);
    assert(warns.some((w) => w.includes("could not update")), warns.join("\n"));
  } finally {
    Object.assign(_renameDeps, real);
    _renameDeps.reset();
    setLogger(prev);
    await dropTempDir(dir);
  }
});

// A temp that cannot be made (its name is taken) fails the write and leaves
// the record, and the file that was in the way, as they were.
Deno.test("installed.json: a write whose temp cannot be made leaves the record whole", async () => {
  const dir = await tempDir("aio-record-temp-taken-");
  const nonce = _recordDeps.nonce;
  try {
    const path = join(dir, "installed.json");
    const before = JSON.stringify({ name: "notes", version: "1.0.0" });
    await Deno.writeTextFile(path, before);
    _recordDeps.nonce = () => "0a1b2c3d";
    const taken = `${path}.tmp-${ownPidTag()}-0a1b2c3d`;
    await Deno.writeTextFile(taken, "another write's");
    assertEquals(
      await reconcileInstalledVersion(dir, { version: "2.0.0" }),
      false,
    );
    assertEquals(await Deno.readTextFile(path), before);
    assertEquals(await Deno.readTextFile(taken), "another write's");
  } finally {
    _recordDeps.nonce = nonce;
    await dropTempDir(dir);
  }
});

// What 1.0.19's run.ps1 wrote under Windows PowerShell 5.1, measured there:
// `--aio=$conf.aioVersion` became the whole parsed deno.json plus the text
// ".aioVersion", and `--artifact=(…)` / `--commit=(…)` became empty.
Deno.test("installed.json: the aio version a 1.0.19 run.ps1 damaged is read as the pin inside it, and the next write puts it right", async () => {
  const damaged = {
    name: "demo",
    version: "1.2.3",
    source: "C:\\x",
    target: "electron",
    aioVersion:
      "@{name=demo; version=1.2.3; aioVersion=1.0.19-beta; imports=; tasks=}.aioVersion",
  };
  assertEquals(repairedRecord(damaged).aioVersion, "1.0.19-beta");
  // No pin in the app's deno.json: no aio version, not the dump.
  assertEquals(
    repairedRecord({
      name: "demo",
      aioVersion: "@{name=demo; version=1}.aioVersion",
    }),
    { name: "demo", aioVersion: undefined },
  );
  // Every other record is the same object, untouched.
  for (
    const sound of [
      { name: "demo" },
      { name: "demo", aioVersion: "1.0.20-beta" },
      { name: "demo", aioVersion: "path:/home/u/aio" },
      { name: "demo", aioVersion: "@{x}.aioVersion and more" },
    ]
  ) assert(repairedRecord(sound) === sound);

  const root = await tempDir("install-record-");
  const prev = Deno.env.get("AIO_INSTALL_ROOT");
  Deno.env.set("AIO_INSTALL_ROOT", root);
  try {
    const dir = join(root, "demo");
    await Deno.mkdir(dir);
    await Deno.writeTextFile(
      join(dir, "installed.json"),
      JSON.stringify(damaged),
    );
    assertEquals((await readRecord("demo"))?.aioVersion, "1.0.19-beta");
    assert(
      await reconcileInstalledVersion(dir, {
        version: "1.2.4",
        artifact: "demo.exe",
      }),
    );
    const onDisk = JSON.parse(
      await Deno.readTextFile(join(dir, "installed.json")),
    );
    assertEquals(
      { ...onDisk, installedAt: "" },
      {
        ...damaged,
        version: "1.2.4",
        artifact: "demo.exe",
        aioVersion: "1.0.19-beta",
        installedAt: "",
      },
    );
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_INSTALL_ROOT");
    else Deno.env.set("AIO_INSTALL_ROOT", prev);
    await dropTempDir(root);
  }
});
