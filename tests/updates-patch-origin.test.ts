// Where relative update URLs land, and which host a patch may come from.
//
// `fetchManifest`'s `base` is the last redirect hop on the requested origin —
// for GitHub, the tag's own folder. A detour through ANOTHER host must not
// choose it: A → B → A/elsewhere would let B pick the folder a relative `url`
// resolves in, and the same-origin check would still pass.
//
// A patch is fetched like the full artifact: an absolute `url` on another
// host is refused (it was downloaded unchecked).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, type ShipManifest } from "../src/build/ship.ts";
import { fetchManifest, fileSha256 } from "../src/server/updates-check.ts";
import { artifactFromPatch } from "../src/server/updates-patch.ts";
import { treeFromPatch } from "../src/server/updates-tree.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const serve = (port: number, h: (req: Request) => Response) =>
  Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, h);

Deno.test("fetchManifest: a redirect detour through another host does not choose the base", async () => {
  const a = freePort(), b = freePort();
  const A = `http://127.0.0.1:${a}`, B = `http://127.0.0.1:${b}`;
  const manifest = JSON.stringify(
    await buildShipManifest({
      name: "app",
      version: "2.0.0",
      binary: new Uint8Array(10),
      sources: [],
      channel: "prod",
      target: "binary",
      platform: { os: Deno.build.os, arch: Deno.build.arch },
      url: "app-2.0.0",
    }),
  );
  const sa = serve(a, (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/rel/m.json") return Response.redirect(`${B}/hop`, 302);
    if (p === "/other/m.json") return new Response(manifest);
    return new Response("no", { status: 404 });
  });
  const sb = serve(b, () => Response.redirect(`${A}/other/m.json`, 302));
  try {
    const got = await fetchManifest(`${A}/rel/m.json`);
    assertEquals(got.kind, "ok", JSON.stringify(got));
    if (got.kind !== "ok") return;
    assertEquals(got.base, `${A}/rel/m.json`, "the detour chose the base");
  } finally {
    await sa.shutdown();
    await sb.shutdown();
  }
});

Deno.test("patches: an absolute patch url on another host is refused, never fetched", async () => {
  const dir = await tempDir("aio-patch-origin-");
  const b = freePort();
  let asked = 0;
  const sb = serve(b, () => {
    asked++;
    return new Response(new Uint8Array(4));
  });
  try {
    const installed = join(dir, "app");
    await Deno.writeFile(installed, new Uint8Array(64));
    const from = await fileSha256(installed);
    const m = {
      name: "app",
      version: "2.0.0",
      channel: "prod",
      target: "binary",
      url: "app-2.0.0",
      sha256: "1".repeat(64),
      size: 1000,
      patches: [{
        from,
        url: `http://127.0.0.1:${b}/p.zst`,
        size: 4,
        sha256: "2".repeat(64),
      }],
    } as unknown as ShipManifest;
    const manifestUrl = `http://127.0.0.1:${freePort()}/rel/m.json`;
    const one = await artifactFromPatch({
      manifest: m,
      manifestUrl,
      installed,
      dataDir: dir,
    });
    assert(
      one && "why" in one && one.why.includes("different host"),
      one ? JSON.stringify(one) : "null",
    );
    const tree = await treeFromPatch({
      manifest: { ...m, target: "electron-zip" } as ShipManifest,
      manifestUrl,
      installed: dir,
      installedSha256: from,
      staged: join(dir, "staged"),
      dataDir: dir,
    });
    assert(tree && "why" in tree, tree ? JSON.stringify(tree) : "null");
    assertEquals(asked, 0, "the other host was asked for the patch");
  } finally {
    await sb.shutdown();
    await dropTempDir(dir);
  }
});
