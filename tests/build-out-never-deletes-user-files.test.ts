// `out` is emptied and refilled on every build, so a directory holding the
// user's own files must be refused, not wiped.
//
// Measured on a scaffolded app: `deno task build --out=tests` printed
// "1 built → tests/" and `tests/cell.test.ts` was gone — every path guard
// (root, src, .git, .aio, the app dir, inside dist/) passed it. A previous
// release in `out` (exactly the files its manifest.json lists) is still
// replaced as before, and dist/ — aio's own staging dir — is exempt.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { foreignOutEntries } from "../src/build/build-shape.ts";
import { shipApp } from "../src/build/ship.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const BUILD_ALL = new URL("../src/build-all.ts", import.meta.url).pathname;

Deno.test("out dir: only what the previous manifest placed counts as the build's own", () => {
  const manifest = {
    targets: [
      { target: "browser", artifacts: [{ file: "app-1.0.0", bytes: 1 }] },
      { target: "server", ok: false, artifacts: [] },
    ],
  };
  assertEquals(
    foreignOutEntries(["app-1.0.0", "manifest.json"], manifest),
    [],
  );
  assertEquals(
    foreignOutEntries(["notes.md", "app-1.0.0", "manifest.json"], manifest),
    ["notes.md"],
  );
  // No manifest: nothing there is the build's — not even a manifest.json
  // that is not one.
  assertEquals(foreignOutEntries(["cell.test.ts"], null), ["cell.test.ts"]);
  assertEquals(foreignOutEntries(["manifest.json"], { x: 1 }), [
    "manifest.json",
  ]);
  assertEquals(foreignOutEntries([], null), []);
});

Deno.test("out dir: a build pointed at a directory of the user's files refuses and deletes nothing", async () => {
  const dir = await tempDir("aio-out-user-files-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "outguard", build: { targets: ["browser"] } }),
    );
    await Deno.mkdir(join(dir, "tests"));
    await Deno.writeTextFile(join(dir, "tests", "cell.test.ts"), "// mine\n");
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", BUILD_ALL, "--out=tests"],
      cwd: dir,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const said = dec.decode(out.stderr) + dec.decode(out.stdout);
    assertEquals(out.code, 1, said);
    assertStringIncludes(said, "cell.test.ts");
    assertStringIncludes(said, "DELETED");
    assert(
      (await Deno.readTextFile(join(dir, "tests", "cell.test.ts"))) ===
        "// mine\n",
      "the user's file was touched",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("out dir: what am publish wrote beside the artifacts counts as aio's own", () => {
  const manifest = {
    targets: [{ target: "server", artifacts: [{ file: "app-1.0.0" }] }],
  };
  const pub = [
    "app-1.0.0.ship.json",
    "linux-x86_64.json",
    "darwin-aarch64.json",
  ];
  assertEquals(
    foreignOutEntries(["app-1.0.0", "manifest.json", ...pub], manifest),
    [],
  );
  // A channel dir (`am publish --dir=<out>`): only manifests + listed artifacts.
  assertEquals(
    foreignOutEntries(["app-1.0.0", "manifest.json", "prod"], manifest, {
      prod: ["linux-x86_64.json", "app-1.0.0"],
    }),
    [],
  );
  // …anything else stays the user's.
  assertEquals(
    foreignOutEntries(
      ["prod", "notes", "app-config.json", "other.ship.json", "empty"],
      manifest,
      { prod: ["linux-x86_64.json", "notes.md"], notes: [], empty: [] },
    ),
    ["app-config.json", "empty", "notes", "other.ship.json", "prod"],
  );
  // No manifest: not even publish-shaped names are the build's.
  assertEquals(foreignOutEntries(["linux-x86_64.json"], null), [
    "linux-x86_64.json",
  ]);
});

Deno.test("out dir: a build after am publish into a custom out is not refused", async () => {
  const dir = await tempDir("aio-out-after-publish-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "outpub", build: { targets: ["browser"] } }),
    );
    const out = join(dir, "out");
    await Deno.mkdir(out);
    // What a build placed (a real program, so shipApp takes it)…
    await Deno.copyFile(Deno.execPath(), join(out, "app"));
    await Deno.writeTextFile(
      join(out, "manifest.json"),
      JSON.stringify({
        targets: [{ target: "server", ok: true, artifacts: [{ file: "app" }] }],
      }),
    );
    // …then exactly what `am publish --no-build --dir=out` does with it.
    await shipApp({
      binaryPath: join(out, "app"),
      version: "1.0.0",
      allowDirty: true,
      channel: "prod",
      url: "app",
      channelDir: out,
      noData: true,
    });
    await Deno.copyFile(join(out, "app"), join(out, "prod", "app"));
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", BUILD_ALL, "--out=out"],
      cwd: dir,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const said = dec.decode(run.stderr) + dec.decode(run.stdout);
    assert(!said.includes("refusing to build into"), said);
    assert(!said.includes("--out=release"), said);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("out dir: no refusal points at publish's own default dir", async () => {
  // `am publish` stages into ./release; a build pointed there next to a
  // published channel is refused by the very rule that suggested it.
  const src = await Deno.readTextFile(BUILD_ALL);
  assert(src.includes("refusing to build into"));
  assert(!src.includes("--out=release"));
});
