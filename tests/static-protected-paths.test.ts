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
