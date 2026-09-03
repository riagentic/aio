// The static deny list — what an HTTP client may never read out of baseDir.
//
// `*.server.ts` and dotfiles were already denied in both modes. TypeScript
// SOURCE was not: a PRODUCTION server handed out `/App.tsx`, `/util.ts` and
// every other module under baseDir as `text/plain`, unauthenticated. Dev must
// serve them (the dev shell's import map makes the browser fetch modules by
// name — that IS the dev loop); prod has no import map at all, loads one
// bundled `/app.js`, and never names a source path. Same reasoning that closed
// the `/__aio/**.ts` framework-source routes in prod, one extension short.
import { assert, assertEquals } from "@std/assert";
import {
  createStaticHandler,
  isProtectedPath,
} from "../src/server/server-static.ts";
import { join } from "@std/path";

async function fixture(): Promise<{ dir: string; cleanup: () => void }> {
  const dir = await Deno.makeTempDir({ prefix: "aio-protected-" });
  await Deno.mkdir(join(dir, "lib"), { recursive: true });
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.mkdir(join(dir, ".well-known"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "App.tsx"),
    "export default function App() { return null }",
  );
  await Deno.writeTextFile(join(dir, "lib", "keys.ts"), "export const K = 1");
  await Deno.writeTextFile(join(dir, "io.server.ts"), "export const s = 1");
  await Deno.writeTextFile(join(dir, ".env"), "SECRET=1");
  await Deno.writeTextFile(join(dir, "readme.md"), "# hi");
  await Deno.writeTextFile(join(dir, "logo.svg"), "<svg/>");
  await Deno.writeTextFile(join(dir, ".well-known", "acme"), "token");
  await Deno.writeTextFile(join(dir, "dist", "app.js"), "export const mount=1");
  return {
    dir,
    cleanup: () => {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* best effort */ }
    },
  };
}

function handlerFor(absBaseDir: string, prod: boolean) {
  return createStaticHandler({
    prod,
    debug: () => {},
    title: "t",
    absBaseDir,
    absDistDir: join(absBaseDir, "dist"),
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => null,
    // deno-lint-ignore no-explicit-any
  } as any);
}

Deno.test("isProtectedPath: the deny list, both modes", () => {
  // Always denied.
  for (
    const p of ["/io.server.ts", "/lib/x.server.tsx", "/.env", "/.git/HEAD"]
  ) {
    assert(isProtectedPath(p), `dev must deny ${p}`);
    assert(isProtectedPath(p, true), `prod must deny ${p}`);
  }
  // Denied in PROD only — dev serves (transpiles) them by design.
  for (const p of ["/App.tsx", "/lib/keys.ts", "/deep/nested/mod.tsx"]) {
    assert(!isProtectedPath(p), `dev must serve ${p}`);
    assert(isProtectedPath(p, true), `prod must deny ${p}`);
  }
  // Never denied.
  for (const p of ["/readme.md", "/logo.svg", "/app.js", "/.well-known/acme"]) {
    assert(!isProtectedPath(p), p);
    assert(!isProtectedPath(p, true), p);
  }
});

Deno.test("static: a PROD server never serves TypeScript source", async () => {
  const f = await fixture();
  try {
    const h = handlerFor(f.dir, true);
    for (const p of ["/App.tsx", "/lib/keys.ts", "/io.server.ts", "/.env"]) {
      const res = await h.serveStatic(p);
      const body = await res.text();
      assertEquals(res.status, 404, `${p} was served in prod: ${body}`);
      assert(!body.includes("export const"), `${p} leaked source: ${body}`);
    }
    // The bundle and ordinary assets are untouched.
    const js = await h.serveStatic("/app.js");
    assertEquals(js.status, 200);
    assert((await js.text()).includes("mount"));
    const svg = await h.serveStatic("/logo.svg");
    assertEquals(svg.status, 200);
    await svg.text();
  } finally {
    f.cleanup();
  }
});

Deno.test("static: DEV still transpiles and serves app modules", async () => {
  const f = await fixture();
  try {
    const h = handlerFor(f.dir, false);
    const app = await h.serveStatic("/App.tsx");
    assertEquals(app.status, 200);
    assertEquals(app.headers.get("content-type"), "application/javascript");
    assert((await app.text()).includes("App"));
    // …but the server-only seam and dotfiles stay closed in dev too.
    for (const p of ["/io.server.ts", "/.env"]) {
      const res = await h.serveStatic(p);
      assertEquals(res.status, 404, p);
      await res.text();
    }
  } finally {
    f.cleanup();
  }
});

// ── The trailing-slash bypass ────────────────────────────────────────────
//
// `isProtectedPath` decided on the last RAW segment of the request path, and
// `/App.tsx/` has an empty one — so it matched nothing, while `resolve()` on
// the way to the filesystem dropped the slash and opened App.tsx. The WHATWG
// parser folds `/.`, `/./` and `/%2e` into that same trailing slash, so every
// spelling reached the same file: `/secret.server.ts/` was served in dev AND
// prod, `/App.tsx/` in prod. The rule now decides on the segments the
// filesystem will see, and a slash-terminated request never serves a FILE.

const SLASH_VARIANTS = ["/", "//", "/.", "/./", "/%2e", "/%2E", "/.//"];
/** What the server's URL parser makes of a request line — the shape the
 *  handler actually sees. */
const asPathname = (raw: string) => new URL(`http://x${raw}`).pathname;

Deno.test("isProtectedPath: every slash spelling of a protected file is still protected", () => {
  const protectedIn = {
    both: ["/io.server.ts", "/lib/x.server.tsx", "/.env", "/.git/HEAD"],
    prod: ["/App.tsx", "/lib/keys.ts", "/deep/nested/mod.tsx"],
  };
  for (const base of protectedIn.both) {
    for (const v of SLASH_VARIANTS) {
      const p = asPathname(base + v);
      assert(isProtectedPath(p), `dev must deny ${base}${v} (→ ${p})`);
      assert(isProtectedPath(p, true), `prod must deny ${base}${v} (→ ${p})`);
    }
  }
  for (const base of protectedIn.prod) {
    for (const v of SLASH_VARIANTS) {
      const p = asPathname(base + v);
      assert(isProtectedPath(p, true), `prod must deny ${base}${v} (→ ${p})`);
    }
  }
  // …and the public paths stay public under the same spellings.
  for (const base of ["/readme.md", "/logo.svg", "/.well-known/acme"]) {
    for (const v of SLASH_VARIANTS) {
      const p = asPathname(base + v);
      assert(!isProtectedPath(p), `${base}${v} (→ ${p})`);
      assert(!isProtectedPath(p, true), `${base}${v} (→ ${p})`);
    }
  }
});

Deno.test("static: a slash-terminated request never serves a FILE, in either mode", async () => {
  const f = await fixture();
  try {
    for (const prod of [true, false]) {
      const h = handlerFor(f.dir, prod);
      // Protected files: closed under every spelling.
      for (const base of ["/io.server.ts", "/.env", "/App.tsx"]) {
        for (const v of SLASH_VARIANTS) {
          if (!prod && base === "/App.tsx") continue; // dev serves App.tsx — by name
          const p = asPathname(base + v);
          const res = await h.serveStatic(p);
          const body = await res.text();
          assertEquals(
            res.status,
            404,
            `prod=${prod} ${base}${v} → ${p}: ${body}`,
          );
          assert(!body.includes("export const"), `${p} leaked source`);
        }
      }
      // A PUBLIC file named with a trailing slash is a different path than the
      // file — 404, not the file under another name.
      const res = await h.serveStatic("/readme.md/");
      await res.text();
      assertEquals(res.status, 404, `prod=${prod} /readme.md/`);
      // The exact name still serves.
      const ok = await h.serveStatic("/readme.md");
      assertEquals(ok.status, 200);
      await ok.text();
    }
  } finally {
    f.cleanup();
  }
});

// ── Names no filesystem can hold ─────────────────────────────────────────
//
// A segment over 255 bytes with a text extension reached `readTextFile`,
// which threw ENAMETOOLONG — not `NotFound`, so the text branch answered 500
// and logged an ERROR carrying the absolute path. Decided before any syscall
// now: such a name cannot exist, so it is a 404 like any other absent file.
Deno.test("static: an impossible file name is a 404, not a 500", async () => {
  const { cannotExist, isNotServable } = await import(
    "../src/server/server-static.ts"
  );
  assert(cannotExist("/a/" + "x".repeat(256) + ".txt"));
  assert(!cannotExist("/a/" + "x".repeat(250) + ".txt"));
  assert(cannotExist("/" + ("a".repeat(200) + "/").repeat(25) + "f.txt"));
  // Multi-byte: 255 is a BYTE limit, not a character count.
  assert(cannotExist("/" + "é".repeat(130) + ".txt"));
  assert(isNotServable(new Deno.errors.NotADirectory("x")));
  assert(isNotServable(new Deno.errors.FilesystemLoop("x")));
  assert(!isNotServable(new Deno.errors.PermissionDenied("x")));
  const f = await fixture();
  try {
    for (const prod of [true, false]) {
      const h = handlerFor(f.dir, prod);
      for (
        const p of [
          "/" + "x".repeat(300) + ".txt",
          "/" + "x".repeat(300) + ".md",
          "/lib/" + "y".repeat(256) + ".css",
          // A path THROUGH a file (ENOTDIR) is equally not there.
          "/readme.md/x.txt",
        ]
      ) {
        const res = await h.serveStatic(p);
        await res.text();
        assertEquals(res.status, 404, `prod=${prod} ${p.slice(0, 40)}…`);
      }
    }
  } finally {
    f.cleanup();
  }
});
