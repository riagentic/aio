// Editing the framework, while running an app against it, changed nothing.
//
// A source-layout app reaches aio through a `dep/aio` SYMLINK into a checkout
// (`am link`). Two facts follow and the watcher got both wrong: the checkout is
// not under `absBaseDir`, and `Deno.watchFs` does not follow symlinks anyway.
// So the page kept serving the modules it had, and the person editing the
// framework saw no reason why (quant §9.6).
//
// Derived from the IMPORT MAP, not by looking for a `dep/aio` path, because the
// import map is what actually decides where `aio` comes from — so an app that
// pins a checkout anywhere else gets the same treatment, and one that pins
// `jsr:` correctly gets none.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { frameworkWatchRoot } from "../src/server/server-watcher.ts";

/** A checkout (with `mod.ts` + `src/`), an app, and a symlink between them. */
async function layout(): Promise<
  { app: string; base: string; checkout: string; link: string }
> {
  const root = await tempDir("aio-fwwatch-");
  const checkout = join(root, "framework");
  const app = join(root, "app");
  const base = join(app, "src");
  await Deno.mkdir(join(checkout, "src"), { recursive: true });
  await Deno.writeTextFile(join(checkout, "mod.ts"), "export const x = 1;\n");
  await Deno.mkdir(join(app, "dep"), { recursive: true });
  await Deno.mkdir(base, { recursive: true });
  const link = join(app, "dep", "aio");
  await Deno.symlink(checkout, link);
  return { app, base, checkout, link };
}

Deno.test("a path pin through a SYMLINK resolves to the real checkout's src/", async () => {
  const l = await layout();
  try {
    const got = frameworkWatchRoot({ aio: "../dep/aio/mod.ts" }, l.base);
    assert(got, "a source-layout app must get a framework watch root");
    // The REAL path, because that is what the watcher can watch and what its
    // events carry — the symlink's own path never appears in them.
    assertEquals(got, await Deno.realPath(join(l.checkout, "src")));
  } finally {
    await dropTempDir(l.app.replace(/\/app$/, ""));
  }
});

Deno.test("a directory pin, with or without a trailing slash, works too", async () => {
  const l = await layout();
  try {
    const real = await Deno.realPath(join(l.checkout, "src"));
    assertEquals(frameworkWatchRoot({ aio: "../dep/aio" }, l.base), real);
    assertEquals(frameworkWatchRoot({ "aio/": "../dep/aio/" }, l.base), real);
  } finally {
    await dropTempDir(l.app.replace(/\/app$/, ""));
  }
});

Deno.test("a registry pin watches NOTHING — there is no working tree", async () => {
  const l = await layout();
  try {
    for (
      const spec of [
        "jsr:@riagentic/aio@1.0.0-alpha77",
        "npm:aio@1",
        "https://example.test/aio/mod.ts",
      ]
    ) {
      assertEquals(
        frameworkWatchRoot({ aio: spec }, l.base),
        null,
        `${spec} has no source to watch, and handles spent on a read-only ` +
          `cache are handles spent on nothing`,
      );
    }
    assertEquals(frameworkWatchRoot({}, l.base), null, "no pin at all");
  } finally {
    await dropTempDir(l.app.replace(/\/app$/, ""));
  }
});

Deno.test("a pin that does not resolve is not an error here", async () => {
  // The import map's own reader reports that, loudly, at boot. A watcher that
  // threw would turn a bad pin into a dead dev server.
  const l = await layout();
  try {
    assertEquals(frameworkWatchRoot({ aio: "../nope/mod.ts" }, l.base), null);
    // A directory that exists but is not a checkout is refused too.
    assertEquals(frameworkWatchRoot({ aio: "../dep" }, l.base), null);
  } finally {
    await dropTempDir(l.app.replace(/\/app$/, ""));
  }
});

Deno.test("a framework INSIDE the watched dir adds nothing — no double events", async () => {
  const root = await tempDir("aio-fwinside-");
  try {
    const base = join(root, "src");
    await Deno.mkdir(join(base, "vendor", "aio", "src"), { recursive: true });
    await Deno.writeTextFile(
      join(base, "vendor", "aio", "mod.ts"),
      "export const x = 1;\n",
    );
    assertEquals(
      frameworkWatchRoot({ aio: "./vendor/aio/mod.ts" }, base),
      null,
      "it is already being watched; adding it doubles every event",
    );
  } finally {
    await dropTempDir(root);
  }
});
