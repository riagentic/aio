// A fresh `am create` must pass its own `deno task doctor`.
//
// It did not: the scaffold wrote no deno.lock, the first `deno task` wrote
// one holding only that run's graph, and doctor's lock-coverage check warned
// "deno.lock is missing 8 entries for aio's tools — run `am fix`" on an app
// nobody had touched (and `am fix` needs the network on a cold cache). create
// now seeds the lock's JSR side from the framework's own deno.lock — offline.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { seedLockText, writeScaffold } from "../src/am/am-cmd-create.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");

Deno.test("seedLockText: the framework lock's JSR side, never its npm packages", () => {
  const seed = JSON.parse(
    seedLockText(JSON.stringify({
      version: "5",
      specifiers: {
        "jsr:@std/path@1.1.3": "1.1.3",
        "npm:react@19.1.0": "19.1.0",
      },
      jsr: { "@std/path@1.1.3": { integrity: "x" } },
      npm: { "react@19.1.0": { integrity: "y" } },
      remote: { "https://deno.land/x.ts": "z" },
      workspace: { dependencies: ["npm:react@19.1.0"] },
    }))!,
  );
  assertEquals(seed, {
    version: "5",
    specifiers: { "jsr:@std/path@1.1.3": "1.1.3" },
    jsr: { "@std/path@1.1.3": { integrity: "x" } },
  });
  assertEquals(seedLockText("not json"), null);
  assertEquals(seedLockText(`{"version":"5"}`), null);
});

Deno.test("writeScaffold: seeds deno.lock from the framework, never over the app's own", async () => {
  const dir = await tempDir("create-seed-");
  try {
    await writeScaffold(join(dir, "a"), { "deno.json": "{}" }, {
      aioPath: REPO,
    });
    const lock = JSON.parse(await Deno.readTextFile(join(dir, "a/deno.lock")));
    assert(Object.keys(lock.jsr).length > 0, "no JSR entries seeded");
    assertEquals(lock.npm, undefined);

    await Deno.mkdir(join(dir, "b"));
    await Deno.writeTextFile(join(dir, "b/deno.lock"), "MINE");
    await writeScaffold(join(dir, "b"), { "deno.json": "{}" }, {
      aioPath: REPO,
    });
    assertEquals(await Deno.readTextFile(join(dir, "b/deno.lock")), "MINE");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test({
  name:
    "am create → deno task doctor: a fresh scaffold passes its own lock check",
  async fn() {
    const dir = await tempDir("create-doctor-");
    // A private HOME, but the machine's Deno cache: this must pass offline.
    const denoDir = Deno.env.get("DENO_DIR") ??
      join(
        Deno.env.get("XDG_CACHE_HOME") ?? join(Deno.env.get("HOME")!, ".cache"),
        "deno",
      );
    const env = {
      HOME: join(dir, "home"),
      AIO_APPS_DIR: join(dir, "apps"),
      XDG_CONFIG_HOME: join(dir, "home/.config"),
      XDG_DATA_HOME: join(dir, "home/.local/share"),
      XDG_STATE_HOME: join(dir, "home/.local/state"),
      XDG_CACHE_HOME: join(dir, "home/.cache"),
      DENO_DIR: denoDir,
      NO_COLOR: "1",
    };
    await Deno.mkdir(join(dir, "home"), { recursive: true });
    const run = async (cwd: string, args: string[]) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args,
        cwd,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: o.code,
        said: new TextDecoder().decode(o.stdout) +
          new TextDecoder().decode(o.stderr),
      };
    };
    try {
      const made = await run(dir, [
        "run",
        "-A",
        join(REPO, "src/am.ts"),
        "create",
        "fresh",
        `--mirror=${REPO}`,
        "--json",
      ]);
      assertEquals(made.code, 0, made.said);
      const doc = await run(join(dir, "fresh"), ["task", "doctor"]);
      assert(
        !/deno\.lock is missing/.test(doc.said),
        `a fresh scaffold failed its own doctor:\n${doc.said}`,
      );
      assert(/deno\.lock covers aio's tools/.test(doc.said), doc.said);
    } finally {
      await dropTempDir(dir);
    }
  },
});
