// Profiles: ONE flag, `--profile`, takes a NAME (`dev` → `<base>-dev`, lock
// key `<appId>@dev`) or a PATH (that exact folder). `--home` is the path-only
// alias. These are the pure rules every reader shares — resolveAppDirs (the
// runtime), lockKey (the lock and socket name), electronProfileName (the
// Chromium profile), and the refusals.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  _resetAppDirs,
  expandProfilePath,
  isProfilePath,
  profileHome,
  profileNameError,
  profileOfHome,
  registeredProfile,
  resolveAppDirs,
  writeAppMeta,
} from "../src/server/app-dirs.ts";
import { hash8, lockKey } from "../src/server/single-instance-lock.ts";
import { electronProfileName } from "../src/electron/electron-shared.ts";
import { homedir } from "../src/server/paths.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** Run `fn` with AIO_APPS_DIR = `root` (or unset), restored after. */
async function withApps<T>(
  root: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const prev = Deno.env.get("AIO_APPS_DIR");
  if (root === undefined) Deno.env.delete("AIO_APPS_DIR");
  else Deno.env.set("AIO_APPS_DIR", root);
  try {
    return await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    _resetAppDirs();
  }
}

Deno.test("profile value: NAME vs PATH classification", () => {
  for (const name of ["dev", "test-2", "a", "x1"]) {
    assertEquals(isProfilePath(name), false, name);
  }
  for (
    const path of [
      "./dev",
      "~/dev",
      "~",
      "dev/x",
      "/abs/dir",
      "C:\\x",
      "c:x",
      "..",
      "a\\b",
    ]
  ) {
    assertEquals(isProfilePath(path), true, path);
  }
});

Deno.test("profile names: shape, `default` and hash look-alikes refused", () => {
  for (const ok of ["dev", "test-2", "0dev", "a".repeat(32)]) {
    assertEquals(profileNameError(ok), null, ok);
  }
  for (
    const bad of [
      "Dev",
      "-x",
      "a_b",
      "",
      "a".repeat(33),
      "default",
      "1a2b3c4d",
      "deadbeef",
    ]
  ) {
    assert(profileNameError(bad) !== null, bad);
  }
});

Deno.test("profile paths: ~ expanded, relative resolved against the cwd", () => {
  assertEquals(expandProfilePath("~/x"), join(homedir(), "x"));
  assertEquals(expandProfilePath("~"), homedir());
  assertEquals(expandProfilePath("./rel"), join(Deno.cwd(), "rel"));
  assertEquals(expandProfilePath("/abs/dir"), "/abs/dir");
});

Deno.test("profile home: <base>-<name>, for the default, AIO_APPS_DIR and appDir bases", async () => {
  await withApps(undefined, () => {
    assertEquals(profileHome("myapp", "dev"), join(homedir(), ".myapp-dev"));
    assertEquals(profileHome("myapp", "dev", "/opt/x"), "/opt/x-dev");
    assertEquals(profileOfHome("myapp", join(homedir(), ".myapp-dev")), "dev");
    assertEquals(profileOfHome("myapp", "/opt/x-dev", "/opt/x"), "dev");
    assertEquals(profileOfHome("myapp", join(homedir(), ".myapp")), undefined);
    assertEquals(profileOfHome("myapp", "/elsewhere"), undefined);
  });
  await withApps("/srv/apps", () => {
    assertEquals(profileHome("myapp", "dev"), "/srv/apps/myapp-dev");
  });
});

Deno.test("lockKey: default plain, profile by NAME (default base and appDir), else hash", async () => {
  await withApps(undefined, () => {
    const def = join(homedir(), ".myapp");
    assertEquals(lockKey("myapp", def), "myapp");
    assertEquals(lockKey("myapp"), "myapp");
    assertEquals(lockKey("myapp", `${def}-dev`), "myapp@dev");
    // An appDir app's profile: named by the profile its lock records.
    assertEquals(lockKey("myapp", "/opt/x-dev", "dev"), "myapp@dev");
    // …a recorded profile the home does not end in is not believed.
    assertEquals(
      lockKey("myapp", "/opt/other", "dev"),
      `myapp@${hash8("/opt/other")}`,
    );
    assertEquals(lockKey("myapp", "/any/dir"), `myapp@${hash8("/any/dir")}`);
    // A home that LOOKS like `<base>-<hash>` is not a profile.
    assertEquals(
      lockKey("myapp", `${def}-1a2b3c4d`),
      `myapp@${hash8(`${def}-1a2b3c4d`)}`,
    );
  });
});

Deno.test("resolveAppDirs: name, path, --home alias — one folder; conflicts refused", async () => {
  const dir = await tempDir("prof-resolve-");
  try {
    await withApps(join(dir, "apps"), () => {
      const base = join(dir, "apps", "pa");
      const byName = resolveAppDirs({
        appId: "pa",
        request: { profile: "dev" },
      });
      assertEquals(byName.home, `${base}-dev`);
      assertEquals(registeredProfile("pa"), "dev");
      // The same folder by path — IS the profile.
      const byPath = resolveAppDirs({
        appId: "pa",
        request: { profile: `${base}-dev` },
      });
      assertEquals(byPath.home, `${base}-dev`);
      assertEquals(registeredProfile("pa"), "dev");
      const byHome = resolveAppDirs({
        appId: "pa",
        request: { home: `${base}-dev` },
      });
      assertEquals(byHome.home, `${base}-dev`);
      // Both, agreeing: fine. Disagreeing: refused.
      assertEquals(
        resolveAppDirs({
          appId: "pa",
          request: { profile: "dev", home: `${base}-dev` },
        }).home,
        `${base}-dev`,
      );
      assertThrows(
        () =>
          resolveAppDirs({
            appId: "pa",
            request: { profile: "dev", home: join(dir, "other") },
          }),
        Error,
        "two different folders",
      );
      // Any folder by path: that folder, no profile.
      const any = resolveAppDirs({
        appId: "pa",
        request: { profile: join(dir, "any") },
      });
      assertEquals(any.home, join(dir, "any"));
      assertEquals(registeredProfile("pa"), undefined);
      // appDir is the BASE of a named profile.
      assertEquals(
        resolveAppDirs({
          appId: "pa",
          appDir: join(dir, "fixed"),
          request: { profile: "dev" },
        }).home,
        join(dir, "fixed-dev"),
      );
      // A bad name is refused, not slugified.
      assertThrows(
        () => resolveAppDirs({ appId: "pa", request: { profile: "Dev" } }),
        Error,
        "not a profile name",
      );
      // libraryMode ignores the request (a test inherits its environment).
      assertEquals(
        resolveAppDirs({
          appId: "pa",
          libraryMode: true,
          baseDir: dir,
          request: { profile: "dev" },
        }).home,
        join(dir, ".aio"),
      );
    });
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("profiles: false refuses every form — name, path, --home", async () => {
  await withApps("/srv/apps-none", () => {
    for (
      const request of [{ profile: "dev" }, { profile: "/x/y" }, {
        home: "/x/y",
      }]
    ) {
      assertThrows(
        () => resolveAppDirs({ appId: "pa", profiles: false, request }),
        Error,
        "profiles: false",
      );
    }
    // No request: profiles:false changes nothing.
    assertEquals(
      resolveAppDirs({ appId: "pa", profiles: false }).home,
      "/srv/apps-none/pa",
    );
  });
});

Deno.test("meta.json ownership: two names deriving one folder never share it", async () => {
  const dir = await tempDir("prof-owner-");
  try {
    await withApps(join(dir, "apps"), () => {
      // `dev` of `myapp` boots first and stamps its folder…
      const dev = resolveAppDirs({
        appId: "myapp",
        request: { profile: "dev" },
      });
      Deno.mkdirSync(dev.data, { recursive: true });
      writeAppMeta(dev, { appId: "myapp", aio: "t", profile: "dev" });
      // …the real app `myapp-dev` (same folder) is refused, loudly.
      assertThrows(
        () => resolveAppDirs({ appId: "myapp-dev" }),
        Error,
        'profile "dev" of app "myapp"',
      );
      // The reverse: a real `myapp-dev` stamped it; the profile is refused.
      writeAppMeta(dev, { appId: "myapp-dev", aio: "t" });
      assertThrows(
        () => resolveAppDirs({ appId: "myapp", request: { profile: "dev" } }),
        Error,
        'belongs to app "myapp-dev"',
      );
      // A plain boot of an older folder (no profile recorded) is untouched.
      assertEquals(resolveAppDirs({ appId: "myapp-dev" }).home, dev.home);
    });
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("electron profile: default plain, profile by name, --instance never the machine's", async () => {
  const def = join(homedir(), ".myapp");
  await withApps(undefined, () => {
    assertEquals(electronProfileName("myapp", "My App", def), "my-app");
    assertEquals(
      electronProfileName("myapp", "My App", `${def}-dev`),
      "my-app@dev",
    );
    // An appDir app's profile, named by the caller.
    assertEquals(
      electronProfileName("myapp", "My App", "/opt/x-dev", "dev"),
      "my-app@dev",
    );
  });
  // Under AIO_APPS_DIR the lock key is the plain id — the Chromium profile
  // must NOT be the machine's own (ERR_CACHE_READ_FAILURE).
  await withApps("/srv/inst", () => {
    const scoped = "/srv/inst/myapp";
    assertEquals(
      electronProfileName("myapp", "My App", scoped),
      `my-app@${hash8(scoped)}`,
    );
    assertEquals(
      electronProfileName("myapp", "My App", `${scoped}-dev`, "dev"),
      `my-app@${hash8(`${scoped}-dev`)}`,
    );
  });
});

Deno.test("am: notProfiles drops profile locks AND any lock sharing a profile's pid", async () => {
  const { notProfiles } = await import("../src/am/am-utils.ts");
  const base = {
    port: 1,
    startedAt: 0,
    status: "started" as const,
    cwd: "/",
    alive: true,
  };
  const got = notProfiles("pc", [
    { ...base, appId: "pc", pid: 10, home: "/opt/x-dev", profile: "dev" },
    // am's placeholder for the SAME child, filed under a computed key: a ghost.
    { ...base, appId: "pc", pid: 10, home: "/home/u/.pc-zz" },
    { ...base, appId: "pc", pid: 11, home: "/opt/x" },
  ]);
  assertEquals(got.map((i) => i.pid), [11]);
});

Deno.test("claimHome: only the EXACT lock just judged may share the home", async () => {
  const { claimHome } = await import("../src/server/single-instance-lock.ts");
  const dir = await tempDir("claim-exact-");
  try {
    const a = claimHome(dir, { appId: "c", port: 0, key: "c" });
    assert(a.ok);
    // Same scope, another lock name (another app/key): refused.
    const b = claimHome(dir, { appId: "c", port: 0, key: "c@other" });
    assertEquals(b.ok, false);
    // The same lock (a zombie this acquire just reclaimed): stands.
    const c = claimHome(dir, { appId: "c", port: 0, key: "c" });
    assert(c.ok);
    if (c.ok) c.close();
    if (a.ok) a.close();
    // Released: free again.
    const d = claimHome(dir, { appId: "c", port: 0, key: "c@other" });
    assert(d.ok);
    if (d.ok) d.close();
  } finally {
    await dropTempDir(dir);
  }
});
