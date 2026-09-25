// The deno.json `build` block, read by `deno task build`: a value of the wrong
// SHAPE is refused naming its key, and a key aio never reads is said out loud.
//
// Measured before the fix, on a scaffolded app:
//   "targets": "browser"   → "✗ no targets to build. Add build.targets" (it had)
//   "platforms": "linux"   → "unknown platform(s): l, i, n, u, x"
//   "out": 5               → an uncaught @std/path TypeError stack
//   ["browser", 5]         → the 5 dropped without a word
//   per-target "platforms": "linux" → ignored; built for the default platforms
//   "targtes": [...]       → built the declared-or-default set, silently
// and the linter called the documented `build.macos` an unknown key.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildBlockShapeProblems,
  buildBlockShapeWarnings,
} from "../src/build/build-shape.ts";
import { unknownBuildKeys } from "../src/server/config.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const BUILD_ALL = new URL("../src/build-all.ts", import.meta.url).pathname;

Deno.test("build block shape: each wrong shape is named by its key", () => {
  const one = (b: unknown) => buildBlockShapeProblems(b);
  assertEquals(one(undefined), []);
  assertEquals(
    one({ targets: ["browser"], platforms: ["host"], out: "dist" }),
    [],
  );
  assertEquals(one({ targets: { server: null, browser: {} } }), []);
  assertStringIncludes(one({ targets: "browser" })[0]!, "build.targets");
  assertStringIncludes(one({ platforms: "linux" })[0]!, "build.platforms");
  assertStringIncludes(one({ out: 5 })[0]!, "build.out");
  assertStringIncludes(one({ out: " " })[0]!, "build.out");
  assertStringIncludes(
    one({ targets: { browser: { platforms: ["linux", 5] } } })[0]!,
    "build.targets.browser.platforms",
  );
  assertStringIncludes(
    one({ targets: { browser: { entry: 1 } } })[0]!,
    "build.targets.browser.entry",
  );
  assertStringIncludes(one("browser")[0]!, "build must be an object");
});

Deno.test("build block shape: what built on 1.0.11 is warned, never refused", () => {
  const warn = (b: unknown, targetsOverridden = false) => ({
    refused: buildBlockShapeProblems(b, { targetsOverridden }),
    warned: buildBlockShapeWarnings(b, { targetsOverridden }),
  });
  // `true` is the array form's entry, like `null` — nothing to say.
  assertEquals(warn({ targets: { server: true, browser: null } }), {
    refused: [],
    warned: [],
  });
  // A scalar under --targets= is read by nothing: said, not refused…
  const s = warn({ targets: "server" }, true);
  assertEquals(s.refused, []);
  assertStringIncludes(s.warned[0]!, "build.targets");
  assertStringIncludes(s.warned[0]!, "--targets=");
  // …and without the flag it builds nothing, so it is still refused.
  assertStringIncludes(
    warn({ targets: "server" }).refused[0]!,
    "build.targets",
  );
  // Built, but not as written.
  for (
    const [b, key] of [
      [{ targets: ["browser", 5] }, "build.targets"],
      [{ targets: { server: false } }, "build.targets.server"],
      [{ targets: { server: "x" } }, "build.targets.server"],
      [
        { targets: { browser: { platforms: "linux" } } },
        "build.targets.browser.platforms",
      ],
    ] as const
  ) {
    const r = warn(b);
    assertEquals(r.refused, [], JSON.stringify(b));
    assertStringIncludes(r.warned[0] ?? "", key, JSON.stringify(b));
  }
});

Deno.test("build block keys: the documented build.macos is a known key", () => {
  assertEquals(
    unknownBuildKeys({ macos: { bundleId: "com.example.app", host: "mac" } }),
    [],
  );
});

async function buildIn(
  config: unknown,
  args: string[] = [],
): Promise<{ code: number; err: string }> {
  const dir = await tempDir("aio-build-block-");
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(config));
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", BUILD_ALL, ...args],
      cwd: dir,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    return {
      code: out.code,
      err: dec.decode(out.stderr) + dec.decode(out.stdout),
    };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("build block: the build refuses a wrong shape before building anything", async () => {
  const r = await buildIn({ title: "shape", build: { platforms: "linux" } });
  assertEquals(r.code, 1, r.err);
  assertStringIncludes(r.err, "build.platforms must be an array of strings");
  assert(!r.err.includes("l, i, n, u, x"), r.err);
});

Deno.test("build block: a scalar targets under --targets= and a true entry still build", async () => {
  // Past the shape gate, both stop at the same next step: an empty app.
  for (
    const [build, args] of [
      [{ targets: "server" }, ["--targets=server"]],
      [{ targets: { server: true } }, []],
    ] as const
  ) {
    const r = await buildIn({ title: "compat", build }, [...args]);
    assert(!r.err.includes("✗ deno.json build block"), r.err);
    if (args.length) assertStringIncludes(r.err, "--targets= decides");
  }
});

Deno.test("build block: the build says a misspelled key does nothing", async () => {
  // An unknown target too, so the run stops right after the warning.
  const r = await buildIn({
    title: "typo",
    build: { targets: ["nope"], targtes: ["browser"] },
  });
  assertEquals(r.code, 1, r.err);
  assertStringIncludes(r.err, "build.targtes");
  assertStringIncludes(r.err, `did you mean "targets"?`);
});
