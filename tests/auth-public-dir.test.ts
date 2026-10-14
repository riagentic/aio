// `auth: { publicDir }` — the ONE directory an anonymous caller may read.
//
// Without it the anonymous gate decides by file EXTENSION: anything shell-
// shaped (`.png`, `.html`, `.js`, a font) under the app dir is served with no
// session, so `/uploads/passport.png`, `/report.html` and `/data/dump.js` are
// public (first test — the default, unchanged). With it, a file is public
// because of WHERE it is: the declared directory, or the built shell itself.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import {
  _isBuiltShellPath,
  isShellAsset,
} from "../src/server/server-static.ts";
import { configConflicts } from "../src/server/config.ts";

const PRIVATE = ["/uploads/passport.png", "/report.html", "/data/dump.js"];

Deno.test("isShellAsset: with a public directory, a file is public by place, not by extension", () => {
  for (const p of PRIVATE) {
    assert(isShellAsset(p, false), `${p}: public by extension without it`);
    assert(!isShellAsset(p, false, "public"), `${p}: needs a session with it`);
  }
  for (
    const p of [
      "/",
      "/some/client/route",
      "/app.js",
      "/app.js.map",
      "/style.css",
      "/index.html",
      "/favicon.ico",
      "/manifest.json",
      "/robots.txt",
      "/__aio/ui.js",
      "/.well-known/security.txt",
      "/public/logo.png",
      "/public/fonts/Inter.woff2",
      "/public/terms.pdf",
      "/public/data.json",
    ]
  ) assert(isShellAsset(p, false, "public"), `${p} must be public`);
  // Not a prefix match on the name, and not through an encoded separator.
  assert(!isShellAsset("/public2/logo.png", false, "public"));
  assert(!isShellAsset("/x/public/logo.png", false, "public"));
  assert(!isShellAsset("/public%2F..%2Fuploads/a.png", false, "public"));
  // Dev loads every module by name; an image is still not code.
  assert(_isBuiltShellPath("/views/Login.tsx", true));
  assert(_isBuiltShellPath("/lib/util.js", true));
  assert(!_isBuiltShellPath("/lib/util.js", false));
  assert(!_isBuiltShellPath("/uploads/passport.png", true));
});

async function served(publicDir: string | undefined) {
  _resetAuthFails();
  const { aio, cell } = await import("../mod.ts");
  const dir = await tempDir("auth-public-dir-");
  for (const d of ["uploads", "data", "public"]) {
    await Deno.mkdir(join(dir, d));
  }
  await Deno.writeTextFile(join(dir, "uploads", "passport.png"), "PASSPORT");
  await Deno.writeTextFile(join(dir, "uploads", "3f9a2c"), "UPLOAD");
  await Deno.writeTextFile(join(dir, "report.html"), "<p>REPORT</p>");
  await Deno.writeTextFile(join(dir, "data", "dump.js"), "DUMP");
  await Deno.writeTextFile(join(dir, "public", "logo.png"), "LOGO");
  await Deno.writeTextFile(join(dir, "public", "terms.pdf"), "TERMS");
  await Deno.writeTextFile(join(dir, "public", "LICENSE"), "MIT");
  const port = freePort();
  const app = await aio.run({
    cells: [cell(`c_pub_${publicDir ?? "off"}`, { state: { n: 0 } })],
    appId: `test-public-dir-${publicDir ?? "off"}-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: publicDir === undefined ? true : { publicDir },
    port,
    baseDir: dir,
  });
  const status: Record<string, number> = {};
  try {
    for (
      const p of [
        ...PRIVATE,
        "/uploads/3f9a2c",
        "/public/logo.png",
        "/public/terms.pdf",
        "/public/LICENSE",
        "/",
        "/login",
      ]
    ) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      status[p] = r.status;
      // A refusal's advice must be something a build can do: `serveDirs` is
      // dev-only, and the file layer's 401 still named it.
      const body = await r.text();
      if (r.status === 401) {
        assert(!body.includes("serveDirs"), `${p}: ${body}`);
        assert(
          body.includes(publicDir === undefined ? "publicDir" : "/public/"),
          `${p}: ${body}`,
        );
      }
    }
  } finally {
    await app.close();
    _resetAuthFails();
    await dropTempDir(dir);
  }
  return status;
}

Deno.test("auth: true, no publicDir — shell-shaped files anywhere are served anonymously (the default, unchanged)", async () => {
  const s = await served(undefined);
  for (const p of PRIVATE) assertEquals(s[p], 200, p);
  assertEquals(s["/public/logo.png"], 200);
  assertEquals(s["/public/terms.pdf"], 401, "not shell-shaped");
  assertEquals(s["/"], 200);
});

Deno.test("auth: { publicDir } — only that directory and the shell answer without a session", async () => {
  const s = await served("public");
  // (This server runs in dev, where code is loaded by name: `/data/dump.js`
  // is the pure test's, with dev off.)
  for (
    const p of ["/uploads/passport.png", "/report.html", "/uploads/3f9a2c"]
  ) {
    assertEquals(s[p], 401, p);
  }
  assertEquals(s["/public/logo.png"], 200);
  assertEquals(s["/public/terms.pdf"], 200, "any file type inside it");
  assertEquals(s["/public/LICENSE"], 200, "an extensionless file inside it");
  assertEquals(s["/"], 200, "the sign-in page");
  assertEquals(s["/login"], 200, "a client route");
});

Deno.test("auth.publicDir: a value the gate could never match is refused at boot", () => {
  const said = (v: unknown) =>
    configConflicts({ auth: { publicDir: v } } as never).filter((c) =>
      c.keys.includes("auth.publicDir")
    );
  for (const ok of ["public", "static/pub", "pub-1_x"]) {
    assertEquals(said(ok), [], ok);
  }
  for (const bad of ["/public", "public/", "../x", ".hidden", "", "__aio", 1]) {
    assertEquals(said(bad).map((c) => c.level), ["error"], String(bad));
  }
});
