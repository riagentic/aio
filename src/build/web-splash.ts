/**
 * @module
 * `build.splash` on the web target: the splash as part of the page itself —
 * markup and a style in the shell, so it paints with the first frame, before
 * any script — gone once the app has mounted, never sooner than `minMs` after
 * it appeared. And the same image as iOS's Home Screen launch images, so an
 * installed app starts on it too. Without `build.splash` none of this exists:
 * the shell is byte for byte today's.
 *
 * No download runs on the web, so `progress` and `bar` mean nothing here.
 */
import { appIdentityColors } from "./app-theme.ts";
import { pngFromRgba } from "./app-icon.ts";
import { decodePng } from "./png-scale.ts";
import { escHtml } from "../server/server-html-constants.ts";
import { lookOf, type SplashSpec, splashText } from "../electron/splash.ts";

/** The splash image's file in the web build. */
export function webSplashFile(s: SplashSpec): string {
  return s.image.scale === 2 ? "splash@2x.png" : "splash.png";
}

/** The manifest's colours with a splash: the app's page background (the
 *  splash's), so the screen a browser paints before the page matches it. */
export function webSplashColors(
  appId: string,
): { background: string; theme: string } {
  const bg = appIdentityColors(appId).light.background;
  return { background: bg, theme: bg };
}

/** The image's CSS width on a `vw`×`vh` screen: its own size (an `@2x` image
 *  at half its pixels), at most 80% of either side. Pure. */
export function splashCssWidth(s: SplashSpec, vw: number, vh: number): number {
  const w = s.image.w / s.image.scale, h = s.image.h / s.image.scale;
  return Math.min(w, 0.8 * vw, 0.8 * vh * w / h);
}

/** The shell's splash: `head` (the style, and the dark mode's theme colour —
 *  first, so it wins over the plain one), `body` (the element over the app,
 *  and the script that takes it away). The script waits for `#root`'s first
 *  child — the mount, the same signal the desktop's window reports — then
 *  for `minMs` since the first paint, fades it out and removes it; after
 *  `maxMs` (30 s unless set) it goes regardless. ES5: an engine too old for
 *  the bundle still shows the page's notice about it. Pure. */
export function webSplash(
  s: SplashSpec,
  title: string,
): { head: string; body: string } {
  const { w, h, scale } = s.image;
  const cw = w / scale, ch = h / scale;
  const look = lookOf(s);
  const fade = look.fadeMs ?? 200;
  const family = s.font.family
    ? JSON.stringify(s.font.family).replace(/</g, "\\3c ") + ","
    : "";
  const css = `#aio-splash{position:fixed;inset:0;z-index:2147483647;` +
    `display:flex;align-items:center;justify-content:center;` +
    `background:${s.light.background};transition:opacity ${fade / 1000}s}` +
    `#aio-splash>div{position:relative}` +
    `#aio-splash img{display:block;height:auto;` +
    (look.radius ? `border-radius:${look.radius}px;` : "") +
    (look.border
      ? `outline:1px solid ${look.border};outline-offset:-1px;`
      : "") +
    `width:min(${cw}px,80vw,calc(80vh*${cw}/${ch}))}` +
    `#aio-splash p{position:absolute;top:100%;left:50%;` +
    `transform:translateX(-50%);width:max-content;max-width:90vw;` +
    `margin:16px 0 0;text-align:center;` +
    `font:${s.font.weight} ${s.font.size}pt ${family}system-ui,sans-serif;` +
    `color:${s.light.text}` +
    (look.shadow ? `;text-shadow:0 1px 2px rgba(0,0,0,.45)` : "") + `}` +
    `@media (prefers-color-scheme:dark){#aio-splash{` +
    `background:${s.dark.background}}#aio-splash p{color:${s.dark.text}}}` +
    `@media (prefers-reduced-motion:reduce){#aio-splash{transition:none}}`;
  const text = s.text === null
    ? ""
    : `<p>${escHtml(splashText(s.text, title))}</p>`;
  const js = `(function(){var s=document.getElementById("aio-splash"),` +
    `r=document.getElementById("root"),done=0,` +
    `c=setTimeout(go,${look.maxMs});` +
    `function go(){if(done)return;done=1;o.disconnect();clearTimeout(c);` +
    `s.style.opacity="0";s.style.pointerEvents="none";` +
    `setTimeout(function(){s.parentNode.removeChild(s)},${fade + 50})}` +
    // It appeared at the first paint. Mounted before any paint (a cached
    // bundle; measured: mount 134 ms, paint 156 ms), there is no paint yet:
    // wait minMs from now — still before the paint — then measure again.
    // An engine with no paint timing goes after that one wait, which began
    // after it appeared.
    `function wait(n){var p=performance.getEntriesByType("paint"),` +
    `now=performance.now(),left=(p.length?p[0].startTime:now)+${s.minMs}-now;` +
    `if(left>0&&(p.length||!n))setTimeout(function(){wait(1)},left);else go()}` +
    `var o=new MutationObserver(function(){if(!r.firstChild)return;` +
    `o.disconnect();wait(0)});` +
    `o.observe(r,{childList:true})})()`;
  return {
    head: `<meta name="theme-color" media="(prefers-color-scheme: dark)" ` +
      `content="${s.dark.background}">\n<style>${css}</style>\n`,
    body: `<div id="aio-splash" aria-hidden="true"><div>` +
      `<img src="./${webSplashFile(s)}" alt="" width="${cw}" height="${ch}">` +
      `${text}</div></div>\n  <script>${js}</script>`,
  };
}

/** The portrait screens iOS shows a Home Screen app's launch image on, as
 *  CSS width × height × pixel ratio — the iPhones and iPads iOS 15.4 runs
 *  on. iOS picks the one whose media query matches the screen exactly; a
 *  screen not listed shows the manifest's background colour. */
export const IOS_SCREENS: readonly (readonly [number, number, number])[] = [
  [320, 568, 2], // SE (1st)
  [375, 667, 2], // 6s, 7, 8, SE (2nd, 3rd)
  [414, 736, 3], // 6s/7/8 Plus
  [375, 812, 3], // X, XS, 11 Pro, 12/13 mini
  [414, 896, 2], // XR, 11
  [414, 896, 3], // XS Max, 11 Pro Max
  [390, 844, 3], // 12, 13, 14
  [428, 926, 3], // 12/13 Pro Max, 14 Plus
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [430, 932, 3], // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [402, 874, 3], // 16 Pro
  [440, 956, 3], // 16 Pro Max
  [768, 1024, 2], // iPad mini 5, iPad 9.7"
  [744, 1133, 2], // iPad mini 6
  [810, 1080, 2], // iPad 10.2"
  [820, 1180, 2], // iPad Air 4/5, iPad 10
  [834, 1112, 2], // iPad Air 3, iPad Pro 10.5"
  [834, 1194, 2], // iPad Pro 11"
  [834, 1210, 2], // iPad Pro 11" (M4)
  [1024, 1366, 2], // iPad Pro 12.9"
  [1032, 1376, 2], // iPad Pro 13" (M4)
];

/** `rgba` (`sw`×`sh`) drawn into `out` (`ow` wide) at `dx,dy`, `dw`×`dh`,
 *  bilinear, alpha-blended over what is there (premultiplied, so a
 *  transparent pixel lends no colour to its neighbours). Mutates `out`. */
function drawOver(
  out: Uint8Array,
  ow: number,
  rgba: Uint8Array,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const pre = new Float32Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]! / 255;
    pre[i] = rgba[i]! * a, pre[i + 1] = rgba[i + 1]! * a;
    pre[i + 2] = rgba[i + 2]! * a, pre[i + 3] = rgba[i + 3]!;
  }
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / dh - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / dw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty, w11 = tx * ty;
      const v = (c: number) =>
        pre[i00 + c]! * w00 + pre[i10 + c]! * w10 + pre[i01 + c]! * w01 +
        pre[i11 + c]! * w11;
      const keep = 1 - v(3) / 255;
      const o = ((dy + y) * ow + dx + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = Math.round(v(c) + out[o + c]! * keep);
      }
    }
  }
}

/** iOS launch images: per {@linkcode IOS_SCREENS} the splash image, at the
 *  size and place the page draws it, on the light background — so the launch
 *  image and the page's splash are one picture. The image's file name, its
 *  `<link>` and its PNG; or why the image cannot be read (then the page's
 *  splash alone runs). */
export async function iosLaunchImages(
  s: SplashSpec,
  png: Uint8Array,
): Promise<{ file: string; link: string; png: Uint8Array }[] | string> {
  const img = await decodePng(png);
  if (typeof img === "string") return img;
  const bg = s.light.background;
  const rgb = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  const out: { file: string; link: string; png: Uint8Array }[] = [];
  for (const [cw, ch, r] of IOS_SCREENS) {
    const W = cw * r, H = ch * r;
    const px = new Uint8Array(W * H * 4);
    for (let i = 0; i < px.length; i += 4) {
      px[i] = rgb[0]!,
        px[i + 1] = rgb[1]!,
        px[i + 2] = rgb[2]!,
        px[i + 3] = 255;
    }
    const dw = Math.round(splashCssWidth(s, cw, ch) * r);
    const dh = Math.round(dw * img.h / img.w);
    drawOver(
      px,
      W,
      img.rgba,
      img.w,
      img.h,
      (W - dw) >> 1,
      (H - dh) >> 1,
      dw,
      dh,
    );
    const file = `apple-splash-${W}x${H}.png`;
    out.push({
      file,
      link: `<link rel="apple-touch-startup-image" media="screen and ` +
        `(device-width: ${cw}px) and (device-height: ${ch}px) and ` +
        `(-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)" ` +
        `href="./${file}">`,
      png: await pngFromRgba(px, W, H),
    });
  }
  return out;
}
