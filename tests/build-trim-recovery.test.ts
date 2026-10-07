// The compile-window trim (§4) — getting the files BACK. The trim moves
// package files out of node_modules for the length of a compile; every way
// that window can end badly (a kill, Ctrl-C, a restore that fails, a
// reinstall in between, a second build beside it) must leave the tree whole
// and never lose the only copy of a file.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, SEPARATOR } from "@std/path";
import {
  recoverInterruptedLinks,
  withDevExcluded,
} from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { linkDir } from "./symlink-helper.ts";

const exists = (p: string) => Deno.lstat(p).then(() => true).catch(() => false);
const UNIX = Deno.build.os !== "windows";

/** Write `<nm>/.deno/<entry>/node_modules/<pkg>/<rel>`. */
async function denoEntryFile(
  nm: string,
  entry: string,
  pkg: string,
  rel: string,
  body = "x",
): Promise<string> {
  const p = join(nm, ".deno", entry, "node_modules", pkg, rel);
  await Deno.mkdir(join(p, ".."), { recursive: true });
  await Deno.writeTextFile(p, body);
  return p;
}

/** Link `node_modules/<name>` at the `.deno` entry, the way deno install does. */
async function link(nm: string, entry: string, pkg: string): Promise<void> {
  await Deno.mkdir(join(nm, pkg, ".."), { recursive: true });
  await linkDir(`.deno/${entry}/node_modules/${pkg}`, join(nm, pkg));
}

/** A killed build's leftovers: `files` (rel → body) in mirror `id`, a journal
 *  naming `rels`. `id` "" is the un-stamped pair an older aio wrote. */
async function leftAside(
  tmp: string,
  id: string,
  rels: string[],
  files: Record<string, string>,
): Promise<{ mirror: string; journal: string }> {
  const mirror = join(tmp, ".aio", id ? `trim.${id}` : "trim");
  const journal = join(
    tmp,
    ".aio",
    id ? `trim-journal.${id}.json` : "trim-journal.json",
  );
  for (const [rel, body] of Object.entries(files)) {
    await Deno.mkdir(join(mirror, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(mirror, rel), body);
  }
  await Deno.writeTextFile(journal, JSON.stringify(rels));
  return { mirror, journal };
}

/** Run `fn`, returning what it sent to `console.warn` / `console.log`. */
async function said(
  fn: () => Promise<unknown>,
): Promise<{ warns: string[]; logs: string[] }> {
  const warns: string[] = [], logs: string[] = [];
  const w = console.warn, l = console.log;
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = w;
    console.log = l;
  }
  return { warns, logs };
}

const build = (nm: string) => withDevExcluded(nm, () => Promise.resolve(true));

async function trimFilesIn(tmp: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(join(tmp, ".aio"))) out.push(e.name);
  } catch { /* no .aio */ }
  return out.sort();
}

const REL = "a@1.0.0/node_modules/a/dist/index.js.map";

Deno.test("trim recovery: a killed build's mirror is back BEFORE the next compile window opens", async () => {
  const tmp = await tempDir("trim-rec-");
  try {
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "a@1.0.0", "a", "index.js");
    await link(nm, "a@1.0.0", "a");
    // One an older aio left (un-stamped), one a stamped build whose pid is gone.
    const dead = await new Deno.Command(Deno.execPath(), {
      args: ["eval", ""],
    }).spawn();
    await dead.status;
    await leftAside(tmp, "", [REL], { [REL]: "MAP" });
    const other = "a@1.0.0/node_modules/a/README.md";
    await leftAside(tmp, `${dead.pid}-0123abcd`, [other], { [other]: "DOC" });

    // Trim off: whatever is in the tree during the window, recovery put there.
    Deno.env.set("AIO_SKIP_TRIM", "1");
    let seen: boolean[] = [];
    await withDevExcluded(nm, async () => {
      seen = [
        await exists(join(nm, ".deno", REL)),
        await exists(join(nm, ".deno", other)),
      ];
      return true;
    });
    assertEquals(seen, [true, true]);
    assertEquals(await Deno.readTextFile(join(nm, ".deno", REL)), "MAP");
    assertEquals(await trimFilesIn(tmp), [], "mirrors + journals are consumed");
  } finally {
    Deno.env.delete("AIO_SKIP_TRIM");
    await dropTempDir(tmp);
  }
});

Deno.test("trim recovery: `deno task build`'s first step restores it too, with no compile", async () => {
  const tmp = await tempDir("trim-rec-build-");
  try {
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "a@1.0.0", "a", "index.js");
    await leftAside(tmp, "", [REL], { [REL]: "MAP" });
    await recoverInterruptedLinks(nm);
    assert(await exists(join(nm, ".deno", REL)));
    assertEquals(await trimFilesIn(tmp), []);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim recovery: a LIVE build's mirror is left alone (per-build journal)", async () => {
  const tmp = await tempDir("trim-rec-live-");
  try {
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "a@1.0.0", "a", "index.js");
    await link(nm, "a@1.0.0", "a");
    // Another build, alive (our parent stands in), mid-compile: its files are
    // aside ON PURPOSE — putting them back would re-embed them in ITS binary.
    const { mirror, journal } = await leftAside(
      tmp,
      `${Deno.ppid}-0123abcd`,
      [REL],
      { [REL]: "MAP" },
    );
    await build(nm);
    assert(
      await exists(join(mirror, REL)),
      "the live build's file stays aside",
    );
    assert(await exists(journal), "…and so does its journal");
    assert(!(await exists(join(nm, ".deno", REL))));
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim: the journal names a path BEFORE that path moves", async () => {
  const tmp = await tempDir("trim-order-");
  const rename = Deno.rename;
  try {
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "a@1.0.0", "a", "dist/index.js.map");
    await denoEntryFile(nm, "a@1.0.0", "a", "README.md");
    await link(nm, "a@1.0.0", "a");
    const journalled: boolean[] = [];
    // A kill between a move and its journal entry strands the file for good,
    // so observe the journal at the instant of every move out of `.deno`.
    Deno.rename = async (from, to) => {
      // The journal lists `.deno`-relative paths with `/` on every OS.
      const rel = String(from).split(`${SEPARATOR}.deno${SEPARATOR}`)[1]
        ?.replaceAll(SEPARATOR, "/");
      if (rel && String(to).includes(`${SEPARATOR}.aio${SEPARATOR}trim.`)) {
        const names = (await trimFilesIn(tmp)).filter((n) =>
          /^trim-journal\..+\.json$/.test(n)
        );
        const listed = names.length === 1 &&
          (JSON.parse(
            await Deno.readTextFile(join(tmp, ".aio", names[0]!)),
          ) as string[]).includes(rel);
        journalled.push(listed);
      }
      return rename(from, to);
    };
    await build(nm);
    assertEquals(journalled, [true, true]);
  } finally {
    Deno.rename = rename;
    await dropTempDir(tmp);
  }
});

Deno.test({
  name:
    "trim recovery: a restore that fails keeps the only copy AND its journal; the next build finishes it",
  ignore: !UNIX || Deno.uid() === 0, // the restore is refused by a read-only directory (POSIX mode)
  async fn() {
    const tmp = await tempDir("trim-rec-fail-");
    const dist = join(tmp, "node_modules/.deno/a@1.0.0/node_modules/a/dist");
    try {
      const nm = join(tmp, "node_modules");
      await denoEntryFile(nm, "a@1.0.0", "a", "dist/index.js");
      await denoEntryFile(nm, "b@1.0.0", "b", "index.js.map");
      await link(nm, "a@1.0.0", "a");
      await link(nm, "b@1.0.0", "b");
      const { mirror, journal } = await leftAside(tmp, "", [REL], {
        [REL]: "ONLY COPY",
        // not in the journal: nobody knows whose it is, so nobody deletes it
        "stray.bin": "STRAY",
      });
      await Deno.chmod(dist, 0o555); // the restore cannot rename into it
      const first = await said(() => build(nm));
      await Deno.chmod(dist, 0o755);

      assertEquals(first.warns.length, 1, first.warns.join("\n"));
      assertStringIncludes(first.warns[0]!, "could not put back 1 path(s)");
      assertStringIncludes(first.warns[0]!, "deno install");
      assertEquals(await Deno.readTextFile(join(mirror, REL)), "ONLY COPY");
      assertEquals(JSON.parse(await Deno.readTextFile(journal)), [REL]);
      // This build trimmed too (b's map) — and put ITS files back.
      assert(
        await exists(join(nm, ".deno/b@1.0.0/node_modules/b/index.js.map")),
      );

      const second = await said(() => build(nm));
      assertEquals(second.warns, []);
      assertEquals(
        await Deno.readTextFile(join(nm, ".deno", REL)),
        "ONLY COPY",
      );
      assert(!(await exists(journal)), "the journal is consumed");
      assertEquals(
        await Deno.readTextFile(join(mirror, "stray.bin")),
        "STRAY",
        "a mirror still holding a file is never deleted",
      );
    } finally {
      await Deno.chmod(dist, 0o755).catch(() => {});
      await dropTempDir(tmp);
    }
  },
});

Deno.test("trim recovery: node_modules reinstalled after a killed build — merged, cleared, silent", async () => {
  const tmp = await tempDir("trim-rec-reinstall-");
  try {
    const nm = join(tmp, "node_modules");
    const dir = "a@1.0.0/node_modules/a/test";
    const doc = "a@1.0.0/node_modules/a/README.md";
    await denoEntryFile(nm, "a@1.0.0", "a", "index.js");
    // The reinstall re-created what the killed build still holds aside…
    await denoEntryFile(nm, "a@1.0.0", "a", "test/fx.bin", "FRESH");
    await denoEntryFile(nm, "a@1.0.0", "a", "README.md", "FRESH");
    await link(nm, "a@1.0.0", "a");
    await leftAside(tmp, "", [dir, doc], {
      [`${dir}/fx.bin`]: "STALE",
      [`${dir}/deep/only-aside.bin`]: "KEEP",
      [doc]: "STALE",
    });

    const first = await said(() => build(nm));
    assertEquals(first.warns, []);
    // …so the tree's own copy wins, and only what it lacks moves back.
    const at = (rel: string) => Deno.readTextFile(join(nm, ".deno", rel));
    assertEquals(await at(`${dir}/fx.bin`), "FRESH");
    assertEquals(await at(doc), "FRESH");
    assertEquals(await at(`${dir}/deep/only-aside.bin`), "KEEP");
    assertEquals(await trimFilesIn(tmp), []);
    assertEquals((await said(() => build(nm))).warns, []);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim: a restore that cannot finish never costs the project its links", async () => {
  const tmp = await tempDir("trim-rec-links-");
  try {
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "esbuild@0.24.2", "esbuild", "bin/esbuild");
    await link(nm, "esbuild@0.24.2", "esbuild");
    await denoEntryFile(nm, "a@1.0.0", "a", "docs/x.md");
    await link(nm, "a@1.0.0", "a");
    const docs = join(nm, ".deno/a@1.0.0/node_modules/a/docs");
    const { warns } = await said(() =>
      withDevExcluded(nm, async () => {
        assert(!(await exists(join(nm, "esbuild"))), "held aside");
        // something replaces the directory during the compile window
        await Deno.remove(docs, { recursive: true });
        await Deno.writeTextFile(docs, "now a file");
        return true;
      })
    );
    assertEquals(warns.length, 1, warns.join("\n"));
    assert(await exists(join(nm, "esbuild")), "node_modules/esbuild is back");
    const left = await trimFilesIn(tmp);
    assertEquals(left.length, 2, "this build's mirror + journal are kept");
    const mirror = left.find((n) => n.startsWith("trim."))!;
    assert(
      await exists(
        join(tmp, ".aio", mirror, "a@1.0.0/node_modules/a/docs/x.md"),
      ),
      "the file it could not put back is still there",
    );

    // Fixed by hand, the NEXT build (same process, same pid) finishes it.
    await Deno.remove(docs);
    assertEquals((await said(() => build(nm))).warns, []);
    assert(await exists(join(docs, "x.md")), "x.md is back");
    assertEquals(await trimFilesIn(tmp), []);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim: the build's own lock + link journal are --exclude'd from the binary", async () => {
  const tmp = await tempDir("trim-bookkeeping-");
  try {
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "a@1.0.0", "a", "index.js");
    await link(nm, "a@1.0.0", "a");
    let excludes: string[] = [];
    const { logs } = await said(() =>
      withDevExcluded(nm, (e) => {
        excludes = e;
        return Promise.resolve(true);
      })
    );
    // …and are not counted as packages left out: this project has none.
    assertEquals(logs.filter((l) => l.startsWith("excluding")), [
      "excluding 0 dev dirs, removed 0 symlinks",
    ]);
    const names = excludes.map((e) => e.slice(nm.length + 1));
    assert(names.includes(".aio-build-lock"), names.join(", "));
    assert(names.includes(".aio-build-lock.id"), names.join(", "));
    assert(
      names.some((n) => /^\.aio-build-links\.\d+-[0-9a-f]+\.json$/.test(n)),
      names.join(", "),
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test({
  name:
    "trim: a mirror on another filesystem — one warning, nothing moved, no false count",
  ignore: Deno.build.os !== "linux", // the other filesystem is /dev/shm
  async fn() {
    const tmp = await tempDir("trim-exdev-");
    let shm: string | undefined;
    try {
      // node_modules reached through a link onto another device: every rename
      // into `.aio/` fails EXDEV.
      // aio-ok: must be on ANOTHER device than the registry's dirs (EXDEV)
      shm = await Deno.makeTempDir({ dir: "/dev/shm", prefix: "aio-trim-" })
        .catch(() => undefined);
      if (!shm || (await Deno.stat(shm)).dev === (await Deno.stat(tmp)).dev) {
        return; // one filesystem here — nothing to cross
      }
      await Deno.symlink(shm, join(tmp, "node_modules"));
      const nm = join(tmp, "node_modules");
      const files = [
        await denoEntryFile(nm, "a@1.0.0", "a", "a.js.map"),
        await denoEntryFile(nm, "a@1.0.0", "a", "b.js.map"),
        await denoEntryFile(nm, "a@1.0.0", "a", "README.md"),
      ];
      await link(nm, "a@1.0.0", "a");
      let seen: boolean[] = [];
      const { warns, logs } = await said(() =>
        withDevExcluded(nm, async () => {
          seen = await Promise.all(files.map(exists));
          return true;
        })
      );
      assertEquals(seen, [true, true, true]);
      assertEquals(warns.length, 1, warns.join("\n"));
      assertStringIncludes(warns[0]!, "another filesystem");
      assertEquals(logs.filter((l) => l.includes("held aside")), []);
      assertEquals(await trimFilesIn(tmp), []);
    } finally {
      if (shm) await Deno.remove(shm, { recursive: true });
      await dropTempDir(tmp);
    }
  },
});

Deno.test({
  name: "trim: SIGINT / SIGTERM mid-compile puts the tree back before exiting",
  ignore: !UNIX, // Deno.kill is TerminateProcess on Windows: no signal reaches the build
  async fn() {
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const tmp = await tempDir("trim-signal-");
      try {
        const nm = join(tmp, "node_modules");
        const map = await denoEntryFile(nm, "a@1.0.0", "a", "index.js.map");
        await link(nm, "a@1.0.0", "a");
        await denoEntryFile(nm, "esbuild@0.24.2", "esbuild", "bin/esbuild");
        await link(nm, "esbuild@0.24.2", "esbuild");
        const marker = join(tmp, "in-window");
        const script = join(tmp, "hang.ts");
        const mod = fromFileUrl(
          new URL("../src/build/build-compile.ts", import.meta.url),
        );
        await Deno.writeTextFile(
          script,
          `import { withDevExcluded } from ${JSON.stringify(mod)};\n` +
            `await withDevExcluded(${JSON.stringify(nm)}, async () => {\n` +
            `  await Deno.writeTextFile(${JSON.stringify(marker)}, "in");\n` +
            `  await new Promise((r) => setTimeout(r, 120_000));\n` +
            `  return true;\n});\n`,
        );
        const child = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            "--no-check",
            "--config",
            fromFileUrl(new URL("../deno.json", import.meta.url)),
            script,
          ],
          stdout: "null",
          stderr: "null",
        }).spawn();
        try {
          for (let i = 0; i < 600 && !(await exists(marker)); i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
          assert(await exists(marker), "the build never reached its window");
          assert(!(await exists(map)), "precondition: the map is held aside");
          assert(!(await exists(join(nm, "esbuild"))), "…and so is the link");
          child.kill(sig);
          assertEquals((await child.status).code, code, sig);
        } finally {
          try {
            child.kill("SIGKILL");
          } catch { /* already exited */ }
          await child.status;
        }
        assert(await exists(map), `${sig}: the map is back`);
        assert(await exists(join(nm, "esbuild")), `${sig}: the link is back`);
        assertEquals(await trimFilesIn(tmp), [], sig);
        // …and the build's own bookkeeping (lock, stamp, link journal) is gone.
        const own: string[] = [];
        for await (const e of Deno.readDir(nm)) {
          if (e.name.startsWith(".aio-build-")) own.push(e.name);
        }
        assertEquals(own, [], sig);
      } finally {
        await dropTempDir(tmp);
      }
    }
  },
});

Deno.test("trim recovery: a build killed before its FIRST journal landed leaves nothing — the empty mirror goes with the .tmp", async () => {
  const tmp = await tempDir("trim-rec-tmp-");
  try {
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "a@1.0.0", "a", "index.js");
    const dead = await new Deno.Command(Deno.execPath(), {
      args: ["eval", ""],
    }).spawn();
    await dead.status;
    const aio = join(tmp, ".aio");
    const plant = async (id: string, file?: string) => {
      const mirror = join(aio, `trim.${id}`);
      await Deno.mkdir(join(mirror, "a@1.0.0", "node_modules"), {
        recursive: true,
      });
      if (file) await Deno.writeTextFile(join(mirror, file), "ONLY COPY");
      await Deno.writeTextFile(
        join(aio, `trim-journal.${id}.json.tmp`),
        JSON.stringify([REL]),
      );
    };
    await plant(`${dead.pid}-0123abcd`);
    await recoverInterruptedLinks(nm);
    assertEquals(await trimFilesIn(tmp), []);

    // A mirror that holds a file is somebody's only copy: never removed.
    await plant(`${dead.pid}-4567abcd`, "stray.bin");
    await recoverInterruptedLinks(nm);
    assertEquals(await trimFilesIn(tmp), [`trim.${dead.pid}-4567abcd`]);
    assertEquals(
      await Deno.readTextFile(
        join(aio, `trim.${dead.pid}-4567abcd`, "stray.bin"),
      ),
      "ONLY COPY",
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim: a finished build leaves no signal listener behind", async () => {
  const tmp = await tempDir("trim-listeners-");
  const add = Deno.addSignalListener, remove = Deno.removeSignalListener;
  const live = new Set<unknown>();
  let added = 0;
  try {
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "a@1.0.0", "a", "index.js");
    await link(nm, "a@1.0.0", "a");
    Deno.addSignalListener = (sig, fn) => {
      added++;
      live.add(fn);
      add(sig, fn);
    };
    Deno.removeSignalListener = (sig, fn) => {
      live.delete(fn);
      remove(sig, fn);
    };
    await build(nm);
    assert(added > 0, "precondition: the build listens for signals");
    assertEquals(live.size, 0);
  } finally {
    Deno.addSignalListener = add;
    Deno.removeSignalListener = remove;
    // aio-ok: a listener the build left (the failure above) must not outlive the test
    for (const fn of live) {
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        try {
          remove(sig, fn as () => void);
        } catch { /* aio-ok: not registered for this signal */ }
      }
    }
    await dropTempDir(tmp);
  }
});

Deno.test({
  name:
    "trim: a signal DURING the hold-aside pass stops the pass, never runs the compile, and puts everything back",
  ignore: !UNIX, // Deno.kill is TerminateProcess on Windows: no signal reaches the build
  async fn() {
    // The pass is stopped at its first link removal (`link`) or at its first
    // file move (`move`); the signal lands there. What must hold: nothing
    // more is held aside after the signal, the restore waits for the step in
    // flight (a restore beside it puts a link back and then watches the pass
    // remove it), and the compile callback never runs.
    for (
      const [at, sig, code] of [
        ["link", "SIGINT", 130],
        ["move", "SIGTERM", 143],
      ] as const
    ) {
      const tmp = await tempDir("trim-signal-pass-");
      try {
        const nm = join(tmp, "node_modules");
        const maps = [
          await denoEntryFile(nm, "a@1.0.0", "a", "index.js.map"),
          await denoEntryFile(nm, "a@1.0.0", "a", "other.js.map"),
        ];
        await link(nm, "a@1.0.0", "a");
        await denoEntryFile(nm, "esbuild@0.24.2", "esbuild", "bin/esbuild");
        await link(nm, "esbuild@0.24.2", "esbuild");
        await denoEntryFile(nm, "electron@44.0.0", "electron", "index.js");
        await link(nm, "electron@44.0.0", "electron");
        const scope = join(nm, "@empty"); // an empty scope dir is removed whole
        await Deno.mkdir(scope);
        const marker = join(tmp, "in-pass");
        const ranFn = join(tmp, "fn-ran");
        const renames = join(tmp, "renames");
        const script = join(tmp, "hang.ts");
        const mod = fromFileUrl(
          new URL("../src/build/build-compile.ts", import.meta.url),
        );
        await Deno.writeTextFile(
          script,
          `import { withDevExcluded } from ${JSON.stringify(mod)};
const nm = ${JSON.stringify(nm)};
// The step in flight goes on 100 ms after the signal (the build's own
// listener has run by then) — or the moment the restore is seen finishing
// while the step is still in flight.
let signalled = () => {};
const got = new Promise<void>((r) => signalled = r);
for (const s of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(s, () => setTimeout(signalled, 100));
}
let release: (() => void) | undefined;
let hung = false;
const hang = async () => {
  hung = true;
  Deno.writeTextFileSync(${JSON.stringify(marker)}, "in");
  await new Promise<void>((r) => {
    release = r;
    got.then(r);
  });
  release = undefined;
};
const remove = Deno.remove, rename = Deno.rename;
Deno.remove = async (p, o) => {
  const path = String(p);
  if (path.includes(".aio-build-links.")) release?.(); // the restore's last step
  else if (
    ${JSON.stringify(at)} === "link" && !hung &&
    (path === nm + "/esbuild" || path === nm + "/electron")
  ) {
    await hang();
    return Deno.removeSync(path);
  }
  return remove(p, o);
};
Deno.rename = async (from, to) => {
  Deno.writeTextFileSync(${JSON.stringify(renames)}, String(to).slice(${
            tmp.length + 1
          }) + "\\n", { append: true });
  if (${
            JSON.stringify(at)
          } === "move" && !hung && String(to).includes("/.aio/trim.")) {
    await hang();
  }
  return rename(from, to);
};
await withDevExcluded(nm, () => {
  Deno.writeTextFileSync(${JSON.stringify(ranFn)}, "ran");
  return Promise.resolve(true);
});
`,
        );
        const child = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            "--no-check",
            "--config",
            fromFileUrl(new URL("../deno.json", import.meta.url)),
            script,
          ],
          stdout: "null",
          stderr: "null",
        }).spawn();
        try {
          for (let i = 0; i < 600 && !(await exists(marker)); i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
          assert(await exists(marker), `${at}: the pass never got there`);
          child.kill(sig);
          assertEquals((await child.status).code, code, at);
        } finally {
          try {
            child.kill("SIGKILL");
          } catch { /* already exited */ }
          await child.status;
        }
        assert(!(await exists(ranFn)), `${at}: the compile ran after ${sig}`);
        for (const m of maps) assert(await exists(m), `${at}: ${m} is back`);
        for (const l of ["a", "esbuild", "electron"]) {
          assert(await exists(join(nm, l)), `${at}: the ${l} link is back`);
        }
        assert(await exists(scope), `${at}: the scope dir is back`);
        assertEquals(await trimFilesIn(tmp), [], at);
        const renamed = (await Deno.readTextFile(renames)).trim().split("\n");
        const journal = /^node_modules\/\.aio-build-links\.[^/]+\.json$/;
        if (at === "link") {
          // One link was journalled (the one in flight). No second link, no
          // scope dir, no trim journal, no move.
          assertEquals(renamed.length, 1, renamed.join("\n"));
          assert(journal.test(renamed[0]!), renamed[0]);
        } else {
          assertEquals(
            renamed.filter((r) => r.startsWith(".aio/trim.")).length,
            1,
            `one move was in flight, none followed:\n${renamed.join("\n")}`,
          );
        }
        const own: string[] = [];
        for await (const e of Deno.readDir(nm)) {
          if (e.name.startsWith(".aio-build-")) own.push(e.name);
        }
        assertEquals(own, [], at);
      } finally {
        await dropTempDir(tmp);
      }
    }
  },
});
