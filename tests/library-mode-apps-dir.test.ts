// libraryMode honours AIO_APPS_DIR when the author named no directory.
//
// A libraryMode app with no `baseDir`/`appDir` resolved `<cwd>/.aio` whatever
// its appId and whatever `AIO_APPS_DIR` said — so two such apps in one cwd
// shared one state.db and one journal (the second boot refused "database is
// locked"; run one after the other, each saw the other's cell as drift).
// `AIO_APPS_DIR` is documented as the root for "apps whose ids [a test suite]
// doesn't control" (app-dirs.ts), so when it is set it now places them:
// `<AIO_APPS_DIR>/<appId>`, one home per app. An explicit `baseDir` or
// `appDir` still wins, and with neither the variable unset the default is
// unchanged.
import { assertEquals, assertNotEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { resolveAppDirs } from "../src/server/app-dirs.ts";

function withAppsDir(v: string | null, fn: () => void): void {
  const prev = Deno.env.get("AIO_APPS_DIR");
  if (v === null) Deno.env.delete("AIO_APPS_DIR");
  else Deno.env.set("AIO_APPS_DIR", v);
  try {
    fn();
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
  }
}

Deno.test("libraryMode + AIO_APPS_DIR, no baseDir: one home per appId under the root", () => {
  withAppsDir("/tmp/aio-libmode-root", () => {
    const a = resolveAppDirs({ appId: "lib-a", libraryMode: true });
    const b = resolveAppDirs({ appId: "lib-b", libraryMode: true });
    assertEquals(a.home, join("/tmp/aio-libmode-root", "lib-a"));
    assertEquals(b.home, join("/tmp/aio-libmode-root", "lib-b"));
    assertNotEquals(a.stateDb, b.stateDb);
  });
});

Deno.test("libraryMode: an explicit baseDir or appDir still wins over AIO_APPS_DIR", () => {
  withAppsDir("/tmp/aio-libmode-root", () => {
    assertEquals(
      resolveAppDirs({ appId: "lib-a", libraryMode: true, baseDir: "/tmp/b" })
        .home,
      join("/tmp/b", ".aio"),
    );
    assertEquals(
      resolveAppDirs({ appId: "lib-a", libraryMode: true, appDir: "/srv/x" })
        .home,
      "/srv/x",
    );
  });
});

Deno.test("libraryMode without AIO_APPS_DIR: the default is unchanged (<cwd>/.aio)", () => {
  withAppsDir(null, () => {
    assertEquals(
      resolveAppDirs({ appId: "lib-a", libraryMode: true }).home,
      join(resolve(Deno.cwd()), ".aio"),
    );
  });
});
