// The build's FLAG VOCABULARY — and the one place that has to agree with it.
//
// Both build entry points read their flags with `Deno.args.includes(...)` /
// `.find(...)`, so a flag they do not recognize is not an error: it is ABSENT.
// The build then produces a DIFFERENT artifact than the one asked for and
// exits 0. That is exactly what shipped: the scaffold's default `compile` task
// passed `--client=cli` / `--client=server-only` — the RUNTIME flags the
// compiled app reads — where the BUILD spellings are `--cli` and
// `--service --headless`. `deno task compile` on a cli/server app therefore
// built the browser-shaped binary (browser bundle embedded, no systemd unit),
// silently disagreeing with `deno task compile:cli` / `compile:service` for
// the same app.
//
// Two gates, so the bug class cannot come back:
//   1. an unknown flag is REFUSED by both build entry points;
//   2. the scaffold's `compile` task is the SAME command as the explicit
//      `compile:<target>` task for that target — one decider, checked.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

import {
  unknownBuildFlags,
  unknownFleetFlags,
} from "../src/build/build-flags.ts";
import { standardTasks, TARGETS } from "../src/am/am-cmd-create.ts";
import type { Target } from "../src/am/am-cmd-create.ts";

// ── 1. the vocabularies ─────────────────────────────────────────────────────

Deno.test("build flags: every flag the pipeline really uses is accepted", () => {
  // The full set build-all passes to a single-target build, plus every
  // documented spelling (examples/targets/*, docs/build/targets.md).
  assertEquals(
    unknownBuildFlags([
      "--compile",
      "--electron",
      "--android",
      "--cli",
      "--client",
      "--remote",
      "--service",
      "--headless",
      "--force",
      "--release",
      "--entry=src/relay/app.ts",
      "--name=My App",
      "--platform=windows",
      "--android-dev-url=http://localhost:3000/",
    ]),
    [],
  );
});

Deno.test("build flags: a runtime flag is not a build flag (the shipped near-miss)", () => {
  // `--client=<mode>` is real — it is what the COMPILED APP parses. Passed to
  // the build it silently selected another target.
  assertEquals(unknownBuildFlags(["--compile", "--client=cli"]), [
    "--client=cli",
  ]);
  assertEquals(unknownBuildFlags(["--compile", "--client=server-only"]), [
    "--client=server-only",
  ]);
  // Typos and near-misses of real flags, in both directions.
  assertEquals(unknownBuildFlags(["--complie"]), ["--complie"]);
  assertEquals(unknownBuildFlags(["--platforms=windows"]), [
    "--platforms=windows",
  ]);
  assertEquals(unknownBuildFlags(["--entry"]), ["--entry"], "value flag, bare");
  assertEquals(
    unknownBuildFlags(["--compile=true"]),
    ["--compile=true"],
    "boolean flag given a value",
  );
});

Deno.test("fleet flags: build-all accepts its own vocabulary and nothing else", () => {
  assertEquals(
    unknownFleetFlags([
      "--list",
      "--help",
      "--release",
      "--force",
      "--targets=browser,cli",
      "--platforms=host,windows",
      "--out=dist",
      "--build-spec=/x/build.ts",
    ]),
    [],
  );
  // The singular typos: both would have been ignored, and the fleet would have
  // fanned out over deno.json's list instead of the one asked for.
  assertEquals(unknownFleetFlags(["--target=browser"]), ["--target=browser"]);
  assertEquals(unknownFleetFlags(["--platform=windows"]), [
    "--platform=windows",
  ]);
});

// ── 2. the refusal is real, through the actual entry points ─────────────────

const BUILD = join(import.meta.dirname ?? ".", "..", "src", "build.ts");
const BUILD_ALL = join(import.meta.dirname ?? ".", "..", "src", "build-all.ts");

/** Run a build script in a throwaway project. */
async function runBuild(
  script: string,
  args: string[],
): Promise<{ code: number; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: "aio-flags-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "Flags", build: { targets: ["browser"] } }),
    );
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "src", "app.ts"), 'console.log("x");\n');
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", script, ...args],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: r.code,
      out: new TextDecoder().decode(r.stdout) +
        new TextDecoder().decode(r.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("build: an unknown flag is refused before anything is built", async () => {
  const r = await runBuild(BUILD, ["--compile", "--client=cli"]);
  assertEquals(r.code, 1, `expected a refusal, got:\n${r.out}`);
  assertStringIncludes(r.out, "--client=cli");
  // …and it names the BUILD spelling, so the fix is in the message.
  assertStringIncludes(r.out, "--cli");
  assert(
    !r.out.includes("dist/app.js"),
    `nothing may be built before the refusal:\n${r.out}`,
  );
});

Deno.test("build-all: an unknown flag is refused before anything is built", async () => {
  const r = await runBuild(BUILD_ALL, ["--target=browser"]);
  assertEquals(r.code, 1, `expected a refusal, got:\n${r.out}`);
  assertStringIncludes(r.out, "--target=browser");
  assertStringIncludes(r.out, "--targets", "names the real flag");
});

// ── 3. `deno task compile` == `deno task compile:<target>` ──────────────────

/** The explicit per-target task that `deno task compile` must equal. `server`
 *  is spelled `service` in the task set (aio's name for "no client UI"). */
const EXPLICIT: Record<Target, string> = {
  browser: "compile:browser",
  electron: "compile:electron",
  android: "compile:android",
  cli: "compile:cli",
  server: "compile:service",
};

Deno.test("scaffold: `deno task compile` builds the SAME artifact as `compile:<target>`", () => {
  for (const source of [true, false]) {
    for (const target of TARGETS) {
      const tasks = standardTasks(source, target);
      assertEquals(
        tasks.compile,
        tasks[EXPLICIT[target]],
        `target "${target}" (source=${source}): the default compile task and ` +
          `${EXPLICIT[target]} must be one command, not two spellings`,
      );
    }
  }
});

Deno.test("scaffold: every compile task uses flags the build understands", () => {
  for (const target of TARGETS) {
    for (const [name, cmd] of Object.entries(standardTasks(true, target))) {
      if (!name.startsWith("compile")) continue;
      // Each `&&`-joined build invocation, minus `deno run -A <script>`.
      for (const part of cmd.split("&&")) {
        const args = part.trim().split(/\s+/).slice(4);
        assertEquals(
          unknownBuildFlags(args),
          [],
          `task "${name}" (target ${target}) passes a flag the build ignores: ${part.trim()}`,
        );
      }
    }
  }
});
