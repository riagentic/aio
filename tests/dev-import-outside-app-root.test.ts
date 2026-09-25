/**
 * Dev serves a relative import that leaves the app root, the way the bundler
 * does (field report: a two-edition app, entry `src/pro/app.ts`).
 *
 * The app root is `dirname(entry)` = `src/pro/`, served at `/`. Its `App.tsx`
 * imports `../ui/Shell.tsx`, which the BROWSER resolves against `/App.tsx` —
 * and a URL cannot go above `/`, so it clamps to `/ui/Shell.tsx` =
 * `src/pro/ui/Shell.tsx`, which does not exist. The page died with
 * "Failed to fetch dynamically imported module", while the production bundle
 * (esbuild follows the file path) was fine: dev != prod.
 *
 * The contract: the dev server rewrites such an import to the file's one
 * canonical URL, serves exactly the files the served modules import (the
 * bundler's graph, not the project directory), with every guard the app root
 * has — and never in prod.
 */
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createStaticHandler,
  devModuleUrl,
  isProtectedPath,
  type StaticDeps,
} from "../src/server/server-static.ts";
import { stopEsbuild } from "../src/server/server-transpile.ts";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";

function deps(over: Partial<StaticDeps>): StaticDeps {
  return {
    prod: false,
    debug: () => {},
    title: "T",
    absBaseDir: "/tmp",
    absDistDir: null,
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => null,
    getVitalsExtra: () => ({ payloadStats: new Map(), clientBackpressure: {} }),
    getTrojanDeps: () => ({}),
    ...over,
  };
}

/** `src/pro/` is the app; `src/ui/` is shared UI beside it. */
async function twoEditionProject(): Promise<string> {
  const p = await tempDir("aio-outside-root-");
  await Deno.mkdir(join(p, "src", "pro"), { recursive: true });
  await Deno.mkdir(join(p, "src", "ui"), { recursive: true });
  await Deno.writeTextFile(
    join(p, "deno.json"),
    JSON.stringify({ title: "Notes", entry: "src/pro/app.ts" }),
  );
  await Deno.writeTextFile(join(p, "src", "pro", "app.ts"), "");
  await Deno.writeTextFile(
    join(p, "src", "pro", "App.tsx"),
    `import { Shell } from "../ui/Shell.tsx";\n` +
      `import { local } from "./local.ts";\n` +
      `export default function App() { return <Shell>{local}</Shell>; }\n`,
  );
  await Deno.writeTextFile(
    join(p, "src", "pro", "local.ts"),
    `export const local = "LOCAL";\n`,
  );
  // The shared module imports BACK into the app root and sideways.
  await Deno.writeTextFile(
    join(p, "src", "ui", "Shell.tsx"),
    `import { local } from "../pro/local.ts";\n` +
      `import { Button } from "./Button.tsx";\n` +
      `export function Shell(p: { children?: unknown }) {\n` +
      `  return <div>SHELL_OK {local}<Button/>{p.children}</div>;\n}\n`,
  );
  await Deno.writeTextFile(
    join(p, "src", "ui", "Button.tsx"),
    `export function Button() { return <button>BUTTON_OK</button>; }\n`,
  );
  await Deno.writeTextFile(
    join(p, "src", "ui", "Unused.tsx"),
    `export const u = "UNUSED";\n`,
  );
  return p;
}

/** Every relative/absolute import specifier in served JS, resolved the way a
 *  browser resolves it against the module's own URL. */
function importsOf(code: string, url: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
    const spec = m[1]!;
    if (spec.startsWith(".") || spec.startsWith("/")) {
      out.push(new URL(spec, `http://h${url}`).pathname);
    }
  }
  return out;
}

Deno.test("dev import outside the app root: ../ui/Shell.tsx from src/pro/App.tsx loads in dev like the bundle", async () => {
  const p = await twoEditionProject();
  try {
    const { serveStatic } = createStaticHandler(
      deps({ absBaseDir: join(p, "src", "pro") }),
    );
    const app = await serveStatic("/App.tsx");
    assertEquals(app.status, 200);
    const appUrls = importsOf(await app.text(), "/App.tsx");
    // The in-root import is untouched (same URL as ever).
    assert(appUrls.includes("/local.ts"), appUrls.join(", "));
    const shellUrl = appUrls.find((u) => u.endsWith("/Shell.tsx"));
    assert(shellUrl, `no Shell import in ${appUrls.join(", ")}`);
    const shell = await serveStatic(shellUrl);
    assertEquals(shell.status, 200, `GET ${shellUrl}`);
    const shellCode = await shell.text();
    assertStringIncludes(shellCode, "SHELL_OK");

    // The shared module's own imports: back into the app root resolves to the
    // module's ONE url (never a second copy, which would be a second module
    // instance), and a sibling in the shared tree loads too.
    const shellUrls = importsOf(shellCode, shellUrl);
    assert(shellUrls.includes("/local.ts"), shellUrls.join(", "));
    const button = shellUrls.find((u) => u.endsWith("/Button.tsx"));
    assert(button, shellUrls.join(", "));
    const b = await serveStatic(button);
    assertEquals(b.status, 200, `GET ${button}`);
    assertStringIncludes(await b.text(), "BUTTON_OK");
  } finally {
    // The transpile started esbuild's service child; it must not outlive the
    // test (the leak sanitizer fails whichever test started it).
    await stopEsbuild();
    await dropTempDir(p);
  }
});

Deno.test("dev import outside the app root: only the imported graph is served, with the app root's guards, and never in prod", async () => {
  const p = await twoEditionProject();
  try {
    await Deno.writeTextFile(join(p, "src", "ui", "k.server.ts"), "SECRET");
    await Deno.writeTextFile(join(p, ".env"), "SECRET=1");
    const { serveStatic } = createStaticHandler(
      deps({ absBaseDir: join(p, "src", "pro") }),
    );
    const app = await serveStatic("/App.tsx");
    const shellUrl = importsOf(await app.text(), "/App.tsx").find((u) =>
      u.endsWith("/Shell.tsx")
    )!;
    const prefix = shellUrl.slice(0, shellUrl.indexOf("/src/ui/"));
    assert(prefix.startsWith("/__aio"), `framework namespace: ${shellUrl}`);

    const status = async (url: string) => {
      const r = await serveStatic(url);
      await r.body?.cancel();
      return r.status;
    };
    // Not imported by any served module → not served (the project directory
    // is not an HTTP root; the bundler's graph is).
    assertEquals(await status(`${prefix}/src/ui/Unused.tsx`), 404);
    assertEquals(await status(`${prefix}/deno.json`), 404);
    assertEquals(await status(`${prefix}/.env`), 404);
    assertEquals(await status(`${prefix}/src/ui/k.server.ts`), 404);
    assert(
      [403, 404].includes(await status(`${prefix}/../../etc/passwd`)),
      "traversal",
    );

    // Prod serves the bundle; the source tree is not mounted at all.
    const prod = createStaticHandler(
      deps({ absBaseDir: join(p, "src", "pro"), prod: true }),
    );
    const r = await prod.serveStatic(shellUrl);
    assert(r.status !== 200, `prod served ${shellUrl}: ${r.status}`);
    await r.body?.cancel();
  } finally {
    // The transpile started esbuild's service child; it must not outlive the
    // test (the leak sanitizer fails whichever test started it).
    await stopEsbuild();
    await dropTempDir(p);
  }
});

Deno.test("dev import outside the app root: a file outside every root and the source tree has no dev url", () => {
  const src = "/p";
  const base = "/p/src/pro";
  // Inside the source tree: one url under the source prefix.
  assertEquals(
    devModuleUrl("/p/src/ui/Shell.tsx", base, [], src),
    "/__aio-src/src/ui/Shell.tsx",
  );
  // Outside it (a sibling of the project, or anywhere on disk): no url, so
  // the dev server never rewrites to it and smoke() names the file instead.
  assertEquals(devModuleUrl("/other/x.ts", base, [], src), null);
  assertEquals(devModuleUrl("/pother/x.ts", base, [], src), null);
  assertEquals(devModuleUrl("/other/x.ts", base, [], null), null);
});

Deno.test("dev import outside the app root: a .js/.mjs module outside the app root has its own relative imports rewritten and served", async () => {
  const p = await twoEditionProject();
  try {
    await Deno.mkdir(join(p, "src", "lib"), { recursive: true });
    await Deno.writeTextFile(
      join(p, "src", "pro", "App.tsx"),
      `import { util } from "../lib/util.js";\nexport default () => util;\n`,
    );
    // Plain JS is served as a module too — its relative imports must reach
    // the same files the bundler loads: a sibling `.mjs`, and one back in the
    // app root (its ONE url, never a second module instance).
    await Deno.writeTextFile(
      join(p, "src", "lib", "util.js"),
      `import { dep } from "./dep.mjs";\n` +
        `import { local } from "../pro/local.ts";\n` +
        `export const util = dep + local;\n`,
    );
    await Deno.writeTextFile(
      join(p, "src", "lib", "dep.mjs"),
      `import { local } from "../pro/local.ts";\nexport const dep = "DEP_OK" + local;\n`,
    );
    const { serveStatic } = createStaticHandler(
      deps({ absBaseDir: join(p, "src", "pro") }),
    );
    const app = await serveStatic("/App.tsx");
    const utilUrl = importsOf(await app.text(), "/App.tsx").find((u) =>
      u.endsWith("/util.js")
    );
    assert(utilUrl, "App.tsx imports util.js");
    const util = await serveStatic(utilUrl);
    assertEquals(util.status, 200, `GET ${utilUrl}`);
    assertStringIncludes(util.headers.get("content-type") ?? "", "javascript");
    const utilUrls = importsOf(await util.text(), utilUrl);
    assert(utilUrls.includes("/local.ts"), utilUrls.join(", "));
    const depUrl = utilUrls.find((u) => u.endsWith("/dep.mjs"));
    assert(depUrl, utilUrls.join(", "));
    const dep = await serveStatic(depUrl);
    assertEquals(dep.status, 200, `GET ${depUrl}`);
    const depCode = await dep.text();
    assertStringIncludes(depCode, "DEP_OK");
    assert(
      importsOf(depCode, depUrl).includes("/local.ts"),
      `dep.mjs's import of ../pro/local.ts must reach its one url: ${depCode}`,
    );
  } finally {
    await stopEsbuild();
    await dropTempDir(p);
  }
});

Deno.test("dev import outside the app root: a .jsx module is transpiled in dev like the bundle", async () => {
  const p = await twoEditionProject();
  try {
    await Deno.writeTextFile(
      join(p, "src", "pro", "App.tsx"),
      `import { Card } from "../ui/Card.jsx";\nexport default () => <Card/>;\n`,
    );
    await Deno.writeTextFile(
      join(p, "src", "ui", "Card.jsx"),
      `import { Button } from "./Button.tsx";\n` +
        `export function Card() { return <section>CARD_OK<Button/></section>; }\n`,
    );
    const { serveStatic } = createStaticHandler(
      deps({ absBaseDir: join(p, "src", "pro") }),
    );
    const app = await serveStatic("/App.tsx");
    const cardUrl = importsOf(await app.text(), "/App.tsx").find((u) =>
      u.endsWith("/Card.jsx")
    );
    assert(cardUrl, "App.tsx imports Card.jsx");
    const card = await serveStatic(cardUrl);
    assertEquals(card.status, 200, `GET ${cardUrl}`);
    // A browser refuses a module served as anything but JavaScript, and
    // cannot parse JSX: the bundler compiles `.jsx`, so dev must too.
    assertStringIncludes(card.headers.get("content-type") ?? "", "javascript");
    const code = await card.text();
    assertStringIncludes(code, "CARD_OK");
    assert(!code.includes("<section>"), `JSX left uncompiled:\n${code}`);
    const btn = importsOf(code, cardUrl).find((u) => u.endsWith("/Button.tsx"));
    assert(btn, code);
    const b = await serveStatic(btn);
    assertEquals(b.status, 200, `GET ${btn}`);
    await b.body?.cancel();
  } finally {
    await stopEsbuild();
    await dropTempDir(p);
  }
});

Deno.test("dev import outside the app root: editing a served ../ui/Shell.tsx live-reloads like an app-root edit", async () => {
  const p = await twoEditionProject();
  const port = freePort();
  const reloads: string[] = [];
  const server = createServer(
    {
      port,
      title: "outside-root-reload",
      appId: "outside-root-reload",
      getUIState: () => ({}),
      dispatch: () => {},
      baseDir: join(p, "src", "pro"),
      debug: () => {},
      prod: false,
      onReload: (s: string) => reloads.push(s),
    } as unknown as Parameters<typeof createServer>[0],
  );
  const until = async (what: string, ok: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  try {
    // The page loads App.tsx, which is what puts ../ui/Shell.tsx in the
    // served graph.
    const app = await fetch(`http://127.0.0.1:${port}/App.tsx`);
    const shellUrl = importsOf(await app.text(), "/App.tsx").find((u) =>
      u.endsWith("/Shell.tsx")
    )!;
    const shell = await fetch(`http://127.0.0.1:${port}${shellUrl}`);
    assertEquals(shell.status, 200);
    await shell.body?.cancel();

    // Control: an app-root edit reloads (the watcher is live).
    await Deno.writeTextFile(
      join(p, "src", "pro", "local.ts"),
      `export const local = "LOCAL2";\n`,
    );
    await until("app-root edit reloads", () => reloads.length > 0);
    await new Promise((r) => setTimeout(r, 700)); // past the debounce ceiling
    reloads.length = 0;

    // The served shared module: the page imports it, so an edit to it is an
    // edit to the page — a silent no-op here is a stale dev page.
    await Deno.writeTextFile(
      join(p, "src", "ui", "Shell.tsx"),
      `export function Shell() { return <div>SHELL_V2</div>; }\n`,
    );
    await until(
      "../ui/Shell.tsx edit reloads",
      () => reloads.includes("reload"),
    );
    // …and the next request serves the edit, not a cached transpile.
    const again = await fetch(`http://127.0.0.1:${port}${shellUrl}`);
    assertStringIncludes(await again.text(), "SHELL_V2");
  } finally {
    await server.shutdown();
    await stopEsbuild();
    await dropTempDir(p);
  }
});

Deno.test("dev import outside the app root: .jsx is source — compiled in dev, refused by a production server like .tsx", () => {
  assertEquals(isProtectedPath("/ui/Card.jsx", true), true);
  assertEquals(isProtectedPath("/ui/Card.JSX", true), true);
  assertEquals(isProtectedPath("/ui/Card.tsx", true), true);
  assertEquals(isProtectedPath("/ui/Card.jsx", false), false);
  // Plain JS is a shipped asset, not source.
  assertEquals(isProtectedPath("/vendor/lib.js", true), false);
});
