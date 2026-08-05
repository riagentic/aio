// The bundle freshness cache, and the guard on the path that PACKAGES a bundle
// it did not build.
//
// Both bugs shipped WRONG CODE with a green build:
//   • the cache matched `/\.(tsx?|css)$/` and walked from the cwd, so an edit
//     to an imported `.js`/`.json`, or to a monorepo sibling package outside
//     the project root, printed "cached — use --force to rebuild" and left the
//     OLD bundle in place; `--compile` then embedded it verbatim.
//   • `--headless` skips the bundle step but still passes `--include dist/`, so
//     `compile:android` followed by `compile:service` shipped a server serving
//     an IIFE that the prod shell (`const { mount } = await import('/app.js')`)
//     cannot mount — a blank page, exit 0.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  embedVerdict,
  isBundleFresh,
  versionStamp,
} from "../src/build/build-bundle.ts";
import { cliEntryFor } from "../src/build/build-cli.ts";
import { apkLabel } from "../src/build/build-android.ts";
import type { BuildConfig } from "../src/build/build-config.ts";
import { VERSION } from "../src/server/aio-cli.ts";

/** `appDir` defaults to `root` — the flat layout the scenario below builds
 *  (App.tsx sits at the project root). Pass another to model a SECOND app in
 *  the same repo (per-target `entry`), which bundles to the very same
 *  dist/app.js. */
const cfgFor = (root: string, appDir = root): BuildConfig =>
  ({
    root,
    appDir,
    out: join(root, "dist", "app.js"),
    dist: join(root, "dist"),
    doForce: false,
    doAndroid: false,
    isRemote: false,
    frameworkSrcDir: "",
  }) as unknown as BuildConfig;

const write = async (path: string, text: string): Promise<void> => {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A project whose bundle was built from four inputs esbuild really read:
 *  a .tsx, a .js, a .json, and a file in a SIBLING package outside the project
 *  root — the two extensions and the one root the old heuristic could not see.
 *  Returns the paths plus a ready BuildConfig. */
type Inputs = { app: string; helper: string; data: string; shared: string };

async function scenario(): Promise<
  { root: string; workspace: string; inputs: Inputs }
> {
  const workspace = await Deno.makeTempDir({ prefix: "aio-cache-" });
  const root = join(workspace, "apps", "web");
  const inputs: Inputs = {
    app: join(root, "App.tsx"),
    helper: join(root, "helper.js"),
    data: join(root, "data.json"),
    shared: join(workspace, "packages", "shared", "lib.ts"), // OUTSIDE root
  };
  await write(join(root, "deno.json"), "{}");
  for (const p of Object.values(inputs)) await write(p, "// v1\n");
  // The artifact is written AFTER its inputs, as a real build does.
  await sleep(15);
  await write(
    join(root, "dist", "app.js"),
    versionStamp(VERSION) + 'globalThis.__aioBundleTarget = "browser";\n',
  );
  await write(
    join(root, ".aio", "bundle-inputs.json"),
    JSON.stringify({
      v: 2,
      out: join(root, "dist", "app.js"),
      app: root, // the app this bundle was built FROM (flat layout: appDir = root)
      inputs: Object.values(inputs),
    }),
  );
  return { root, workspace, inputs };
}

Deno.test("bundle cache: an edit to ANY real input invalidates it — whatever its extension or root", async () => {
  for (
    const [what, key] of [
      [".tsx source", "app"],
      ["an imported .js file", "helper"],
      ["an imported .json file", "data"],
      ["a sibling package OUTSIDE the project root", "shared"],
    ] as const
  ) {
    const { root, workspace, inputs } = await scenario();
    try {
      const cfg = cfgFor(root);
      assertEquals(await isBundleFresh(cfg), true, `control (${what})`);
      await sleep(15);
      await Deno.writeTextFile(inputs[key], "// v2\n");
      assertEquals(await isBundleFresh(cfg), false, `edited ${what}`);
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  }
});

Deno.test("bundle cache: a DELETED input is a change too", async () => {
  const { root, workspace, inputs } = await scenario();
  try {
    const cfg = cfgFor(root);
    assertEquals(await isBundleFresh(cfg), true, "control");
    await Deno.remove(inputs.helper);
    assertEquals(await isBundleFresh(cfg), false, "input removed");
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("bundle cache: no recorded input list → rebuild, never a guess", async () => {
  const { root, workspace } = await scenario();
  try {
    const cfg = cfgFor(root);
    assertEquals(await isBundleFresh(cfg), true, "control");
    // A bundle from an aio that did not record its inputs (or a wiped .aio)
    // cannot be shown fresh — the absence of the honest answer is not a yes.
    await Deno.remove(join(root, ".aio", "bundle-inputs.json"));
    assertEquals(await isBundleFresh(cfg), false, "no input record");
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("bundle cache: a record written for another artifact is ignored", async () => {
  const { root, workspace } = await scenario();
  try {
    await Deno.writeTextFile(
      join(root, ".aio", "bundle-inputs.json"),
      JSON.stringify({
        v: 2,
        out: "/somewhere/else/app.js",
        app: root,
        inputs: [],
      }),
    );
    assertEquals(await isBundleFresh(cfgFor(root)), false);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

// ── two apps, one repo: `dist/app.js` is not enough of a key ────────────────
// `"targets": { "server": { "entry": "src/relay/app.ts" }, "browser": {} }` is
// a supported layout (TargetOverride.entry). EVERY target bundles to the SAME
// dist/app.js and stamps it with the same version + shape, so nothing in the
// artifact or in the mtimes distinguished app A's bundle from app B's: the
// second app's build printed "cached — use --force", shipped app A's UI and
// exited 0. On a headless target it is worse — that path never rebuilds, so
// `embedVerdict` saw `fresh: true` and embedded the other app's bundle
// verbatim into the binary.
Deno.test("bundle cache: a bundle built from ANOTHER app in the same repo is not fresh", async () => {
  const { root, workspace } = await scenario();
  try {
    // Control: the app the record was written for is still cached.
    assertEquals(await isBundleFresh(cfgFor(root)), true, "control (same app)");

    // A second app in the same repo — its own App.tsx, its own app dir, the
    // same dist/app.js. Its sources are OLDER than the bundle (they were
    // written first), so every mtime says "fresh".
    const other = join(root, "relay");
    await write(join(other, "App.tsx"), "// app B\n");
    const st = await Deno.stat(join(root, "dist", "app.js"));
    const old = new Date(st.mtime!.getTime() - 60_000);
    await Deno.utime(join(other, "App.tsx"), old, old);

    assertEquals(
      await isBundleFresh(cfgFor(root, other)),
      false,
      "the other app's build must NOT reuse this app's bundle",
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

// ── the PACKAGING path: what may be embedded, and what must not ─────────────

const V = (over: Partial<Parameters<typeof embedVerdict>[0]> = {}) =>
  embedVerdict({
    stamps: { version: VERSION, target: "browser" },
    want: "browser",
    version: VERSION,
    fresh: true,
    canRebuild: true,
    out: "/proj/dist/app.js",
    appEntry: "/proj/src/App.tsx",
    ...over,
  });

Deno.test("embed guard: only a bundle matching THIS target's shape and version is embedded", () => {
  assertEquals(V().action, "embed", "current browser bundle");
  // No dist/app.js at all is the headless build — it must stay embeddable, so
  // the server keeps answering with the loud 503 "no browser UI" page.
  assertEquals(V({ stamps: null }).action, "embed", "no bundle at all");
  // The android IIFE the prod shell cannot mount.
  const wrongShape = V({ stamps: { version: VERSION, target: "android" } });
  assertEquals(wrongShape.action, "rebuild");
  assert("message" in wrongShape);
  assertStringIncludes(wrongShape.message, "android");
  assertStringIncludes(wrongShape.message, "browser", "names BOTH shapes");
  // …and in the other direction (an android target finding a browser bundle).
  assertEquals(
    V({ want: "android", stamps: { version: VERSION, target: "browser" } })
      .action,
    "rebuild",
  );
  // Built by another aio, or before the shape stamp existed.
  assertEquals(
    V({ stamps: { version: "0.0.1", target: "browser" } }).action,
    "rebuild",
  );
  assertEquals(V({ stamps: { target: "browser" } }).action, "rebuild");
  assertEquals(V({ stamps: { version: VERSION } }).action, "rebuild");
  // Right shape, right version, but older than its sources.
  assertEquals(V({ fresh: false }).action, "rebuild");
});

Deno.test("embed guard: with no App.tsx to rebuild from it REFUSES, naming both shapes", () => {
  const v = V({
    stamps: { version: VERSION, target: "android" },
    canRebuild: false,
  });
  assertEquals(v.action, "refuse");
  assert("message" in v);
  assertStringIncludes(v.message, "android");
  assertStringIncludes(v.message, "browser");
  assertStringIncludes(v.message, "/proj/src/App.tsx");
  // A stale-but-right-shape bundle with no source is refused for the same
  // reason: this target embeds dist/ verbatim and never rebuilds it.
  assertEquals(V({ fresh: false, canRebuild: false }).action, "refuse");
  // …but "no bundle" is still fine without any source.
  assertEquals(V({ stamps: null, canRebuild: false }).action, "embed");
});

// The same guard, through the real `build.ts`: a server/headless build whose
// dist/ holds the WRONG SHAPE must not produce a binary. Reproduced exactly as
// reported — `compile:android` leaves an IIFE behind, `compile:service` picks
// it up. It exits before `deno compile` runs, so this stays cheap.
Deno.test("build --compile --headless: refuses to package an android bundle as a browser one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-embed-" });
  try {
    await write(
      join(dir, "deno.json"),
      JSON.stringify({ title: "Svc", version: "1.0.0" }),
    );
    // Entry only — no App.tsx, so the build cannot honestly rebuild the UI.
    await write(join(dir, "src", "app.ts"), 'console.log("svc");\n');
    // What `compile:android` leaves behind.
    await write(
      join(dir, "dist", "app.js"),
      versionStamp(VERSION) + 'globalThis.__aioBundleTarget = "android";\n' +
        "(function(){/* IIFE, no export */})();\n",
    );
    const buildScript = join(
      import.meta.dirname ?? ".",
      "..",
      "src",
      "build.ts",
    );
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", buildScript, "--compile", "--service", "--headless"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(r.stderr) +
      new TextDecoder().decode(r.stdout);
    assertEquals(r.code, 1, `expected a refusal, got:\n${err}`);
    assertStringIncludes(err, "android");
    assertStringIncludes(err, "browser");
    // …and no binary was produced from the wrong-shaped bundle.
    const names = [...Deno.readDirSync(dir)].map((e) => e.name);
    assert(!names.includes("svc"), `binary produced anyway: ${names}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── cli-client compiles the entry it DECLARED ───────────────────────────────

Deno.test("cliEntryFor: a declared entry wins; the src/client.ts convention only fills the gap", () => {
  // The reported bug: the banner and manifest.json said apps/cli/client.ts,
  // `deno compile` got src/client.ts.
  assertEquals(
    cliEntryFor({
      doRemote: true,
      configEntry: "apps/cli/client.ts",
      entryOverride: "apps/cli/client.ts",
    }),
    "apps/cli/client.ts",
  );
  // No per-target entry → the scaffold's convention for a REMOTE client, which
  // is a different program from the app's own entry.
  assertEquals(
    cliEntryFor({ doRemote: true, configEntry: "src/app.ts" }),
    "src/client.ts",
  );
  // Local CLI → the app's entry, declared or default.
  assertEquals(
    cliEntryFor({ doRemote: false, configEntry: "apps/cli/main.ts" }),
    "apps/cli/main.ts",
  );
  assertEquals(
    cliEntryFor({
      doRemote: false,
      configEntry: "src/app.ts",
      entryOverride: "  apps/x/main.ts  ",
    }),
    "apps/x/main.ts",
  );
  assertEquals(
    cliEntryFor({
      doRemote: true,
      configEntry: "src/app.ts",
      entryOverride: "",
    }),
    "src/client.ts",
    "an empty override is not an entry",
  );
});

// …through the real build: the declared module is the one handed to
// `deno compile`. Reported symptom — the banner printed the declared entry,
// `src/client.ts` got compiled, and with no such file the build died naming a
// path the app never mentions.
Deno.test("build --cli --remote: compiles the DECLARED entry, not src/client.ts", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-clientry-" });
  try {
    await write(
      join(dir, "deno.json"),
      JSON.stringify({ title: "Relay", version: "1.0.0" }),
    );
    // Deliberately unparsable: the compile fails fast, and what we assert is
    // WHICH module it was handed. There is no src/client.ts anywhere.
    await write(
      join(dir, "apps", "cli", "client.ts"),
      "this is not typescript(",
    );
    const buildScript = join(
      import.meta.dirname ?? ".",
      "..",
      "src",
      "build.ts",
    );
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        buildScript,
        "--compile",
        "--cli",
        "--remote",
        "--entry=apps/cli/client.ts",
      ],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    assertStringIncludes(out, "apps/cli/client.ts");
    assert(
      !out.includes("src/client.ts"),
      `must not fall back to the convention when an entry was declared:\n${out}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── a dev APK is not the shippable one ──────────────────────────────────────

Deno.test("apkLabel: the dev APK has its own name (and therefore its own package id)", () => {
  const bin = "myapp";
  assertEquals(apkLabel({ binaryName: bin, doRemote: false }), "myapp");
  assertEquals(apkLabel({ binaryName: bin, doRemote: true }), "myapp-client");
  // dev:android writes a cleartext, localhost-pointing APK. Under the shipped
  // name it was indistinguishable from the release artifact on disk.
  assertEquals(
    apkLabel({
      binaryName: bin,
      doRemote: false,
      androidDevUrl: "http://localhost:3000/",
    }),
    "myapp-dev",
  );
  // dev:android re-derives the applicationId from the APK's filename, so the
  // label the build writes and the id it stamps must come from this one rule.
  assert(
    apkLabel({
      binaryName: bin,
      doRemote: false,
      androidDevUrl: "http://x/",
    }) !==
      apkLabel({ binaryName: bin, doRemote: false }),
    "dev and release APKs are two different artifacts",
  );
});
