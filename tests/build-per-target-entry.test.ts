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
    [{ name: "server", kind: "server" }, {
      name: "electron-client",
      kind: "electron-client",
    }],
  );
  // whitespace/empties tolerated exactly as before
  assertEquals(normalizeTargets([" server ", "", "cli"]), [
    { name: "server", kind: "server" },
    { name: "cli", kind: "cli" },
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
    {
      name: "server",
      kind: "server",
      entry: "src/relay/app.ts",
      appName: "relay",
    },
    { name: "electron", kind: "electron", entry: "src/app.ts" },
    { name: "cli", kind: "cli" },
  ]);
});

Deno.test("normalizeTargets: --targets selects without dropping overrides", () => {
  const block = {
    server: { entry: "src/relay/app.ts", name: "relay" },
    electron: { entry: "src/app.ts" },
  };
  assertEquals(normalizeTargets(block, "server"), [
    {
      name: "server",
      kind: "server",
      entry: "src/relay/app.ts",
      appName: "relay",
    },
  ]);
  // a name absent from the declaration is still selectable (array-form parity)
  assertEquals(normalizeTargets(block, "cli"), [{ name: "cli", kind: "cli" }]);
  // --targets= on an array-form config behaves as before
  assertEquals(normalizeTargets(["server"], "cli,browser"), [
    { name: "cli", kind: "cli" },
    { name: "browser", kind: "browser" },
  ]);
});

Deno.test("normalizeTargets: per-target platforms survive", () => {
  assertEquals(normalizeTargets({ cli: { platforms: ["linux", "windows"] } }), [
    { name: "cli", kind: "cli", platforms: ["linux", "windows"] },
  ]);
});

Deno.test("normalizeTargets: labelled targets with kind (two apps, one kind)", () => {
  // R-3: two Electron apps in one repo — labels are free, `kind`
  // names what gets built.
  assertEquals(
    normalizeTargets({
      agent: {
        kind: "electron",
        entry: "src/agent/app.ts",
        name: "remote-agent",
      },
      control: {
        kind: "electron",
        entry: "src/control/app.ts",
        name: "remote-control",
      },
      relay: {
        kind: "server-app",
        entry: "src/server/app.ts",
        name: "remote-server",
        ui: "Status.tsx",
      },
    }),
    [
      {
        name: "agent",
        kind: "electron",
        entry: "src/agent/app.ts",
        appName: "remote-agent",
      },
      {
        name: "control",
        kind: "electron",
        entry: "src/control/app.ts",
        appName: "remote-control",
      },
      {
        name: "relay",
        kind: "server-app",
        entry: "src/server/app.ts",
        appName: "remote-server",
        ui: "Status.tsx",
      },
    ],
  );
  // --targets= selects by LABEL and keeps the kind
  assertEquals(
    normalizeTargets(
      { agent: { kind: "electron", entry: "src/agent/app.ts" } },
      "agent",
    ),
    [{ name: "agent", kind: "electron", entry: "src/agent/app.ts" }],
  );
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
  /** Every file still in the project when the build finished, root-relative.
   *  The guard exists to keep sources ALIVE, so that is what is asserted. */
  survivors: string[];
};

/** Run the orchestrator against a temp project. `args` is the argv buildAll
 *  reads (Deno.args), minus the stub wiring. */
async function runBuildAll(
  denoJson: Record<string, unknown>,
  files: string[],
  args: string[] = [],
  stubSrc: string = STUB,
): Promise<Run> {
  const dir = await Deno.makeTempDir({ prefix: "aio-per-target-" });
  const stub = join(dir, "stub-build.ts");
  await Deno.writeTextFile(stub, stubSrc);
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
    const survivors: string[] = [];
    const walk = (d: string, prefix: string): void => {
      for (const e of Deno.readDirSync(d)) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory) walk(join(d, e.name), rel);
        else survivors.push(rel);
      }
    };
    walk(dir, "");
    return {
      code,
      argv: log.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
      dist: dist.sort(),
      manifest,
      survivors: survivors.sort(),
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
  assert(run.survivors.includes("src/relay/app.ts"), "the app's source lives");
});

// The reported repro, end to end: an app at `apps/web/` with `out: "apps"`.
// The guard tested EXACT set membership, so `apps` (the app dir's PARENT) was
// not "forbidden" — the build then ran `Deno.remove(outDir, {recursive:true})`
// over the user's source tree, printed `✓ 1/1 build(s) → apps/` and exited 0.
Deno.test("build-all: an `out` that CONTAINS the app dir is refused — sources survive", async () => {
  const run = await runBuildAll(
    {
      title: "Web",
      entry: "apps/web/main.ts",
      build: { targets: ["browser"], out: "apps" },
    },
    ["apps/web/main.ts", "apps/web/App.tsx", "apps/web/PRECIOUS.txt"],
  );
  assertEquals(run.code, 1, "the build must refuse");
  assertEquals(run.argv.length, 0, "nothing was spawned");
  for (
    const f of ["apps/web/main.ts", "apps/web/App.tsx", "apps/web/PRECIOUS.txt"]
  ) {
    assert(
      run.survivors.includes(f),
      `${f} was DELETED (survivors: ${run.survivors})`,
    );
  }
});

// ── a target that emitted nothing is a FAILURE, not a green tick ────────────
// The single-target build exited 0 but no artifact appeared (a packaging step
// that swallowed its own error, a name the artifact detector cannot see). That
// was recorded as `ok: true` with an empty artifact list: a green ✓ in the
// summary, exit 0, and a manifest.json — what a release pipeline reads to
// decide what to publish — declaring a successful target with nothing in it.
Deno.test("build-all: a target that produces NO artifact fails the build", async () => {
  // Exits 0 like a happy build, but only the `--cli` target actually writes a
  // file — the `browser` target succeeds loudly and emits nothing.
  const SILENT_BROWSER_STUB = STUB.replace(
    'await Deno.writeTextFile(root + "/" + slug, "binary\\n");',
    'if (Deno.args.includes("--cli")) {\n' +
      '  await Deno.writeTextFile(root + "/" + slug, "binary\\n");\n' +
      "}",
  );
  const run = await runBuildAll(
    { title: "Silent", build: { targets: ["browser", "cli"], out: "dist" } },
    ["src/app.ts"],
    [],
    SILENT_BROWSER_STUB,
  );
  assertEquals(run.code, 1, "the fleet build must not exit 0");
  const targets = run.manifest.targets as Array<Record<string, unknown>>;
  const browser = targets.find((t) => t.target === "browser")!;
  assertEquals(browser.ok, false, "the empty-handed target is not ok");
  assert(
    String(browser.error).includes("no recognized artifact"),
    `the manifest says why: ${JSON.stringify(browser.error)}`,
  );
  assertEquals(browser.artifacts, []);
  // The target that DID produce something is still collected and still ok.
  const cli = targets.find((t) => t.target === "cli")!;
  assertEquals(cli.ok, true);
  assertEquals((cli.artifacts as unknown[]).length, 1);
});

// A fleet run that produces nothing must leave the LAST GOOD RELEASE standing —
// the orchestrator says so in as many words ("leaving dist/ untouched"), and it
// was not true. `out` defaults to `dist/`, which the per-target builds treat as
// scratch: the bundle step removes it recursively and the pre-compile sweep
// clears everything but app.js. So by the time the first target failed, the
// previous binaries and manifest.json — what a release pipeline reads to decide
// what to publish — were already deleted, and the summary said they weren't.
// The stub reproduces exactly that: wipe `out`, leave intermediate output, fail.
Deno.test("build-all: a fleet run that produces nothing keeps the previous release", async () => {
  const WIPES_OUT_THEN_FAILS = `
const root = Deno.cwd();
await Deno.remove(root + "/dist", { recursive: true }).catch(() => {});
await Deno.mkdir(root + "/dist", { recursive: true });
await Deno.writeTextFile(root + "/dist/app.js", "intermediate\\n");
Deno.exit(1);
`;
  const run = await runBuildAll(
    { title: "My App", build: { targets: ["browser"], out: "dist" } },
    ["src/app.ts", "dist/my-app", "dist/manifest.json"],
    [],
    WIPES_OUT_THEN_FAILS,
  );
  assertEquals(run.code, 1, "the fleet build must not exit 0");
  assertEquals(
    run.dist,
    ["manifest.json", "my-app"],
    "the previous release must still be there, and the failed run's " +
      "intermediate output must not be presented as one",
  );
  assert(
    run.survivors.includes("dist/my-app") &&
      run.survivors.includes("dist/manifest.json"),
    `previous artifacts destroyed by a failed build: ${run.survivors}`,
  );
});

// …and the other direction: `out` INSIDE the app dir.
Deno.test("build-all: an `out` INSIDE the app dir is refused — sources survive", async () => {
  const run = await runBuildAll(
    {
      title: "Web",
      entry: "src/main.ts",
      build: { targets: ["browser"], out: "src/ui" },
    },
    ["src/main.ts", "src/ui/Button.tsx"],
  );
  assertEquals(run.code, 1);
  assert(run.survivors.includes("src/ui/Button.tsx"), "nested sources live");
});

// ── fleet sanity: clients with nothing to dial ──────────────────────────────

Deno.test("buildAll: client targets without a server role or build.server warn loud", async () => {
  // a field report shipped ["browser", "electron-client", "android-client"] —
  // `browser` is a LOCAL app binary, so the two client artifacts recorded no
  // server to dial. Builds fine, ships broken: exactly the class that must
  // say so at build time.
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    await runBuildAll(
      {
        title: "fleet-warn",
        build: { targets: ["browser", "cli-client"], out: "dist" },
      },
      ["src/app.ts", "src/client.ts"],
    );
    const all = errors.join("\n");
    if (!all.includes('no "server" target')) {
      throw new Error(`expected the fleet warning, got:\n${all}`);
    }
  } finally {
    console.error = orig;
  }
});

Deno.test("buildAll: build.server (or a server target) silences the fleet warning", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    await runBuildAll(
      {
        title: "fleet-ok",
        build: {
          targets: ["cli-client"],
          out: "dist",
          server: "192.168.1.50:8000",
        },
      },
      ["src/app.ts", "src/client.ts"],
    );
    const all = errors.join("\n");
    if (all.includes('no "server" target')) {
      throw new Error(`warning must not fire with build.server set:\n${all}`);
    }
  } finally {
    console.error = orig;
  }
});
