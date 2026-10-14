// A deno.json-only `assets` mount sits behind EXACTLY the gates an
// `aio.run({ assets })` mount does.
//
// Until 1.0.19 the server read `aio.run({ assets })` alone, though the docs
// declared the mount in deno.json first ("`GET /media/song.mp3` then works in
// dev, in `--prod`, and from a compiled binary") and the build embedded it.
// Serving it now must not open a door the other spelling keeps shut: for
// every caller — anonymous on an `auth: true` app, with and without the key
// on an exposed keyed one — both spellings answer the same status for a data
// file and for a shell-shaped one. And an app with NO mount gets the very
// object it passed (nothing added, no handler, no socket).
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { _denoJsonMountsNote, _servedAssets } from "../src/server/server.ts";
import { resolveZeroPort } from "../src/server/aio-server.ts";
import { assetMounts } from "../src/build/build-compile.ts";
import { captureConsole } from "./console-capture.ts";

const FILES = ["/media/data.json", "/media/secret.bin", "/media/lib.js"];
const KEY = "k".repeat(32);

/** What each caller is answered for each file, the mount declared in
 *  deno.json (`where: "deno"`) or passed to `aio.run` (`"run"`). */
async function statuses(
  where: "deno" | "run",
  mode: "auth" | "key",
): Promise<Record<string, number>> {
  _resetAuthFails();
  const { aio, cell } = await import("../mod.ts");
  const dir = await tempDir("assets-gates-");
  const tag = `${where}-${mode}`;
  await Deno.mkdir(join(dir, "media"));
  for (const f of FILES) await Deno.writeTextFile(join(dir, f), `BODY${f}`);
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(where === "deno" ? { assets: { "/media": "./media" } } : {}),
  );
  const port = freePort();
  const app = await aio.run({
    cells: [cell(`c_assets_${where}_${mode}`, { state: { n: 0 } })],
    appId: `test-assets-gates-${tag}-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    appDir: join(dir, "home"),
    ...(where === "run" ? { assets: { "/media": join(dir, "media") } } : {}),
    ...(mode === "auth"
      ? { auth: true }
      : { key: KEY, expose: true, tls: false }),
    watch: false,
    baseDir: join(dir, "src-none"),
  });
  const out: Record<string, number> = {};
  try {
    for (const f of FILES) {
      for (
        const [who, headers] of [
          ["anonymous", {}],
          ["keyed", { Authorization: `Bearer ${KEY}` }],
        ] as const
      ) {
        const r = await fetch(`http://127.0.0.1:${port}${f}`, { headers });
        await r.body?.cancel();
        out[`${who} ${f}`] = r.status;
      }
    }
  } finally {
    await app.close();
    _resetAuthFails();
    await dropTempDir(dir);
  }
  return out;
}

Deno.test("assets: a deno.json-only mount answers every caller what an aio.run mount answers — auth: true", async () => {
  const deno = await statuses("deno", "auth");
  assertEquals(deno, await statuses("run", "auth"));
  // The anonymous gate is the extension gate, as for any served file.
  assertEquals(deno["anonymous /media/data.json"], 401);
  assertEquals(deno["anonymous /media/secret.bin"], 401);
  assertEquals(deno["anonymous /media/lib.js"], 200);
});

Deno.test("assets: a deno.json-only mount answers every caller what an aio.run mount answers — exposed, keyed", async () => {
  const deno = await statuses("deno", "key");
  assertEquals(deno, await statuses("run", "key"));
  // Served at all — to the key's holder, and to nobody else.
  for (const f of FILES) {
    assertEquals(deno[`keyed ${f}`], 200, f);
    assert(deno[`anonymous ${f}`] !== 200, `${f} without the key`);
  }
});

Deno.test("assets: an app that declares no mount is handed what it passed — and a packaged window with none still skips the handler", async () => {
  const dir = await tempDir("assets-none-");
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), `{ "title": "x" }`);
    assert(_servedAssets(undefined, dir) === undefined);
    const run = { "/x": "./x" };
    assert(_servedAssets(run, dir) === run);
    // No deno.json at all (a packaged app reads its own): the same.
    assert(_servedAssets(undefined, join(dir, "a/b/c/d/e/f")) === undefined);
    const packaged = {
      prod: true,
      localElectronUds: true,
      canServeFromDisk: true,
      portRequested: false,
    };
    // What aio-server.ts counts: routes + mounts.
    const mounts = Object.keys(_servedAssets(undefined, dir) ?? {}).length;
    assertEquals(resolveZeroPort({ ...packaged, routeCount: 0 + mounts }), {
      zeroPort: true,
      skipHttp: true,
      useHttpSocket: false,
    });
  } finally {
    await dropTempDir(dir);
  }
});

// Dev == build: a mount the build REFUSES (it points outside the project, so
// no artifact could carry it) is not served from the tree either — 404, as
// in 1.0.19, which served no deno.json mount — and the server says so in the
// build's own sentence.
Deno.test("assets: a deno.json mount outside the project is not served, in the sentence the build refuses it with — aio.run's own mount of that prefix stays", async () => {
  const dir = await tempDir("assets-outside-");
  try {
    const root = join(dir, "app");
    await Deno.mkdir(join(root, "in"), { recursive: true });
    const assets = { "/up": "../x", "/abs": dir, "/in": "./in" };
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ assets }),
    );
    let served: Record<string, string> | undefined;
    const said = captureConsole(() => {
      served = _servedAssets(undefined, root);
    }).join("\n");
    assertEquals(served, { "/in": join(root, "in") });
    for (const [prefix, value] of [["/up", "../x"], ["/abs", dir]] as const) {
      const refusal = assertThrows(
        () => assetMounts({ assets: { [prefix]: value } }, root),
        Error,
        "is outside the project",
      ).message;
      // The server's line holds the build's whole sentence (minus its mark).
      assertStringIncludes(said, refusal.slice(refusal.indexOf("deno.json")));
    }
    assertEquals(assetMounts({ assets: { "/in": "./in" } }, root), [
      { prefix: "/in", rel: "in" },
    ]);
    // `aio.run({ assets })` may point anywhere, as before: its value is kept.
    const run = { "/up": join(dir, "x") };
    captureConsole(() => {
      served = _servedAssets(run, root);
    });
    assertEquals(served, { "/up": join(dir, "x"), "/in": join(root, "in") });
  } finally {
    await dropTempDir(dir);
  }
});

// Served where it answered 404 before — so the boot SAYS so, once, dev and
// prod alike; an exposed app with no key and no auth is warned.
Deno.test("assets: the mounts deno.json alone declares are named at boot — a warning when the app is exposed with no key and no auth", () => {
  const served = { "/media": "/app/media", "/both": "/app/b", "/run": "/r" };
  const run = { "/both": "/app/b", "/run": "/r" };
  assertEquals(_denoJsonMountsNote(run, served, false), {
    level: "info",
    text: "serving deno.json mount(s) /media → /app/media",
  });
  const open = _denoJsonMountsNote(undefined, served, true);
  assertEquals(open?.level, "warn");
  assert(
    open!.text.startsWith(
      "serving deno.json mount(s) /media → /app/media, /both → /app/b, " +
        "/run → /r — exposed with no key and no auth",
    ),
    open!.text,
  );
  // Nothing from deno.json alone: no line.
  assertEquals(_denoJsonMountsNote(run, run, true), null);
  assertEquals(_denoJsonMountsNote(undefined, undefined, true), null);
});

Deno.test("assets: a real boot writes the deno.json-mount line to the app's log; an aio.run mount writes none", async () => {
  const said = async (where: "deno" | "run", open: boolean) => {
    const { aio, cell } = await import("../mod.ts");
    const dir = await tempDir("assets-line-");
    try {
      await Deno.mkdir(join(dir, "media"));
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify(
          where === "deno" ? { assets: { "/media": "./media" } } : {},
        ),
      );
      const app = await aio.run({
        cells: [cell(`c_assets_line_${where}_${open}`, { state: { n: 0 } })],
        appId: `test-assets-line-${where}-${open}-${Deno.pid}`,
        client: "server-only",
        persist: false,
        libraryMode: true,
        port: freePort(),
        appDir: join(dir, "home"),
        ...(where === "run"
          ? { assets: { "/media": join(dir, "media") } }
          : {}),
        ...(open ? { expose: true, key: false, tls: false } : {}),
        watch: false,
        baseDir: join(dir, "src-none"),
      });
      await app.close();
      // The line as each log file holds it (text and JSON sinks): the most
      // any ONE file says is what a reader of that file sees.
      let lines: string[] = [];
      for await (const f of walk(join(dir, "home"), { includeDirs: false })) {
        const own = (await Deno.readTextFile(f.path)).split("\n").filter((l) =>
          l.includes("serving deno.json mount(s)")
        );
        if (own.length > lines.length) lines = own;
      }
      return lines;
    } finally {
      await dropTempDir(dir);
    }
  };
  const loopback = await said("deno", false);
  assertEquals(loopback.length, 1, loopback.join("\n"));
  const line = loopback[0] ?? "";
  assert(/INFO\s+assets\s/.test(line), line);
  assert(line.includes("/media → "), line);
  const open = await said("deno", true);
  assertEquals(open.length, 1, open.join("\n"));
  const warned = open[0] ?? "";
  assert(/WARN\s+assets\s/.test(warned), warned);
  assert(warned.includes("exposed with no key and no auth"), warned);
  assertEquals(await said("run", true), []);
});
