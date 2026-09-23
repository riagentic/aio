// A failed `am create` takes back exactly what it wrote — and nothing else.
//
// It used to exit 1 and leave the half-scaffold: a `deno.json` and a
// `.gitignore` in a directory the user then cleaned by hand, and under
// `--force` their own files overwritten. `writeScaffold` records every path as
// it creates or changes it (`ScaffoldLedger`) and undoes from that record,
// never from a listing of the directory.
//
// The failure here is a real filesystem one — a scaffold entry nested under
// another entry that is a FILE (ENOTDIR) — not an injected fault.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { writeScaffold } from "../src/am/am-cmd-create.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const there = (p: string) => Deno.lstat(p).then(() => true, () => false);
const names = async (dir: string) =>
  (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort();

/** Files that write fine, then one that cannot: `src/app.ts` is a file, so
 *  `src/app.ts/boom` fails half-way through the scaffold. */
const DOOMED = {
  "deno.json": '{"name":"scaffolded"}\n',
  ".gitignore": "dep/\n",
  "src/app.ts": "export {};\n",
  "src/app.ts/boom": "never written\n",
};

Deno.test("create undo: a directory create MADE is removed whole", async () => {
  const base = await tempDir("am-create-undo-fresh-");
  try {
    const dir = join(base, "freshapp");
    const e = await assertRejects(() => writeScaffold(dir, DOOMED));
    assert(!(e as Error).message.includes("undo incomplete"), String(e));
    assertEquals(await there(dir), false, "the half-scaffold was left behind");
    assertEquals(await names(base), [], "nothing else appeared beside it");
  } finally {
    await dropTempDir(base);
  }
});

Deno.test("create undo: levels above the target that create made go too", async () => {
  const base = await tempDir("am-create-undo-nested-");
  try {
    await assertRejects(() => writeScaffold(join(base, "a", "b"), DOOMED));
    assertEquals(await names(base), []);
  } finally {
    await dropTempDir(base);
  }
});

Deno.test("create undo: --force into an existing dir restores it exactly", async () => {
  const base = await tempDir("am-create-undo-force-");
  try {
    const dir = join(base, "mine");
    await Deno.mkdir(join(dir, "notes"), { recursive: true });
    await Deno.writeTextFile(join(dir, "user.txt"), "keep me\n");
    await Deno.writeTextFile(join(dir, "notes", "n.md"), "mine\n");
    await Deno.writeTextFile(join(dir, "deno.json"), '{"mine":true}\n');
    const e = await assertRejects(() => writeScaffold(dir, DOOMED));
    assert(!(e as Error).message.includes("undo incomplete"), String(e));
    assertEquals(await names(dir), ["deno.json", "notes", "user.txt"]);
    assertEquals(await Deno.readTextFile(join(dir, "user.txt")), "keep me\n");
    assertEquals(await Deno.readTextFile(join(dir, "notes", "n.md")), "mine\n");
    assertEquals(
      await Deno.readTextFile(join(dir, "deno.json")),
      '{"mine":true}\n',
      "an overwritten file is put back, not deleted",
    );
  } finally {
    await dropTempDir(base);
  }
});

Deno.test("create undo: a scaffold that succeeds is left alone", async () => {
  const base = await tempDir("am-create-undo-ok-");
  try {
    const dir = join(base, "okapp");
    const ok = { ...DOOMED } as Record<string, string>;
    delete ok["src/app.ts/boom"];
    await writeScaffold(dir, ok);
    assertEquals(await names(dir), [".gitignore", "deno.json", "src"]);
    assert(await there(join(dir, "src", "app.ts")));
  } finally {
    await dropTempDir(base);
  }
});

Deno.test("create undo: a symlinked file in the target is never written THROUGH", async () => {
  const base = await tempDir("am-create-undo-link-");
  try {
    const outside = join(base, "outside.json");
    await Deno.writeTextFile(outside, '{"outside":true}\n');
    const dir = join(base, "mine");
    await Deno.mkdir(dir);
    await Deno.symlink(outside, join(dir, "deno.json"));

    // Failure: the link is back, pointing where it did; the file it points
    // at was never touched.
    await assertRejects(() => writeScaffold(dir, DOOMED));
    assertEquals(await Deno.readLink(join(dir, "deno.json")), outside);
    assertEquals(await Deno.readTextFile(outside), '{"outside":true}\n');

    // Success: the app gets its own deno.json; the outside file is intact.
    const ok = { ...DOOMED } as Record<string, string>;
    delete ok["src/app.ts/boom"];
    await writeScaffold(dir, ok);
    assert((await Deno.lstat(join(dir, "deno.json"))).isFile);
    assertEquals(await Deno.readTextFile(outside), '{"outside":true}\n');
  } finally {
    await dropTempDir(base);
  }
});

Deno.test("create: an EMPTY real dep/aio is replaced by the link, and restored on undo", async () => {
  const base = await tempDir("am-create-undo-emptydep-");
  try {
    const ok = { ...DOOMED } as Record<string, string>;
    delete ok["src/app.ts/boom"];
    // Success: replaced by the link, as it always was.
    const good = join(base, "good");
    await Deno.mkdir(join(good, "dep", "aio"), { recursive: true });
    await writeScaffold(good, ok, { aioPath: base });
    assertEquals(await Deno.readLink(join(good, "dep", "aio")), base);
    // Failure AFTER the link: `.aio` is a user FILE, so the pin step's mkdir
    // fails — and the empty directory comes back, empty.
    const bad = join(base, "bad");
    await Deno.mkdir(join(bad, "dep", "aio"), { recursive: true });
    await Deno.writeTextFile(join(bad, ".aio"), "the user's\n");
    await assertRejects(() =>
      writeScaffold(bad, ok, { aioPath: base, pinnedVersion: `path:${base}` })
    );
    const st = await Deno.lstat(join(bad, "dep", "aio"));
    assert(st.isDirectory && !st.isSymlink, "dep/aio was not restored");
    assertEquals(await names(join(bad, "dep", "aio")), []);
    assertEquals(await Deno.readTextFile(join(bad, ".aio")), "the user's\n");
    assertEquals(await names(bad), [".aio", "dep"]);
  } finally {
    await dropTempDir(base);
  }
});

Deno.test("create: a NON-empty real dep/aio is the user's — refused, contents intact", async () => {
  const base = await tempDir("am-create-undo-depdir-");
  try {
    const dir = join(base, "mine");
    await Deno.mkdir(join(dir, "dep", "aio"), { recursive: true });
    await Deno.writeTextFile(join(dir, "dep", "aio", "mod.ts"), "vendored\n");
    const ok = { ...DOOMED } as Record<string, string>;
    delete ok["src/app.ts/boom"];
    await assertRejects(
      () => writeScaffold(dir, ok, { aioPath: base }),
      Error,
      "is not a symlink",
    );
    assertEquals(
      await Deno.readTextFile(join(dir, "dep", "aio", "mod.ts")),
      "vendored\n",
    );
    assertEquals(await names(dir), ["dep"], "the scaffold was undone");
  } finally {
    await dropTempDir(base);
  }
});

Deno.test("create undo: bytes written through a parent symlink or a hard link are put back", async () => {
  const base = await tempDir("am-create-undo-through-");
  try {
    // Outside the app: a directory `src` points at, and a file `deno.json`
    // shares an inode with. `--force` writes through both (as it always
    // has); a failed create must leave both as they were.
    const outside = join(base, "outside");
    await Deno.mkdir(outside);
    await Deno.writeTextFile(join(outside, "app.ts"), "their app\n");
    await Deno.writeTextFile(join(outside, "shared.json"), '{"shared":1}\n');
    const dir = join(base, "mine");
    await Deno.mkdir(dir);
    await Deno.symlink(outside, join(dir, "src"));
    await Deno.link(join(outside, "shared.json"), join(dir, "deno.json"));

    const doomed = {
      "deno.json": '{"name":"scaffolded"}\n',
      "src/app.ts": "export {};\n", // through the dir link: outside/app.ts
      "src/new.ts": "export {};\n", // made through the link
      "src/app.ts/boom": "never written\n", // ENOTDIR — the failure
    };
    await assertRejects(() => writeScaffold(dir, doomed));
    assertEquals(
      await Deno.readTextFile(join(outside, "app.ts")),
      "their app\n",
    );
    assertEquals(
      await Deno.readTextFile(join(outside, "shared.json")),
      '{"shared":1}\n',
    );
    assertEquals(await names(outside), ["app.ts", "shared.json"]);
    assertEquals(await Deno.readLink(join(dir, "src")), outside);
  } finally {
    await dropTempDir(base);
  }
});

// The undo used to swallow EVERY failure — including a failed restore of the
// user's own overwritten deno.json — and report only the original error. Now
// what could not be put back is named, on stderr and in the error itself.
Deno.test("create undo: a restore that FAILS is named, never swallowed", async () => {
  const base = await tempDir("am-create-undo-incomplete-");
  const orig = Deno.writeFile;
  const errs: string[] = [];
  const origErr = console.error;
  try {
    const dir = join(base, "mine");
    await Deno.mkdir(dir);
    await Deno.writeTextFile(join(dir, "deno.json"), '{"mine":true}\n');
    // The scaffold writes with writeTextFile; the undo restores saved bytes
    // with writeFile — the one call made to fail here.
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeFile = () =>
      Promise.reject(new Deno.errors.PermissionDenied("read-only"));
    console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
    const e = await assertRejects(() => writeScaffold(dir, DOOMED));
    const msg = (e as Error).message;
    assert(/^File exists .*src[\\/]app\.ts/.test(msg), `original lost: ${msg}`);
    assertEquals(
      msg.split("\n")[1],
      `  undo incomplete — not put back: ${join(dir, "deno.json")}`,
    );
    assert(msg.includes("undo incomplete"), msg);
    assert(msg.includes(join(dir, "deno.json")), msg);
    assert(!msg.includes("boom"), `a never-made path was reported: ${msg}`);
    assert(errs.some((l) => l.includes("undo incomplete")), errs.join("\n"));
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeFile = orig;
    console.error = origErr;
    await dropTempDir(base);
  }
});

Deno.test({
  name:
    "create undo: a path the failure never created is not an incomplete undo",
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    const base = await tempDir("am-create-undo-absent-");
    const ro = join(base, "mine", "ro");
    try {
      await Deno.mkdir(ro, { recursive: true });
      await Deno.chmod(ro, 0o555);
      // `ro/x.ts` is recorded as made, then its write is refused: at undo it
      // is simply absent — nothing to put back, nothing to report.
      const e = await assertRejects(() =>
        writeScaffold(join(base, "mine"), {
          "deno.json": "{}\n",
          "ro/x.ts": "export {};\n",
        })
      );
      assert(!(e as Error).message.includes("undo incomplete"), String(e));
      assertEquals(await names(join(base, "mine")), ["ro"]);
    } finally {
      await Deno.chmod(ro, 0o755);
      await dropTempDir(base);
    }
  },
});
