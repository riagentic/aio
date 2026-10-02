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
import { walk } from "@std/fs/walk";
import { codeText } from "../src/diagnostics/code-mask.ts";
import { unknownBuildKeys, VALID_BUILD_KEYS } from "../src/server/config.ts";
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

/** Names that follow a `build` in src/ and are NOT a deno.json key — each
 *  with what it is. A name that is neither here nor in `VALID_BUILD_KEYS`
 *  fails the test below: decide which it is. */
const NOT_A_BUILD_KEY: Record<string, string> = {
  os: "Deno.build, passed as a `build` parameter",
  arch: "Deno.build, passed as a `build` parameter",
  onLoad: "esbuild's plugin API — `setup(build)`",
  onResolve: "esbuild's plugin API — `setup(build)`",
  code: "dev-android's `build` is a finished child process",
  err: "dev-android's `build` is a finished child process",
};

Deno.test("build block keys: every key src/ READS from the build block is a known key, and every known key is read", async () => {
  // `keepPackages` and `chromiumExtras` shipped, documented and honoured —
  // and the same build said "aio never reads build.keepPackages — it does
  // nothing", and the linter called both an ERROR, because the list is
  // hand-kept and each reader is its own little cast. So the readers are
  // derived from the source: the three shapes a build key is read in.
  const READS = [
    // cfg.build?.minify · build.css
    /(?<!Deno\??\.)(?<![\w$])build\??\.([A-Za-z_]\w*)/g,
    // { build?: { minify?: unknown } } · (cfg.build as { out?: string })
    /\bbuild(?:\??:|\s+as)\s*\{([^{}]*)/g,
  ];
  const read = new Map<string, string>();
  const src = new URL("../src/", import.meta.url);
  for await (
    const e of walk(src, {
      includeDirs: false,
      exts: [".ts", ".tsx"],
      skip: [/node_modules/],
    })
  ) {
    // Code only: `build.gradle` in a string and `build.ts` in a comment are
    // not reads.
    const code = codeText(await Deno.readTextFile(e.path));
    for (const m of code.matchAll(READS[0]!)) read.set(m[1]!, e.path);
    for (const m of code.matchAll(READS[1]!)) {
      for (const k of m[1]!.matchAll(/([A-Za-z_]\w*)\??:/g)) {
        read.set(k[1]!, e.path);
      }
    }
  }
  const unknown = [...read].filter(([k]) =>
    !VALID_BUILD_KEYS.has(k) && !(k in NOT_A_BUILD_KEY)
  );
  assertEquals(
    unknown,
    [],
    "src/ reads a build key that VALID_BUILD_KEYS (src/server/config.ts) " +
      "does not list — the build would call it a key aio never reads",
  );
  // …and the other way: a listed key nothing reads is a typo gate that
  // accepts a key doing nothing (and proves the scan sees every reader).
  assertEquals(
    [...VALID_BUILD_KEYS].filter((k) => !read.has(k)),
    [],
    "a key in VALID_BUILD_KEYS is read nowhere in src/",
  );
  assertEquals(
    unknownBuildKeys({ keepPackages: ["typescript"], chromiumExtras: "strip" }),
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
