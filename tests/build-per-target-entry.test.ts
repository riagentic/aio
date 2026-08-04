/**
 * Per-target build entry — one repo, two apps (field report #8).
 *
 * `build.targets` may be the plain array (what `am create` writes, what every
 * existing project has) OR an object whose values override the entry module,
 * the app name, and the platform list for that target alone. Both must reach
 * the single-target build as the same thing; only the object form can express
 * "the server target compiles the relay, the electron target compiles the app".
 *
 * The build itself is stubbed via `--build-spec` — the contract under test is
 * the ARGV each target is invoked with (and the dist/ it assembles from the
 * artifacts that appear), not `deno compile`.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildAll, normalizeTargets, unsafeOutDir } from "../src/build-all.ts";
import { slugify } from "../src/build/build-helpers.ts";

// ── normalization: the array form is the object form with no overrides ──────

Deno.test("normalizeTargets: array form is unchanged (compat)", () => {
  assertEquals(
    normalizeTargets(["server", "electron-client"]),
    [{ name: "server" }, { name: "electron-client" }],
  );
  // whitespace/empties tolerated exactly as before
  assertEquals(normalizeTargets([" server ", "", "cli"]), [
    { name: "server" },
    { name: "cli" },
  ]);
  assertEquals(normalizeTargets(undefined), []);
});

Deno.test("normalizeTargets: object form carries entry/name/platforms", () => {
  const got = normalizeTargets({
    server: { entry: "src/relay/app.ts", name: "relay" },
    electron: { entry: "src/app.ts" },
    cli: {},
  });
  assertEquals(got, [
    { name: "server", entry: "src/relay/app.ts", appName: "relay" },
    { name: "electron", entry: "src/app.ts" },
    { name: "cli" },
  ]);
});

Deno.test("normalizeTargets: --targets selects without dropping overrides", () => {
  const block = {
    server: { entry: "src/relay/app.ts", name: "relay" },
    electron: { entry: "src/app.ts" },
  };
  assertEquals(normalizeTargets(block, "server"), [
    { name: "server", entry: "src/relay/app.ts", appName: "relay" },
  ]);
  // a name absent from the declaration is still selectable (array-form parity)
  assertEquals(normalizeTargets(block, "cli"), [{ name: "cli" }]);
  // --targets= on an array-form config behaves as before
  assertEquals(normalizeTargets(["server"], "cli,browser"), [
    { name: "cli" },
    { name: "browser" },
  ]);
});

Deno.test("normalizeTargets: per-target platforms survive", () => {
  assertEquals(normalizeTargets({ cli: { platforms: ["linux", "windows"] } }), [
    { name: "cli", platforms: ["linux", "windows"] },
  ]);
});

// ── the out-dir guard protects EVERY target's app dir ───────────────────────

Deno.test("unsafeOutDir: refuses out pointing at ANY target's app dir", () => {
  const root = "/proj";
  const appDirs = ["/proj/src", "/proj/src/relay"];
  // Both apps' source dirs are refused — `out` is wiped recursively, so
  // guarding only the first target's dir leaves the second app deletable.
  assert(unsafeOutDir("/proj/src/relay", root, appDirs), "second app's dir");
  assert(unsafeOutDir("/proj/src", root, appDirs), "first app's dir");
  // and an unrelated dedicated subdir is still fine
  assert(!unsafeOutDir("/proj/dist", root, appDirs), "dist");
  // an app dir OUTSIDE the conventional src/ is only known via the union
  const apps = ["/proj/apps/web", "/proj/apps/relay"];
  assert(unsafeOutDir("/proj/apps/relay", root, apps), "apps/relay");
  assert(unsafeOutDir("/proj/apps/web", root, apps), "apps/web");
});

// ── end to end: the right module reaches the right build ────────────────────

/** A stand-in for `build.ts`: records its argv, then creates the artifact the
 *  orchestrator expects (a bare binary named after `--name=`), so artifact
 *  detection, dist/ assembly and the manifest all run for real. Dependency-free
 *  — it runs in the temp project, whose deno.json has no import map. Its
 *  slugify mirrors build-helpers' and is asserted against it below. */
const STUB = `
const root = Deno.cwd();
await Deno.writeTextFile(
  root + "/argv.log",
  JSON.stringify(Deno.args) + "\\n",
  { append: true },
);
const name = Deno.args.find((a) => a.startsWith("--name="))!.slice(7);
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "") || "myapp";
await Deno.writeTextFile(root + "/" + slug, "binary\\n");
`;

type Run = {
  code: number;
  argv: string[][];
  dist: string[];
  manifest: Record<string, unknown>;
};

/** Run the orchestrator against a temp project. `args` is the argv buildAll
 *  reads (Deno.args), minus the stub wiring. */
async function runBuildAll(
  denoJson: Record<string, unknown>,
  files: string[],
  args: string[] = [],
): Promise<Run> {
  const dir = await Deno.makeTempDir({ prefix: "aio-per-target-" });
  const stub = join(dir, "stub-build.ts");
  await Deno.writeTextFile(stub, STUB);
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(denoJson, null, 2),
  );
  for (const f of files) {
    await Deno.mkdir(join(dir, f, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, f), "export {};\n");
  }
  const origArgs = Deno.args;
  const origCwd = Deno.cwd();
  Object.defineProperty(Deno, "args", {
    value: [`--build-spec=${stub}`, ...args],
    configurable: true,
  });
  Deno.chdir(dir);
  try {
    const code = await buildAll();
    const log = await Deno.readTextFile(join(dir, "argv.log")).catch(() => "");
    const dist: string[] = [];
    try {
      for await (const e of Deno.readDir(join(dir, "dist"))) dist.push(e.name);
    } catch { /* no dist */ }
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(
        await Deno.readTextFile(join(dir, "dist", "manifest.json")),
      );
    } catch { /* none */ }
    return {
      code,
      argv: log.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
      dist: dist.sort(),
      manifest,
    };
  } finally {
    Deno.chdir(origCwd);
    Object.defineProperty(Deno, "args", {
      value: origArgs,
      configurable: true,
    });
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const argOf = (argv: string[], flag: string): string | undefined =>
  argv.find((a) => a.startsWith(flag))?.slice(flag.length);

Deno.test("build-all: object-form targets build their OWN entry and name", async () => {
  const run = await runBuildAll(
    {
      title: "Two Apps",
      entry: "src/app.ts",
      build: {
        targets: {
          server: { entry: "src/relay/app.ts", name: "relay" },
          browser: { entry: "src/app.ts" },
        },
        out: "dist",
      },
    },
    ["src/app.ts", "src/relay/app.ts"],
  );
  assertEquals(run.code, 0);
  assertEquals(run.argv.length, 2);

  const [server, browser] = run.argv;
  // Each target compiles its OWN module — without --entry both would compile
  // deno.json's single `entry` and the repo could not hold two apps.
  assertEquals(argOf(server!, "--entry="), "src/relay/app.ts");
  assertEquals(argOf(browser!, "--entry="), "src/app.ts");
  // …under its OWN name: identical names would collide and be papered over by
  // the collision suffix (`myapp-server`), as if they were one app.
  assertEquals(argOf(server!, "--name="), "relay");
  assertEquals(argOf(browser!, "--name="), "Two Apps");

  // Both artifacts survive into dist/ under their own names.
  assertEquals(
    run.dist,
    ["manifest.json", slugify("relay"), slugify("Two Apps")].sort(),
  );
  const targets = run.manifest.targets as Array<Record<string, unknown>>;
  assertEquals(targets.map((t) => t.binary), ["relay", "two-apps"]);
  assertEquals(targets.map((t) => t.entry), [
    "src/relay/app.ts",
    "src/app.ts",
  ]);
});

Deno.test("build-all: array-form targets are byte-identical to before (compat)", async () => {
  const run = await runBuildAll(
    {
      title: "My App",
      build: { targets: ["server", "cli"], out: "dist" },
    },
    ["src/app.ts"],
  );
  assertEquals(run.code, 0);
  assertEquals(run.argv.length, 2);
  for (const argv of run.argv) {
    // no --entry at all: the single-target build keeps reading deno.json
    assertEquals(argv.filter((a) => a.startsWith("--entry=")), []);
    assertEquals(argOf(argv, "--name="), "My App");
  }
  // one app, one name → the collision suffix still disambiguates
  assertEquals(
    run.dist,
    ["manifest.json", slugify("My App"), `${slugify("My App")}-cli`].sort(),
  );
});

Deno.test("build-all: --targets selects a target and keeps its entry", async () => {
  const run = await runBuildAll(
    {
      title: "Two Apps",
      build: {
        targets: {
          server: { entry: "src/relay/app.ts", name: "relay" },
          browser: { entry: "src/app.ts" },
        },
      },
    },
    ["src/app.ts", "src/relay/app.ts"],
    ["--targets=server"],
  );
  assertEquals(run.code, 0);
  assertEquals(run.argv.length, 1);
  assertEquals(argOf(run.argv[0]!, "--entry="), "src/relay/app.ts");
  assertEquals(argOf(run.argv[0]!, "--name="), "relay");
});

Deno.test("build-all: a per-target entry that does not exist is refused, not compiled", async () => {
  const run = await runBuildAll(
    {
      title: "Two Apps",
      build: { targets: { server: { entry: "src/relay/nope.ts" } } },
    },
    ["src/app.ts"],
  );
  assertEquals(run.code, 1);
  assertEquals(run.argv.length, 0, "nothing was spawned");
});

Deno.test("build-all: out pointing at a target's app dir is refused", async () => {
  const run = await runBuildAll(
    {
      title: "Two Apps",
      entry: "src/app.ts",
      build: {
        // `out: "src/relay"` is only reachable as an app dir through the
        // per-target entry — the guard has to see EVERY target's dir.
        targets: { server: { entry: "src/relay/app.ts" }, browser: {} },
        out: "src/relay",
      },
    },
    ["src/app.ts", "src/relay/app.ts"],
  );
  assertEquals(run.code, 1);
  assertEquals(run.argv.length, 0, "nothing was spawned");
  // the sources are still there — the whole point of the guard
});
