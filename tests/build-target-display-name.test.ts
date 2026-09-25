/**
 * A target's DISPLAY name (field report: a two-edition app).
 *
 * `"pro": { "kind": "electron", "entry": "src/pro/app.ts", "name": "Notes PRO" }`
 * beside a project titled "Notes" named the PRO FILES right
 * (`notes-pro-…`) but everything a person sees inside them — the macOS
 * `.app` folder, the DMG volume, the Linux `.desktop` `Name=`, the Windows
 * README/product name, the generated icon monogram, the Android label — came
 * from deno.json `title`. Installing PRO therefore replaced the free app in
 * /Applications (both were `Notes.app`).
 *
 * `name` stays the FILE name only: making it the display name would rename
 * every shipped app that has a per-target `name` (frozen surface). The fix is
 * additive: a per-target `title` (handed to the single-target build as
 * `--display-name=`) is that build's display name, and the fleet WARNS when
 * two desktop targets are different apps that show one name. Measured in a
 * real child process, because the config reads the real argv and cwd.
 */
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { normalizeTargets } from "../src/build-all.ts";
import { displayNameClashes } from "../src/build/build-config.ts";
import { unknownBuildKeys } from "../src/server/config.ts";
import { join, toFileUrl } from "@std/path";

const CONFIG_URL = new URL("../src/build/build-config.ts", import.meta.url);
/** The repo's import map, so the probe resolves `@std/*` like the build does. */
const REPO_CONFIG = new URL("../deno.json", import.meta.url).pathname;

/** Run `loadBuildConfig()` in `dir` with `args`; return the identity fields. */
async function configIn(
  dir: string,
  args: string[],
): Promise<{ appTitle?: string; binaryName: string; macBundleId: string }> {
  const probe = join(dir, "probe.ts");
  await Deno.writeTextFile(
    probe,
    `import { loadBuildConfig } from ${JSON.stringify(CONFIG_URL.href)};\n` +
      `const c = await loadBuildConfig();\n` +
      `console.log("@@" + JSON.stringify({ appTitle: c.appTitle, ` +
      `binaryName: c.binaryName, macBundleId: c.macBundleId }));\n`,
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      `--config=${REPO_CONFIG}`,
      toFileUrl(probe).href,
      ...args,
    ],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  const line = text.split("\n").find((l) => l.startsWith("@@"));
  if (!out.success || !line) {
    throw new Error(
      `probe failed (${out.code}):\n${text}\n${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return JSON.parse(line.slice(2));
}

async function twoEditionProject(): Promise<string> {
  const dir = await tempDir("aio-display-name-");
  await Deno.mkdir(join(dir, "src", "pro"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      title: "Notes",
      entry: "src/app.ts",
      build: {
        targets: {
          electron: {},
          pro: {
            kind: "electron",
            entry: "src/pro/app.ts",
            name: "Notes PRO",
          },
        },
      },
    }),
  );
  await Deno.writeTextFile(join(dir, "src", "app.ts"), "");
  await Deno.writeTextFile(join(dir, "src", "pro", "app.ts"), "");
  return dir;
}

Deno.test("build display name: a per-target title (--display-name=) is the display name", async () => {
  const dir = await twoEditionProject();
  try {
    const pro = await configIn(dir, [
      "--compile",
      "--electron",
      "--name=Notes PRO",
      "--display-name=Notes PRO",
      "--entry=src/pro/app.ts",
    ]);
    // What the .app, DMG volume, .desktop Name=, Windows README, icon
    // monogram and Android label are all made from.
    assertEquals(pro.appTitle, "Notes PRO");
    // …and the identity that keeps it from replacing the free edition.
    assertEquals(pro.binaryName, "notes-pro");
    assertEquals(pro.macBundleId, "app.aio.notes-pro");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("build display name: --name alone names the files, never the display name (shipped apps keep theirs)", async () => {
  const dir = await twoEditionProject();
  try {
    const pro = await configIn(dir, [
      "--compile",
      "--electron",
      "--name=Notes PRO",
      "--entry=src/pro/app.ts",
    ]);
    assertEquals(pro.appTitle, "Notes");
    assertEquals(pro.binaryName, "notes-pro");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("build display name: with no --name the display name stays deno.json title (compat)", async () => {
  const dir = await twoEditionProject();
  try {
    const free = await configIn(dir, ["--compile", "--electron"]);
    assertEquals(free.appTitle, "Notes");
    assertEquals(free.binaryName, "notes");
    assertEquals(free.macBundleId, "app.aio.notes");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("build display name: a per-target title survives target normalization", () => {
  const [pro] = normalizeTargets({
    pro: { kind: "electron", name: "notes-pro", title: " Notes PRO " },
  });
  assertEquals(pro!.title, "Notes PRO");
  assertEquals(normalizeTargets(["electron"])[0]!.title, undefined);
});

Deno.test("build display name: two desktop apps showing one name clash; one app, other kinds, or distinct names do not", () => {
  const t = (label: string, kind: string, display: string, binary: string) => ({
    label,
    kind,
    display,
    binary,
  });
  assertEquals(
    displayNameClashes([
      t("electron", "electron", "Notes", "notes"),
      t("pro", "electron", "Notes", "notes-pro"),
    ]),
    [["electron", "pro", "Notes"]],
  );
  // Same binary = the same app (two platforms, a re-label): no clash.
  assertEquals(
    displayNameClashes([
      t("a", "electron", "Notes", "notes"),
      t("b", "electron-client", "Notes", "notes"),
    ]),
    [],
  );
  // Not installed by display name (a server, an APK with its own id).
  assertEquals(
    displayNameClashes([
      t("electron", "electron", "Notes", "notes"),
      t("relay", "server", "Notes", "relay"),
      t("android", "android", "Notes", "notes-android"),
    ]),
    [],
  );
  // The fix: a per-target title.
  assertEquals(
    displayNameClashes([
      t("electron", "electron", "Notes", "notes"),
      t("pro", "electron", "Notes PRO", "notes-pro"),
    ]),
    [],
  );
});

const BUILD_ALL = new URL("../src/build-all.ts", import.meta.url).pathname;

/** Run the fleet in `dir`; the project's entries are missing on purpose, so
 *  it stops at the entry check right after its config warnings. */
async function fleetIn(dir: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `--config=${REPO_CONFIG}`, BUILD_ALL],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).output();
  assert(!out.success, "the fleet must stop at the missing entries");
  const d = new TextDecoder();
  return d.decode(out.stdout) + d.decode(out.stderr);
}

Deno.test("build display name: the fleet warns when two desktop editions would install over each other", async () => {
  const dir = await tempDir("aio-display-name-");
  try {
    const project = (pro: Record<string, string>) =>
      Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          title: "Notes",
          entry: "src/missing.ts",
          build: {
            targets: {
              electron: {},
              pro: { kind: "electron", entry: "src/pro/missing.ts", ...pro },
            },
          },
        }),
      );
    await project({ name: "Notes PRO" });
    const clash = await fleetIn(dir);
    assertStringIncludes(clash, `targets "electron" and "pro"`);
    assertStringIncludes(clash, `"title"`, "names the key that fixes it");
    await project({ name: "Notes PRO", title: "Notes PRO" });
    const fixed = await fleetIn(dir);
    assert(
      !fixed.includes("both show as"),
      `a per-target title must silence it:\n${fixed}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("build display name: the fleet hands a target's title to its build as --display-name=", async () => {
  const dir = await tempDir("aio-display-name-");
  try {
    await Deno.mkdir(join(dir, "src", "pro"), { recursive: true });
    await Deno.writeTextFile(join(dir, "src", "app.ts"), "");
    await Deno.writeTextFile(join(dir, "src", "pro", "app.ts"), "");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: "Notes",
        entry: "src/app.ts",
        build: {
          targets: {
            electron: {},
            pro: {
              kind: "electron",
              entry: "src/pro/app.ts",
              name: "Notes PRO",
              title: "Notes PRO",
            },
          },
        },
      }),
    );
    // A stand-in builder: records the argv each target's build receives.
    const log = join(dir, "argv.jsonl");
    const builder = join(dir, "builder.ts");
    await Deno.writeTextFile(
      builder,
      `await Deno.writeTextFile(${JSON.stringify(log)}, ` +
        `JSON.stringify(Deno.args) + "\\n", { append: true });\n`,
    );
    await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        `--config=${REPO_CONFIG}`,
        BUILD_ALL,
        `--build-spec=${builder}`,
      ],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
      env: { NO_COLOR: "1" },
    }).output();
    const runs = (await Deno.readTextFile(log)).trim().split("\n").map(
      (l) => JSON.parse(l) as string[],
    );
    const pro = runs.find((a) => a.includes("--name=Notes PRO"));
    const free = runs.find((a) => a.includes("--name=Notes"));
    assert(pro && free, `both targets built:\n${runs.join("\n")}`);
    assert(pro.includes("--display-name=Notes PRO"), pro.join(" "));
    // No per-target title: nothing extra, so deno.json `title` decides.
    assert(!free.some((a) => a.startsWith("--display-name=")), free.join(" "));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("build display name: a per-target title is a known key, and a blank one is unset", () => {
  // The clash warning tells the user to add `title` — the linter must not
  // then call it a key aio never reads.
  assertEquals(
    unknownBuildKeys({
      targets: { pro: { kind: "electron", title: "Notes PRO" } },
    }),
    [],
  );
  // Whitespace-only names nothing: the build and the clash check both see
  // "no title", never "".
  const [blank] = normalizeTargets({ pro: { kind: "electron", title: "  " } });
  assertEquals(blank!.title, undefined);
});
