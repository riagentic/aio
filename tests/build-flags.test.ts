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

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";

import {
  BUILD_BOOL_FLAGS,
  BUILD_VALUE_FLAGS,
  FLEET_BOOL_FLAGS,
  FLEET_VALUE_FLAGS,
  SHIP_BOOL_FLAGS,
  SHIP_VALUE_FLAGS,
  unknownBuildFlags,
  unknownFleetFlags,
  unknownShipFlags,
} from "../src/build/build-flags.ts";
import { standardTasks, TARGETS } from "../src/am/am-cmd-create.ts";

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

Deno.test("ship flags: the release CLI has the same gate, and it matters more", () => {
  assertEquals(
    unknownShipFlags([
      "./dist/app",
      "--src=src",
      "--name=n",
      "--version=1.0.0",
      "--key=k.json",
      "--channel=prod",
      "--target=binary",
      "--url=https://x/y",
      "--notes=hi",
      "--min-from=1.0.0",
      "--data=c.json",
      "--no-data",
      "--out=ship.json",
      "--channel-dir=site",
      "--github",
      "--stdout",
      "--force",
    ]),
    [],
  );
  // The three that publish a DIFFERENT release in silence: a misspelled --key
  // publishes UNSIGNED, a misspelled --no-data runs the probe it meant to
  // skip, a misspelled --min-from drops the floor clients check.
  assertEquals(unknownShipFlags(["bin", "--keys=k.json"]), ["--keys=k.json"]);
  assertEquals(unknownShipFlags(["bin", "--no-dta"]), ["--no-dta"]);
  assertEquals(unknownShipFlags(["bin", "--min-form=1.0.0"]), [
    "--min-form=1.0.0",
  ]);
  // The binary itself is positional and must not be read as a flag.
  assertEquals(unknownShipFlags(["./dist/app"]), []);
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

Deno.test("build-all: `--allow-server-only` reaches the single-target build", async () => {
  // The Android gate refuses a standalone APK whose graph reaches server-only
  // code and names `--allow-server-only` as the way out. The fleet did not
  // know that flag, and the fleet IS the build path (`deno task build` /
  // `deno task compile`), so the advice pointed at a command no scaffolded app
  // could run. Accepted here, and forwarded verbatim.
  const r = await runBuild(BUILD_ALL, [
    "--targets=browser",
    "--allow-server-only",
  ]);
  assert(
    !r.out.includes("unknown flag"),
    `the fleet must accept --allow-server-only:\n${r.out}`,
  );
  const src = await Deno.readTextFile(BUILD_ALL);
  assertStringIncludes(
    src.replace(/\/\/.*$/gm, ""),
    'args.push("--allow-server-only")',
    "accepting it is only half — it has to be forwarded to the target build",
  );
});

Deno.test("ship: an unknown flag is refused before anything is published", async () => {
  const ship = join(
    import.meta.dirname ?? ".",
    "..",
    "src",
    "build",
    "ship.ts",
  );
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", ship, "/bin/true", "--keys=release-key.json"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(r.stdout) +
    new TextDecoder().decode(r.stderr);
  assertEquals(r.code, 1, `expected a refusal, got:\n${out}`);
  assertStringIncludes(out, "--keys=release-key.json");
  assertStringIncludes(out, "--key=", "the real spelling is in the message");
});

// ── 3. `deno task compile` == `deno task build --targets=<target>` ──────────
// The one-decider contract, one step stronger since alpha52: `compile` is not
// a SECOND flag table that must be kept equal to the fleet's — it IS the fleet
// pipeline, narrowed. There is exactly one producer of build flags
// (build-all's TARGETS map), so the runtime-flag drift can't recur.

Deno.test("scaffold: `compile` is the fleet build narrowed to the default target", () => {
  for (const source of [true, false]) {
    for (const target of TARGETS) {
      const tasks = standardTasks(source, target);
      assertEquals(
        tasks.compile,
        `${tasks.build} --targets=${target}`,
        `target "${target}" (source=${source}): compile must be the build ` +
          `task plus --targets — one pipeline, not two spellings`,
      );
    }
  }
});

Deno.test("scaffold: the build/compile tasks use flags the FLEET understands", () => {
  for (const target of TARGETS) {
    const tasks = standardTasks(true, target);
    for (const name of ["build", "compile"] as const) {
      // Minus `deno run -A <script>` — everything after is fleet argv.
      const args = tasks[name]!.trim().split(/\s+/).slice(4);
      assertEquals(
        unknownFleetFlags(args),
        [],
        `task "${name}" (target ${target}) passes a flag the fleet ignores: ${
          tasks[name]
        }`,
      );
    }
  }
});

// ── 4. the vocabulary IS the whole vocabulary ───────────────────────────────
//
// Sections 1–3 check the tables against hand-written lists, which is the same
// hand-maintained invariant one layer along: a flag added to an entry point
// and forgotten here is read fine and refused by nothing, and a flag that is
// only in the table documents something no code reads. Both already happened —
// `--print-install-root` was read by `src/build.ts` and absent from
// `BUILD_BOOL_FLAGS` (harmless only by accident of ordering: build.ts answers
// it before loadBuildConfig validates), and `--allow-server-only` was a real
// build flag the FLEET refused, which made the Android refusal name a way out
// no scaffolded app could take.
//
// So the source is the input: every `--flag` an entry point actually reads
// must be in that entry point's table.

/** Flag literals `src` reads from its argv, with comments stripped so a flag
 *  merely DISCUSSED in a doc comment is not mistaken for one that is read. */
function flagsReadBy(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const found = new Set<string>();
  // `args.includes("--x")` — a boolean.
  for (const m of code.matchAll(/\bargs\.includes\("(--[a-z0-9-]+)"\)/gi)) {
    found.add(m[1]!);
  }
  // `a.startsWith("--x=")` / `a.startsWith("--x")` — a value flag or a prefix
  // test; either way the entry point reads that spelling.
  for (const m of code.matchAll(/\.startsWith\("(--[a-z0-9-]+)=?"\)/gi)) {
    found.add(m[1]!);
  }
  // The `flag("x")` helper both fleet and ship use: `--x=<value>`.
  for (const m of code.matchAll(/\bflag\("([a-z0-9-]+)"\)/gi)) {
    found.add(`--${m[1]!}`);
  }
  return [...found].sort();
}

/** The table's spellings, with `=` stripped from the value flags. */
const vocabulary = (
  bools: readonly string[],
  values: readonly string[],
): Set<string> => new Set([...bools, ...values]);

Deno.test("build flags: every flag the SOURCE reads is in its table", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const read = async (rel: string) => await Deno.readTextFile(join(root, rel));

  const cases: [string, string[], Set<string>][] = [
    [
      "src/build.ts + src/build/build-config.ts",
      [
        ...flagsReadBy(await read("src/build.ts")),
        ...flagsReadBy(await read("src/build/build-config.ts")),
      ],
      vocabulary(BUILD_BOOL_FLAGS, BUILD_VALUE_FLAGS),
    ],
    [
      "src/build-all.ts",
      flagsReadBy(await read("src/build-all.ts")),
      vocabulary(FLEET_BOOL_FLAGS, FLEET_VALUE_FLAGS),
    ],
    [
      "src/build/ship.ts",
      flagsReadBy(await read("src/build/ship.ts")),
      vocabulary(SHIP_BOOL_FLAGS, SHIP_VALUE_FLAGS),
    ],
  ];

  const missing: string[] = [];
  for (const [where, reads, known] of cases) {
    for (const f of reads) {
      if (!known.has(f)) missing.push(`${where} reads ${f}`);
    }
  }
  assertEquals(
    missing,
    [],
    `these flags are READ but not in the entry point's vocabulary, so the ` +
      `refusal gate would reject a caller who passes one — and the "known:" ` +
      `line the refusal prints is a lie:\n     ${missing.join("\n     ")}`,
  );
});

Deno.test("build flags: no table entry is a flag nothing reads", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const read = async (rel: string) => await Deno.readTextFile(join(root, rel));
  const buildReads = new Set([
    ...flagsReadBy(await read("src/build.ts")),
    ...flagsReadBy(await read("src/build/build-config.ts")),
    // Read from the BuildConfig the two files above produce, but spelled in
    // the bundle's refusal — the gate below only needs to know it is real.
    ...flagsReadBy(await read("src/build/build-bundle.ts")),
  ]);
  const fleetReads = new Set(flagsReadBy(await read("src/build-all.ts")));
  const shipReads = new Set([
    ...flagsReadBy(await read("src/build/ship.ts")),
  ]);

  const stray: string[] = [];
  const check = (
    where: string,
    table: readonly string[],
    reads: Set<string>,
  ) => {
    for (const f of table) if (!reads.has(f)) stray.push(`${where}: ${f}`);
  };
  check("BUILD", [...BUILD_BOOL_FLAGS, ...BUILD_VALUE_FLAGS], buildReads);
  check("FLEET", [...FLEET_BOOL_FLAGS, ...FLEET_VALUE_FLAGS], fleetReads);
  check("SHIP", [...SHIP_BOOL_FLAGS, ...SHIP_VALUE_FLAGS], shipReads);
  assertEquals(
    stray,
    [],
    `these flags are ACCEPTED but nothing reads them — a caller passing one ` +
      `gets no refusal and no effect, which is the exact silence this module ` +
      `exists to remove:\n     ${stray.join("\n     ")}`,
  );
});

// ── the same near-miss, the other direction ──────────────────────────
//
// "a runtime flag is not a build flag" (above) has been a red gate for
// releases. The reverse — a BUILD flag typed at a running app — was refused
// correctly and phrased as though it were a misspelling, so the reader went
// looking for a typo that was not there. `--headless` and `--no-electron` are
// the two people actually type at a binary.
import { parseCli } from "../src/server/aio-cli.ts";

Deno.test("runtime: a BUILD flag is refused as a CATEGORY error, not a typo", () => {
  for (
    const [flag, runtime] of [
      ["--headless", "--client=server-only"],
      ["--no-electron", "--client=browser"],
      ["--cli", "--client=cli"],
    ] as const
  ) {
    const e = assertThrows(() => parseCli([flag])) as Error;
    assertStringIncludes(e.message, "BUILD flag");
    assertStringIncludes(
      e.message,
      runtime,
      `${flag} must name the runtime spelling for what it selects`,
    );
    assert(
      !/did you mean/.test(e.message),
      `${flag} is not a misspelling — a did-you-mean sends the reader hunting ` +
        `for a typo that is not there: ${e.message}`,
    );
  }
});

Deno.test("runtime: an actual typo still gets its did-you-mean", () => {
  // The category branch must not swallow the case it sits in front of.
  const e = assertThrows(() => parseCli(["--experse"])) as Error;
  assertStringIncludes(e.message, "did you mean --expose");
});
