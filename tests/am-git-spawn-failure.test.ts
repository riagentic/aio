// "git could not be started" is not "git ran and said no".
//
// `am` asks git whether its install is a clone (`rev-parse --show-toplevel`).
// When the spawn itself failed — no git on PATH, or Windows with no `PATHEXT`
// in the environment (measured on Windows 11, Deno 2.9: the name `git` then
// resolves to nothing, `git.exe` still does) — the failure was folded into the
// answer: "<root> is not a git clone … Reinstall with install.sh", for an
// install that was a perfectly good clone. The verdict now says what failed.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { gitSpawnFailure } from "../src/am/am-versions.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

/** `ensureVersion` + `cloneProblem` on `root`, in a child with `env` as its
 *  WHOLE environment. */
async function ask(
  dir: string,
  root: string,
  env: Record<string, string>,
): Promise<{ error: string; problem: { spawn?: string } | null }> {
  const script = join(dir, "ask.ts");
  await Deno.writeTextFile(
    script,
    `import { cloneProblem, ensureVersion } from "${
      spec(REPO)
    }/src/am/am-versions.ts";
const root = ${JSON.stringify(root)};
const r = await ensureVersion(root, "v0.0.0-none");
console.log(JSON.stringify({ error: r.ok ? "" : r.error, problem: await cloneProblem(root) }));
`,
  );
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(REPO, "deno.json"), script],
    clearEnv: true,
    env,
    stdin: "null",
  }).output();
  const out = new TextDecoder().decode(o.stdout);
  assertEquals(o.code, 0, out + new TextDecoder().decode(o.stderr));
  return JSON.parse(out);
}

Deno.test("am: git that cannot be started is reported as that, never as 'not a git clone'", async () => {
  const dir = await tempDir("am-git-spawn-");
  try {
    // Looks like an install (`.git`, `mod.ts`), so git IS asked.
    const root = join(dir, "install");
    await Deno.mkdir(join(root, ".git"), { recursive: true });
    await Deno.writeTextFile(join(root, "mod.ts"), "");
    const empty = join(dir, "empty-path");
    await Deno.mkdir(empty);
    const whole = { ...Deno.env.toObject(), AIO_APPS_DIR: join(dir, "apps") };
    const without = (name: string) =>
      Object.fromEntries(
        Object.entries(whole).filter(([k]) => k.toUpperCase() !== name),
      );

    // Git runs and says no: the domain verdict, as before.
    const ran = await ask(dir, root, whole);
    assertStringIncludes(ran.error, "is not a git clone");
    assertEquals(ran.problem, {});

    // Git cannot start. Every OS: no git on PATH. Windows also: a cleared
    // environment — PATH intact, PATHEXT gone.
    const broken: Record<string, Record<string, string>> = {
      "no git on PATH": { ...without("PATH"), PATH: empty },
      ...(Deno.build.os === "windows"
        ? { "no PATHEXT": without("PATHEXT") }
        : {}),
    };
    for (const [what, env] of Object.entries(broken)) {
      const r = await ask(dir, root, env);
      assertStringIncludes(r.error, "could not start git", what);
      assertStringIncludes(r.error, "Failed to spawn", what);
      assert(!r.error.includes("is not a git clone"), `${what}: ${r.error}`);
      assertEquals(r.problem?.spawn, r.error, what);
      if (what === "no PATHEXT") assertStringIncludes(r.error, "PATHEXT");
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am: the spawn failure names PATHEXT only where that is the cause", () => {
  const e = new Error("Failed to spawn 'git': entity not found");
  assertStringIncludes(gitSpawnFailure(e, "windows", false), "PATHEXT");
  assert(!gitSpawnFailure(e, "windows", true).includes("PATHEXT"));
  assert(!gitSpawnFailure(e, "linux", false).includes("PATHEXT"));
  assertStringIncludes(gitSpawnFailure(e, "linux", false), "install git");
});
