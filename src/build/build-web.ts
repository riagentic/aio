/**
 * @module
 * Build web — the standalone app as a static site (a PWA): the standalone
 * bundle (cells run in the page, state in page storage, no server), the shell,
 * a web manifest, the Apple Home Screen tags and an offline service worker.
 * Deploy the directory to any HTTPS static host; on an iPhone, "Add to Home
 * Screen" installs it.
 */
import { join, relative, SEPARATOR } from "@std/path";
import type { BuildConfig } from "./build-config.ts";
import { emptyDir, foreignArtifactRefusal } from "./dist-staging.ts";
import { resolveAppIcon } from "./build-helpers.ts";
import { _packAssetMounts, _warnRunOptions } from "./build-android.ts";
import { appHue, appIconLabel, appIconPng, hsl, pngSize } from "./app-icon.ts";
import { androidLocalHTML } from "../server/server-html-gen.ts";
import { APP_ICON, APP_STYLE, BUNDLE_JS } from "../server/app-files.ts";
import { escHtml } from "../server/server-html-constants.ts";
import { HEY, NO, OK } from "../diagnostics/fmt.ts";
import { count } from "../diagnostics/fmt.ts";
import { VERSION_STAMP } from "../protocol/protocol-version.ts";

/** The artifact's name — the one spelling the builder writes and the fleet
 *  recognises (a DIRECTORY in the project root, like the iOS project). */
export function webArtifactName(binaryName: string): string {
  return `${binaryName}-web`;
}

const hex = (rgb: [number, number, number]): string =>
  "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

/** The web manifest — name, icons and colours from the app's own identity
 *  (the same hue its icon and theme take). Pure. */
export function webManifest(
  title: string,
  appId: string,
  icons: readonly { src: string; sizes: string }[],
): string {
  const hue = appHue(appId);
  return JSON.stringify(
    {
      name: title,
      short_name: title,
      id: "./",
      start_url: "./",
      scope: "./",
      display: "standalone",
      background_color: hex(hsl(hue, 0.68, 0.96)),
      theme_color: hex(hsl(hue, 0.62, 0.68)),
      icons: icons.map((i) => ({ ...i, type: "image/png" })),
    },
    null,
    2,
  ) + "\n";
}

/** The `<head>` lines that make the page installable: the manifest, the
 *  Apple Home Screen tags (iOS reads these, not the manifest, for the title
 *  and icon), and the service worker registration — which says why when the
 *  browser refuses it (file://, plain http off localhost). Pure. */
export function webHead(title: string, icon: string, theme: string): string {
  const t = escHtml(title);
  return [
    `<link rel="manifest" href="./manifest.webmanifest">`,
    `<meta name="theme-color" content="${theme}">`,
    `<link rel="icon" href="./${icon}">`,
    `<link rel="apple-touch-icon" href="./${icon}">`,
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-title" content="${t}">`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="default">`,
    `<script>if("serviceWorker"in navigator)navigator.serviceWorker` +
    `.register("./sw.js").catch(function(e){` +
    `console.error("✗ [aio] offline cache (service worker) not registered — the app works ` +
    `online only. It needs https (or localhost):",e)})</script>`,
  ].join("\n");
}

/** `f` as the worker fetches it and keys its cache: only what would make it
 *  another URL is escaped (`%`, `#`, `?`, and `\`, a `/` to a URL) — one
 *  failed fetch fails the whole install. The rest is left to the URL parser,
 *  as the page's own `logo@2x.png` is: escaped by hand (`%40`) it is another
 *  cache key, and the page's request misses the cache offline. Pure. */
function precacheUrl(f: string): string {
  return `./${f.replace(/[%#?\\]/g, encodeURIComponent)}`;
}

/** The service worker: precaches every file of the build under a cache named
 *  by `version` (a hash of every file's bytes, the bundle included) — fetched
 *  past the browser's HTTP cache (`cache: "reload"`), else a host's `max-age`
 *  hands the new version the OLD build's bytes, served cache-first — and
 *  checked against `integrity` (file → `sha256-…`): a CDN edge ignores
 *  `reload`, and an edge that has not seen the deploy fails the install (the
 *  old build keeps serving, whole; the browser retries) instead of pinning its
 *  stale bytes under the new version until the build after next — answers
 *  same-origin GETs cache-first, serves the shell for a navigation the host
 *  has no file for (a reload on a client route: 404) or cannot answer
 *  (offline) — with a `<base>` of its scope, so a route two levels deep loads
 *  the build from the deploy root, not from the route's directory — and
 *  drops the caches of older builds when it takes over. A new
 *  build is a new `sw.js` byte-for-byte, which is what makes the browser
 *  install it. Pure. */
export function serviceWorker(
  appId: string,
  version: string,
  files: readonly string[],
  integrity: Readonly<Record<string, string>> = {},
): string {
  const prefix = `aio-${appId}-`;
  return `// generated by aio — the offline cache of this build
const V = ${JSON.stringify(prefix + version)};
const FILES = ${
    JSON.stringify([
      "./",
      ...files.map(precacheUrl),
    ])
  };
const SRI = ${
    JSON.stringify(
      Object.fromEntries(
        files.filter((f) => integrity[f] && digestPinned(f)).map((f) => [
          precacheUrl(f),
          integrity[f],
        ]),
      ),
    )
  };
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload", integrity: SRI[f] || "" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) =>
    k.startsWith(${
    JSON.stringify(prefix)
  }) && k !== V).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// The shell for a client route: its relative refs (./app.js, css, manifest,
// icons, sw.js) must resolve against the deploy root — this worker's scope —
// not against the route's directory (/a/b → /a/app.js). Only a route whose
// directory IS another gets the <base>: one level deep already resolves, and
// a <base> would re-point its "#section" links at the root.
const shell = (c, url) => c.match("./index.html").then((s) => {
  const scope = self.registration.scope;
  if (!s || new URL(".", url).href === scope) return s;
  return s.text().then((t) =>
    new Response(t.replace("<head>", "<head><base href=\\"" + scope + "\\">"),
      { headers: { "content-type": "text/html; charset=utf-8" } }));
});
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return;
  e.respondWith(caches.open(V).then((c) =>
    c.match(r, { ignoreSearch: true }).then((hit) => hit || fetch(r).then((res) =>
      r.mode === "navigate" && res.status === 404
        ? shell(c, r.url).then((s) => s || res)
        : res, (err) => {
      if (r.mode === "navigate") return shell(c, r.url);
      throw err;
    }))
  ));
});
`;
}

/** Why the app's own `icon.png` (its PNG size, null = not a PNG) cannot serve
 *  as the web app's icon, or null. Chrome installs a web app only when its
 *  manifest names an icon of at least 144 px (measured: a 64 px one reports
 *  `manifest-missing-suitable-icon`), so a smaller icon built a PWA no Android
 *  phone offers to install, under a green build. Pure. */
export function webIconProblem(
  size: { w: number; h: number } | null,
): string | null {
  if (!size) {
    return "icon.png is not a PNG — the web app uses the generated monogram";
  }
  if (Math.min(size.w, size.h) >= 144) return null;
  return `icon.png is ${size.w}×${size.h}: Chrome offers to install a web ` +
    `app only with an icon of at least 144×144, so this one is not ` +
    `installable on Android. Fix: ship a 512×512 icon.png`;
}

/** Every file under `dir`, as `/`-separated paths relative to it, sorted. */
async function listFiles(dir: string, at = dir): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(at)) {
    const p = join(at, e.name);
    if (e.isDirectory) out.push(...await listFiles(dir, p));
    else out.push(relative(dir, p).split(SEPARATOR).join("/"));
  }
  return out.sort();
}

/** Whether the worker pins `f`'s digest: code only (script, style, wasm) —
 *  the bytes a stale edge would skew against the new build. A host may
 *  rewrite the rest — a page (an injected snippet), an image (an optimizer
 *  recompresses it: Cloudflare Polish) — and a pinned digest would then
 *  refuse every install: no offline cache, said nowhere a user looks. Pure. */
function digestPinned(f: string): boolean {
  return /\.(m?js|css|wasm)$/i.test(f);
}

/** `sha256-<base64>` of every file `digestPinned` keeps, for the worker's
 *  precache. */
async function subresourceIntegrity(
  dir: string,
  files: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of files) {
    if (!digestPinned(f)) continue;
    const d = new Uint8Array(
      await crypto.subtle.digest("SHA-256", await Deno.readFile(join(dir, f))),
    );
    let bin = "";
    for (const b of d) bin += String.fromCharCode(b);
    out[f] = `sha256-${btoa(bin)}`;
  }
  return out;
}

/** SHA-256 over every file's path and bytes — the build's content version. */
async function contentHash(
  dir: string,
  files: readonly string[],
): Promise<string> {
  const parts: BlobPart[] = [];
  for (const f of files) {
    parts.push(f + "\0", await Deno.readFile(join(dir, f)));
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await new Blob(parts).arrayBuffer(),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildWeb(cfg: BuildConfig): Promise<void> {
  const { root, dist, binaryName, appTitle } = cfg;
  const title = appTitle ?? binaryName;
  const outDir = join(root, webArtifactName(binaryName));
  // Never a user folder that shares the artifact's name: only a directory an
  // aio web build wrote (its bundle carries the version stamp) is emptied.
  const refusal = await foreignArtifactRefusal(
    outDir,
    BUNDLE_JS,
    `globalThis.${VERSION_STAMP} =`,
  );
  if (refusal) {
    console.error(`${NO} ${refusal}`);
    Deno.exit(1);
  }
  // EMPTIED, never replaced (see `emptyDir`): a server or watcher holding
  // the directory keeps serving the new build.
  // The stamped bundle is what makes the folder aio's: it goes last and comes
  // back first, so an interrupted build never leaves a folder the next one
  // refuses as a user's.
  await emptyDir(outDir, [BUNDLE_JS]);
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.copyFile(join(dist, BUNDLE_JS), join(outDir, BUNDLE_JS));

  let hasCSS = false;
  try {
    await Deno.copyFile(join(dist, APP_STYLE), join(outDir, APP_STYLE));
    hasCSS = true;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e; // no app stylesheet
  }
  // The app's entry module never runs in the page (only the UI and what it
  // imports is bundled) — name the aio.run() options that are lost.
  await _warnRunOptions(cfg, "web");

  const { icon: userIcon } = await resolveAppIcon(root, cfg.appDir);
  const size = userIcon ? pngSize(await Deno.readFile(userIcon)) : null;
  const iconProblem = userIcon ? webIconProblem(size) : null;
  if (iconProblem) console.warn(`${HEY} ${iconProblem}`);
  let icons: { src: string; sizes: string }[];
  if (userIcon && size) {
    await Deno.copyFile(userIcon, join(outDir, APP_ICON));
    icons = [{ src: APP_ICON, sizes: `${size.w}x${size.h}` }];
  } else {
    const label = appIconLabel(appTitle, binaryName);
    icons = [];
    for (const n of [192, 512]) {
      const src = `icon-${n}.png`;
      await Deno.writeFile(
        join(outDir, src),
        await appIconPng(label, n, binaryName),
      );
      icons.push({ src, sizes: `${n}x${n}` });
    }
  }
  const manifest = webManifest(title, binaryName, icons);
  await Deno.writeTextFile(join(outDir, "manifest.webmanifest"), manifest);
  await Deno.writeTextFile(
    join(outDir, "index.html"),
    androidLocalHTML(title, hasCSS, {
      themeName: binaryName,
      appId: binaryName,
      head: webHead(
        title,
        icons[0]!.src,
        (JSON.parse(manifest) as { theme_color: string }).theme_color,
      ),
    }),
  );
  await _packAssetMounts(root, outDir, "the web build");

  const files = await listFiles(outDir);
  const version = await contentHash(outDir, files);
  await Deno.writeTextFile(
    join(outDir, "sw.js"),
    serviceWorker(
      binaryName,
      version,
      files,
      await subresourceIntegrity(
        outDir,
        files,
      ),
    ),
  );
  console.log(
    `${OK} ${webArtifactName(binaryName)}/ — ${
      count(files.length + 1, "file")
    }, offline cache ${version}. Serve it over https; iPhone: Share → Add to Home Screen`,
  );
}
