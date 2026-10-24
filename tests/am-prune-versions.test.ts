// `am prune versions`: the version store (`~/.local/lib/aio-versions`) had no
// verb that ever shrank it — `removeVersion` existed, nothing called it. The
// prune is report-only by default, keeps what an app pins/links and anything
// git cannot vouch for, and removes through `git worktree remove` so the
// registering clone forgets the checkout too.
//
// Everything runs against a THROWAWAY repo and store made here — never this
// checkout, never the user's store.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, normalize } from "@std/path";
import {
  applyVersionPrune,
  ensureVersion,
  planVersionPrune,
} from "../src/am/am-versions.ts";
import { _withVersionsDir } from "../src/server/framework-pin.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "aio test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "aio test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const o = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    env: GIT_ENV,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  assert(o.success, `git ${args.join(" ")}: ${d.decode(o.stderr)}`);
  return d.decode(o.stdout);
}

const registered = async (repo: string) =>
  (await git(repo, "worktree", "list", "--porcelain")).split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => normalize(l.slice("worktree ".length)));

const exists = (p: string) => Deno.lstat(p).then(() => true, () => false);

/** A repo tagged v1.0.0 … v1.0.<n-1>, each tag provisioned into `store`. */
async function seed(base: string, n: number) {
  const repo = join(base, "aio");
  const store = join(base, "store");
  await Deno.mkdir(repo);
  await git(repo, "init", "-q");
  await Deno.writeTextFile(join(repo, "mod.ts"), "export {};\n");
  await Deno.writeTextFile(join(repo, "deno.lock"), "{}\n");
  await Deno.writeTextFile(join(repo, ".gitignore"), "feedback/\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");
  for (let i = 0; i < n; i++) {
    await git(repo, "tag", `v1.0.${i}`);
    await _withVersionsDir(store, async () => {
      const r = await ensureVersion(repo, `v1.0.${i}`);
      assert(r.ok, r.ok ? "" : r.error);
    });
  }
  return { repo, store };
}

Deno.test("prune versions: removes only clean, unprotected, re-provisionable checkouts", async () => {
  const base = await tempDir("am-prune-versions-");
  try {
    const { repo, store } = await seed(base, 6);
    const v = (i: number) => join(store, `v1.0.${i}`);
    // v1.0.0: clean but for deno.lock (deno rewrites it) → goes.
    await Deno.writeTextFile(join(v(0), "deno.lock"), '{"x":1}\n');
    // v1.0.1: an app pins it → stays.
    // v1.0.2: an untracked file → stays.
    await Deno.writeTextFile(join(v(2), "notes.md"), "mine\n");
    // v1.0.3: an IGNORED file (a feedback note) → stays.
    await Deno.mkdir(join(v(3), "feedback"));
    await Deno.writeTextFile(join(v(3), "feedback", "a.md"), "mine\n");
    // v1.0.4: its tag is gone — it could never come back → stays.
    await git(repo, "tag", "-d", "v1.0.4");
    // v1.0.5: clean → goes.

    await _withVersionsDir(store, async () => {
      const plan = await planVersionPrune(
        new Map([["v1.0.1", "pinned by an app"]]),
      );
      const verdict = Object.fromEntries(plan.map((d) => [d.ref, d]));
      assertEquals(
        plan.filter((d) => !d.keep).map((d) => d.ref),
        ["v1.0.0", "v1.0.5"],
        JSON.stringify(plan, null, 1),
      );
      assertEquals(verdict["v1.0.1"]?.why ?? "", "pinned by an app");
      assertStringIncludes(verdict["v1.0.2"]?.why ?? "", "notes.md");
      assertStringIncludes(verdict["v1.0.3"]?.why ?? "", "feedback/");
      assertStringIncludes(verdict["v1.0.4"]?.why ?? "", "tag is gone");

      const r = await applyVersionPrune(plan);
      assertEquals(r.failed, []);
      assertEquals(r.removed, [v(0), v(5)]);
    });
    for (const i of [0, 5]) {
      assertEquals(await exists(v(i)), false, `v1.0.${i} still on disk`);
      assertEquals(await exists(`${v(i)}.provisioned`), false, "marker left");
    }
    for (const i of [1, 2, 3, 4]) assert(await exists(v(i)), `v1.0.${i} gone`);
    const regs = await registered(repo);
    assertEquals(regs.includes(v(0)), false, "registration survived");
    assertEquals(regs.includes(v(5)), false, "registration survived");
    assert(regs.includes(v(1)), "a kept checkout lost its registration");
  } finally {
    await dropTempDir(base);
  }
});

Deno.test("am prune versions: report-only by default; protects the cwd app's pin and the newest release; --yes removes", async () => {
  const base = await tempDir("am-prune-versions-cli-");
  try {
    const { repo, store } = await seed(base, 3);
    const app = join(base, "app");
    await Deno.mkdir(app);
    await Deno.writeTextFile(
      join(app, "deno.json"),
      '{ "aioVersion": "v1.0.1" }\n',
    );
    const am = fromFileUrl(new URL("../src/am.ts", import.meta.url));
    const run = async (...args: string[]) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", am, "prune", "versions", "--json", ...args],
        cwd: app,
        env: {
          ...Deno.env.toObject(),
          AIO_VERSIONS_DIR: store,
          AIO_HOME: repo,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      assert(o.success, d.decode(o.stderr) + d.decode(o.stdout));
      return JSON.parse(d.decode(o.stdout)) as {
        applied: boolean;
        removed: string[];
        plan: { ref: string; keep: boolean; why: string }[];
      };
    };

    const report = await run();
    assertEquals(report.applied, false);
    const why = Object.fromEntries(report.plan.map((d) => [d.ref, d]));
    assertEquals(why["v1.0.0"]?.keep, false);
    assertStringIncludes(why["v1.0.1"]?.why ?? "", "pinned by");
    assertStringIncludes(why["v1.0.2"]?.why ?? "", "newest release");
    assert(await exists(join(store, "v1.0.0")), "the report deleted");

    const done = await run("--yes");
    assertEquals(done.removed, [join(store, "v1.0.0")]);
    assertEquals(await exists(join(store, "v1.0.0")), false);
    assert(await exists(join(store, "v1.0.1")));
    assert(await exists(join(store, "v1.0.2")));
  } finally {
    await dropTempDir(base);
  }
});
