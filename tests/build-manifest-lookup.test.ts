// Where an artifact IS, since "one path, one name, one dist/".
//
// `dev:android` and `install:android --build` both spawned a build and then
// listed `Deno.cwd()` for a `.apk`. That was right while a direct
// `build.ts --android` wrote into the project root; the fleet places artifacts
// in the out dir and leaves the root empty. Both tasks therefore built an APK
// successfully and then reported that no APK existed — a green build and a red
// task, over a directory listing nobody had revisited.
//
// So the manifest is the contract, and these pin it: the out dir comes from the
// project's own `build.out`, a missing report is a message rather than an empty
// list, and every path handed back is one that exists.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  artifactPaths,
  type BuildManifest,
  outDirOf,
  readBuildManifest,
  soleArtifact,
} from "../src/build/build-manifest.ts";

const MANIFEST: BuildManifest = {
  app: "notes",
  version: "1.2.3",
  targets: [
    {
      target: "android",
      ok: true,
      artifacts: [{ file: "notes-1.2.3-android.apk" }],
    },
    {
      target: "cli",
      ok: true,
      artifacts: [{ file: "notes-1.2.3-cli" }],
    },
    {
      target: "electron",
      ok: false,
      artifacts: [{ file: "notes-1.2.3-electron.AppImage" }],
    },
  ],
};

async function project(
  build?: Record<string, unknown>,
  manifest?: BuildManifest,
  outName = "dist",
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "manifest-" });
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify(build ? { build } : {}),
  );
  if (manifest) {
    await Deno.mkdir(join(root, outName), { recursive: true });
    await Deno.writeTextFile(
      join(root, outName, "manifest.json"),
      JSON.stringify(manifest),
    );
  }
  return root;
}

Deno.test("manifest: the out dir is the project's own, not a hard-coded dist/", async () => {
  const a = await project();
  const b = await project({ out: "release" });
  try {
    assertEquals(await outDirOf(a), join(a, "dist"));
    assertEquals(await outDirOf(b), join(b, "release"));
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("manifest: a missing or unreadable report reads as null, not a throw", async () => {
  const empty = await project();
  try {
    assertEquals(await readBuildManifest(join(empty, "dist")), null);
    await Deno.mkdir(join(empty, "dist"));
    await Deno.writeTextFile(join(empty, "dist/manifest.json"), "{ not json");
    assertEquals(await readBuildManifest(join(empty, "dist")), null);
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});

Deno.test("manifest: a FAILED target contributes no artifact", async () => {
  const root = await project(undefined, MANIFEST);
  try {
    const dir = join(root, "dist");
    const all = artifactPaths(dir, await readBuildManifest(dir));
    assert(
      !all.some((p) => p.endsWith(".AppImage")),
      `a target with ok:false was offered as an artifact: ${all}`,
    );
    assertEquals(all.length, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("manifest: filters by target and by suffix", async () => {
  const root = await project(undefined, MANIFEST);
  try {
    const dir = join(root, "dist");
    const m = await readBuildManifest(dir);
    assertEquals(artifactPaths(dir, m, { target: "cli" }), [
      join(dir, "notes-1.2.3-cli"),
    ]);
    assertEquals(artifactPaths(dir, m, { suffix: ".apk" }), [
      join(dir, "notes-1.2.3-android.apk"),
    ]);
    assertEquals(artifactPaths(dir, m, { target: "nope" }), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("manifest: soleArtifact finds the APK the fleet placed", async () => {
  // The exact lookup `dev:android` does after its build.
  const root = await project({ out: "release" }, MANIFEST, "release");
  try {
    const got = await soleArtifact(root, {
      target: "android",
      suffix: ".apk",
      what: "an .apk",
    });
    assert(!("error" in got), JSON.stringify(got));
    assertEquals(got.path, join(root, "release", "notes-1.2.3-android.apk"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("manifest: no report at all names the command that writes one", async () => {
  const root = await project();
  try {
    const got = await soleArtifact(root, {
      target: "android",
      what: "an .apk",
    });
    assert("error" in got);
    assertStringIncludes(got.error, "manifest.json");
    assertStringIncludes(got.error, "--targets=android");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("manifest: a report without the target says what it DOES hold", async () => {
  // "no .apk" with no further word is what sent someone reading build source.
  const root = await project(undefined, {
    ...MANIFEST,
    targets: [MANIFEST.targets![1]!],
  });
  try {
    const got = await soleArtifact(root, {
      target: "android",
      suffix: ".apk",
      what: "an .apk",
    });
    assert("error" in got);
    assertStringIncludes(got.error, "cli");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
