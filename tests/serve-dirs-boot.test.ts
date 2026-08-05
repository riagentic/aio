// `serveDirs` through a REAL boot — the test that was missing.
//
// tests/serve-dirs.test.ts drives `createStaticHandler` directly and was green
// while the feature was completely dead in alpha45: `aio.ts` handed
// `setupTransport` a hand-copied config literal that never listed `serveDirs`,
// so `config.serveDirs` was `undefined` at the server and every mapped path
// 404'd. A handler test can never see that hop. This one boots `aio.run()` and
// fetches over HTTP, which is the only place the whole chain is real.
//
// The relative case is the documented one (`{"/shared": "../core/lib"}`) and
// was a second, independent break: the mapped root was compared against
// itself un-normalized, so the containment guard refused every file with a
// blanket 403. Roots are resolved once now, exactly like `baseDir`.
import { assert, assertEquals } from "@std/assert";
import { join, relative } from "@std/path";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";

interface Fixture {
  base: string;
  shared: string;
  root: string;
  cleanup: () => void;
}

async function fixture(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "aio-servedirs-boot-" });
  const base = join(root, "app", "src");
  const shared = join(root, "core", "lib");
  await Deno.mkdir(base, { recursive: true });
  await Deno.mkdir(shared, { recursive: true });
  await Deno.writeTextFile(join(base, "App.tsx"), "export default () => null;");
  await Deno.writeTextFile(
    join(shared, "sse.ts"),
    "export const parseSSE = (s: string): string => s.trim();",
  );
  await Deno.writeTextFile(join(shared, ".secret"), "nope");
  await Deno.writeTextFile(join(root, "outside.ts"), "export const x = 1;");
  return {
    base,
    shared,
    root,
    cleanup: () => {
      try {
        Deno.removeSync(root, { recursive: true });
      } catch { /* best effort */ }
    },
  };
}

/** Keep app-manager state out of the developer's real apps dir. */
function pinAppsDir(): { dir: string; restore: () => void } {
  const prev = Deno.env.get("AIO_APPS_DIR");
  const dir = Deno.makeTempDirSync({ prefix: "aio-apps-servedirs-" });
  Deno.env.set("AIO_APPS_DIR", dir);
  return {
    dir,
    restore: () => {
      if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev);
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* best effort */ }
    },
  };
}

Deno.test("serveDirs reaches the server: an ABSOLUTE root serves over HTTP", async () => {
  const f = await fixture();
  const apps = pinAppsDir();
  try {
    const c = cell("servedirs-abs", { state: { n: 0 }, methods: {} });
    await using srv = await testServer({
      cells: [c],
      baseDir: f.base,
      serveDirs: { "/shared": f.shared },
    });
    const res = await srv.fetch("/shared/sse.ts");
    const body = await res.text();
    assertEquals(
      res.status,
      200,
      `serveDirs must survive aio.run() → setupTransport → createServer; ` +
        `got ${res.status}: ${body.slice(0, 200)}`,
    );
    assert(
      body.includes("parseSSE"),
      `the mapped module must be the response body: ${body.slice(0, 200)}`,
    );
    // baseDir keeps serving its own files.
    const own = await srv.fetch("/App.tsx");
    assertEquals(own.status, 200);
    await own.text();
  } finally {
    apps.restore();
    f.cleanup();
  }
});

Deno.test("serveDirs reaches the server: a RELATIVE root serves over HTTP", async () => {
  const f = await fixture();
  const apps = pinAppsDir();
  try {
    // The documented form. Relative roots resolve against the process cwd,
    // the same rule `baseDir` follows.
    const rel = relative(Deno.cwd(), f.shared);
    assert(!rel.startsWith("/"), "fixture path must be relative for this test");
    const c = cell("servedirs-rel", { state: { n: 0 }, methods: {} });
    await using srv = await testServer({
      cells: [c],
      baseDir: f.base,
      serveDirs: { "/shared": rel },
    });
    const res = await srv.fetch("/shared/sse.ts");
    const body = await res.text();
    assertEquals(
      res.status,
      200,
      `a relative serveDirs root must resolve, not 403 — an un-normalized ` +
        `root failed containment against itself; got ${res.status}: ` +
        body.slice(0, 200),
    );
    assert(body.includes("parseSSE"), body.slice(0, 200));
  } finally {
    apps.restore();
    f.cleanup();
  }
});

Deno.test("serveDirs through a real boot is not a weaker root", async () => {
  const f = await fixture();
  const apps = pinAppsDir();
  try {
    const c = cell("servedirs-guards", { state: { n: 0 }, methods: {} });
    await using srv = await testServer({
      cells: [c],
      baseDir: f.base,
      serveDirs: { "/shared": relative(Deno.cwd(), f.shared) },
    });
    // Traversal out of the mapped root (normalizing the root must not have
    // widened it).
    const esc = await srv.fetch("/shared/../../outside.ts");
    await esc.text();
    assert(
      esc.status === 403 || esc.status === 404,
      `traversal out of a mapped root must be refused, got ${esc.status}`,
    );
    // Dotfiles are protected there exactly as under baseDir.
    const dot = await srv.fetch("/shared/.secret");
    await dot.text();
    assert(
      dot.status === 403 || dot.status === 404,
      `a dotfile in a mapped root must be refused, got ${dot.status}`,
    );
  } finally {
    apps.restore();
    f.cleanup();
  }
});
