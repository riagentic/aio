// What the release a build replaces says about the new one (field report:
// a history squash lowered versionCode and Android refused the update; a
// per-target `name` silently forked the applicationId; dist/ files the app
// wrote vanished). All three were silent; each is now a ⚠ in the summary.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildAll } from "../src/build-all.ts";
import {
  applicationIdChangeNotes,
  type BuildManifest,
  shipOutputEntries,
  strayOutEntries,
  versionRegressionNote,
} from "../src/build/build-manifest.ts";
import { keepInDistStaging } from "../src/build/dist-staging.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const prev = (version: string, extra: Partial<BuildManifest> = {}) =>
  ({ version, ...extra }) as BuildManifest;

Deno.test("versionRegressionNote: only a LOWER major.minor.build warns, naming the fix", () => {
  const n = versionRegressionNote(prev("0.1.52"), "0.1.5", "dist") ?? "";
  assert(n.includes("0.1.5 is LOWER than the last build's 0.1.52"), n);
  assert(n.includes('"0.2"') && n.includes("AIO_BUILD_VERSION"), n);
  for (
    const next of ["0.1.52", "0.1.53", "0.2.5", "1.0.0", "0.1.52-dirty.ab"]
  ) {
    assertEquals(versionRegressionNote(prev("0.1.52"), next, "dist"), null);
  }
  assert(versionRegressionNote(prev("1.0.3"), "0.9.900", "dist"));
  assert(versionRegressionNote(prev("0.2.1-beta"), "0.1.999", "dist"));
  assertEquals(versionRegressionNote(null, "0.1.5", "dist"), null);
  assertEquals(versionRegressionNote(prev("unknown"), "0.1.5", "dist"), null);
});

Deno.test("strayOutEntries: what no build put there, and nothing else", () => {
  const m = prev("0.1.1", {
    targets: [{ target: "cli", artifacts: [{ file: "notes-0.1.1" }] }],
  });
  assertEquals(
    strayOutEntries(
      m,
      ["manifest.json", "notes-0.1.1", "app.js", ".DS_Store", "export", "a.md"],
      keepInDistStaging,
    ),
    ["a.md", "export"],
  );
});

Deno.test("strayOutEntries: what `aio ship` wrote beside the release is ship output, not a stray", () => {
  const m = prev("0.1.1", {
    targets: [{ target: "cli", artifacts: [{ file: "notes-0.1.1" }] }],
  });
  const names = [
    "manifest.json",
    "notes-0.1.1",
    "notes-0.1.1.ship.json",
    "linux-x86_64.json",
    "other.ship.json",
  ];
  assertEquals(strayOutEntries(m, names, keepInDistStaging), [
    "other.ship.json",
  ]);
  assertEquals(shipOutputEntries(m, names), [
    "linux-x86_64.json",
    "notes-0.1.1.ship.json",
  ]);
});

Deno.test("applicationIdChangeNotes: a changed derived id names the pin", () => {
  const m = prev("0.1.1", {
    targets: [{
      target: "android",
      artifacts: [{ file: "myapp-0.1.1.apk" }],
    }],
  });
  const derive = (f: string) => `app.aio.${f.split("-")[0]}`;
  const notes = applicationIdChangeNotes(
    m,
    [{ target: "android", applicationId: "app.aio.newname" }],
    derive,
    "dist",
  );
  assertEquals(notes.length, 1);
  assert(notes[0]!.includes('"applicationId": "app.aio.myapp"'), notes[0]);
  assertEquals(
    applicationIdChangeNotes(
      m,
      [{ target: "android", applicationId: "app.aio.myapp" }],
      derive,
      "dist",
    ),
    [],
  );
  // A recorded id wins over the file-name derivation.
  assertEquals(
    applicationIdChangeNotes(
      prev("0.1.1", {
        targets: [{ target: "android", applicationId: "app.aio.newname" }],
      }),
      [{ target: "android", applicationId: "app.aio.newname" }],
      derive,
      "dist",
    ),
    [],
  );
});

Deno.test("applicationIdChangeNotes: a dev APK and a release APK are never compared", () => {
  const derive = (f: string) =>
    f.endsWith("-dev.apk") ? "app.aio.myappdev" : "app.aio.myapp";
  const release = { target: "android", applicationId: "app.aio.myapp" };
  const dev = {
    target: "android",
    applicationId: "app.aio.myappdev",
    dev: true,
  };
  // After a dev build (recorded, or an older manifest's `-dev.apk`), a
  // release build would have been told to pin app.aio.myappdev.
  for (
    const p of [
      { target: "android", applicationId: "app.aio.myappdev", dev: true },
      { target: "android", artifacts: [{ file: "myapp-0.1.1-dev.apk" }] },
    ]
  ) {
    assertEquals(
      applicationIdChangeNotes(
        prev("0.1.1", { targets: [p] }),
        [release],
        derive,
        "dist",
      ),
      [],
    );
  }
  // …and the other way round.
  assertEquals(
    applicationIdChangeNotes(
      prev("0.1.1", { targets: [release] }),
      [dev],
      derive,
      "dist",
    ),
    [],
  );
  // Two dev builds still compare.
  assertEquals(
    applicationIdChangeNotes(
      prev("0.1.1", {
        targets: [{ ...dev, applicationId: "app.aio.otherdev" }],
      }),
      [dev],
      derive,
      "dist",
    ).length,
    1,
  );
});

const STUB = `
const arg = (f) => Deno.args.find((a) => a.startsWith(f))?.slice(f.length);
const bin = arg("--name=").toLowerCase();
await Deno.writeTextFile(Deno.cwd() + "/" + bin + ".apk", "apk");
`;

Deno.test("fleet: a lower version, a renamed applicationId and removed app files are each a ⚠", async () => {
  const dir = await tempDir("aio-fleet-previous-release-");
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const origArgs = Deno.args;
  const origCwd = Deno.cwd();
  const lines: string[] = [];
  try {
    const stub = join(dir, "stub-build.ts");
    await Deno.writeTextFile(stub, STUB);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: "myapp",
        build: { targets: { android: { name: "newname" } } },
      }),
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "app.ts"), "export {};\n");
    // The release this build replaces: 0.1.52, as app.aio.myapp, plus a file
    // the app's own task wrote into dist/.
    await Deno.mkdir(join(dir, "dist", "export"), { recursive: true });
    await Deno.writeTextFile(join(dir, "dist", "export", "a.md"), "x");
    await Deno.writeTextFile(join(dir, "dist", "myapp-0.1.52.apk"), "apk");
    await Deno.writeTextFile(
      join(dir, "dist", "manifest.json"),
      JSON.stringify({
        app: "myapp",
        version: "0.1.52",
        targets: [{
          target: "android",
          ok: true,
          artifacts: [{ file: "myapp-0.1.52.apk" }],
        }],
      }),
    );
    Object.defineProperty(Deno, "args", {
      value: [`--build-spec=${stub}`],
      configurable: true,
    });
    Deno.chdir(dir);
    console.log = console.warn = console.error = (...a: unknown[]) =>
      void lines.push(a.map(String).join(" "));
    const code = await buildAll();
    Object.assign(console, orig);
    // deno-lint-ignore no-control-regex
    const said = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assertEquals(code, 0, said);
    assert(said.includes("⚠ version 0.1.0-"), said);
    assert(said.includes("LOWER than the last build's 0.1.52"), said);
    assert(
      said.includes("⚠ android: the applicationId is now app.aio.newname") &&
        said.includes('"applicationId": "app.aio.myapp"'),
      said,
    );
    assert(said.includes("removed 1 entry no build put there: export"), said);
    const m = JSON.parse(
      await Deno.readTextFile(join(dir, "dist", "manifest.json")),
    );
    assertEquals(m.targets[0].applicationId, "app.aio.newname");
    assertEquals(m.targets[0].dev, undefined);
    // A dev APK build is recorded as one.
    Object.defineProperty(Deno, "args", {
      value: [`--build-spec=${stub}`, "--android-dev-url=http://10.0.2.2:8000"],
      configurable: true,
    });
    console.log = console.warn = console.error = () => {};
    assertEquals(await buildAll(), 0);
    Object.assign(console, orig);
    const d = JSON.parse(
      await Deno.readTextFile(join(dir, "dist", "manifest.json")),
    );
    assertEquals(d.targets[0].dev, true);
  } finally {
    Object.assign(console, orig);
    Deno.chdir(origCwd);
    Object.defineProperty(Deno, "args", {
      value: origArgs,
      configurable: true,
    });
    await dropTempDir(dir);
  }
});
