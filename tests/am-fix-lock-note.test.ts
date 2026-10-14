// `am fix` caches the app's entry AND aio's tool entry points, which adds
// their dependencies to `deno.lock` — on purpose. From a field report: a
// fresh clone's `am fix` therefore left the lock modified and said nothing,
// so the drift was found in `git status`. The report line now says the lock
// changed and should be committed.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { lockChangeNote } from "../src/am/am-cmd-fix.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));

Deno.test("am fix: lockChangeNote — a created or changed lock is named; an untouched or absent one is not", () => {
  assertEquals(lockChangeNote(null, null), "");
  assertEquals(lockChangeNote("a", "a"), "");
  assertEquals(lockChangeNote("a", null), "");
  assertStringIncludes(lockChangeNote(null, "a"), "deno.lock was created");
  assertStringIncludes(lockChangeNote("a", "b"), "deno.lock gained entries");
  for (const note of [lockChangeNote(null, "a"), lockChangeNote("a", "b")]) {
    assertStringIncludes(note, "commit it");
  }
});

Deno.test({
  name: "am fix: the cache step SAYS the lock changed, and says nothing " +
    "on the run that leaves it alone",
  async fn() {
    const root = await Deno.realPath(await tempDir("am-fix-lock-note-"));
    try {
      const fw = join(root, "fw");
      await Deno.mkdir(fw);
      await Deno.writeTextFile(
        join(fw, "mod.ts"),
        "export const aio = { run(_o: unknown) {} };\n",
      );
      const app = join(root, "app");
      await Deno.mkdir(join(app, "src"), { recursive: true });
      await Deno.mkdir(join(app, "dep"));
      await Deno.symlink(fw, join(app, "dep", "aio"));
      // The one remote dependency: what this repo's own tests import, so it
      // is in the cache already and nothing is downloaded.
      const std = (JSON.parse(
        await Deno.readTextFile(join(REPO, "deno.json")),
      ).imports as Record<string, string>)["@std/assert"]!;
      await Deno.writeTextFile(
        join(app, "deno.json"),
        JSON.stringify({
          name: "lock-note",
          imports: { aio: "./dep/aio/mod.ts", "@std/assert": std },
        }),
      );
      await Deno.writeTextFile(
        join(app, "src", "app.ts"),
        `import { aio } from "aio";\nimport { assert } from "@std/assert";\n` +
          `assert(true);\nawait aio.run({ appId: "lock-note" });\n`,
      );
      const home = join(root, "home");
      await Deno.mkdir(home);
      const fix = async () => {
        const r = await new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", join(REPO, "src", "am.ts"), "fix", "--json"],
          cwd: app,
          env: {
            ...Deno.env.toObject(),
            HOME: home,
            AIO_HOME: fw, // an install that is not a clone — nothing to provision
            AIO_VERSIONS_DIR: join(root, "versions"),
            AIO_APPS_DIR: join(root, "apps"),
            AIO_AM_NO_DELEGATE: "1",
            GIT_CEILING_DIRECTORIES: root,
            NO_COLOR: "1",
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
        const text = new TextDecoder().decode(r.stdout);
        const cached = (JSON.parse(text) as {
          results: { name: string; outcome: string; note: string }[];
        }).results.find((x) => x.name === "dependencies cached");
        assert(cached, text);
        return cached;
      };
      const first = await fix();
      assertEquals(first.outcome, "fixed", first.note);
      await Deno.stat(join(app, "deno.lock")); // the premise: it wrote one
      assertStringIncludes(first.note, "deno.lock was created: commit it");
      const second = await fix();
      assert(!second.note.includes("deno.lock"), second.note);
    } finally {
      await dropTempDir(root);
    }
  },
});
