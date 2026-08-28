// `am build` / `am compile` / `am dev` ARE `deno task build` / `compile` /
// `dev`. Not "equivalent", not "the same flags" — the same command line, in
// the same process tree, so the two spellings cannot drift. This file pins
// that from three sides:
//
//   1. the pure planner (`am build a b` → `deno task build --targets=a,b`);
//   2. on a REAL scaffold: `am build --list` and `deno task build --list`
//      print the same table, and every scaffolded task string is a command
//      that resolves (the script it names exists);
//   3. gated (AIO_BUILD_E2E=1, real compiles): `deno task build` and
//      `am build` write the same dist/manifest.json (modulo builtAt) and the
//      same artifact names; `deno task compile` and `am compile` the same
//      single artifact.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  argvAfterVerb,
  missingTaskLine,
  planTask,
} from "../src/am/am-cmd-build.ts";
import { standardTasks } from "../src/am/am-cmd-create.ts";
import { makeApp, REPO_ROOT, task } from "./e2e-app-harness.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";
const dec = new TextDecoder();

/** `am <argv>` in dir, through the checkout's am (what `deno task am` runs). */
async function am(
  dir: string,
  ...argv: string[]
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command("deno", {
    args: ["run", "-A", "dep/aio/src/am.ts", ...argv],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
    env: { AIO_AM_NO_DELEGATE: "1" },
  }).output();
  return { code: p.code, out: dec.decode(p.stdout), err: dec.decode(p.stderr) };
}

// ── 1. the planner ──────────────────────────────────────────────────────────

Deno.test("am build: the argv after the verb is forwarded, am's own flags before it are not", () => {
  assertEquals(argvAfterVerb(["--json", "build", "--list"], "build"), [
    "--list",
  ]);
  assertEquals(argvAfterVerb(["dev", "--client=electron", "--expose"], "dev"), [
    "--client=electron",
    "--expose",
  ]);
  assertEquals(argvAfterVerb(["status"], "build"), []);
});

Deno.test("am build [words] is deno task build --targets=words; flags pass through", () => {
  assertEquals(planTask("build", []), { ok: true, task: "build", args: [] });
  assertEquals(planTask("build", ["--list"]), {
    ok: true,
    task: "build",
    args: ["--list"],
  });
  assertEquals(planTask("build", ["server", "electron", "--release"]), {
    ok: true,
    task: "build",
    args: ["--targets=server,electron", "--release"],
  });
  assertEquals(planTask("build", ["--targets=cli", "--force"]), {
    ok: true,
    task: "build",
    args: ["--targets=cli", "--force"],
  });
  const twice = planTask("build", ["cli", "--targets=server"]);
  assert(!twice.ok && twice.error.includes("twice"));
});

Deno.test("am compile is deno task compile; am compile <t> is build --targets=<t>", () => {
  assertEquals(planTask("compile", []), {
    ok: true,
    task: "compile",
    args: [],
  });
  assertEquals(planTask("compile", ["--release"]), {
    ok: true,
    task: "compile",
    args: ["--release"],
  });
  // The compile task already carries `--targets=<default>` and the fleet
  // reads the FIRST one — so a second target must go through `build`.
  assertEquals(planTask("compile", ["cli"]), {
    ok: true,
    task: "build",
    args: ["--targets=cli"],
  });
  assert(!planTask("compile", ["cli", "server"]).ok);
  assert(!planTask("compile", ["--targets=cli"]).ok);
});

Deno.test("am dev forwards everything verbatim (deno task dev is a pass-through)", () => {
  assertEquals(planTask("dev", ["--client=electron", "--expose", "x"]), {
    ok: true,
    task: "dev",
    args: ["--client=electron", "--expose", "x"],
  });
});

Deno.test("a missing task is refused with the repair, never re-implemented", () => {
  const line = missingTaskLine("build", "/app");
  assertStringIncludes(line, "/app/deno.json");
  assertStringIncludes(line, "am fix");
});

// ── 2. a real scaffold, no compile ──────────────────────────────────────────

Deno.test("am build --list and deno task build --list print the same target table", async () => {
  const dir = await makeApp("counter", "am-build-");
  try {
    const viaTask = await task(dir, "build", "--list");
    const viaAm = await am(dir, "build", "--list");
    assertEquals(viaTask.code, 0, viaTask.err);
    assertEquals(viaAm.code, 0, viaAm.err);
    assertStringIncludes(viaTask.out, "Available build targets");
    assertEquals(viaAm.out, viaTask.out);
    // `am` runs the task with -q: the output is the build's own, no
    // `Task build …` banner on either stream.
    assert(!viaAm.err.includes("Task build"), viaAm.err);
    assert(!viaAm.out.includes("Task build"), viaAm.out);
    // `am compile` reaches the same table through the same task family.
    const viaCompile = await am(dir, "compile", "--list");
    assertEquals(viaCompile.out, viaTask.out);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("am build refuses an unknown fleet flag exactly as deno task build does", async () => {
  const dir = await makeApp("counter", "am-build-");
  try {
    const viaTask = await task(dir, "build", "--target=cli");
    const viaAm = await am(dir, "build", "--target=cli");
    assertEquals(viaTask.code, 1);
    assertEquals(viaAm.code, 1);
    assertStringIncludes(viaAm.err, "unknown flag(s): --target=cli");
    assertStringIncludes(viaTask.err, "unknown flag(s): --target=cli");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("am build without a build task names the repair (am fix), exit 1", async () => {
  const dir = await Deno.makeTempDir({ prefix: "am-build-notask-" });
  try {
    await Deno.mkdir(join(dir, "dep"));
    await Deno.symlink(REPO_ROOT, join(dir, "dep/aio"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "x", tasks: { test: "deno test -A" } }),
    );
    const r = await am(dir, "build");
    assertEquals(r.code, 1);
    // Piped → JSON mode: the error rides on stdout.
    assertStringIncludes(r.out + r.err, 'no \\"build\\" task');
    assertStringIncludes(r.out + r.err, "am fix");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** The first command of every `&&`-joined segment of a task string. */
function commandsOf(taskStr: string): string[][] {
  return taskStr.split("&&").map((seg) => seg.trim().split(/\s+/));
}

Deno.test("scaffold: the task set is the promised one, and every task resolves", async () => {
  // The one set an app author has to learn — these MUST be there, whatever
  // the default target. (The diet test caps what else may join them.)
  const REQUIRED = ["dev", "build", "compile", "test", "check", "lint", "am"];
  const repoExports = JSON.parse(
    await Deno.readTextFile(join(REPO_ROOT, "deno.json")),
  ).exports as Record<string, string>;
  const targets = ["browser", "electron", "android", "cli", "server"] as const;
  for (const target of targets) {
    for (const source of [true, false]) {
      const tasks = standardTasks(source, target);
      for (const k of REQUIRED) {
        assert(k in tasks, `${target}/source=${source}: no "${k}" task`);
      }
      assert("publish" in tasks, `${target}: no "publish" task`);
      assert(Object.keys(tasks).length >= 7, `${target}: the task set`);
      for (const [name, str] of Object.entries(tasks)) {
        assert(commandsOf(str).length > 0, `${name}: a task runs something`);
        for (const cmd of commandsOf(str)) {
          assertEquals(
            cmd[0],
            "deno",
            `${name}: "${str}" is not a deno command`,
          );
          const sub = cmd[1]!;
          if (sub !== "run") {
            // A deno builtin (test, check, fmt, lint) — resolves by definition.
            assert(
              ["test", "check", "fmt", "lint"].includes(sub),
              `${name}: unknown deno subcommand in "${str}"`,
            );
            continue;
          }
          const spec = cmd.find((a, i) => i >= 2 && !a.startsWith("-"))!;
          if (source) {
            // dep/aio/<path> — the file must exist in THIS checkout.
            assert(
              spec.startsWith("./dep/aio/") || spec.startsWith("src/"),
              `${name}: "${spec}" is neither a framework file nor the app's`,
            );
            const rel = spec.startsWith("./dep/aio/")
              ? join(REPO_ROOT, spec.slice("./dep/aio/".length))
              : null;
            if (rel) await Deno.stat(rel); // throws → the task names nothing
          } else if (spec.startsWith("jsr:")) {
            // jsr:@riagentic/aio@<v>/<sub> — <sub> must be a published export.
            const sub2 = spec.replace(/^jsr:@riagentic\/aio@[^/]+/, "");
            const key = sub2 === "" ? "." : `.${sub2}`;
            assert(
              key in repoExports,
              `${name}: "${spec}" names export "${key}", which deno.json does not publish`,
            );
          } else {
            assert(spec.startsWith("src/"), `${name}: unresolvable "${spec}"`);
          }
        }
      }
    }
  }
  // …and on a materialised scaffold the file paths really resolve from the
  // app dir (the symlink layout `am create` + `am fix` produce).
  const dir = await makeApp("counter", "am-build-", "cli");
  try {
    const tasks = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")))
      .tasks as Record<string, string>;
    assert(Object.keys(tasks).length >= 7, "the cli scaffold's task set");
    for (const [name, str] of Object.entries(tasks)) {
      assert(commandsOf(str).length > 0, `${name}: a task runs something`);
      for (const cmd of commandsOf(str)) {
        if (cmd[1] !== "run") continue;
        const spec = cmd.find((a, i) => i >= 2 && !a.startsWith("-"))!;
        const st = await Deno.stat(join(dir, spec)).catch(() => null);
        assert(st?.isFile, `${name}: ${spec} does not exist under ${dir}`);
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── 3. real compiles: the same artifact ─────────────────────────────────────

type Manifest = {
  builtAt: string;
  targets: { target: string; ok: boolean; artifacts: { file: string }[] }[];
};

async function manifest(dir: string): Promise<Manifest> {
  return JSON.parse(await Deno.readTextFile(join(dir, "dist/manifest.json")));
}
async function distNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(join(dir, "dist"))) names.push(e.name);
  return names.sort();
}
const sansTime = (m: Manifest) => ({ ...m, builtAt: "" });

Deno.test({
  name: "e2e: deno task build and am build write the same dist/ and manifest",
  ignore: !GATE,
  fn: async () => {
    // A cli scaffold: no browser bundle, so two real compiles stay short.
    const dir = await makeApp("counter", "am-build-e2e-", "cli");
    try {
      const a = await task(dir, "build");
      assertEquals(a.code, 0, a.err + a.out);
      const mA = await manifest(dir);
      const namesA = await distNames(dir);
      assert(mA.targets.every((t) => t.ok && t.artifacts.length > 0));

      const b = await am(dir, "build");
      assertEquals(b.code, 0, b.err + b.out);
      assertEquals(sansTime(await manifest(dir)), sansTime(mA));
      assertEquals(await distNames(dir), namesA);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "e2e: deno task compile and am compile produce the same single artifact",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "am-build-e2e-", "cli");
    try {
      const a = await task(dir, "compile");
      assertEquals(a.code, 0, a.err + a.out);
      const mA = await manifest(dir);
      assertEquals(mA.targets.length, 1);
      assertEquals(mA.targets[0]!.target, "cli");
      const namesA = await distNames(dir);

      const b = await am(dir, "compile");
      assertEquals(b.code, 0, b.err + b.out);
      assertEquals(sansTime(await manifest(dir)), sansTime(mA));
      assertEquals(await distNames(dir), namesA);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
