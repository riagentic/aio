// `assets: { "/media": "./media" }` — the twenty lines every app wrote by hand.
//
// _"Every app with binary data writes the same twenty lines — route, MIME,
// caching, range, traversal guard, `compile.include` — and one of them will
// forget the guard."_ (anathomy §7, §10.5).
//
// `serveDirs` already did the serving, and is DEV-ONLY on purpose: it exists so
// the dev server can resolve a MODULE that lives outside baseDir, which a prod
// bundle resolves for itself. Data is the opposite — production needs it
// exactly as much as dev does — so `assets` is the same machinery without the
// `prod ? undefined` and with the build half attached.
//
// THE GUARDS ARE THE POINT. An extra root must not be a weaker root, so most of
// this file is the things a mount must still refuse.
import { assert, assertEquals } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assetIncludes } from "../src/build/build-compile.ts";
import { isProtectedPath } from "../src/server/server-static.ts";
import {
  CONFIG_DOCS,
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
} from "../src/server/config.ts";

Deno.test("assets is a real config key on both config shapes, and documented", () => {
  // The three surfaces that have to agree, or the key is accepted by one and
  // rejected by another — the config-bridge trap this repo has hit before.
  assert(VALID_FEATURES_CONFIG_KEYS.has("assets"));
  assert(VALID_AIO_CONFIG_KEYS.has("assets"));
  assert(
    CONFIG_DOCS.assets,
    "a key that ships undocumented is a key nobody finds",
  );
});

Deno.test("a declared asset dir is EMBEDDED in the binary", async () => {
  // `deno compile` cannot trace a directory nobody imports, so a mount
  // declared only in code serves in dev and 404s from the binary. That is the
  // failure a user finds, not a test — unless the build reads the same
  // declaration the server does.
  const root = await tempDir("aio-assets-");
  try {
    await Deno.mkdir(`${root}/media`);
    await Deno.writeTextFile(`${root}/media/song.txt`, "hi");
    await Deno.writeTextFile(
      `${root}/deno.json`,
      JSON.stringify({ assets: { "/media": "./media" } }),
    );
    const args = await assetIncludes(root);
    assert(
      args.includes("media"),
      `the mounted dir must be embedded: ${args.join(" ")}`,
    );
    // …and it is an `--include` pair, not a bare path.
    assertEquals(args[args.indexOf("media") - 1], "--include");
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("a mount pointing OUTSIDE the project is refused, not dropped", async () => {
  // A silently skipped mount ships a binary without the data it was told to
  // carry, and the failure surfaces in a user's hands.
  const root = await tempDir("aio-assets2-");
  try {
    await Deno.writeTextFile(
      `${root}/deno.json`,
      JSON.stringify({ assets: { "/x": "../elsewhere" } }),
    );
    let msg = "";
    try {
      await assetIncludes(root);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.includes("outside the project"), `it must say why: ${msg}`);
    assert(msg.includes("/x"), `it must name the mount: ${msg}`);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("a mount with an empty directory is refused by name", async () => {
  const root = await tempDir("aio-assets3-");
  try {
    await Deno.writeTextFile(
      `${root}/deno.json`,
      JSON.stringify({ assets: { "/x": "  " } }),
    );
    let msg = "";
    try {
      await assetIncludes(root);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.includes("/x"), msg);
    assert(msg.includes("non-empty"), msg);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("no `assets` key: the build behaves exactly as before", async () => {
  const root = await tempDir("aio-assets4-");
  try {
    await Deno.writeTextFile(`${root}/deno.json`, JSON.stringify({}));
    const args = await assetIncludes(root);
    // Only the identity file the build always embeds.
    assertEquals(args.filter((a) => a !== "--include"), ["deno.json"]);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("a mounted root is not a WEAKER root — the guards still refuse", () => {
  // `assets` joins the same `_roots` list `serveDirs` uses, so everything after
  // the prefix match treats it exactly as baseDir is treated. These are the
  // rules that must keep applying inside a mount.
  assert(isProtectedPath("/media/.env"), "a dotfile, at any depth");
  assert(isProtectedPath("/media/secret.server.ts"), "a server-only module");
  assert(isProtectedPath("/media/sub/.git/config"), "…nested too");
  // …and an ordinary asset is still servable, or the mount would be useless.
  assert(!isProtectedPath("/media/song.mp3"));
  assert(!isProtectedPath("/media/model.bin"));
});

// ── it actually SERVES, in both worlds ──────────────────────────────────────

import { join } from "@std/path";
import { createStaticHandler } from "../src/server/server-static.ts";

function handlerFor(
  absBaseDir: string,
  extra: {
    assets?: Record<string, string>;
    serveDirs?: Record<string, string>;
  },
  prod = false,
) {
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
    ...extra,
    // deno-lint-ignore no-explicit-any
  } as any);
}

async function mountFixture(): Promise<{ base: string; media: string }> {
  const root = await tempDir("aio-assets-serve-");
  const base = join(root, "src");
  const media = join(root, "media");
  await Deno.mkdir(base, { recursive: true });
  await Deno.mkdir(join(media, "sub"), { recursive: true });
  await Deno.writeTextFile(join(base, "App.tsx"), "export default () => null");
  await Deno.writeTextFile(join(media, "song.txt"), "MEDIA_BODY");
  await Deno.writeTextFile(join(media, ".secret"), "nope");
  await Deno.writeTextFile(
    join(media, "load.server.ts"),
    "export const x = 1;",
  );
  return { base, media };
}

Deno.test("assets serves in DEV and, unlike serveDirs, in PROD", async () => {
  const f = await mountFixture();
  for (const prod of [false, true]) {
    const h = handlerFor(f.base, { assets: { "/media": f.media } }, prod);
    const res = await h.serveStatic("/media/song.txt");
    assertEquals(res.status, 200, `prod=${prod} must serve the mount`);
    assertEquals((await res.text()).trim(), "MEDIA_BODY");
  }
  // …and this is the difference, stated: the same directory through
  // `serveDirs` is dev-only BY CONSTRUCTION — server.ts passes `undefined` in
  // prod — so a data mount had to be hand-rolled or it vanished at build time.
  const dev = handlerFor(f.base, { serveDirs: { "/media": f.media } }, false);
  assertEquals((await dev.serveStatic("/media/song.txt")).status, 200);
});

Deno.test("a mounted root is not a weaker root — the real handler refuses", async () => {
  // The unit check above asks the predicate; this asks the SERVER, because a
  // guard that is only true of a helper is a guard nobody is behind.
  const f = await mountFixture();
  for (const prod of [false, true]) {
    const h = handlerFor(f.base, { assets: { "/media": f.media } }, prod);
    assertEquals(
      (await h.serveStatic("/media/.secret")).status,
      404,
      "a dotfile inside a mount",
    );
    assertEquals(
      (await h.serveStatic("/media/load.server.ts")).status,
      404,
      "a server-only module inside a mount",
    );
    const up = await h.serveStatic("/media/../src/App.tsx");
    assert(
      up.status === 403 || up.status === 404,
      `traversal out: ${up.status}`,
    );
  }
});

Deno.test("when both claim a prefix, the one that survives a build wins", async () => {
  // A mount that resolves differently either side of a build is exactly the
  // class this repo calls WYSIDIWYSIP, so `assets` is matched first.
  const f = await mountFixture();
  const other = await tempDir("aio-assets-other-");
  await Deno.writeTextFile(join(other, "song.txt"), "FROM_SERVEDIRS");
  try {
    const h = handlerFor(f.base, {
      assets: { "/media": f.media },
      serveDirs: { "/media": other },
    });
    assertEquals((await h.serveStatic("/media/song.txt")).status, 200);
    assertEquals(
      (await (await handlerFor(f.base, {
        assets: { "/media": f.media },
        serveDirs: { "/media": other },
      }).serveStatic("/media/song.txt")).text()).trim(),
      "MEDIA_BODY",
    );
  } finally {
    await dropTempDir(other);
  }
});
