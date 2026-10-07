// deno.json `build.guestPreloads` — the `<webview>` guest preload files an
// app ships. From a field report: a guest preload worked in dev and was
// dropped by every packaged build, in silence. Pinned here: the path rule,
// the name → file resolution the window runs (the generated fragment, with
// real node fs/path), the build's staging and its source check. The real
// packaged window is tests/electron-guest-preload-artifact-e2e.test.ts.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as nodeUrl from "node:url";
import {
  GUEST_PRELOAD_REFUSED_EVENT,
  GUEST_PRELOAD_URL,
  guestPreload,
  guestPreloadRefusal,
} from "../src/protocol/guest-preload.ts";
import {
  declaredGuestPreloads,
  GUEST_PRELOADS_DIR,
  resolveGuestPreloads,
  stagedGuestPreloadDirs,
} from "../src/server/guest-preloads.ts";
import {
  appSources,
  checkedGuestPreloads,
  guestPreloadFindings,
  stageGuestPreloads,
} from "../src/build/guest-preloads.ts";
import {
  tmplGuestPreloads,
  tmplWillNavigate,
} from "../src/electron/electron-shared.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { keepInDistStaging } from "../src/build/dist-staging.ts";
import { assembleMacApp } from "../src/build/macos-app.ts";
import { Browser } from "../src/ui/browser.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { linkFile } from "./symlink-helper.ts";

const BAD = [
  "",
  "/abs/preload.cjs",
  "../preload.cjs",
  "src/../../preload.cjs",
  "src/./preload.cjs",
  "src//preload.cjs",
  "src/preload.cjs/",
  "src\\preload.cjs",
  "C:/preload.cjs",
  "src/my preload.cjs",
  "src/%2e%2e/preload.cjs",
  "src/preload.cjs?x",
  "src/preload.cjs#x",
  "src/\u0000.cjs",
  5,
  null,
  ["src/preload.cjs"],
];

Deno.test("guest preload path rule: plain relative paths only", () => {
  for (const ok of ["preload.cjs", "src/guest/preload.cjs", "a-b/c_d/e.f.js"]) {
    assertEquals(guestPreloadRefusal(ok), null, ok);
    assertEquals(guestPreload(ok), GUEST_PRELOAD_URL + ok);
    // The name survives the URL parser unchanged — what Electron's renderer
    // does to a `<webview preload>` before the main process sees it.
    assertEquals(new URL(guestPreload(ok)).href, GUEST_PRELOAD_URL + ok);
  }
  for (const bad of BAD) {
    assert(guestPreloadRefusal(bad) !== null, JSON.stringify(bad));
    assertThrows(() => guestPreload(bad as string), TypeError);
    assertThrows(
      () => declaredGuestPreloads({ build: { guestPreloads: [bad] } }),
      Error,
      "build.guestPreloads",
    );
  }
});

Deno.test("guest preload path rule: no accepted path leaves its directory (property)", () => {
  const alphabet = ["a", "b.cjs", ".", "..", "", "/", "\\", "%2e", " ", "C:"];
  let seed = 20261006;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (const sep of [nodePath.posix, nodePath.win32]) {
    for (let i = 0; i < 5000; i++) {
      const n = 1 + Math.floor(rnd() * 6);
      const p = Array.from(
        { length: n },
        () => alphabet[Math.floor(rnd() * alphabet.length)]!,
      ).join(rnd() < 0.8 ? "/" : "");
      if (guestPreloadRefusal(p) !== null) continue;
      const r = sep === nodePath.posix ? "/root/dir" : "C:\\root\\dir";
      const full = sep.resolve(r, ...p.split("/"));
      assert(full.startsWith(r + sep.sep), `${p} → ${full}`);
    }
  }
});

Deno.test("build.guestPreloads: the declaration is read, deduplicated, and refused by name", () => {
  assertEquals(declaredGuestPreloads(undefined), []);
  assertEquals(declaredGuestPreloads({ build: {} }), []);
  assertEquals(
    declaredGuestPreloads({ build: { guestPreloads: ["a.cjs", "a.cjs"] } }),
    ["a.cjs"],
  );
  assertThrows(
    () => declaredGuestPreloads({ build: { guestPreloads: "a.cjs" } }),
    Error,
    "must be a list",
  );
  assertThrows(
    () => declaredGuestPreloads({ build: { guestPreloads: ["../a.cjs"] } }),
    Error,
    '"../a.cjs"',
  );
});

type Handler = (...a: unknown[]) => unknown;

/** Run the generated resolver + `will-attach-webview` hook with real node
 *  fs/path, as the shell does. */
function hook(g: { dir: string; files: string[] } | undefined, base = "") {
  const handlers: Record<string, Handler> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  const scripts: string[] = [];
  new Function(
    "win",
    "fs",
    "path",
    "console",
    "BASE_DIR",
    "_appOrigin",
    "require",
    tmplGuestPreloads(g) + "\n" + tmplWillNavigate("_appOrigin"),
  )(
    {
      webContents: {
        on(ev: string, fn: Handler) {
          handlers[ev] = fn;
        },
        setWindowOpenHandler() {},
        executeJavaScript(js: string) {
          scripts.push(js);
          return Promise.resolve();
        },
      },
    },
    nodeFs,
    nodePath,
    {
      warn: (m: unknown) => warnings.push(String(m)),
      error: (m: unknown) => errors.push(String(m)),
      log() {},
    },
    base,
    "aio://app",
    (m: string) => m === "url" ? nodeUrl : { shell: { openExternal() {} } },
  );
  return {
    errors,
    // Only the preload refusals: the hook says other things about a guest.
    refused: () => warnings.filter((w) => w.includes("preload REFUSED")),
    scripts,
    attach(preload: string) {
      const wp: Record<string, unknown> = {};
      const params: Record<string, unknown> = { preload };
      handlers["will-attach-webview"]!(null, wp, params);
      return { wp, params };
    },
  };
}

Deno.test("guest preload hook: a declared name resolves to the staged file; nothing else does", async (t) => {
  const dir = join(await tempDir("aio-guest-preload-"), "My App");
  await Deno.mkdir(join(dir, "src", "guest"), { recursive: true });
  await Deno.writeTextFile(join(dir, "src", "guest", "preload.cjs"), "");
  await Deno.writeTextFile(join(dir, "src", "guest", "other.cjs"), "");
  const outside = join(await tempDir("aio-guest-outside-"), "secret.cjs");
  await Deno.writeTextFile(outside, "");
  const files = ["src/guest/preload.cjs", "src/guest/missing.cjs"];

  await t.step("declared → the real file, no refusal", () => {
    const h = hook({ dir, files });
    const { wp } = h.attach(guestPreload("src/guest/preload.cjs"));
    assertEquals(
      wp.preload,
      nodeFs.realpathSync(join(dir, "src", "guest", "preload.cjs")),
    );
    assertEquals([h.errors, h.refused(), h.scripts], [[], [], []]);
  });

  await t.step(
    "undeclared (though it exists) → refused, named, with the fix, and the page is told",
    () => {
      const h = hook({ dir, files });
      const name = guestPreload("src/guest/other.cjs");
      const { wp, params } = h.attach(name);
      assertEquals([wp.preload, params.preload], [undefined, undefined]);
      assertEquals(h.refused().length, 1);
      assertStringIncludes(h.refused()[0]!, "preload REFUSED");
      assertStringIncludes(h.refused()[0]!, "src/guest/other.cjs");
      assertStringIncludes(h.refused()[0]!, "not a declared guest preload");
      assertStringIncludes(h.refused()[0]!, "build");
      // The fix names the REFUSED file, added to what is declared — it used
      // to show the example list, which here is the list the app already has.
      assertStringIncludes(
        h.refused()[0]!,
        `"guestPreloads": ${
          JSON.stringify([...files, "src/guest/other.cjs"])
        } } and name it in the page with guestPreload("src/guest/other.cjs")`,
      );
      // The page's event: valid JS that dispatches the named event.
      assertEquals(h.scripts.length, 1);
      const got: {
        type: string;
        detail: { preload: string; reason: string };
      }[] = [];
      new Function("window", "CustomEvent", h.scripts[0]!)(
        { dispatchEvent: (e: typeof got[0]) => got.push(e) },
        class {
          constructor(public type: string, public init: { detail: unknown }) {}
          get detail() {
            return this.init.detail;
          }
        },
      );
      assertEquals(got[0]!.type, GUEST_PRELOAD_REFUSED_EVENT);
      assertEquals(got[0]!.detail.preload, name);
      assertStringIncludes(got[0]!.detail.reason, "not a declared");
    },
  );

  await t.step("declared but missing → refused with the reason", () => {
    const h = hook({ dir, files });
    const { wp } = h.attach(guestPreload("src/guest/missing.cjs"));
    assertEquals(wp.preload, undefined);
    assertStringIncludes(h.refused()[0]!, "could not be read");
  });

  await t.step(
    "a traversal in the name never resolves — the name must BE a declared path",
    () => {
      for (
        const evil of [
          "src/guest/../guest/preload.cjs",
          "../" + outside,
          "src/guest/preload.cjs/../../../x",
          "src%2Fguest%2Fpreload.cjs",
          "",
        ]
      ) {
        const h = hook({ dir, files });
        const { wp } = h.attach(GUEST_PRELOAD_URL + evil);
        assertEquals(wp.preload, undefined, evil);
        assertEquals(h.refused().length, 1, evil);
      }
    },
  );

  await t.step(
    "the fix quotes the page's text, and never offers a dot-path as a name",
    () => {
      // A quote and a newline: quoted (JSON), so the fix stays one line.
      const odd = 'src/guest/a"\nb.cjs';
      const h = hook({ dir, files });
      h.attach(GUEST_PRELOAD_URL + odd);
      const fix = h.refused()[0]!.split("Fix: ")[1]!;
      assert(!fix.includes("\n"), fix);
      assertStringIncludes(fix, `guestPreload(${JSON.stringify(odd)})`);
      assertStringIncludes(fix, JSON.stringify([...files, odd]));
      // `../x.cjs` is no name a declaration can hold: the example stands in.
      for (const dot of ["../x.cjs", "./src/guest/other.cjs"]) {
        const d = hook({ dir, files });
        d.attach(GUEST_PRELOAD_URL + dot);
        const said = d.refused()[0]!.split("Fix: ")[1]!;
        assertStringIncludes(said, 'guestPreload("src/guest/preload.cjs")');
        assert(!said.includes(dot), said);
      }
    },
  );

  await t.step(
    "a declared path that is a link out of the directory is refused",
    async () => {
      const link = join(dir, "src", "guest", "link.cjs");
      try {
        await linkFile(outside, link);
      } catch (e) {
        // A file symlink is a privilege a stock Windows account lacks.
        if (Deno.build.os === "windows") return;
        throw e;
      }
      const h = hook({ dir, files: [...files, "src/guest/link.cjs"] });
      const { wp } = h.attach(guestPreload("src/guest/link.cjs"));
      assertEquals(wp.preload, undefined);
      assertStringIncludes(h.refused()[0]!, "outside");
    },
  );

  await t.step(
    "nothing declared → every name is refused; a plain path keeps the old rule",
    () => {
      const h = hook(undefined, dir);
      assertEquals(
        h.attach(guestPreload("src/guest/preload.cjs")).wp.preload,
        undefined,
      );
      assertStringIncludes(h.refused()[0]!, "declared: none");
      // The path rule is untouched: a file inside the base dir is accepted,
      const inside = join(dir, "src", "guest", "preload.cjs");
      assertEquals(
        h.attach(nodeUrl.pathToFileURL(inside).href).wp.preload,
        nodeFs.realpathSync(inside),
      );
      // …one outside it is refused, and now says the fix.
      assertEquals(
        h.attach(nodeUrl.pathToFileURL(outside).href).wp.preload,
        undefined,
      );
      assertStringIncludes(h.refused()[1]!, "inside the app directory");
      assertStringIncludes(h.refused()[1]!, "guestPreload(");
    },
  );

  await t.step("the guest hardening is forced either way", () => {
    const h = hook({ dir, files });
    const { wp, params } = h.attach(guestPreload("src/guest/preload.cjs"));
    assertEquals(
      [wp.nodeIntegration, wp.contextIsolation, wp.webSecurity],
      [false, true, true],
    );
    assertEquals(params.nodeintegration, "off");
  });
});

Deno.test("guest preload hook: BOTH shells emit the resolver, with this run's files", () => {
  const meta = { guestPreloads: { dir: "/pkg/dist/gp", files: ["a/b.cjs"] } };
  for (
    const script of [
      electronMainScript("http://127.0.0.1:1/", meta),
      electronMainScriptUDS("aio://app/", "/tmp/s.sock", { meta }),
    ]
  ) {
    assertStringIncludes(script, "const __aioGuestPreload = ");
    assertStringIncludes(script, '{"dir":"/pkg/dist/gp","files":["a/b.cjs"]}');
    // Declared before the hook that asks it.
    assert(
      script.indexOf("const __aioGuestPreload = ") <
        script.indexOf("will-attach-webview"),
    );
    new Function(script); // parses
  }
});

Deno.test("build.guestPreloads: a declared file that does not exist fails by name", async () => {
  const root = await tempDir("aio-guest-check-");
  await Deno.mkdir(join(root, "src"));
  await Deno.writeTextFile(join(root, "src", "a.cjs"), "");
  const cfg = (l: unknown) => ({ build: { guestPreloads: l } });
  assertEquals(await checkedGuestPreloads(root, undefined), []);
  assertEquals(await checkedGuestPreloads(root, cfg(["src/a.cjs"])), [
    "src/a.cjs",
  ]);
  const e = await assertRejects(
    () => checkedGuestPreloads(root, cfg(["src/a.cjs", "src/gone.cjs"])),
    Error,
  );
  assertStringIncludes(e.message, '"src/gone.cjs"');
  assertStringIncludes(e.message, "build.guestPreloads");
  // A directory is not a preload.
  await assertRejects(() => checkedGuestPreloads(root, cfg(["src"])), Error);
});

Deno.test("build.guestPreloads: staging copies exactly the declared files, and the server lists them back", async () => {
  const root = await tempDir("aio-guest-stage-");
  const dist = join(await tempDir("aio-guest-pkg-"), "dist");
  await Deno.mkdir(join(root, "src", "guest"), { recursive: true });
  await Deno.writeTextFile(join(root, "src", "guest", "a.cjs"), "A");
  await Deno.writeTextFile(join(root, "src", "guest", "b.cjs"), "B");
  await Deno.writeTextFile(join(root, "top.js"), "T");
  await stageGuestPreloads(root, ["src/guest/a.cjs", "top.js"], dist);
  const staged = join(dist, GUEST_PRELOADS_DIR);
  assertEquals(
    await Deno.readTextFile(join(staged, "src", "guest", "a.cjs")),
    "A",
  );
  // What the packaged server hands the window: the staged dir, those files.
  assertEquals(
    await resolveGuestPreloads({ baseDir: root, staged: [staged] }),
    { dir: staged, files: ["src/guest/a.cjs", "top.js"] },
  );
  // A file LOST from the package after staging is still declared — the
  // staged record says so, where the listing alone would call it undeclared
  // (measured on a macOS bundle with one preload deleted: the refusal read
  // "is not a declared guest preload").
  await Deno.remove(join(staged, "top.js"));
  assertEquals(
    (await resolveGuestPreloads({ baseDir: root, staged: [staged] })).files,
    ["src/guest/a.cjs", "top.js"],
  );
  // A package from before the record existed, or one whose record is not a
  // list of valid paths: the files that are there, as it always was.
  for (const bad of [null, "{", '["../x.cjs"]', '"top.js"']) {
    const rec = join(staged, ".declared.json");
    if (bad === null) await Deno.remove(rec);
    else await Deno.writeTextFile(rec, bad);
    assertEquals(
      (await resolveGuestPreloads({ baseDir: root, staged: [staged] })).files,
      ["src/guest/a.cjs"],
      String(bad),
    );
  }
  // A re-stage with fewer files leaves no stale one behind.
  await stageGuestPreloads(root, ["top.js"], dist);
  assertEquals(
    (await resolveGuestPreloads({ baseDir: root, staged: [staged] })).files,
    ["top.js"],
  );
  // …and none declared leaves no directory at all.
  await stageGuestPreloads(root, [], dist);
  await assertRejects(() => Deno.stat(staged), Deno.errors.NotFound);
  // The directory is NOT a dist-staging survivor: it is written into the
  // package's own dist/, never into the project's.
  assertEquals(keepInDistStaging(GUEST_PRELOADS_DIR), false);
});

Deno.test("build.guestPreloads: dev resolves the declaration from the project's deno.json", async () => {
  const root = await tempDir("aio-guest-dev-");
  await Deno.mkdir(join(root, "src"));
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({ build: { guestPreloads: ["src/p.cjs"] } }),
  );
  // From the app dir (`<project>/src`), with no staged dir (or a missing one).
  for (const staged of [[], [join(root, "nope")]]) {
    assertEquals(
      await resolveGuestPreloads({ baseDir: join(root, "src"), staged }),
      { dir: root, files: ["src/p.cjs"] },
    );
  }
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({ build: { guestPreloads: ["../p.cjs"] } }),
  );
  await assertRejects(
    () => resolveGuestPreloads({ baseDir: join(root, "src") }),
    Error,
    "build.guestPreloads",
  );
});

// A package installed under somebody's project (`~/proj/tools/app/`, with
// `~/proj/deno.json` declaring ITS guest preloads) declared none of its own,
// so it has no staged directory — and must not go looking for a deno.json.
Deno.test("build.guestPreloads: a package with nothing staged has none — it never reads a deno.json above its install directory", async () => {
  const root = await tempDir("aio-guest-pkg-");
  const install = join(root, "tools", "app");
  await Deno.mkdir(install, { recursive: true });
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({ build: { guestPreloads: ["src/theirs.cjs"] } }),
  );
  for (
    const staged of [undefined, [], [join(install, "dist", "guest-preloads")]]
  ) {
    assertEquals(
      await resolveGuestPreloads({ baseDir: install, staged, packaged: true }),
      { dir: install, files: [] },
    );
  }
  // A deno.json that would THROW when read is not read either.
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({ build: { guestPreloads: ["../x.cjs"] } }),
  );
  assertEquals(
    (await resolveGuestPreloads({ baseDir: install, packaged: true })).files,
    [],
  );
  // What it DID stage is still what it has.
  const staged = join(install, "dist", "guest-preloads");
  await Deno.mkdir(staged, { recursive: true });
  await Deno.writeTextFile(join(staged, "mine.cjs"), "");
  assertEquals(
    await resolveGuestPreloads({
      baseDir: install,
      staged: [staged],
      packaged: true,
    }),
    { dir: staged, files: ["mine.cjs"] },
  );
  await dropTempDir(root);
});

Deno.test("build.guestPreloads: where a package keeps them, per OS", () => {
  const j = (a: string, ...p: string[]) => join(a, ...p);
  assertEquals(
    stagedGuestPreloadDirs({
      distDir: j("/app", "dist"),
      execDir: "/app",
      os: "linux",
    }),
    [j("/app", "dist", GUEST_PRELOADS_DIR)],
  );
  assertEquals(
    stagedGuestPreloadDirs({
      execDir: j("/A.app", "Contents", "MacOS"),
      os: "darwin",
    }),
    [j("/A.app", "Contents", "Resources", GUEST_PRELOADS_DIR)],
  );
  assertEquals(stagedGuestPreloadDirs({ execDir: "/app", os: "windows" }), []);
});

Deno.test("build.guestPreloads: the source check — certain mistakes refuse, a path literal warns, the rest is silent", async () => {
  const declared = ["src/guest/preload.cjs"];
  const f = (content: string, path = "App.tsx") =>
    guestPreloadFindings([{ path, content }], declared);
  const clean = { errors: [], warnings: [] };
  // Declared, computed, other tags, comments and strings: nothing to say.
  for (
    const ok of [
      `<webview src={u} preload={guestPreload("src/guest/preload.cjs")} />`,
      `<Browser src={u} preload={guestPreload('src/guest/preload.cjs')} />`,
      `<webview src={u} preload={somewhere} />`,
      `<webview src={u} preload={guestPreload(name)} />`,
      `<video preload="auto" src={u} />`,
      `<link rel="preload" href="/x.js" />`,
      `// guestPreload("src/nope.cjs")\nconst x = 1;`,
      `const s = 'guestPreload("src/nope.cjs")';`,
      `/* <webview preload="file:///x.cjs" /> */`,
    ]
  ) assertEquals(f(ok), clean, ok);

  const undeclared = f(
    `const a = 1;\nconst p = guestPreload("src/guest/other.cjs");`,
  );
  assertEquals(undeclared.errors.length, 1);
  assertStringIncludes(undeclared.errors[0]!, "App.tsx:2");
  assertStringIncludes(undeclared.errors[0]!, '"src/guest/other.cjs"');
  assertStringIncludes(undeclared.errors[0]!, "build");
  assertEquals(
    f(`<webview preload="${GUEST_PRELOAD_URL}src/x.cjs" />`).errors.length,
    1,
  );

  for (
    const byPath of [
      `<webview src={u} preload="file:///home/me/app/src/guest/preload.cjs" />`,
      `<webview src={u} preload={"file:///x/preload.cjs"} />`,
      "<Browser src={u} preload={`file://${cwd}/src/guest/preload.cjs`} />",
      `<webview\n  src={u}\n  preload='./preload.cjs'\n/>`,
    ]
  ) {
    const r = f(byPath);
    assertEquals(r.errors, [], byPath);
    assertEquals(r.warnings.length, 1, byPath);
    assertStringIncludes(r.warnings[0]!, "packaged build cannot load it");
    assertStringIncludes(
      r.warnings[0]!,
      'guestPreload("src/guest/preload.cjs")',
    );
  }

  // openWindow's preload has the same file rule: a literal path warns, an
  // undeclared name written out is certain; anything else is not judged.
  for (
    const ok of [
      `__aioIPC.openWindow(url, { preload: guestPreload("src/guest/preload.cjs") });`,
      `__aioIPC.openWindow(url, { preload: where, sandbox: true });`,
      `openWindow(url, { preload: "preload.cjs" });`, // somebody else's function
      `mine.openWindow(url, { preload: "preload.cjs" });`,
      `// __aioIPC.openWindow(url, { preload: "preload.cjs" })`,
      `__aioIPC.openWindow(url); const o = { preload: "auto" };`,
    ]
  ) assertEquals(f(ok, "app.ts"), clean, ok);
  for (
    const byPath of [
      `await __aioIPC.openWindow(url, { preload: "preload.cjs" });`,
      `window.__aioIPC?.openWindow("https://x.example/", {\n  sandbox: true,\n  preload: './src/guest/preload.cjs',\n});`,
    ]
  ) {
    const r = f(byPath, "app.ts");
    assertEquals(r.errors, [], byPath);
    assertEquals(r.warnings.length, 1, byPath);
    assertStringIncludes(r.warnings[0]!, "an openWindow preload named by path");
    assertStringIncludes(
      r.warnings[0]!,
      '{ preload: guestPreload("src/guest/preload.cjs") }',
    );
  }
  assertEquals(
    f(`__aioIPC.openWindow(u, { preload: "${GUEST_PRELOAD_URL}src/x.cjs" })`)
      .errors.length,
    1,
  );

  // The walker reads the app's own sources only.
  const app = await tempDir("aio-guest-src-");
  await Deno.mkdir(join(app, "node_modules", "x"), { recursive: true });
  await Deno.mkdir(join(app, "ui"));
  await Deno.writeTextFile(join(app, "node_modules", "x", "i.js"), "");
  await Deno.writeTextFile(join(app, "ui", "App.tsx"), "a");
  await Deno.writeTextFile(join(app, "notes.md"), "");
  assertEquals(await appSources(app), [{ path: "ui/App.tsx", content: "a" }]);
});

Deno.test("build.guestPreloads: the BUILD refuses a missing declared file and an undeclared guestPreload(), by name", async () => {
  const BUILD_ALL = fromFileUrl(
    new URL("../src/build-all.ts", import.meta.url),
  );
  const run = async (files: Record<string, string>) => {
    const dir = await tempDir("aio-guest-build-");
    try {
      for (const [rel, text] of Object.entries(files)) {
        await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
        await Deno.writeTextFile(join(dir, rel), text);
      }
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", BUILD_ALL, "--targets=browser"],
        cwd: dir,
        env: { NO_COLOR: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const dec = new TextDecoder();
      return {
        code: out.code,
        said: dec.decode(out.stderr) + dec.decode(out.stdout),
      };
    } finally {
      await dropTempDir(dir);
    }
  };
  const cfg = (l: string[]) =>
    JSON.stringify({ title: "gp", build: { guestPreloads: l } });
  const gone = await run({ "deno.json": cfg(["src/gone.cjs"]) });
  assertEquals(gone.code, 1, gone.said);
  assertStringIncludes(gone.said, 'build.guestPreloads: "src/gone.cjs"');
  const undeclared = await run({
    "deno.json": cfg(["src/a.cjs"]),
    "src/a.cjs": "",
    "src/App.tsx":
      `export default () => <webview preload={guestPreload("src/b.cjs")} />;`,
  });
  assertEquals(undeclared.code, 1, undeclared.said);
  assertStringIncludes(
    undeclared.said,
    'App.tsx:1: guestPreload("src/b.cjs") is not declared',
  );
});

Deno.test("build.guestPreloads: a macOS bundle carries them in Contents/Resources — where the run looks, and never in MacOS/", async () => {
  const dir = await tempDir("aio-guest-mac-");
  try {
    const bundle = async (declared: string[]) => {
      const staged = join(dir, "staged");
      await Deno.remove(staged, { recursive: true }).catch(() => {});
      const el = join(staged, "electron", "Electron.app", "Contents");
      for (const d of ["MacOS", "Resources", "Frameworks"]) {
        await Deno.mkdir(join(el, d), { recursive: true });
      }
      await Deno.writeTextFile(join(el, "Info.plist"), "<plist/>");
      await Deno.writeTextFile(join(el, "MacOS", "Electron"), "el-bin");
      await Deno.writeTextFile(join(staged, "counter"), "binary");
      await Deno.mkdir(join(dir, "src"), { recursive: true });
      await Deno.writeTextFile(join(dir, "src", "p.cjs"), "P");
      // Exactly what buildElectron does before it packages any OS.
      await stageGuestPreloads(dir, declared, join(staged, "dist"));
      return await assembleMacApp({
        stagedDir: staged,
        outDir: join(dir, "out"),
        name: "Counter",
        binaryName: "counter",
        identifier: "app.aio.counter",
        version: "1.0.0",
        iconIcns: new Uint8Array([1, 2, 3]),
      });
    };
    const app = await bundle(["src/p.cjs"]);
    // The directory the packaged server resolves on macOS, from its execPath.
    const [where] = stagedGuestPreloadDirs({
      execDir: join(app, "Contents", "MacOS"),
      os: "darwin",
    });
    assertEquals(where, join(app, "Contents", "Resources", GUEST_PRELOADS_DIR));
    assertEquals(
      await resolveGuestPreloads({ baseDir: dir, staged: [where!] }),
      { dir: where!, files: ["src/p.cjs"] },
    );
    assertEquals(await Deno.readTextFile(join(where!, "src", "p.cjs")), "P");
    // Code-only under codesign: nothing of dist/ may land beside the binary.
    await assertRejects(() =>
      Deno.stat(join(app, "Contents", "MacOS", "dist"))
    );
    // None declared → no directory in the bundle at all.
    const bare = await bundle([]);
    await assertRejects(
      () => Deno.stat(join(bare, "Contents", "Resources", GUEST_PRELOADS_DIR)),
      Deno.errors.NotFound,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("<Browser preload>: the attribute reaches the <webview>", () => {
  const name = guestPreload("src/guest/preload.cjs");
  const v = Browser({ src: "https://example.com/", preload: name });
  assertEquals((v.props as Record<string, unknown>).preload, name);
  const none = Browser({ src: "https://example.com/" });
  assert(!("preload" in (none.props as Record<string, unknown>)));
});

Deno.test("guest preload startup check: the shell names what it can attach, and refuses a declared file that is not there — once, at startup", async () => {
  const dir = await tempDir("aio-guest-startup-");
  try {
    await Deno.writeTextFile(join(dir, "a.cjs"), "");
    const run = (files: string[]) => {
      const said: string[] = [];
      new Function("fs", "path", "console", tmplGuestPreloads({ dir, files }))(
        nodeFs,
        nodePath,
        {
          warn: (m: unknown) => said.push("warn " + m),
          log: (m: unknown) => said.push("log " + m),
        },
      );
      return said;
    };
    assertEquals(run([]), [], "nothing declared, nothing said");
    assertEquals(run(["a.cjs"]), [
      `log [aio:electron] guest preloads present in ${dir}: a.cjs`,
    ]);
    // One missing: it is refused by name, and "present" names only what
    // this run can attach — build --smoke reads that line.
    const lost = run(["a.cjs", "gone.cjs"]);
    assertEquals(lost.length, 2);
    assertStringIncludes(
      lost[0]!,
      "warn [aio:electron] declared guest preload missing — REFUSED at startup: gone.cjs",
    );
    assertEquals(
      lost[1],
      `log [aio:electron] guest preloads present in ${dir}: a.cjs`,
    );
    assertEquals(run(["gone.cjs"]).length, 1, "none present: no such line");
  } finally {
    await dropTempDir(dir);
  }
});
