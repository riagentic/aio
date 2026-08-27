// `am update` could destroy a dev checkout.
//
// THE historical data-loss bug in this project is `git checkout --force <tag>`
// run inside a repo someone works in: it deletes uncommitted work, and it wiped
// aio's own tree twice. `install.sh` was fixed (its AIO_DEV_CHECKOUT block) —
// and `am update`, which re-implements the same fetch+checkout in TypeScript,
// was not. It guarded on LOCATION instead ("is this the canonical install?"),
// and `canonicalRoot()` reads `AIO_HOME`, so the guard answers "yes, canonical"
// for a developer's own repo the moment AIO_HOME points at it.
//
// Reproduced before the fix, on a clone of this repo:
//
//   $ echo WIP-PRECIOUS >> README.md
//   $ AIO_HOME=/tmp/aio-clone am update
//   HEAD is now at dae2ee9 release: v1.0.0-alpha68
//   {"updated":true,"via":"git","tag":"v1.0.0-alpha68"}     ← exit 0
//   $ tail -1 README.md
//   [MIT](LICENSE)                                          ← WIP gone
//
// One fact, two deciders, one of them fixed. This file pins the rule AND that
// the two deciders still say the same thing.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirtyLines, gitMutationRefusal } from "../src/am/am-cmd-meta.ts";

const ROOT = new URL("../", import.meta.url).pathname;

// ── the rule ─────────────────────────────────────────────────

Deno.test("am update: a checkout with uncommitted work is never git-mutated", () => {
  const r = gitMutationRefusal({
    root: "/home/dev/code/aio",
    dirty: ["M src/server/aio.ts", "M todo.md"],
    onBranch: null,
    force: false,
  });
  assert(r, "a dirty checkout must be refused");
  assertStringIncludes(r, "/home/dev/code/aio");
  assertStringIncludes(r, "M src/server/aio.ts"); // names the work at risk
  assertStringIncludes(r, "am update --force"); // and the way past
});

Deno.test("am update: a checkout ON A BRANCH is a checkout someone works in", () => {
  // install.sh's second half of the rule: the canonical install is always
  // detached at a tag, so a branch means a human put it there.
  const r = gitMutationRefusal({
    root: "/opt/aio",
    dirty: [],
    onBranch: "main",
    force: false,
  });
  assert(r);
  assertStringIncludes(r, "main");
});

Deno.test("am update: the canonical install (clean, detached) still updates", () => {
  assertEquals(
    gitMutationRefusal({
      root: "/home/u/.local/lib/aio",
      dirty: [],
      onBranch: null,
      force: false,
    }),
    null,
  );
});

Deno.test("am update --force: the override is explicit, and only that", () => {
  assertEquals(
    gitMutationRefusal({
      root: "/x",
      dirty: ["M a.ts"],
      onBranch: "wip",
      force: true,
    }),
    null,
  );
});

Deno.test("am update: deno.lock alone is not 'worked in'", () => {
  // install.sh's measured reason: `deno install` from the checkout rewrites
  // deno.lock, so counting it would make every canonical install look worked
  // in after its first run and freeze it forever.
  assertEquals(dirtyLines(" M deno.lock"), []);
  assertEquals(dirtyLines(" M deno.lock\n M src/a.ts"), ["M src/a.ts"]);
  assertEquals(dirtyLines(""), []);
  assertEquals(dirtyLines("\n\n"), []);
});

// ── grounded in what git actually prints ─────────────────────

Deno.test("am update: the porcelain parse matches a real git repo", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-dirty-" });
  const git = async (...args: string[]) => {
    const o = await new Deno.Command("git", {
      args: ["-C", dir, ...args],
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
        HOME: dir,
      },
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(o.stdout).trim();
  };
  try {
    await git("init", "-q", "-b", "main");
    await Deno.writeTextFile(`${dir}/a.ts`, "1");
    await Deno.writeTextFile(`${dir}/deno.lock`, "{}");
    await git("add", ".");
    await git("commit", "-qm", "first");

    // Clean: nothing to refuse.
    assertEquals(dirtyLines(await git("status", "--porcelain", "-uno")), []);

    // deno.lock only: still nothing.
    await Deno.writeTextFile(`${dir}/deno.lock`, '{"x":1}');
    assertEquals(dirtyLines(await git("status", "--porcelain", "-uno")), []);

    // Real work: refused.
    await Deno.writeTextFile(`${dir}/a.ts`, "2");
    const lines = dirtyLines(await git("status", "--porcelain", "-uno"));
    assertEquals(lines, ["M a.ts"]);
    assert(
      gitMutationRefusal({
        root: dir,
        dirty: lines,
        onBranch: "main",
        force: false,
      }),
    );

    // An UNTRACKED file is not at risk — `git checkout --force` leaves it
    // alone — and counting it would refuse for something that cannot be lost.
    await git("checkout", "--", "a.ts");
    await Deno.writeTextFile(`${dir}/scratch.md`, "notes");
    assertEquals(dirtyLines(await git("status", "--porcelain", "-uno")), []);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── one fact, two deciders — they must agree ─────────────────

Deno.test("the dev-checkout rule is the SAME rule in install.sh and in am update", async () => {
  const sh = await Deno.readTextFile(`${ROOT}install.sh`);
  // install.sh's three ingredients. If any of these is reworded, this test
  // fails and the TypeScript half has to be looked at in the same change —
  // which is the whole point: the last time only one half moved, `am update`
  // kept the bug for months.
  assertStringIncludes(sh, "status --porcelain --untracked-files=no");
  assertStringIncludes(sh, "deno.lock"); // excluded, for the measured reason
  assertStringIncludes(sh, "symbolic-ref -q HEAD"); // "on a branch" = worked in

  const ts = await Deno.readTextFile(`${ROOT}src/am/am-cmd-meta.ts`);
  // And the TypeScript half must CONSULT the rule before it mutates. A
  // `checkout --force` that is not preceded by the refusal is the bug back.
  const idxGuard = ts.indexOf("gitMutationRefusal({");
  const idxCheckout = ts.indexOf('"checkout", "--force"');
  assert(idxGuard > 0, "cmdUpdate must call gitMutationRefusal");
  assert(idxCheckout > 0, "this test is watching the wrong call");
  assert(
    idxGuard < idxCheckout,
    "am update runs `git checkout --force` before checking whether the " +
      "checkout is one someone works in — that is the wipe, restored",
  );
});
