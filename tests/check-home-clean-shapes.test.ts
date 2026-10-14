// check:home-clean — two leak shapes the install gate could not see.
//
// MEASURED 2026-10-08 on a developer's workstation, with the gate GREEN:
//   - 6 installs `~/app/app-<id>-0.1.0-nogit.<hash>` and their 6 links in
//     `~/.local/bin` — a built artifact's name carries its version, and the
//     gate matched the bare `app-<id>` only;
//   - 73 `~/.config/app-<id>@<hash>` — the profile directory of an Electron
//     test app that was launched with the developer's own config home.
//
// Every control runs against a TEMP home. Never the real one.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  installStrays,
  isInstallStray,
  isStubProfile,
} from "../scripts/check-home-clean.ts";

Deno.test("check:home-clean: a versioned test install and an Electron test profile are test shapes; near-misses are not", () => {
  for (
    const n of [
      "app-07f6b93d-0.1.0-nogit.32ade896", // measured
      "app-07f6b93d-0.1.0",
      "e2e-07f6b93d-1.0",
      "ver-probe-07f6b93d-1.0.19-beta",
      "app-07f6b93d-0.1.0.desktop",
      "app-07f6b93d", // what it always caught
      "e2e-0f9e8d7c.desktop",
      "app-07f6b93d@1a2b3c4d", // measured
    ]
  ) assert(isInstallStray(n), `${n} was not flagged`);
  for (
    const n of [
      "quant",
      "app-store",
      "app-store-1.2.0",
      "app-1a2b3c4-0.1.0", // 7 hex
      "app-1a2b3c4g-0.1.0", // not hex
      "app-07f6b93d-tools",
      "app-07f6b93d-0.1.0_x", // not a version tail
      "app-07f6b93d@1a2b3c4", // 7 hex
      "app-07f6b93d@home",
      "e2e-07f6b93d@1a2b3c4d", // only makeApp()'s name is a profile's
      "myapp-07f6b93d@1a2b3c4d",
    ]
  ) assert(!isInstallStray(n), `${n} is the user's own`);
});

Deno.test("check:home-clean: both shapes are found in the directories an install occupies, named by full path", async () => {
  const home = await tempDir("aio-fakehome-");
  try {
    const mine = ["app/quant", ".local/bin", ".config/apple@1a2b3c4d"];
    const strays = [
      ".config/app-07f6b93d@1a2b3c4d",
      ".local/bin/app-07f6b93d-0.1.0-nogit.32ade896",
      "app/app-07f6b93d-0.1.0-nogit.32ade896",
    ];
    for (const d of mine) await Deno.mkdir(join(home, d), { recursive: true });
    assertEquals(installStrays({ HOME: home }), []);
    for (const d of strays) {
      await Deno.mkdir(join(home, d), { recursive: true });
    }
    assertEquals(
      installStrays({ HOME: home }).sort(),
      strays.map((s) => join(home, s)).sort(),
    );
  } finally {
    await dropTempDir(home);
  }
});

// The DEFAULT appId's profile, `aio-app@<hash>`, is a name a person's own app
// has too — no shape can claim it. MEASURED 2026-10-10 with this gate green:
// 178 of them in one `~/.config`, each holding nothing but `aio-main/` — a
// launch whose "Electron" was a test's stand-in. The content is the tell.
Deno.test("check:home-clean: a profile holding only aio-main/ is a window that never ran — flagged under ANY name, on every OS's profile parent; a real profile is not", async () => {
  const home = await tempDir("aio-fakehome-");
  try {
    const parents = [".config", join("Library", "Application Support")];
    for (const p of parents) {
      // Stand-in launches: the script dir alone, with or without a leftover.
      await Deno.mkdir(join(home, p, "aio-app@0029a875", "aio-main"), {
        recursive: true,
      });
      await Deno.mkdir(join(home, p, "profiled", "aio-main"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(home, p, "profiled", "aio-main", "1-ab.cjs"),
        "",
      );
      // A window that ran: Chromium's files beside it. And someone's own.
      await Deno.mkdir(join(home, p, "aio-app@1ab1d0b5", "aio-main"), {
        recursive: true,
      });
      await Deno.mkdir(join(home, p, "aio-app@1ab1d0b5", "Cache"));
      await Deno.mkdir(join(home, p, "gimp"));
      await Deno.writeTextFile(join(home, p, "mimeapps.list"), "");
    }
    assert(isStubProfile(join(home, ".config", "profiled")));
    assert(!isStubProfile(join(home, ".config", "aio-app@1ab1d0b5")));
    assert(!isStubProfile(join(home, ".config", "gimp")), "an empty dir");
    assert(!isStubProfile(join(home, ".config", "mimeapps.list")), "a file");
    assertEquals(
      installStrays({ HOME: home }),
      parents.flatMap((p) => [
        join(home, p, "aio-app@0029a875"),
        join(home, p, "profiled"),
      ]),
    );
    // Windows keeps the profile in %APPDATA%.
    assertEquals(
      installStrays({ APPDATA: join(home, ".config") }),
      [
        join(home, ".config", "aio-app@0029a875"),
        join(home, ".config", "profiled"),
      ],
    );
  } finally {
    await dropTempDir(home);
  }
});
