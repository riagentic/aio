// `am backup` and `am restore` never leave a half-copy where a whole one is
// expected.
//
// restore used to move the live data aside FIRST and then copy; a copy that
// died half-way (an unreadable file, a full disk) left data/ nearly empty, and
// the aside `data.replaced-<stamp>` was never named. backup wrote straight into
// `<dest>`, so a half-copy with a meta.json passed restore's "is this a
// backup" check. Now: restore copies into a sibling and swaps by rename;
// backup copies to `<dest>.partial` and renames only a finished copy.
//
// The failure is a real one — a mode-000 file the copy cannot read — so these
// cannot run as root (root reads it anyway).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdBackup, cmdRestore } from "../src/am/am-cmd-data.ts";
import {
  _resetAppDirs,
  appDirs,
  ensureAppDirs,
  writeAppMeta,
} from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  lockKey,
  readLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";

const ROOT = Deno.build.os !== "windows" && Deno.uid() === 0;
const SUITE_HOME = Deno.env.get("AIO_APPS_DIR");

async function run(
  fn: (args: string[], flags: Record<string, unknown>) => void | Promise<void>,
  args: string[],
): Promise<{ out: string; exited: number | null }> {
  const chunks: string[] = [];
  const [log, err, exit] = [console.log, console.error, Deno.exit];
  let exited: number | null = null;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (code = 0) => {
    exited = code;
    throw new Error("__exit__");
  };
  try {
    await fn(args, { app: "atomicapp", json: true });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    console.log = log;
    console.error = err;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = exit;
  }
  return { out: chunks.join("\n"), exited };
}

async function world() {
  const base = await tempDir("am-atomic-");
  Deno.env.set("AIO_APPS_DIR", join(base, "apps"));
  _resetAppDirs();
  const d = appDirs("atomicapp");
  ensureAppDirs(d);
  Deno.writeTextFileSync(d.stateDb, "LIVE");
  writeAppMeta(d, { appId: "atomicapp", aio: "1.0.0-test" });
  return { base, d };
}

async function done(base: string) {
  if (SUITE_HOME === undefined) Deno.env.delete("AIO_APPS_DIR");
  else Deno.env.set("AIO_APPS_DIR", SUITE_HOME);
  _resetAppDirs();
  await dropTempDir(base);
}

const siblings = (dir: string, prefix: string) =>
  [...Deno.readDirSync(join(dir, ".."))].map((e) => e.name)
    .filter((n) => n.startsWith(prefix));

Deno.test({
  name: "am restore: a copy that fails half-way leaves data/ untouched",
  ignore: ROOT,
  fn: async () => {
    const { base, d } = await world();
    const src = join(base, "archive");
    try {
      Deno.mkdirSync(src);
      Deno.writeTextFileSync(join(src, "meta.json"), '{"appId":"atomicapp"}');
      Deno.writeTextFileSync(join(src, "state.db"), "ARCHIVE");
      Deno.writeTextFileSync(join(src, "zz-unreadable"), "x");
      Deno.chmodSync(join(src, "zz-unreadable"), 0o000);
      const r = await run(cmdRestore, [src]);
      assertEquals(r.exited, 1, r.out);
      assertStringIncludes(r.out, "was not touched");
      assertEquals(Deno.readTextFileSync(d.stateDb), "LIVE");
      assertEquals(siblings(d.data, "data.restoring-"), [], "staging left");
      assertEquals(siblings(d.data, "data.replaced-"), [], "nothing moved");
    } finally {
      Deno.chmodSync(join(src, "zz-unreadable"), 0o600);
      await done(base);
    }
  },
});

Deno.test("am restore: success swaps in the copy and names the aside", async () => {
  const { base, d } = await world();
  try {
    const src = join(base, "archive");
    Deno.mkdirSync(src);
    Deno.writeTextFileSync(join(src, "state.db"), "ARCHIVE");
    const r = await run(cmdRestore, [src]);
    assertEquals(r.exited, null, r.out);
    assertEquals(Deno.readTextFileSync(d.stateDb), "ARCHIVE");
    const doc = JSON.parse(r.out) as { replaced?: string };
    assert(doc.replaced, r.out);
    assertEquals(Deno.readTextFileSync(join(doc.replaced, "state.db")), "LIVE");
    assertEquals(siblings(d.data, "data.restoring-"), []);
  } finally {
    await done(base);
  }
});

Deno.test({
  name: "am backup: a copy that fails half-way leaves no <dest> at all",
  ignore: ROOT,
  fn: async () => {
    const { base, d } = await world();
    const bad = join(d.data, "zz-unreadable");
    try {
      Deno.writeTextFileSync(bad, "x");
      Deno.chmodSync(bad, 0o000);
      const dest = join(base, "bk");
      const r = await run(cmdBackup, [dest]);
      assertEquals(r.exited, 1, r.out);
      assertStringIncludes(r.out, "nothing was written");
      assertEquals(
        [...Deno.readDirSync(base)].map((e) => e.name).filter((n) =>
          n.startsWith("bk")
        ),
        [],
        "a partial backup was left where restore would accept it",
      );
    } finally {
      Deno.chmodSync(bad, 0o600);
      await done(base);
    }
  },
});

Deno.test("am backup: a finished copy is renamed into place", async () => {
  const { base } = await world();
  try {
    const dest = join(base, "bk");
    const r = await run(cmdBackup, [dest]);
    assertEquals(r.exited, null, r.out);
    assertEquals(Deno.readTextFileSync(join(dest, "state.db")), "LIVE");
    assertEquals(
      [...Deno.readDirSync(base)].map((e) => e.name).includes("bk.partial"),
      false,
    );
  } finally {
    await done(base);
  }
});

Deno.test("am backup: a leftover <dest>.partial (a killed backup) is named, never reused", async () => {
  const { base } = await world();
  try {
    const dest = join(base, "bk");
    Deno.mkdirSync(`${dest}.partial`);
    const r = await run(cmdBackup, [dest]);
    assertEquals(r.exited, 1, r.out);
    assertStringIncludes(r.out, `${dest}.partial already exists`);
    assertStringIncludes(r.out, "did not finish");
    assertEquals(
      [...Deno.readDirSync(base)].map((e) => e.name).includes("bk"),
      false,
    );
  } finally {
    await done(base);
  }
});

// ── The app lock is HELD across the copy ─────────────────────────────────
//
// restore (and backup without --force) checked "stopped" once and then copied
// for seconds; an app started in that window wrote into data/ that was then
// moved aside — restore said success, the writes were gone. Now the command
// holds the app's own lock from copy to swap, so that start refuses. Observed
// from INSIDE the copy: every file copied must happen under our lock.

function copiesUnderLock(appId: string, home: string, op: string) {
  const seen: boolean[] = [];
  const orig = Deno.copyFile;
  // deno-lint-ignore no-explicit-any
  (Deno as any).copyFile = (from: string | URL, to: string | URL) => {
    const held = readLock(lockKey(appId, home)) as
      | (Record<string, unknown> & { pid: number })
      | null;
    // Ours, and a MAINTENANCE hold naming the op — never the `starting` a
    // boot writes (status/stop/start read that as an app).
    seen.push(
      held !== null && held.pid === Deno.pid &&
        (held.maintenance as { op?: string } | undefined)?.op === op,
    );
    return orig(from, to);
  };
  return {
    seen,
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).copyFile = orig),
  };
}

Deno.test("am restore: the app lock is held for the whole copy, and released after", async () => {
  const { base, d } = await world();
  const spy = copiesUnderLock("atomicapp", d.home, "am restore");
  try {
    const src = join(base, "archive");
    Deno.mkdirSync(src);
    Deno.writeTextFileSync(join(src, "state.db"), "ARCHIVE");
    Deno.writeTextFileSync(join(src, "auth.db"), "A");
    const r = await run(cmdRestore, [src]);
    assertEquals(r.exited, null, r.out);
    assert(spy.seen.length >= 2, `copied ${spy.seen.length} files`);
    assert(spy.seen.every(Boolean), "a file was copied with the app unlocked");
    assertEquals(readLock(lockKey("atomicapp", d.home)), null, "not released");
  } finally {
    spy.restore();
    await done(base);
  }
});

Deno.test("am backup: the app lock is held for the whole copy, and released after", async () => {
  const { base, d } = await world();
  const spy = copiesUnderLock("atomicapp", d.home, "am backup");
  try {
    const r = await run(cmdBackup, [join(base, "bk")]);
    assertEquals(r.exited, null, r.out);
    assert(spy.seen.length >= 2, `copied ${spy.seen.length} files`);
    assert(spy.seen.every(Boolean), "a file was copied with the app unlocked");
    assertEquals(readLock(lockKey("atomicapp", d.home)), null, "not released");
  } finally {
    spy.restore();
    await done(base);
  }
});

// Ctrl-C / SIGTERM mid-copy. `AppLock`'s listeners (they are an APP's) only
// mark the lock `stopping`, so the copy ignored the signal and exited 0. Now
// the op aborts like any failure — cleaned up, data untouched — and exits with
// the signal's code. SIGTERM, not SIGINT: the test runner owns Ctrl-C.
function signalOnFirstCopy() {
  const orig = Deno.copyFile;
  let sent = false;
  // deno-lint-ignore no-explicit-any
  (Deno as any).copyFile = async (from: string | URL, to: string | URL) => {
    if (!sent) {
      sent = true;
      Deno.kill(Deno.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 200)); // let the listener run
    }
    return orig(from, to);
  };
  // deno-lint-ignore no-explicit-any
  return () => ((Deno as any).copyFile = orig);
}

Deno.test({
  name: "am backup: SIGTERM mid-copy aborts, leaves nothing, exits 143",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { base, d } = await world();
    Deno.writeTextFileSync(join(d.data, "b.db"), "B");
    const undo = signalOnFirstCopy();
    try {
      const dest = join(base, "bk");
      const r = await run(cmdBackup, [dest]);
      assertEquals(r.exited, 143, r.out);
      assertStringIncludes(r.out, "interrupted (SIGTERM)");
      assert(!r.out.includes('"ok":true'), r.out);
      assertEquals(siblings(dest, "bk"), [], "a partial or a dest was left");
      assertEquals(readLock(lockKey("atomicapp", d.home)), null);
    } finally {
      undo();
      await done(base);
    }
  },
});

Deno.test({
  name: "am restore: SIGTERM mid-copy aborts, data/ untouched, exits 143",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { base, d } = await world();
    const undo = signalOnFirstCopy();
    try {
      const src = join(base, "archive");
      Deno.mkdirSync(src);
      Deno.writeTextFileSync(join(src, "state.db"), "ARCHIVE");
      Deno.writeTextFileSync(join(src, "auth.db"), "A");
      const r = await run(cmdRestore, [src]);
      assertEquals(r.exited, 143, r.out);
      assertStringIncludes(r.out, "interrupted (SIGTERM)");
      assertEquals(Deno.readTextFileSync(d.stateDb), "LIVE");
      assertEquals(siblings(d.data, "data."), [], "staging/aside left behind");
      assertEquals(readLock(lockKey("atomicapp", d.home)), null);
    } finally {
      undo();
      await done(base);
    }
  },
});

// The swap is two renames; when the SECOND fails (staging → data/), the live
// data already moved aside must be put back — and the message must say so.
Deno.test("am restore: a failed swap puts the previous data back and says so", async () => {
  const { base, d } = await world();
  const orig = Deno.renameSync;
  // deno-lint-ignore no-explicit-any
  (Deno as any).renameSync = (from: string | URL, to: string | URL) => {
    if (String(from).includes(".restoring-")) {
      throw new Deno.errors.PermissionDenied("swap refused");
    }
    return orig(from, to);
  };
  try {
    const src = join(base, "archive");
    Deno.mkdirSync(src);
    Deno.writeTextFileSync(join(src, "state.db"), "ARCHIVE");
    const r = await run(cmdRestore, [src]);
    assertEquals(r.exited, 1, r.out);
    assert(!r.out.includes('"ok":true'), r.out);
    assertStringIncludes(r.out, "swap refused");
    assertStringIncludes(r.out, `the previous data was put back at`);
    assertEquals(Deno.readTextFileSync(d.stateDb), "LIVE");
    assertEquals(siblings(d.data, "data.replaced-"), [], "aside left behind");
    const staged = siblings(d.data, "data.restoring-");
    assertEquals(staged.length, 1, "the restored copy must be kept, named");
    assertStringIncludes(r.out, staged[0] ?? "<none>");
    assertEquals(readLock(lockKey("atomicapp", d.home)), null);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).renameSync = orig;
    await done(base);
  }
});

// Ctrl-C is SIGINT → exit 130. In a child process: the test runner owns
// SIGINT in this one.
Deno.test({
  name: "am backup: Ctrl-C (SIGINT) mid-copy aborts, leaves nothing, exits 130",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const base = await tempDir("am-atomic-int-");
    try {
      const data = new URL("../src/am/am-cmd-data.ts", import.meta.url).href;
      const dirs = new URL("../src/server/app-dirs.ts", import.meta.url).href;
      const dest = join(base, "bk");
      const code = `
        import { cmdBackup } from ${JSON.stringify(data)};
        import { appDirs, ensureAppDirs, writeAppMeta } from ${
        JSON.stringify(dirs)
      };
        const d = appDirs("intapp");
        ensureAppDirs(d);
        Deno.writeTextFileSync(d.stateDb, "LIVE");
        Deno.writeTextFileSync(d.data + "/b.db", "B");
        writeAppMeta(d, { appId: "intapp", aio: "1.0.0-test" });
        const orig = Deno.copyFile;
        let sent = false;
        Deno.copyFile = async (f, t) => {
          if (!sent) {
            sent = true;
            Deno.kill(Deno.pid, "SIGINT");
            await new Promise((r) => setTimeout(r, 200));
          }
          return orig(f, t);
        };
        await cmdBackup([${
        JSON.stringify(dest)
      }], { app: "intapp", json: true });
      `;
      const o = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "--config",
          new URL("../deno.json", import.meta.url).pathname,
          code,
        ],
        env: { AIO_APPS_DIR: join(base, "apps"), NO_COLOR: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(o.stdout);
      const all = out + new TextDecoder().decode(o.stderr);
      assertEquals(o.code, 130, all);
      assertStringIncludes(out, "interrupted (SIGINT)");
      assert(!out.includes('"ok":true'), out);
      assertEquals(siblings(dest, "bk"), [], "a partial or a dest was left");
    } finally {
      await dropTempDir(base);
    }
  },
});

// The aside/staging names carry a ONE-second stamp. Two restores inside one
// second collided: the second's `rename(data → data.replaced-<stamp>)` hit
// the first one's aside, the restore failed, and its message named THAT
// directory — the data from before the first restore — as "the previous
// data". Names are now free names (`-2`, `-3`, …), and a message names a
// directory only once the previous data is really in it.
Deno.test("am restore: two restores in the same second both succeed, each aside its own", async () => {
  const { base, d } = await world();
  const RealDate = Date;
  const FIXED = RealDate.parse("2026-09-23T12:00:00.000Z");
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Date = class extends RealDate {
    // deno-lint-ignore no-explicit-any
    constructor(...a: any[]) {
      // deno-lint-ignore no-explicit-any
      if (a.length) super(...(a as [any]));
      else super(FIXED);
    }
    static override now() {
      return FIXED;
    }
  };
  try {
    const mk = (name: string, body: string) => {
      const src = join(base, name);
      Deno.mkdirSync(src);
      Deno.writeTextFileSync(join(src, "state.db"), body);
      return src;
    };
    const r1 = await run(cmdRestore, [mk("a1", "ARCHIVE1")]);
    const r2 = await run(cmdRestore, [mk("a2", "ARCHIVE2")]);
    assertEquals(r1.exited, null, r1.out);
    assertEquals(r2.exited, null, r2.out);
    const aside1 = JSON.parse(r1.out.split("\n").at(-1)!).replaced as string;
    const aside2 = JSON.parse(r2.out.split("\n").at(-1)!).replaced as string;
    assert(aside1 !== aside2, `${aside1} reused`);
    assertEquals(Deno.readTextFileSync(join(aside1, "state.db")), "LIVE");
    assertEquals(Deno.readTextFileSync(join(aside2, "state.db")), "ARCHIVE1");
    assertEquals(Deno.readTextFileSync(d.stateDb), "ARCHIVE2");
  } finally {
    globalThis.Date = RealDate;
    await done(base);
  }
});

Deno.test("am restore: a swap that could not move data/ says it is still there", async () => {
  const { base, d } = await world();
  const orig = Deno.renameSync;
  // deno-lint-ignore no-explicit-any
  (Deno as any).renameSync = (from: string | URL, to: string | URL) => {
    if (String(from) === d.data) {
      throw new Deno.errors.PermissionDenied("aside refused");
    }
    return orig(from, to);
  };
  try {
    const src = join(base, "archive");
    Deno.mkdirSync(src);
    Deno.writeTextFileSync(join(src, "state.db"), "ARCHIVE");
    const r = await run(cmdRestore, [src]);
    assertEquals(r.exited, 1, r.out);
    assertStringIncludes(r.out, "aside refused");
    assertStringIncludes(r.out, `the previous data was not moved`);
    assert(!r.out.includes("data.replaced-"), `names no aside: ${r.out}`);
    assertEquals(Deno.readTextFileSync(d.stateDb), "LIVE");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).renameSync = orig;
    await done(base);
  }
});

Deno.test("am restore: a data.restoring-* a killed restore left is named, never deleted", async () => {
  const { base, d } = await world();
  try {
    const left = `${d.data}.restoring-20200101-000000`;
    Deno.mkdirSync(left);
    Deno.writeTextFileSync(join(left, "state.db"), "HALF");
    const src = join(base, "archive");
    Deno.mkdirSync(src);
    Deno.writeTextFileSync(join(src, "state.db"), "ARCHIVE");
    const r = await run(cmdRestore, [src]);
    assertEquals(r.exited, null, r.out);
    assertStringIncludes(r.out, `${left} was left by an interrupted restore`);
    assertEquals(Deno.readTextFileSync(join(left, "state.db")), "HALF");
  } finally {
    await done(base);
  }
});

// A signal that lands WHILE THE LAST FILE copies is not seen by the copy's
// per-file check (it ran before that file). The op checks once more after
// the copy: an interrupted backup leaves no `<dest>`, an interrupted restore
// never swaps — both exit 143. And while interrupted the hold stays a
// MAINTENANCE record: `AppLock`'s own listener marks it `stopping`, which a
// v1.0.9 `am start` SIGKILLs after 3 s; the op's listener re-marks it.
async function lastFileSignal(verb: "backup" | "restore"): Promise<number> {
  const base = await tempDir(`am-atomic-last-${verb}-`);
  try {
    const data = new URL("../src/am/am-cmd-data.ts", import.meta.url).href;
    const dirs = new URL("../src/server/app-dirs.ts", import.meta.url).href;
    const lock =
      new URL("../src/server/single-instance-lock.ts", import.meta.url)
        .href;
    const target = join(base, "target");
    if (verb === "restore") {
      Deno.mkdirSync(target);
      Deno.writeTextFileSync(join(target, "state.db"), "ARCHIVE");
    }
    const code = `
      import { cmdBackup, cmdRestore } from ${JSON.stringify(data)};
      import { appDirs, ensureAppDirs } from ${JSON.stringify(dirs)};
      import { lockKey, readLock } from ${JSON.stringify(lock)};
      const d = appDirs("lastapp");
      ensureAppDirs(d);
      Deno.writeTextFileSync(d.stateDb, "LIVE");
      const orig = Deno.copyFile;
      Deno.copyFile = async (f, t) => {
        // The ONLY file: the per-file check already passed for it.
        Deno.kill(Deno.pid, "SIGTERM");
        await new Promise((r) => setTimeout(r, 200));
        const l = readLock(lockKey("lastapp", d.home));
        console.error("HOLD", l?.status, l?.maintenance?.op);
        return orig(f, t);
      };
      await ${verb === "backup" ? "cmdBackup" : "cmdRestore"}([${
      JSON.stringify(target)
    }], { app: "lastapp", json: true });
      console.error("STATE", Deno.readTextFileSync(d.stateDb));
    `;
    const o = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        code,
      ],
      env: { AIO_APPS_DIR: join(base, "apps"), NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(60_000),
    }).output();
    const out = new TextDecoder().decode(o.stdout);
    const all = out + new TextDecoder().decode(o.stderr);
    assertEquals(o.code, 143, all);
    assertStringIncludes(out, "interrupted (SIGTERM)");
    assertStringIncludes(all, `HOLD starting am ${verb}`);
    // `AppLock`'s "SIGTERM — shutting down … am stop stops this app" is advice
    // about an APP; a maintenance hold reports its own interruption.
    assert(!all.includes("SIGTERM — shutting down"), all);
    assert(!all.includes("stops this app alone"), all);
    if (verb === "backup") {
      assertEquals(
        siblings(target, "target"),
        [],
        "a partial or dest was left",
      );
    } else {
      const d = join(base, "apps", "lastapp", "data");
      assertEquals(Deno.readTextFileSync(join(d, "state.db")), "LIVE");
      assertEquals(siblings(d, "data.restoring-"), [], "staging left");
      assertEquals(siblings(d, "data.replaced-"), [], "data was moved");
    }
    return o.code;
  } finally {
    await dropTempDir(base);
  }
}

Deno.test({
  name: "am backup: SIGTERM during the last file still aborts — no dest, 143",
  ignore: Deno.build.os === "windows",
  fn: async () => assertEquals(await lastFileSignal("backup"), 143),
});

Deno.test({
  name:
    "am restore: SIGTERM during the last file never swaps — data/ kept, 143",
  ignore: Deno.build.os === "windows",
  fn: async () => assertEquals(await lastFileSignal("restore"), 143),
});

// The free-name search is bounded: a thousand taken names is a directory to
// clean, not a loop to spin in forever. The restore then fails by name, and
// data/ stays where it was.
Deno.test("am restore: a thousand taken aside names fail by name, data/ kept", async () => {
  const { base, d } = await world();
  const RealDate = Date;
  const FIXED = RealDate.parse("2026-09-23T12:00:00.000Z");
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Date = class extends RealDate {
    // deno-lint-ignore no-explicit-any
    constructor(...a: any[]) {
      // deno-lint-ignore no-explicit-any
      if (a.length) super(...(a as [any]));
      else super(FIXED);
    }
    static override now() {
      return FIXED;
    }
  };
  try {
    const taken = `${d.data}.replaced-20260923-120000`;
    Deno.mkdirSync(taken);
    for (let n = 2; n <= 1000; n++) Deno.mkdirSync(`${taken}-${n}`);
    const src = join(base, "archive");
    Deno.mkdirSync(src);
    Deno.writeTextFileSync(join(src, "state.db"), "ARCHIVE");
    const r = await run(cmdRestore, [src]);
    assertEquals(r.exited, 1, r.out);
    assertStringIncludes(r.out, "1000 names already taken");
    assertStringIncludes(r.out, "the previous data was not moved");
    assertEquals(Deno.readTextFileSync(d.stateDb), "LIVE");
  } finally {
    globalThis.Date = RealDate;
    await done(base);
  }
});

// Signals arriving at a copy, driven from OUTSIDE (the parent sends them) —
// the child's `Deno.copyFile` is stubbed so the test controls how long a
// file takes.
async function signalledCopy(opts: {
  verb: "backup" | "restore";
  files: number;
  /** The stub: "log" = copy, logging each file; "hang" = never finish. */
  copy: "log" | "hang";
  signals: Deno.Signal[];
}): Promise<{ code: number; out: string; base: string }> {
  const base = await tempDir(`am-atomic-sig-${opts.verb}-`);
  const data = new URL("../src/am/am-cmd-data.ts", import.meta.url).href;
  const dirs = new URL("../src/server/app-dirs.ts", import.meta.url).href;
  const target = join(base, "target");
  if (opts.verb === "restore") {
    Deno.mkdirSync(target);
    for (let i = 0; i < opts.files; i++) {
      const name = i === 0 ? "state.db" : `f${i}.db`; // state.db: an archive
      Deno.writeTextFileSync(join(target, name), "ARCHIVE");
    }
  }
  const code = `
    import { cmdBackup, cmdRestore } from ${JSON.stringify(data)};
    import { appDirs, ensureAppDirs } from ${JSON.stringify(dirs)};
    const d = appDirs("sigapp");
    ensureAppDirs(d);
    Deno.writeTextFileSync(d.stateDb, "LIVE");
    if (${opts.verb === "backup"}) {
      for (let i = 1; i < ${opts.files}; i++) {
        Deno.writeTextFileSync(d.data + "/f" + i + ".db", "B");
      }
    }
    const orig = Deno.copyFile;
    Deno.copyFile = async (f, t) => {
      console.error("COPY " + f);
      ${
    opts.copy === "hang"
      ? `console.error("PARKED"); await new Promise(() => {}); // aio-ok`
      : `console.error("PARKED"); await new Promise((r) => setTimeout(r, 400));
         return orig(f, t);`
  }
    };
    setInterval(() => {}, 1000); // the loop stays up while a copy hangs
    await ${opts.verb === "backup" ? "cmdBackup" : "cmdRestore"}([${
    JSON.stringify(target)
  }], { app: "sigapp", json: true });
    Deno.exit(0);
  `;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--config",
      new URL("../deno.json", import.meta.url).pathname,
      code,
    ],
    env: { AIO_APPS_DIR: join(base, "apps"), NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let err = "";
  const r = child.stderr.getReader();
  const dec = new TextDecoder();
  const until = async (s: string) => {
    const deadline = Date.now() + 30_000;
    while (!err.includes(s) && Date.now() < deadline) {
      const { value, done } = await r.read();
      if (done) break;
      err += dec.decode(value);
    }
  };
  await until("PARKED");
  if (!err.includes("PARKED")) {
    throw new Error(`never reached its copy:\n${err}`);
  }
  for (const s of opts.signals) {
    child.kill(s);
    await new Promise((res) => setTimeout(res, 150));
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* aio-ok: exited in time */ }
  }, 10_000);
  const status = await child.status;
  clearTimeout(timer);
  await until("\u0000"); // drain what is left
  r.releaseLock();
  const out = dec.decode(await new Response(child.stdout).arrayBuffer());
  return { code: status.code, out: out + err, base };
}

Deno.test({
  name:
    "am backup: one signal stops the copy at the NEXT file — later files are never copied",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const r = await signalledCopy({
      verb: "backup",
      files: 4,
      copy: "log",
      signals: ["SIGTERM"],
    });
    try {
      assertEquals(r.code, 143, r.out);
      assertEquals(r.out.match(/^COPY /gm)?.length, 1, r.out);
      assertEquals(siblings(join(r.base, "target"), "target"), []);
    } finally {
      await dropTempDir(r.base);
    }
  },
});

Deno.test({
  name:
    "am backup: a SECOND signal abandons the file in flight — exits now, no partial",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const t0 = Date.now();
    const r = await signalledCopy({
      verb: "backup",
      files: 1,
      copy: "hang",
      signals: ["SIGINT", "SIGINT"],
    });
    try {
      assertEquals(r.code, 130, r.out); // the FIRST signal names the exit
      assert(Date.now() - t0 < 9_000, "the second signal was not honoured");
      assertStringIncludes(r.out, "interrupted (SIGINT)");
      assertEquals(siblings(join(r.base, "target"), "target"), []);
    } finally {
      await dropTempDir(r.base);
    }
  },
});

Deno.test({
  name: "am restore: a SECOND signal abandons the copy — data/ untouched, 143",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const r = await signalledCopy({
      verb: "restore",
      files: 1,
      copy: "hang",
      signals: ["SIGTERM", "SIGTERM"],
    });
    try {
      assertEquals(r.code, 143, r.out);
      const d = join(r.base, "apps", "sigapp", "data");
      assertEquals(Deno.readTextFileSync(join(d, "state.db")), "LIVE");
      assertEquals(siblings(d, "data.restoring-"), [], "staging left");
    } finally {
      await dropTempDir(r.base);
    }
  },
});

// "Is the app running?" asks the lock's OWNER, not its pid: a lock a crash
// left behind names a pid the kernel may have handed to anything since —
// here pid 1, alive, with a start token it never had. Asked by pid alone,
// backup refused ("is running (pid 1)") and restore refused to touch data/
// for an app that was not running at all.
Deno.test({
  name: "am backup/restore: a recycled pid in a stale lock is not 'running'",
  ignore: Deno.build.os !== "linux", // a kernel start token to disagree with
  fn: async () => {
    const { base, d } = await world();
    try {
      const stale = () =>
        writeLock({
          appId: "atomicapp",
          pid: 1,
          port: 0,
          startedAt: 0,
          status: "started",
          cwd: "/",
          home: d.home,
          startToken: "999999999999",
        });
      stale();
      const dest = join(base, "bk");
      const b = await run(cmdBackup, [dest]);
      assertEquals(b.exited, null, b.out);
      assert(!b.out.includes("is running"), b.out);
      assertEquals(Deno.readTextFileSync(join(dest, "state.db")), "LIVE");
      stale();
      Deno.writeTextFileSync(join(dest, "state.db"), "ARCHIVE");
      const r = await run(cmdRestore, [dest]);
      assertEquals(r.exited, null, r.out);
      assertEquals(Deno.readTextFileSync(d.stateDb), "ARCHIVE");
    } finally {
      await done(base);
    }
  },
});
