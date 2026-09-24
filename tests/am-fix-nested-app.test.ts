// `am fix` in a NESTED app (llama §2): `client/` is a second aio app in the
// same repo, consuming the PARENT's framework through `../dep/aio`. `am fix`
// read any `dep/aio` segment as this app's own layout, so it pinned whatever
// its own `latest` said (not the parent's pin), made `client/dep/aio` — a link
// nothing imports — and added tasks naming `./dep/aio/...` paths that do not
// exist for this layout. The framework is the parent's: leave pin, link and
// tasks alone, and say so.
//
// Fixture monorepo in a temp dir; HOME, AIO_HOME, the versions store and the
// apps dir are all throwaway — no network, no real HOME, no real repo.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { depAioProvider, isOwnDepAio } from "../src/am/am-cmd-fix.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));

Deno.test("depAioProvider: own ./dep/aio, a parent's ../dep/aio, no dep/aio", () => {
  const d = "/r/client";
  assertEquals(depAioProvider(d, "./dep/aio/mod.ts"), resolve(d, "dep/aio"));
  assertEquals(depAioProvider(d, "../dep/aio/mod.ts"), "/r/dep/aio");
  assertEquals(depAioProvider(d, "../dep/aio/"), "/r/dep/aio");
  assertEquals(depAioProvider(d, "/x/dep/aio/mod.ts"), "/x/dep/aio");
  assertEquals(depAioProvider(d, "../vendor-dep/aio-core/mod.ts"), null);
  assertEquals(depAioProvider(d, "jsr:@x/aio"), null);
});

Deno.test({
  name:
    "am fix in a nested app on the parent's ../dep/aio: no pin, no client/dep/aio link, tasks untouched",
  async fn() {
    const root = await tempDir("am-fix-nested-");
    try {
      // The parent app and ITS framework (a plain dir — not a git clone).
      const fw = join(root, "fw");
      await Deno.mkdir(fw, { recursive: true });
      await Deno.writeTextFile(join(fw, "mod.ts"), "export {};\n");
      await Deno.mkdir(join(root, "dep"));
      await Deno.symlink(fw, join(root, "dep", "aio"));
      await Deno.writeTextFile(
        join(root, "deno.json"),
        JSON.stringify({
          aioVersion: "v1.0.9-beta",
          imports: { aio: "./dep/aio/mod.ts" },
        }),
      );
      // The nested app.
      const client = join(root, "client");
      await Deno.mkdir(join(client, "src"), { recursive: true });
      const cfg = JSON.stringify(
        {
          name: "client",
          imports: { aio: "../dep/aio/mod.ts" },
          tasks: { dev: "deno run -A src/app.ts" },
        },
        null,
        2,
      ) + "\n";
      await Deno.writeTextFile(join(client, "deno.json"), cfg);
      await Deno.writeTextFile(
        join(client, "src", "app.ts"),
        `import { aio } from "aio";\nawait aio.run({ appId: "client" });\n`,
      );
      const home = join(root, "home");
      await Deno.mkdir(home);
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          join(REPO, "src", "am.ts"),
          "fix",
          "--no-download",
          "--json",
        ],
        cwd: client,
        env: {
          ...Deno.env.toObject(),
          HOME: home,
          AIO_HOME: fw, // an install that is not a clone — nothing to provision
          AIO_VERSIONS_DIR: join(root, "versions"),
          AIO_APPS_DIR: join(root, "apps"),
          AIO_AM_NO_DELEGATE: "1",
          // git must never walk up out of the fixture into an enclosing repo
          // (the test root may sit inside one).
          GIT_CEILING_DIRECTORIES: root,
          NO_COLOR: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = new TextDecoder().decode(r.stdout);
      const report = JSON.parse(text) as {
        results: { name: string; outcome: string; note: string }[];
      };
      const mode = report.results.find((x) =>
        x.name === "aio consumption mode"
      );
      assertStringIncludes(
        mode?.note ?? "",
        `provided by ${join(root, "dep", "aio")}`,
      );
      assertEquals(
        await Deno.readTextFile(join(client, "deno.json")),
        cfg,
        "deno.json rewritten (pin or tasks)",
      );
      const link = await Deno.lstat(join(client, "dep")).then(
        () => true,
        () => false,
      );
      assert(!link, "client/dep created — a link nothing imports");
      assert(
        !report.results.some((x) => x.name === "aio version pin"),
        text,
      );
    } finally {
      await dropTempDir(root);
    }
  },
});

// `am fix` runs with dir = Deno.cwd(), which is the REAL path. An absolute
// import-map path to the app's OWN dep/aio spelled through a symlink failed a
// resolve() comparison, so the app's own framework was classified as a
// PARENT's and its pin, link and tasks were left unrepaired.
Deno.test("isOwnDepAio: the app's own dep/aio through a symlinked absolute path is its own", async () => {
  const root = await Deno.realPath(await tempDir("am-fix-own-dep-"));
  try {
    const app = join(root, "real", "app");
    await Deno.mkdir(join(app, "dep"), { recursive: true });
    await Deno.mkdir(join(root, "real", "dep"));
    await Deno.symlink(join(root, "real"), join(root, "link"));
    const own = (spec: string) => {
      const p = depAioProvider(app, spec);
      assert(p !== null, spec);
      return isOwnDepAio(app, p);
    };
    assertEquals(own(join(root, "link", "app", "dep", "aio", "mod.ts")), true);
    assertEquals(own("./dep/aio/mod.ts"), true);
    assertEquals(own("../app/dep/aio/mod.ts"), true);
    assertEquals(own(join(app, "dep", "aio", "mod.ts")), true);
    // A parent's — real or through the link — stays the parent's.
    assertEquals(own("../dep/aio/mod.ts"), false);
    assertEquals(own(join(root, "link", "dep", "aio", "mod.ts")), false);
    // Not on disk: the lexical answer.
    assertEquals(isOwnDepAio("/nope/app", "/nope/app/dep/aio"), true);
    assertEquals(isOwnDepAio("/nope/app", "/nope/dep/aio"), false);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test({
  name:
    "am fix: an import map naming the app's OWN dep/aio through a symlink is the dep/aio layout, not a parent's",
  async fn() {
    const root = await Deno.realPath(await tempDir("am-fix-own-dep-run-"));
    try {
      const fw = join(root, "fw");
      await Deno.mkdir(fw);
      await Deno.writeTextFile(join(fw, "mod.ts"), "export {};\n");
      const app = join(root, "real", "app");
      await Deno.mkdir(join(app, "src"), { recursive: true });
      await Deno.mkdir(join(app, "dep"));
      await Deno.symlink(fw, join(app, "dep", "aio"));
      await Deno.symlink(join(root, "real"), join(root, "link"));
      const spec = join(root, "link", "app", "dep", "aio", "mod.ts");
      await Deno.writeTextFile(
        join(app, "deno.json"),
        JSON.stringify({ name: "own", imports: { aio: spec } }),
      );
      await Deno.writeTextFile(
        join(app, "src", "app.ts"),
        `import { aio } from "aio";\nawait aio.run({ appId: "own" });\n`,
      );
      const home = join(root, "home");
      await Deno.mkdir(home);
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          join(REPO, "src", "am.ts"),
          "fix",
          "--dry-run",
          "--no-download",
          "--json",
        ],
        cwd: join(root, "link", "app"),
        env: {
          ...Deno.env.toObject(),
          HOME: home,
          AIO_HOME: fw,
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
      const report = JSON.parse(text) as {
        results: { name: string; outcome: string; note: string }[];
      };
      const mode = report.results.find((x) =>
        x.name === "aio consumption mode"
      );
      assertEquals(mode?.note, "dep/aio layout", text);
    } finally {
      await dropTempDir(root);
    }
  },
});
