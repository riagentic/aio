// The `web` target — the standalone app as a static site (a PWA). A field
// report shipped one for iPhone by importing two aio internals (`bundleClient`
// with the Android switch, `androidLocalHTML`) and writing the manifest, the
// Apple tags and the service worker itself. These pin the pieces the target
// now owns; tests/build-e2e-web.test.ts builds one and runs it offline in a
// real browser from a foreign cwd.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  isArtifactName,
  placedName,
  targetForFlags,
  TARGETS,
} from "../src/build-all.ts";
import { crossCompileBlocker } from "../src/build/platforms.ts";
import {
  serviceWorker,
  webArtifactName,
  webHead,
  webIconProblem,
  webManifest,
} from "../src/build/build-web.ts";
import { makeEntryCode } from "../src/build/client-bundle.ts";
import { bundleFrameworkEntries } from "../src/build/esbuild-shared.ts";
import { androidRunOptionsWarning } from "../src/build/android-run-options.ts";
import { isStandalone } from "../src/build/build-config.ts";
import { androidLocalHTML } from "../src/server/server-html-gen.ts";

Deno.test("web target: in the fleet table, named by --web, a directory artifact", () => {
  assertEquals(TARGETS.web?.flags, ["--web"]);
  assertEquals(TARGETS.web?.role, "app");
  assertEquals(targetForFlags(["--web"]), "web");
  assertEquals(webArtifactName("notes"), "notes-web");
  assert(isArtifactName("notes-web", "notes"));
  assert(!isArtifactName("other-web", "notes"));
  assertEquals(
    placedName("notes-web", "web", new Set(), {
      version: "1.2.3",
      binaryName: "notes",
    }),
    "notes-1.2.3-web",
  );
  // Same files on every OS: built once, like the APK, never per platform.
  assertStringIncludes(crossCompileBlocker("web", "windows") ?? "", "once");
});

Deno.test("web target: the standalone switch is its own, and picks the standalone runtime", () => {
  assertEquals(
    bundleFrameworkEntries(true)["aio/air"],
    "src/standalone-air.ts",
  );
  assertEquals(bundleFrameworkEntries(false)["aio/air"], "src/browser-air.ts");
  // Auto-mounting classic script (the shell has no importer to call mount()).
  assertStringIncludes(makeEntryCode(true, "./App.tsx"), "function boot()");
  assertStringIncludes(
    makeEntryCode(false, "./App.tsx"),
    "export function mount",
  );
});

Deno.test("web target: isStandalone — a config built before `standalone` existed keeps its meaning", () => {
  // BuildConfig is `build(cfg)`'s public input: a hand-built one that says
  // only `doAndroid: true` must still get the APK's bundle, never a browser
  // one without a word.
  assertEquals(isStandalone({ doAndroid: true }), true);
  assertEquals(isStandalone({ doAndroid: false }), false);
  assertEquals(isStandalone({ doAndroid: false, doWeb: true }), true);
  assertEquals(isStandalone({ doAndroid: true, standalone: false }), false);
});

Deno.test("web target: the manifest comes from the app's identity", () => {
  const m = JSON.parse(
    webManifest("My Notes", "my-notes", [{
      src: "icon-192.png",
      sizes: "192x192",
    }]),
  );
  assertEquals(m.name, "My Notes");
  assertEquals(m.short_name, "My Notes");
  assertEquals(m.display, "standalone");
  assertEquals(m.start_url, "./");
  assertEquals(m.scope, "./");
  assertEquals(m.icons, [{
    src: "icon-192.png",
    sizes: "192x192",
    type: "image/png",
  }]);
  assert(/^#[0-9a-f]{6}$/.test(m.theme_color), m.theme_color);
  assert(/^#[0-9a-f]{6}$/.test(m.background_color), m.background_color);
  // One app, one colour: the hue is keyed on the id, not the title.
  assertEquals(
    JSON.parse(webManifest("Other Title", "my-notes", [])).theme_color,
    m.theme_color,
  );
});

Deno.test("web target: the head carries the Apple Home Screen tags and a loud service worker registration", () => {
  const h = webHead(`A <b>"x"`, "icon-192.png", "#123456");
  for (
    const tag of [
      `<link rel="manifest" href="./manifest.webmanifest">`,
      `<meta name="theme-color" content="#123456">`,
      `<link rel="apple-touch-icon" href="./icon-192.png">`,
      `<meta name="apple-mobile-web-app-capable" content="yes">`,
      `<meta name="apple-mobile-web-app-status-bar-style" content="default">`,
      `navigator.serviceWorker.register("./sw.js")`,
      `console.error(`,
    ]
  ) assertStringIncludes(h, tag);
  // The title is escaped — it cannot close the attribute or open a tag.
  assert(!h.includes(`<b>`), h);
  assert(!h.includes(`content="A <b>"x""`), h);
});

Deno.test("web target: the service worker is versioned by content, precaches every file, and parses", () => {
  const sw = serviceWorker("notes", "abc123", [
    "app.js",
    "index.html",
    "text/a.md",
  ]);
  assertStringIncludes(sw, `const V = "aio-notes-abc123";`);
  assertStringIncludes(
    sw,
    `const FILES = ["./","./app.js","./index.html","./text/a.md"];`,
  );
  // Old builds' caches are dropped — only this app's (prefix), never another's.
  assertStringIncludes(sw, `k.startsWith("aio-notes-") && k !== V`);
  // Offline navigation falls back to the shell.
  assertStringIncludes(sw, `c.match("./index.html")`);
  new Function(sw); // a syntax error here is a dead offline cache
  // The precache checks each file's digest — keyed by the URL it fetches.
  const pinned = serviceWorker("notes", "abc123", ["a b.js", "index.html"], {
    "a b.js": "sha256-x",
  });
  assertStringIncludes(pinned, `const SRI = {"./a b.js":"sha256-x"};`);
  // Escaped only where a name would be another URL: the page asks for
  // `logo@2x.png`, and a `%40` key would miss it offline.
  assertStringIncludes(
    serviceWorker("notes", "abc123", ["100%.css", "a#b?.js", "logo@2x.png"]),
    `const FILES = ["./","./100%25.css","./a%23b%3F.js","./logo@2x.png"];`,
  );
  assertStringIncludes(pinned, `integrity: SRI[f] || ""`);
  new Function(pinned);
  // Only code is pinned: a host rewrites pages and images (an optimizer
  // recompresses a PNG), and a pinned digest would refuse every install.
  const rewritable = serviceWorker(
    "notes",
    "abc123",
    ["app.css", "app.js", "icon.png", "index.html", "logo.svg", "x.wasm"],
    {
      "app.css": "sha256-c",
      "app.js": "sha256-j",
      "icon.png": "sha256-p",
      "index.html": "sha256-h",
      "logo.svg": "sha256-s",
      "x.wasm": "sha256-w",
    },
  );
  assertStringIncludes(
    rewritable,
    `const SRI = {"./app.css":"sha256-c","./app.js":"sha256-j","./x.wasm":"sha256-w"};`,
  );
  assert(
    serviceWorker("notes", "abc124", ["app.js"]) !==
      serviceWorker("notes", "abc123", ["app.js"]),
    "a new build must be a new sw.js, or the browser never installs it",
  );
});

Deno.test("web target: the lost-run-options warning names the web app, not the APK", () => {
  const src =
    `import { aio } from "aio";\nawait aio.run({ onStart() {}, ui: { theme: "auto" } });`;
  const w = androidRunOptionsWarning(src, "src/app.ts", "web")!;
  assertStringIncludes(w.headline, "standalone web app never runs src/app.ts");
  assertStringIncludes(w.fix, "`browser` target");
  assert(!/APK|phone/.test(w.headline + w.body + w.fix), JSON.stringify(w));
  // The APK wording is unchanged.
  assertStringIncludes(
    androidRunOptionsWarning(src, "src/app.ts")!.headline,
    "the local APK never runs",
  );
});

Deno.test("web target: the shell names its app id (store aio:<appId>); the APK shell names none (store aio:app)", () => {
  // The standalone runtime keys its store by `__aioConfig.appId`: without it
  // every web build on one origin shared `aio:app`. The APK must NOT get one —
  // shipped APKs saved their state under `aio:app`.
  assertStringIncludes(
    androidLocalHTML("N", false, { appId: "my-notes" }),
    `window.__aioConfig={"appId":"my-notes"}`,
  );
  assert(!androidLocalHTML("N", false).includes("__aioConfig"));
});

Deno.test("web target: an app icon Chrome cannot install from is said at build time", () => {
  // Measured in Chromium (Page.getInstallabilityErrors): a 64 px icon.png
  // reports manifest-missing-suitable-icon (minimum 144) — the PWA was never
  // offered for install on Android, under a green build.
  assertStringIncludes(webIconProblem({ w: 64, h: 64 }) ?? "", "144×144");
  assertStringIncludes(webIconProblem({ w: 143, h: 512 }) ?? "", "512×512");
  assertEquals(webIconProblem({ w: 144, h: 144 }), null);
  assertEquals(webIconProblem({ w: 1024, h: 1024 }), null);
  // Not a PNG: the monogram stands in, and that is said too.
  assertStringIncludes(webIconProblem(null) ?? "", "not a PNG");
});
