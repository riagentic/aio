// `build.splash` on the web target: in the shell only when configured, the
// manifest's colours, iOS's launch images, and — in a real headless Chromium
// — visible at first paint, gone after the mount but never before minMs,
// the app usable after it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { pngFromRgba } from "../src/build/app-icon.ts";
import { resolveSplash } from "../src/build/splash.ts";
import { decodePng } from "../src/build/png-scale.ts";
import { appIdentityColors } from "../src/build/app-theme.ts";
import { webManifest } from "../src/build/build-web.ts";
import {
  IOS_SCREENS,
  iosLaunchImages,
  splashCssWidth,
  webSplash,
  webSplashColors,
  webSplashFile,
} from "../src/build/web-splash.ts";
import type { SplashSpec } from "../src/electron/splash.ts";
import { androidLocalHTML } from "../src/server/server-html-gen.ts";
import { chromiumPage, launchChromium } from "../src/testing/chromium.ts";
import { findChromium, freePort } from "../src/testing/server-test.ts";

/** A `n`×`n` PNG: an opaque red disc on transparency. */
async function disc(n: number): Promise<Uint8Array> {
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      if ((x - n / 2) ** 2 + (y - n / 2) ** 2 < (n / 2.5) ** 2) {
        px[o] = 255, px[o + 3] = 255;
      }
    }
  }
  return await pngFromRgba(px, n);
}

async function spec(
  splash: Record<string, unknown>,
  png?: Uint8Array,
): Promise<SplashSpec> {
  const bytes = png ?? await disc(200);
  const r = resolveSplash({ build: { splash } }, {
    root: "/p",
    appId: "notes",
    read: () => bytes,
  });
  if ("error" in r) throw new Error(r.error);
  return r.splash!;
}

const shell = (body?: string, head = "") =>
  androidLocalHTML("Notes", false, { appId: "notes", body, head });

Deno.test("web splash: the shell is today's without build.splash, and carries it only when configured", async () => {
  // Off: byte for byte the shell without the option.
  assertEquals(shell(undefined), shell());
  assert(!shell().includes("aio-splash"));
  const s = await spec({
    image: "assets/logo@2x.png",
    text: "Starting {title}…",
    minMs: 1500,
    font: { family: "Georgia</style>", size: 14, weight: "normal" },
  });
  const p = webSplash(s, "Notes & co");
  const html = shell(p.body, p.head);
  // The element after #root, before the bundle — painted before any script.
  const at = (x: string) => html.indexOf(x);
  assert(at(`<div id="root">`) < at(`id="aio-splash"`));
  assert(at(`id="aio-splash"`) < at(`<script src="./app.js">`));
  assertStringIncludes(
    p.body,
    `<img src="./splash@2x.png" alt="" width="100" height="100">`,
  );
  assertEquals(webSplashFile(s), "splash@2x.png");
  assertStringIncludes(p.body, `<p>Starting Notes &amp; co…</p>`);
  assertStringIncludes(p.body, `+1500-now`);
  assertStringIncludes(p.body, `setTimeout(go,30000)`);
  // A font name cannot close the style.
  assertEquals(p.head.split("</style>").length, 2);
  // The colours are the resolver's (the app's identity), per mode.
  const id = appIdentityColors("notes");
  assertStringIncludes(p.head, `background:${id.light.background}`);
  assertStringIncludes(p.head, `background:${id.dark.background}`);
  assertStringIncludes(
    p.head,
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${id.dark.background}">`,
  );
  // Image only (text false): no text element; left out, the title.
  assert(
    !webSplash(await spec({ image: "a.png", text: false }), "x").body
      .includes("<p>"),
  );
  assertStringIncludes(
    webSplash(await spec({ image: "a.png" }), "Notes").body,
    "Notes",
  );
  // The script is ES5 — an engine too old for the bundle still runs it.
  const js = p.body.match(/<script>(.*)<\/script>/)![1]!;
  assert(!/=>|\blet\b|\bconst\b|`/.test(js), js);
  new Function(js);
});

Deno.test("web splash: no CSP is added or loosened — the shell has none, and the splash brings none", async () => {
  const p = webSplash(await spec({ image: "a.png" }), "x");
  assert(!shell().includes("Content-Security-Policy"));
  assert(!shell(p.body, p.head).includes("Content-Security-Policy"));
});

Deno.test("web splash: progress and bar are accepted and mean nothing on the web", async () => {
  const s = await spec({
    image: "a.png",
    progress: true,
    bar: { style: "thin", color: "#112233" },
  });
  const p = webSplash(s, "x");
  assert(!/112233|progress/.test(p.head + p.body));
});

Deno.test("web splash: the manifest takes the splash's colours only with a splash", () => {
  const plain = JSON.parse(webManifest("N", "notes", []));
  const c = webSplashColors("notes");
  const lit = JSON.parse(webManifest("N", "notes", [], c));
  assertEquals(
    lit.background_color,
    appIdentityColors("notes").light.background,
  );
  assertEquals(lit.theme_color, lit.background_color);
  // Without it: today's colours, untouched (the pinned pair).
  assertEquals(
    [plain.background_color, plain.theme_color],
    ["#eef1fc", "#7b92e0"],
  );
});

Deno.test("web splash: iOS launch images — every listed screen, its exact media query, the image where the page draws it", async () => {
  const s = await spec({ image: "logo@2x.png" }, await disc(400));
  const imgs = await iosLaunchImages(s, await disc(400));
  if (typeof imgs === "string") throw new Error(imgs);
  assertEquals(imgs.length, IOS_SCREENS.length);
  const ipad = IOS_SCREENS.findIndex(([w, h]) => w === 768 && h === 1024);
  const i = imgs[ipad]!;
  assertEquals(i.file, "apple-splash-1536x2048.png");
  assertStringIncludes(
    i.link,
    `media="screen and (device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" href="./apple-splash-1536x2048.png"`,
  );
  const px = await decodePng(i.png);
  if (typeof px === "string") throw new Error(px);
  assertEquals([px.w, px.h], [1536, 2048]);
  const rgb = (
    x: number,
    y: number,
  ) => [...px.rgba.subarray((y * px.w + x) * 4, (y * px.w + x) * 4 + 3)];
  const bg = s.light.background;
  const want = [1, 3, 5].map((k) => parseInt(bg.slice(k, k + 2), 16));
  assertEquals(rgb(5, 5), want); // the corner: the background
  assertEquals(rgb(768, 1024), [255, 0, 0]); // the centre: the disc
  // 200 CSS px wide (an @2x 400 px image) × 2: the disc's edge (r = 160 of
  // 400 px source → 160 device px) is where the page draws it.
  assertEquals(splashCssWidth(s, 768, 1024), 200);
  assertEquals(rgb(768 + 150, 1024), [255, 0, 0]);
  assertEquals(rgb(768 + 170, 1024), want);
  // An image the decoder cannot read: a reason, never a throw.
  assertEquals(typeof await iosLaunchImages(s, new Uint8Array(40)), "string");
});

// ── a real browser ─────────────────────────────────────────────────────────

const CHROME = findChromium();

/** Times the page reports: the first paint, the mount, the fade's start, the
 *  removal — and whether the splash covered the page at the mount. */
const PROBE = `(() => {
  const p = window.__probe = {};
  new MutationObserver(() => {
    const now = performance.now(), r = document.getElementById("root");
    const s = document.getElementById("aio-splash");
    if (s) p.seen = true;
    if (r && r.firstChild && p.mount === undefined) {
      p.mount = now;
      const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      p.coveredAtMount = !!(s && s.contains(top));
    }
    if (s && s.style.opacity === "0" && p.hide === undefined) p.hide = now;
    if (!s && p.seen && p.gone === undefined) p.gone = now;
  }).observe(document, { subtree: true, childList: true, attributes: true });
})()`;

Deno.test({
  name:
    "web splash (chromium): visible at first paint, gone after the mount and never before minMs, the app usable after",
  ignore: !CHROME,
  sanitizeOps: false, // aio-ok(sanitizers): the browser child and the server are stopped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same
  fn: async () => {
    const png = await disc(200);
    const pages = new Map<string, string>();
    for (const minMs of [1500, 0]) {
      const p = webSplash(
        await spec({ image: "a.png", minMs, text: "Hi" }),
        "x",
      );
      pages.set(`/${minMs}/`, shell(p.body, p.head));
      // A render-blocking sheet that comes late: the bundle runs, and the app
      // mounts, before the first paint — a cached bundle's order.
      pages.set(
        `/early${minMs}/`,
        shell(p.body, `<link rel="stylesheet" href="./slow.css">` + p.head),
      );
    }
    // The app: mounts a button `#hash` ms after it runs (`#-1`: at once).
    const app = `function m(){var b=document.createElement("button");` +
      `b.textContent="go";b.style.cssText="position:fixed;left:10px;top:10px;width:80px;height:40px";` +
      `b.onclick=function(){b.textContent="clicked"};` +
      `document.getElementById("root").appendChild(b)}` +
      `var d=parseInt(location.hash.slice(1));if(d<0)m();else setTimeout(m,d)`;
    const port = freePort();
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port,
      onListen: () => {},
    }, async (req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/slow.css")) {
        await new Promise((r) => setTimeout(r, 400));
        return new Response("", { headers: { "content-type": "text/css" } });
      }
      if (path.endsWith("/app.js")) {
        return new Response(app, {
          headers: { "content-type": "text/javascript" },
        });
      }
      if (path.endsWith(".png")) {
        return new Response(png as BlobPart, {
          headers: { "content-type": "image/png" },
        });
      }
      const html = pages.get(path);
      return html
        ? new Response(html, { headers: { "content-type": "text/html" } })
        : new Response("no", { status: 404 });
    });
    const b = await launchChromium(CHROME!, [
      "--remote-debugging-port=0",
      "about:blank",
    ]);
    try {
      const cdp = await chromiumPage(b);
      await cdp.call("Page.enable");
      await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
        source: PROBE,
      });
      const js = async <T>(expression: string): Promise<T> => {
        const r = await cdp.call("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }) as { result?: { value?: T }; exceptionDetails?: unknown };
        assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
        return r.result!.value as T;
      };
      type Probe = {
        mount?: number;
        hide?: number;
        gone?: number;
        coveredAtMount?: boolean;
        paint: number;
      };
      const run = async (page: string, mountMs: number): Promise<Probe> => {
        await cdp.call("Page.navigate", {
          url: `http://127.0.0.1:${port}/${page}/#${mountMs}`,
        });
        const deadline = Date.now() + 20_000;
        for (;;) {
          const p = await js<Probe>(
            `({...(window.__probe||{}),paint:(performance.getEntriesByType("paint")[0]||{}).startTime})`,
          ).catch(() => null);
          if (p?.gone !== undefined) return p;
          assert(Date.now() < deadline, `no removal: ${JSON.stringify(p)}`);
          await new Promise((r) => setTimeout(r, 50));
        }
      };

      // minMs 1500, a fast mount: the splash covers the mounted app, and
      // goes 1500 ms after the first paint — not at the mount.
      const fast = await run("1500", 50);
      assert(fast.coveredAtMount, JSON.stringify(fast));
      assert(
        fast.paint !== undefined && fast.mount! >= 0,
        JSON.stringify(fast),
      );
      assert(fast.hide! - fast.paint >= 1500, JSON.stringify(fast));
      assert(fast.hide! - fast.paint < 2500, JSON.stringify(fast));
      assert(fast.gone! >= fast.hide!, JSON.stringify(fast));

      // Mounted before the first paint: still minMs from the PAINT (measured
      // on a real bundle: a wait from the script's own time was 42 ms short).
      const early = await run("early1500", -1);
      // (`paint` is whole milliseconds, `mount` is not: 428.1 vs 428 is the
      // same moment.)
      assert(early.mount! < early.paint + 1, JSON.stringify(early));
      assert(early.hide! - early.paint >= 1500, JSON.stringify(early));
      assert(early.hide! - early.paint < 2500, JSON.stringify(early));

      // minMs 0, a slow mount: never before the mount, and right after it.
      const slow = await run("0", 800);
      assert(slow.coveredAtMount, JSON.stringify(slow));
      assert(slow.hide! >= slow.mount!, JSON.stringify(slow));
      assert(slow.hide! - slow.mount! < 300, JSON.stringify(slow));

      // Gone means gone: the button is on top and takes a real click.
      assertEquals(await js(`document.getElementById("aio-splash")`), null);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.call("Input.dispatchMouseEvent", {
          type,
          x: 50,
          y: 30,
          button: "left",
          clickCount: 1,
        });
      }
      assertEquals(
        await js(`document.querySelector("button").textContent`),
        "clicked",
      );
      await cdp.close();
    } finally {
      await b.close();
      await server.shutdown();
    }
  },
});
