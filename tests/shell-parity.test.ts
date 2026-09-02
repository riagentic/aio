// WYSIDIWYSIP — What You See In Dev Is What You See In Prod.
//
// The gate for the bug class behind the "white border" field report: an app's
// prod build looked different from `deno task dev` because dev and prod
// resolved a VISUAL input (shell markup, stylesheet, viewport, app dir)
// through two different deciders. Dev==prod is a load-bearing convention
// (CLAUDE.md, .katana/core.md): a dev/prod difference may only be observe-only
// tooling or dev-stricter checks — never markup, styles, or asset resolution.
//
// Pins, one per past divergence:
//   1. dev shell vs prod shell — identical outside <script> blocks, and every
//      dev-only script is on an explicit allowlist (observe-only / dev-strict).
//   2. electron aio:// shell === server prod shell (alpha41 unification —
//      a hand-rolled copy once dropped every ui.head input).
//   3. android local shell head === server prod shell head (its hand-rolled
//      copy shipped a DIFFERENT default viewport — no viewport-fit=cover).
//   4. the app-dir decider — the build resolves the app dir with the same
//      rule the dev server uses (the entry's directory), for every layout.

import { assert, assertEquals } from "@std/assert";
import { dirname, join, resolve } from "@std/path";
import {
  androidLocalHTML,
  generateHTML,
} from "../src/server/server-html-gen.ts";
import { udsProdHTML } from "../src/electron/electron-shared.ts";
import { appImportSpecifier } from "../src/build/build-bundle.ts";
import { resolveAppDir } from "../src/build/build-config.ts";

/** Strip every <script …>…</script> block — what remains is the VISUAL shell
 *  (markup, head metas, css links) and must be byte-identical dev vs prod. */
function visualShell(html: string): string {
  return html.replace(/[ \t]*<script\b[\s\S]*?<\/script>\n?/g, "");
}

function headOf(html: string): string {
  const m = html.match(/<head>([\s\S]*?)<\/head>/);
  assert(m, "shell has a <head>");
  return m![1]!;
}

/** Every dev-only <script> must match one of these — each is (a) observe-only
 *  or (b) dev-stricter, per the dev==prod rule. Adding a dev script that
 *  changes VISUALS or BEHAVIOR must fail here and be argued in review. */
const DEV_ONLY_SCRIPT_ALLOWLIST: [RegExp, string][] = [
  [/window\.__aioDev=true/, "dev-strict flag (dev throws where prod degrades)"],
  [/type="importmap"/, "module resolution — no runtime behavior of its own"],
  [
    /blank-screen guard|_importRetry|aio-renderer/i,
    "dev boot script: live-transpiled mount + observe-only diagnostics " +
    "(prod mounts the same renderer from the bundle)",
  ],
];

const shellInputs = {
  title: "Parity App",
  hasCSS: true,
  showStatus: undefined,
  width: 1024,
  height: 768,
  viewport: undefined,
  head: '<meta name="description" content="x"><style>body{margin:0}</style>',
} as const;

function serverShell(prod: boolean): string {
  return generateHTML({
    title: shellInputs.title,
    prod: prod,
    hasCSS: shellInputs.hasCSS,
    importMap: "{}",
    showStatus: shellInputs.showStatus,
    width: shellInputs.width,
    height: shellInputs.height,
    uiEntry: "App.tsx",
    viewport: shellInputs.viewport,
    headExtra: shellInputs.head,
  });
}

Deno.test("WYSIDIWYSIP: dev and prod shells are visually identical", () => {
  const dev = serverShell(false);
  const prod = serverShell(true);
  assertEquals(
    visualShell(dev),
    visualShell(prod),
    "outside <script> blocks the dev and prod shells must be byte-identical — " +
      "a markup/style difference here IS a dev≠prod UI bug",
  );
  assertEquals(headOf(dev), headOf(prod), "same <head>, key for key");
});

Deno.test("WYSIDIWYSIP: every dev-only script is allowlisted observe-only/dev-strict", () => {
  const dev = serverShell(false);
  const prod = serverShell(true);
  const scriptsOf = (html: string) =>
    [...html.matchAll(/<script\b[\s\S]*?<\/script>/g)].map((m) => m[0]);
  const prodScripts = new Set(scriptsOf(prod));
  const devOnly = scriptsOf(dev).filter((s) => !prodScripts.has(s));
  assert(devOnly.length > 0, "dev shell has its dev-only scripts");
  for (const s of devOnly) {
    const hit = DEV_ONLY_SCRIPT_ALLOWLIST.find(([re]) => re.test(s));
    assert(
      hit,
      `dev-only <script> not on the allowlist — is it observe-only or ` +
        `dev-stricter? If yes, allowlist it WITH its justification. ` +
        `If it changes visuals/behavior, it violates dev==prod:\n${
          s.slice(0, 200)
        }`,
    );
  }
});

Deno.test("WYSIDIWYSIP: electron aio:// shell IS the server prod shell", () => {
  const viaElectron = udsProdHTML(shellInputs.title, shellInputs.hasCSS, {
    showStatus: shellInputs.showStatus,
    width: shellInputs.width,
    height: shellInputs.height,
    viewport: shellInputs.viewport,
    head: shellInputs.head,
  });
  const viaServer = generateHTML({
    title: shellInputs.title,
    prod: true,
    hasCSS: shellInputs.hasCSS,
    importMap: "",
    showStatus: shellInputs.showStatus,
    width: shellInputs.width,
    height: shellInputs.height,
    viewport: shellInputs.viewport,
    headExtra: shellInputs.head,
  });
  assertEquals(
    viaElectron,
    viaServer,
    "udsProdHTML must DELEGATE to generateHTML — a second prod shell is the " +
      "bug class (the pre-alpha41 copy dropped every ui.head input)",
  );
});

Deno.test("WYSIDIWYSIP: android local shell head matches the prod shell head", () => {
  const android = androidLocalHTML("A", true);
  const server = generateHTML({
    title: "A",
    prod: true,
    hasCSS: true,
    importMap: "",
  });
  // Only sanctioned differences: relative asset base (android_asset has no
  // server root), the window-box metas (the OS sizes a phone window), the
  // favicon link — `/__aio/icon` is served by a SERVER (or the aio://
  // protocol handler), which the asset shell does not have, and a WebView has
  // no tab to show a favicon in anyway; emitting it there was a guaranteed
  // dead request in every console (alpha61) — and the DISABLED theme sheet,
  // which is how `ui.theme` reaches a shell written before `aio.run()` exists:
  // it carries `media="not all"`, so it applies nothing until the standalone
  // runtime enables it from the config (see `_applyShellUi`). Carrying it is
  // what makes dev and the APK agree for an app that opted in; it is inert
  // for every app that did not.
  const norm = (h: string) =>
    h
      .replace('href="./style.css"', 'href="/style.css"')
      .replace(/\n\s*<meta name="aio:(width|height)"[^>]*>/g, "")
      .replace(/\n\s*<link rel="icon"[^>]*>/g, "")
      .replace(
        /\n\s*<style media="not all" data-aio-theme-deferred>[\s\S]*?<\/style>/g,
        "",
      );
  assertEquals(
    norm(headOf(android)),
    norm(headOf(server)),
    "android's hand-rolled head once shipped a different default viewport — " +
      "the head must come from the ONE head builder",
  );
  // The regression that motivated this: the responsive default viewport.
  assert(
    android.includes("viewport-fit=cover"),
    "android shell carries the same default viewport as every other target",
  );
});

Deno.test("WYSIDIWYSIP: the build's app-dir decider is the entry's directory (dev server rule)", () => {
  // The dev server resolves the app dir as the MAIN MODULE'S DIRECTORY
  // (aio.ts _inferBaseDir). The build must apply the same rule to deno.json's
  // "entry" — one decider — or a stylesheet/App.tsx that dev serves silently
  // vanishes from the prod artifact (the "white border" report).
  for (
    const [entry, wantAppDir, wantImport] of [
      ["src/app.ts", "/proj/src", "./src/App.tsx"],
      ["app.ts", "/proj", "./App.tsx"], // flat app — examples/counter layout
      ["apps/web/main.ts", "/proj/apps/web", "./apps/web/App.tsx"],
    ] as const
  ) {
    // THE decider itself, imported — not a re-derivation of its rule (a copy
    // here would stay green if resolveAppDir changed: a second decider inside
    // the anti-second-decider gate).
    const appDir = resolveAppDir("/proj", entry);
    assertEquals(appDir, resolve(wantAppDir), `appDir for entry=${entry}`);
    assertEquals(
      appImportSpecifier("/proj", appDir),
      wantImport,
      `bundle App import for entry=${entry}`,
    );
    // The asset copy reads the SAME dir — pinned by construction in
    // build-bundle.ts (styleSrc/iconSrc = join(appDir, …)); this loop pins
    // the dir they all share.
    assert(join(appDir, "style.css").startsWith(appDir));
  }
});
