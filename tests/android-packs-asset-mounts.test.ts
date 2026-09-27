// A standalone APK has no server, so a deno.json `assets` mount — served by the
// server on every other target — reached the phone as nothing: the page's
// relative `fetch("text/a.md")` worked on the desktop and 404'd in the APK. A
// field report (a multi-screen reader app) had to derive a second copy of its
// content by hand. The build now packages each mount at the same path under
// the page, with the server's guards (no dotfiles, no *.server.ts).
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createStaticHandler } from "../src/server/server-static.ts";
import { _packAssetMounts } from "../src/build/build-android.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function project(assets: unknown): Promise<string> {
  const root = await tempDir("aio-android-mounts-");
  await Deno.writeTextFile(join(root, "deno.json"), JSON.stringify({ assets }));
  await Deno.mkdir(join(root, "content", "en"), { recursive: true });
  await Deno.writeTextFile(join(root, "content", "en", "a.md"), "# a");
  await Deno.writeTextFile(join(root, "content", "top.txt"), "t");
  await Deno.writeTextFile(join(root, "content", ".secret"), "s");
  await Deno.writeTextFile(join(root, "content", "x.server.ts"), "s");
  await Deno.mkdir(join(root, "out"));
  return root;
}

async function files(dir: string, at = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(join(dir, at))) {
    const p = at ? `${at}/${e.name}` : e.name;
    if (e.isDirectory) out.push(...await files(dir, p));
    else out.push(p);
  }
  return out.sort();
}

Deno.test("android: deno.json assets mounts are packaged under the page, guarded", async () => {
  const root = await project({ "/text": "./content" });
  try {
    await _packAssetMounts(root, join(root, "out"));
    assertEquals(await files(join(root, "out")), [
      "text/en/a.md",
      "text/top.txt",
    ]);
    assertEquals(
      await Deno.readTextFile(join(root, "out", "text", "en", "a.md")),
      "# a",
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("android: no deno.json assets → nothing packaged", async () => {
  const root = await project(undefined);
  try {
    await _packAssetMounts(root, join(root, "out"));
    assertEquals(await files(join(root, "out")), []);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("android: a mount that would overwrite the page or escape is refused", async () => {
  for (const prefix of ["/", "/index.html", "/../up", "/a/./b"]) {
    const root = await project({ [prefix]: "./content" });
    try {
      await assertRejects(
        () => _packAssetMounts(root, join(root, "out")),
        Error,
        "cannot be packaged",
      );
    } finally {
      await dropTempDir(root);
    }
  }
});

Deno.test("android: a mount outside the project or missing is refused, never dropped", async () => {
  const outside = await project({ "/text": "../elsewhere" });
  const missing = await project({ "/text": "./nope" });
  try {
    await assertRejects(
      () => _packAssetMounts(outside, join(outside, "out")),
      Error,
      "outside the project",
    );
    await assertRejects(
      () => _packAssetMounts(missing, join(missing, "out")),
      Deno.errors.NotFound,
    );
  } finally {
    await dropTempDir(outside);
    await dropTempDir(missing);
  }
});

// ── What ships is what the PRODUCTION server serves — asked of its deciders ──
// The packer once had its own copy of the server's rules, weaker than the
// original: a symlink's TARGET was copied (`env.txt -> ../.env` shipped the
// secret the server answers 403 for), and `db.server.js`, `Db.Server.ts`, a
// module declaring `import "aio/server-only"` and all `.ts`/`.tsx`/`.jsx`
// source (404 on a prod server) went into the APK.

const MARKER = `import "aio/server-only";\nexport const k = "s";\n`;

/** A mount holding one file per rule, plus links that stay inside it. */
async function guarded(): Promise<string> {
  const root = await project({ "/text": "./content" });
  const c = join(root, "content");
  const bodies: [string, string][] = [
    ["plain.js", "export const x = 1;"],
    ["db.server.js", "s"],
    ["Db.Server.ts", "s"],
    ["marker.js", MARKER],
    ["marker.mjs", MARKER],
    ["src.ts", "s"],
    ["comp.tsx", "s"],
    ["comp.jsx", "s"],
    ["data.json", "{}"],
  ];
  for (const [n, body] of bodies) await Deno.writeTextFile(join(c, n), body);
  await Deno.mkdir(join(c, ".hidden"));
  await Deno.writeTextFile(join(c, ".hidden", "x.txt"), "s");
  await Deno.symlink("top.txt", join(c, "inlink.txt"));
  await Deno.symlink("en", join(c, "linkdir")); // a directory, inside
  return root;
}

/** Every file in the mount, as its URL under /text (links followed). */
async function urls(dir: string, at = "/text"): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if ((await Deno.stat(p)).isDirectory) {
      out.push(...await urls(p, `${at}/${e.name}`));
    } else out.push(`${at}/${e.name}`);
  }
  return out.sort();
}

function prodServer(root: string) {
  return createStaticHandler({
    prod: true,
    debug: () => {},
    title: "t",
    absBaseDir: root,
    assets: { "/text": join(root, "content") },
    absDistDir: join(root, "dist"),
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => null,
    // deno-lint-ignore no-explicit-any
  } as any);
}

Deno.test("android: a mount ships exactly what the prod server serves (links, case, marker, source)", async () => {
  const root = await guarded();
  try {
    await _packAssetMounts(root, join(root, "out"));
    const shipped = (await files(join(root, "out"))).map((f) => `/${f}`);
    assertEquals(shipped, [
      "/text/data.json",
      "/text/en/a.md",
      "/text/inlink.txt",
      "/text/linkdir/a.md",
      "/text/plain.js",
      "/text/top.txt",
    ]);
    // The property, not the list: served (200) ⇔ shipped.
    const h = prodServer(root);
    const all = await urls(join(root, "content"));
    assertEquals(all.length, 16, all.join(", "));
    for (const url of all) {
      const res = await h.serveStatic(url);
      await res.body?.cancel();
      assertEquals(
        res.status === 200,
        shipped.includes(url),
        `${url}: server ${res.status}, packed ${shipped.includes(url)}`,
      );
    }
    assertEquals(
      await Deno.readTextFile(join(root, "out", "text", "inlink.txt")),
      "t",
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("android: a symlink out of the mount is refused, naming it — its target never ships", async () => {
  const secret = await tempDir("aio-android-secret-");
  await Deno.writeTextFile(join(secret, "id_rsa"), "PRIVATE");
  type Make = (c: string, root: string) => Promise<void>;
  const cases: [string, Make, string][] = [
    ["relative file", async (c, root) => {
      await Deno.writeTextFile(join(root, ".env"), "SECRET=1");
      await Deno.symlink("../.env", join(c, "env.txt"));
    }, "env.txt"],
    [
      "absolute file",
      (c) => Deno.symlink(join(secret, "id_rsa"), join(c, "key.txt")),
      "key.txt",
    ],
    ["directory", (c) => Deno.symlink(secret, join(c, "keys")), "keys"],
    ["dangling", (c) => Deno.symlink("nope", join(c, "gone.txt")), "gone.txt"],
    ["loop", (c) => Deno.symlink("..", join(c, "en", "up")), "up"],
  ];
  try {
    for (const [what, make, name] of cases) {
      const root = await project({ "/text": "./content" });
      try {
        await make(join(root, "content"), root);
        const e = await assertRejects(
          () => _packAssetMounts(root, join(root, "out")),
          Error,
          `assets["/text"]`,
        );
        assertStringIncludes(e.message, name, what);
        assertEquals(
          (await files(join(root, "out"))).filter((f) =>
            f.includes(name) || f.includes("id_rsa")
          ),
          [],
          what,
        );
      } finally {
        await dropTempDir(root);
      }
    }
    // …and the server answers 403 for the same link: one rule, both sides.
    const root = await project({ "/text": "./content" });
    try {
      await Deno.symlink(
        join(secret, "id_rsa"),
        join(root, "content", "k.txt"),
      );
      const res = await prodServer(root).serveStatic("/text/k.txt");
      await res.body?.cancel();
      assertEquals(res.status, 403);
    } finally {
      await dropTempDir(root);
    }
  } finally {
    await dropTempDir(secret);
  }
});

Deno.test("android: a mount that contains the build output is refused, naming the mount", async () => {
  const root = await project({ "/data": "." });
  try {
    await assertRejects(
      () => _packAssetMounts(root, join(root, "out")),
      Error,
      `assets["/data"] cannot be packaged into the APK: it contains ` +
        `the build output`,
    );
  } finally {
    await dropTempDir(root);
  }
});
