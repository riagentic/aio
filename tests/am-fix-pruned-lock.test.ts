// A CI step that runs any deno command in the app before `dep/aio` exists
// (`deno eval` reading `aioVersion`) rewrites the committed deno.lock without
// aio's entries — the import map points into a folder that is not there yet.
// `am fix` then made the link, the clone stayed dirty, and `am publish` built
// all four targets before refusing the `-dirty` version (aio-launcher §4).
// Once the link exists the committed lock is right again: `am fix` restores
// it — only when the working lock is that lock with entries DROPPED.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { onlyPruned } from "../src/am/am-cmd-fix.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));

Deno.test("onlyPruned: entries dropped yes; added or changed no", () => {
  const c = { version: "5", specifiers: { a: "1", b: "2" }, x: ["p", "q"] };
  assert(onlyPruned(c, { version: "5", specifiers: { a: "1" }, x: ["q"] }));
  assert(onlyPruned(c, c));
  assert(!onlyPruned(c, { version: "5", specifiers: { a: "9" } }));
  assert(!onlyPruned(c, { version: "5", specifiers: { z: "1" } }));
  assert(!onlyPruned(c, { version: "5", x: ["r"] }));
  assert(!onlyPruned(c, { version: "4" }));
});

const git = (cwd: string, ...args: string[]) =>
  new Deno.Command("git", {
    args,
    cwd,
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CEILING_DIRECTORIES: dirname(cwd),
    },
    stdout: "null",
    stderr: "null",
  }).output();

/** A git repo holding one app (at the root, or in `sub/` of a monorepo),
 *  its committed lock pruned as a deno command before `dep/aio` prunes it;
 *  `alsoEdit` changes a tracked source file too. Runs `am fix` and returns
 *  the lock after it and the report's outcome for the lock. */
async function fixPruned(
  root: string,
  opts: { sub?: boolean; alsoEdit?: boolean } = {},
): Promise<{ lock: string; committed: string; outcome?: string }> {
  const repo = join(root, "repo");
  const app = opts.sub ? join(repo, "apps", "one") : repo;
  await Deno.mkdir(join(app, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify({ name: "app", imports: { aio: "./dep/aio/mod.ts" } }),
  );
  await Deno.writeTextFile(join(app, ".gitignore"), "dep/\n");
  await Deno.writeTextFile(
    join(app, "src", "app.ts"),
    `import { aio } from "aio";\nawait aio.run({ appId: "app" });\n`,
  );
  const committed = JSON.stringify(
    {
      version: "5",
      specifiers: { "jsr:@std/path@1": "1.1.3", "npm:immer@10": "10.2.0" },
    },
    null,
    2,
  ) + "\n";
  await Deno.writeTextFile(join(app, "deno.lock"), committed);
  await git(repo, "init", "-q");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "init");
  const pruned = JSON.stringify(
    { version: "5", specifiers: { "npm:immer@10": "10.2.0" } },
    null,
    2,
  ) + "\n";
  await Deno.writeTextFile(join(app, "deno.lock"), pruned);
  if (opts.alsoEdit) {
    await Deno.writeTextFile(
      join(app, "src", "app.ts"),
      `import { aio } from "aio";\nawait aio.run({ appId: "app", title: "x" });\n`,
    );
  }
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
      `--aio=${REPO}`,
    ],
    cwd: app,
    env: {
      ...Deno.env.toObject(),
      HOME: home,
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
    results: { name: string; outcome: string }[];
  };
  return {
    lock: await Deno.readTextFile(join(app, "deno.lock")),
    committed,
    outcome: report.results.find((x) => x.name === "committed deno.lock")
      ?.outcome,
  };
}

Deno.test({
  name:
    "am fix: a committed deno.lock pruned before dep/aio existed is restored when the link is made",
  ignore: Deno.build.os === "windows", // the link and git fixture: POSIX
  async fn() {
    const root = await tempDir("am-fix-pruned-lock-");
    try {
      const r = await fixPruned(root);
      assertEquals(r.lock, r.committed);
      assertEquals(r.outcome, "fixed");
    } finally {
      await dropTempDir(root);
    }
  },
});

Deno.test({
  name:
    "am fix: an app in a monorepo folder gets its pruned lock back too (git finds the repository)",
  ignore: Deno.build.os === "windows", // the link and git fixture: POSIX
  async fn() {
    const root = await tempDir("am-fix-pruned-lock-sub-");
    try {
      const r = await fixPruned(root, { sub: true });
      assertEquals(r.lock, r.committed);
      assertEquals(r.outcome, "fixed");
    } finally {
      await dropTempDir(root);
    }
  },
});

Deno.test({
  name:
    "am fix: a lock pruned beside another change is the developer's own — left as it is",
  ignore: Deno.build.os === "windows", // the link and git fixture: POSIX
  async fn() {
    const root = await tempDir("am-fix-pruned-lock-own-");
    try {
      const r = await fixPruned(root, { alsoEdit: true });
      assert(r.lock !== r.committed, "a deliberate prune was undone");
      assertEquals(r.outcome, undefined);
    } finally {
      await dropTempDir(root);
    }
  },
});
