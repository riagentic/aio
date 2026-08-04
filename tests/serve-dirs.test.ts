// `serveDirs` — extra read-only DEV roots, with baseDir's guards unchanged.
//
// Field report (llama-master #1): two apps in one repository cannot share a
// pure module. The client reused the server app's SSE parser and formatters,
// because "a second implementation of 'what did this token event contain' is a
// second implementation that drifts". A relative import (`../../src/lib/sse.ts`)
// type-checks and runs on the server, then blanks the browser:
//
//     WARN client BLANK SCREEN (boot): Failed to fetch dynamically imported
//       module: http://localhost:52058/App.tsx
//
// because modules are fetched over HTTP from baseDir and anything outside it
// 404s. A symlink into it is refused too — correctly, and that guard stays.
// They ended up generating a mirror of six files with a test policing drift.
//
// The security shape is the point: an extra root is not a weaker root. Every
// guard that protects baseDir — traversal, symlink escape, dotfiles,
// server-only paths — applies to each mapped root unchanged, and the whole
// feature is DEV-ONLY (prod serves a bundle whose imports were followed at
// build time), so a production server cannot be pointed outside its own root
// by a config key at all.
import { assert, assertEquals } from "@std/assert";
import { createStaticHandler } from "../src/server/server-static.ts";
import { join } from "@std/path";

async function fixture(): Promise<
  { base: string; shared: string; outside: string; cleanup: () => void }
> {
  const root = await Deno.makeTempDir({ prefix: "aio-servedirs-" });
  const base = join(root, "app", "src");
  const shared = join(root, "core", "lib");
  await Deno.mkdir(base, { recursive: true });
  await Deno.mkdir(shared, { recursive: true });
  await Deno.writeTextFile(join(base, "App.tsx"), "export default () => null");
  await Deno.writeTextFile(
    join(shared, "sse.ts"),
    "export const parseSSE = (s: string) => s.trim();",
  );
  await Deno.writeTextFile(join(shared, ".secret"), "nope");
  await Deno.writeTextFile(join(root, "outside.ts"), "export const x = 1;");
  return {
    base,
    shared,
    outside: root,
    cleanup: () => {
      try {
        Deno.removeSync(root, { recursive: true });
      } catch { /* best effort */ }
    },
  };
}

function handlerFor(
  absBaseDir: string,
  serveDirs?: Record<string, string>,
  prod = false,
) {
  return createStaticHandler({
    prod,
    debug: () => {},
    title: "t",
    absBaseDir,
    serveDirs,
    absDistDir: join(absBaseDir, "dist"),
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => null,
    // deno-lint-ignore no-explicit-any
  } as any);
}

Deno.test("serveDirs: a module outside baseDir is served under its prefix", async () => {
  const f = await fixture();
  try {
    const h = handlerFor(f.base, { "/shared": f.shared });
    const res = await h.serveStatic("/shared/sse.ts");
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(
      body.includes("parseSSE"),
      `the shared module must be served: ${body.slice(0, 120)}`,
    );
  } finally {
    f.cleanup();
  }
});

Deno.test("serveDirs: baseDir still serves its own files unchanged", async () => {
  const f = await fixture();
  try {
    const h = handlerFor(f.base, { "/shared": f.shared });
    const res = await h.serveStatic("/App.tsx");
    assertEquals(res.status, 200);
    await res.text();
  } finally {
    f.cleanup();
  }
});

Deno.test("serveDirs: an extra root is NOT a weaker root", async () => {
  const f = await fixture();
  try {
    const h = handlerFor(f.base, { "/shared": f.shared });
    // Traversal out of the mapped root.
    const esc = await h.serveStatic("/shared/../../outside.ts");
    assert(
      esc.status === 403 || esc.status === 404,
      `traversal out of a mapped root must be refused, got ${esc.status}`,
    );
    // Dotfiles are protected there exactly as under baseDir.
    const dot = await h.serveStatic("/shared/.secret");
    assert(
      dot.status === 403 || dot.status === 404,
      `a dotfile in a mapped root must be refused, got ${dot.status}`,
    );
  } finally {
    f.cleanup();
  }
});

Deno.test("serveDirs: unmapped paths behave exactly as before", async () => {
  const f = await fixture();
  try {
    const withDirs = handlerFor(f.base, { "/shared": f.shared });
    const without = handlerFor(f.base);
    // A path that matches no prefix resolves against baseDir in both.
    const a = await withDirs.serveStatic("/nope.ts");
    const b = await without.serveStatic("/nope.ts");
    assertEquals(a.status, b.status);
    await a.text();
    await b.text();
  } finally {
    f.cleanup();
  }
});
