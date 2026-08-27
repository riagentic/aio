// updates-targets.test.ts — which install this process IS, and which releases
// it can therefore install.
//
// `detectTarget()` and `installableTargets()` had no direct test at all, and
// one of the branches was unreachable: `electron-appimage` probed
// `$AIO_ELECTRON`, which nothing in this repo has ever set, so every Electron
// AppImage classified itself as a plain `appimage`. A rule that can only be
// exercised by actually being an AppImage is a rule nothing checks — so the
// decision is a pure function over the process facts, and this is where it is
// measured.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  artifactPath,
  classifyTarget,
  detectTarget,
  installableTargets,
  installDir,
} from "../src/server/updates-apply.ts";
import type { UpdateTarget } from "../src/build/ship.ts";

Deno.test("detect: a plain compiled binary", () => {
  assertEquals(
    classifyTarget({ execPath: "/usr/local/bin/notes" }),
    "binary",
  );
});

Deno.test("detect: running from source is `source`, on every platform", () => {
  for (
    const exec of [
      "/home/me/.deno/bin/deno",
      "/usr/bin/deno",
      "C:\\Users\\me\\.deno\\bin\\deno.exe",
      "/opt/DENO",
    ]
  ) {
    assertEquals(classifyTarget({ execPath: exec }), "source", exec);
  }
  // …and a binary that merely CONTAINS the word is not.
  assertEquals(classifyTarget({ execPath: "/usr/bin/denote" }), "binary");
  assertEquals(classifyTarget({ execPath: "/usr/bin/my-deno-app" }), "binary");
});

Deno.test("detect: an AppImage, and the Electron one it used to be confused with", () => {
  const base = {
    execPath: "/tmp/.mount_Notesab12/usr/bin/notes",
    appImage: "/home/me/app/notes/notes.AppImage",
  };
  assertEquals(classifyTarget(base), "appimage");
  // THE BUG: this probed `AIO_ELECTRON`, which nothing sets. The AppRun an
  // Electron AppImage ships exports ELECTRON_PATH.
  assertEquals(
    classifyTarget({ ...base, electronPath: "/tmp/.mount_x/electron" }),
    "electron-appimage",
  );
  // An AppImage is never mistaken for a directory install, whatever is above it.
  assertEquals(
    classifyTarget({ ...base, installDir: "/home/me/app/notes" }),
    "appimage",
  );
});

Deno.test("detect: an unpacked Electron release is a DIRECTORY target", () => {
  assertEquals(
    classifyTarget({
      execPath: "/home/me/MyApp/electron/electron",
      installDir: "/home/me/MyApp",
    }),
    "electron-zip",
  );
});

Deno.test("detect: the real process answers something coherent", () => {
  // Under `deno test` this is `source` — the point is that the live wiring
  // agrees with the pure rule rather than drifting from it.
  const live = detectTarget();
  const expected = classifyTarget({
    execPath: Deno.execPath(),
    appImage: Deno.env.get("APPIMAGE") ?? null,
    electronPath: Deno.env.get("ELECTRON_PATH") ?? null,
    installDir: Deno.env.get("APPIMAGE") ? null : installDir(Deno.execPath()),
  });
  assertEquals(live, expected);
});

Deno.test("installable: one executable file installs either single-file target", () => {
  // An AppImage and a plain binary are both "one file, replaced by rename", so
  // the strategy covers both and either manifest is installable.
  assertEquals(installableTargets("appimage").sort(), [
    "appimage",
    "electron-appimage",
  ]);
  assertEquals(installableTargets("electron-appimage").sort(), [
    "appimage",
    "electron-appimage",
  ]);
});

Deno.test("installable: a directory install takes only directory releases", () => {
  assertEquals(installableTargets("electron-zip"), ["electron-zip"]);
});

Deno.test("installable: a plain binary takes only a plain binary", () => {
  assertEquals(installableTargets("binary"), ["binary"]);
});

Deno.test("installable: from SOURCE, detection is universal — apply is where it refuses", () => {
  // The update UI has to be developable against a real source tree, and dev
  // must not take a different code path from prod. `apply` refuses, loudly,
  // because swapping an artifact is the one step a source tree genuinely
  // cannot perform.
  const all: UpdateTarget[] = [
    "appimage",
    "binary",
    "electron-appimage",
    "electron-zip",
  ];
  assertEquals(installableTargets("source").sort(), all);
});

Deno.test("installable: never offers a target this process cannot install", () => {
  // The whole point of the list: a manifest for a target that is not in it is
  // reported with a reason, never installed and never silently ignored.
  for (
    const t of [
      "binary",
      "appimage",
      "electron-appimage",
      "electron-zip",
    ] as UpdateTarget[]
  ) {
    const list = installableTargets(t);
    assert(list.includes(t), `${t} must be able to install its own kind`);
    if (t === "binary" || t === "electron-zip") assertEquals(list.length, 1);
  }
});

Deno.test("install dir: bounded, and requires BOTH the launcher and electron/", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-targets-" });
  try {
    const app = join(root, "MyApp");
    const launcher = Deno.build.os === "windows" ? "run.bat" : "run.sh";
    await Deno.mkdir(join(app, "electron"), { recursive: true });
    await Deno.writeTextFile(join(app, launcher), "#!/bin/sh\n");
    assertEquals(installDir(join(app, "electron", "electron")), app);

    // Deep enough to be past the walk's bound — replacing the wrong directory
    // is the most expensive mistake this code could make, so it gives up rather
    // than searching the whole filesystem.
    const deep = join(app, "a", "b", "c", "d", "e", "f");
    await Deno.mkdir(deep, { recursive: true });
    assertEquals(installDir(join(deep, "exe")), null);

    // electron/ without a launcher is not an install root either.
    const half = join(root, "half");
    await Deno.mkdir(join(half, "electron"), { recursive: true });
    assertEquals(installDir(join(half, "electron", "electron")), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("artifactPath: answers an absolute path that exists", () => {
  // It decides where an update is WRITTEN. A relative or missing path here
  // installs a release somewhere nobody launches from.
  const p = artifactPath();
  assert(p.length > 0);
  assert(
    p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p),
    `absolute: ${p}`,
  );
  assert(Deno.statSync(p).isFile, `exists and is a file: ${p}`);
});
