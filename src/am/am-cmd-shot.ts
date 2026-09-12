/**
 * @module
 * `am shot` — a PNG of the live Electron window, headlessly, over the Chrome
 * DevTools Protocol the app opened with `--cdp`.
 */

import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { liveLock, resolveAmAppId } from "./am-utils.ts";
import { appPageTargets, cdpConnect, cdpTargets } from "./am-cdp.ts";
import { comparePng, type PngDiffOptions } from "./png-compare.ts";

/** Pure: the output path — `--out`, or `<appId>-<stamp>.png` in the cwd. */
export function shotOutPath(
  appId: string,
  outFlag: string | undefined,
  now: Date = new Date(),
): string {
  if (outFlag) return outFlag;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")
    .replace("T", "-");
  return `${appId}-${stamp}.png`;
}

/** Clients with a desktop window. Everything else has nothing to screenshot,
 *  and no flag will give it one. */
const WINDOWED = new Set(["electron"]);

/** Pure: the exact instruction when the running app opened no CDP port.
 *
 *  `client` is what the instance recorded in its lock (absent on locks written
 *  before alpha76 → the honest "if this is a desktop app" wording). Naming it
 *  first is the whole point: a `--client=browser` app was told to restart with
 *  `--cdp` and try again, and the operator who did got "recorded cdp
 *  127.0.0.1:PORT but nothing answers there" — a two-step path to the same
 *  dead end, when the first answer was knowable. */
export function noCdpMessage(appId: string, client?: string): string {
  if (client !== undefined && !WINDOWED.has(client)) {
    return `${appId} runs with --client=${client}, which has no desktop ` +
      `window — there is nothing for a screenshot to capture, and no flag ` +
      `changes that (--cdp drives an Electron window). To see the live UI: ` +
      `\`am surface ${appId} --json\` reads it as text, or open the page in ` +
      `your own browser and screenshot it there. For a real window, run the ` +
      `app with --client=electron.`;
  }
  return `${appId} is running without the DevTools Protocol — a screenshot ` +
    `needs it.${
      client === undefined
        ? ` (If this app runs with --client=browser / cli / server-only there ` +
          `is no window to shoot at all — use \`am surface\` instead.) `
        : " "
    }Restart with the flag: am restart ${appId} --cdp ` +
    `(or run the app with --cdp / AIO_CDP=1), then am shot again. ` +
    `Opt-in on purpose: --cdp binds a loopback port, and an app that did not ` +
    `ask binds none.`;
}

export async function cmdShot(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  if (args.some((a) => a === "--pose" || a.startsWith("--pose="))) {
    outError(
      "--pose is not supported: the app decides its own camera. Expose a " +
        "cell method (or serverFn) that sets the view, drive it with " +
        "`am dispatch`, then `am shot`.",
      mode,
    );
    Deno.exit(1);
  }
  const pf = liveLock(appId); // wherever the instance's home is
  if (!pf) {
    outError(`${appId} is not running (no lock) — am start first`, mode);
    Deno.exit(1);
  }
  // A client with no window is refused FIRST, cdp port or not: a recorded
  // port that nothing listens on is the second dead end, not a second chance.
  if (pf.client !== undefined && !WINDOWED.has(pf.client)) {
    outError(noCdpMessage(appId, pf.client), mode);
    Deno.exit(1);
  }
  if (!pf.cdpPort) {
    outError(noCdpMessage(appId, pf.client), mode);
    Deno.exit(1);
  }
  const idxRaw = args.find((a) => !a.startsWith("--"));
  // The positional is a WINDOW INDEX, and the thing people type there is a
  // filename — `am shot shots/home.png` reads like every other screenshot tool
  // on earth (report 3 §8.4). It is a detectable mistake, so it gets the flag
  // rather than "invalid window index: shots/home.png", which explains the
  // parser and not the intent.
  if (idxRaw !== undefined && /[/\\]|\.(?:png|jpe?g|webp)$/i.test(idxRaw)) {
    outError(
      `\`${idxRaw}\` looks like a file path, and the positional argument here ` +
        `is a WINDOW INDEX (0 = the first window).`,
      mode,
      `am shot --out=${idxRaw}`,
    );
    Deno.exit(1);
  }
  const idx = idxRaw === undefined ? 0 : Number(idxRaw);
  if (!Number.isInteger(idx) || idx < 0) {
    outError(
      `invalid window index: ${idxRaw} — a non-negative integer (0 = the ` +
        `first window)`,
      mode,
      `am shot --out=<file.png>   # if you meant a destination`,
    );
    Deno.exit(1);
  }
  const full = args.includes("--full");
  // `--selector=<css>`: capture ONE element instead of the window. The
  // measurement comes from the page, not from a guess — a clip computed here
  // would be wrong the moment the page scrolled.
  const selector = args.find((a) => a.startsWith("--selector="))?.slice(11);
  if (selector !== undefined && !selector.trim()) {
    outError(
      '--selector= needs a CSS selector (e.g. --selector="#chart"). ' +
        "`am surface --names` lists the semantic paths; this flag takes CSS.",
      mode,
    );
    Deno.exit(1);
  }
  // `--check[=file]` / `--update[=file]` — a committed baseline. aio already
  // had the three hard parts (headless capture, deterministic state via
  // `am snapshot load`, any state reachable with `am dispatch`); this is the
  // last 10% (report 4 §10.7).
  const checkFlag = args.find((a) =>
    a === "--check" || a.startsWith("--check=")
  );
  const updateFlag = args.find((a) =>
    a === "--update" || a.startsWith("--update=")
  );
  if (checkFlag && updateFlag) {
    outError(
      "--check and --update are opposites: one asserts the baseline, the " +
        "other replaces it. Pick one.",
      mode,
    );
    Deno.exit(1);
  }
  const outFile = shotOutPath(
    appId,
    args.find((a) => a.startsWith("--out="))?.slice(6),
  );
  const timeout = flags.timeout ?? 8000;

  let targets;
  try {
    targets = await cdpTargets(pf.cdpPort, timeout);
  } catch (e) {
    outError(
      `${appId} recorded cdp 127.0.0.1:${pf.cdpPort} but nothing answers ` +
        `there (${e instanceof Error ? e.message : e}) — is the Electron ` +
        `window up? (--client=browser / server-only open no window)`,
      mode,
    );
    Deno.exit(1);
  }
  const pages = appPageTargets(targets, pf.port);
  const target = pages[idx];
  if (!target) {
    const seen = targets.map((t) => `${t.type} ${t.url}`).join(", ") ||
      "none";
    outError(
      pages.length === 0
        ? `no app window among the CDP targets (saw: ${seen})`
        : `window ${idx} does not exist — ${pages.length} app window(s): ${
          pages.map((p, i) => `${i}=${p.url}`).join(", ")
        }`,
      mode,
    );
    Deno.exit(1);
  }
  const cdp = await cdpConnect(target.webSocketDebuggerUrl, timeout);
  try {
    // Wait for the window to actually PAINT before capturing.
    //
    // `Page.captureScreenshot` hands back whatever the compositor last
    // composited. Immediately after an `am dispatch` — the exact moment anyone
    // takes a screenshot — the state has changed, the render is queued, and
    // nothing has been painted yet. The old pixels came back and the command
    // said `wrote shot.png`. A field report (report 6 §2) read that as proof
    // the UI had not updated, which was the opposite of the truth.
    //
    // Two `requestAnimationFrame`s: the first runs before the next paint, the
    // second after a frame has been committed. That is the browser's own
    // definition of "something was painted since you asked".
    const painted = await framePainted(cdp, timeout);
    let clip: Record<string, number> | undefined;
    if (selector !== undefined) {
      clip = (await selectorClip(cdp, selector)) ?? undefined;
      if (!clip) {
        outError(
          `no element matches ${selector} in ${target.url} — nothing to ` +
            `capture. (\`am surface --names\` lists what the page actually ` +
            `has; this flag takes a CSS selector, not a semantic path.)`,
          mode,
        );
        Deno.exit(1);
      }
      if (clip.width === 0 || clip.height === 0) {
        // A 0x0 clip makes Chrome return a 1x1 image, which reads as a
        // successful capture of a collapsed element — the same
        // "answered with zeroes" failure `am surface --rects` already refuses.
        outError(
          `${selector} measures ${clip.width}x${clip.height} in ${target.url}` +
            ` — it is in the DOM and has no box, so there is nothing to ` +
            `capture. Either it is \`display:none\`, or the layout has not ` +
            `run yet.`,
          mode,
        );
        Deno.exit(1);
      }
    }
    const r = await cdp.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: full,
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    }) as { data?: string };
    if (!r?.data) throw new Error("Page.captureScreenshot returned no data");
    const png = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));

    // ── a committed baseline ────────────────────────────────────────────
    if (checkFlag || updateFlag) {
      const flag = (checkFlag ?? updateFlag)!;
      const eq = flag.indexOf("=");
      const baseline = eq >= 0 ? flag.slice(eq + 1) : outFile;
      if (!baseline) {
        outError(`${flag.slice(0, eq)}= needs a path`, mode);
        Deno.exit(1);
      }
      if (updateFlag) {
        await Deno.writeFile(baseline, png);
        out(
          mode === "pretty"
            ? `updated baseline ${baseline} (${png.byteLength} bytes)`
            : { baseline, bytes: png.byteLength, updated: true, painted },
          mode,
        );
        return;
      }
      const prior = await Deno.readFile(baseline).catch(() => null);
      if (!prior) {
        // NOT a pass. A missing baseline is the one case where "nothing to
        // compare" and "nothing changed" look identical, and a green there is
        // a check that never ran.
        outError(
          `no baseline at ${baseline} — there is nothing to compare against, ` +
            `and reporting that as a pass would be a check that never ran. ` +
            `Record one first: am shot --update=${baseline}`,
          mode,
        );
        Deno.exit(1);
      }
      const th = args.find((a) => a.startsWith("--threshold="))?.slice(12);
      const mr = args.find((a) => a.startsWith("--max-diff="))?.slice(11);
      const opts: PngDiffOptions = {
        ...(th !== undefined ? { threshold: Number(th) } : {}),
        ...(mr !== undefined ? { maxRatio: Number(mr) } : {}),
      };
      const diff = await comparePng(png, prior, opts);
      if (diff.same) {
        out(
          mode === "pretty"
            ? `matches ${baseline}${
              diff.maxDelta > 0
                ? ` (largest channel change ${diff.maxDelta}, within tolerance)`
                : ""
            }`
            : { baseline, ...diff, painted },
          mode,
        );
        return;
      }
      // The ACTUAL pixels are written beside the baseline, because "they
      // differ" with nothing to look at is a report nobody can act on.
      const actual = baseline.replace(/(\.png)?$/i, ".actual.png");
      await Deno.writeFile(actual, png).catch(() => {
        // aio-ok: the comparison already FAILED and the reason is about to be
        // printed. An unwritable directory would replace that message with a
        // filesystem error about a file the user did not ask for — losing the
        // finding to a footnote about the footnote.
      });
      outError(
        `${baseline} does not match: ${diff.reason}.` +
          (painted ? "" : " (the window also did not confirm a frame)") +
          ` The pixels captured now are in ${actual}; accept them with ` +
          `am shot --update=${baseline}`,
        mode,
      );
      Deno.exit(1);
    }

    await Deno.writeFile(outFile, png);
    const result = {
      file: outFile,
      bytes: png.byteLength,
      url: target.url,
      painted,
      ...(painted ? {} : {
        warning:
          `the window did not paint within ${timeout}ms, so these pixels may ` +
          `predate whatever you just did — a hidden, minimised or occluded ` +
          `window is not composited. Raise it, or raise --timeout=`,
      }),
    };
    out(
      mode === "pretty"
        ? `wrote ${outFile} (${png.byteLength} bytes) — ${target.url}` +
          (painted
            ? ""
            : `\n  ! STALE RISK: the window did not paint within ${timeout}ms, ` +
              `so these pixels may predate what you just did.\n` +
              `    A hidden, minimised or occluded window is not composited — ` +
              `raise the window, or raise --timeout=`)
        : result,
      mode,
    );
  } finally {
    cdp.close();
  }
}

/** The viewport box of the first element matching `selector`, or `null`.
 *
 *  MEASURED IN THE PAGE, through `getBoundingClientRect`, rather than computed
 *  from a layout tree here. The page is the only thing that knows where the
 *  element is after a scroll, a transform or a `position: sticky` — and the
 *  clip Chrome wants is in viewport coordinates, which is exactly what that
 *  call returns. */
async function selectorClip(
  cdp: { call: (m: string, p?: Record<string, unknown>) => Promise<unknown> },
  selector: string,
): Promise<Record<string, number> | null> {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`;
  const res = await cdp.call("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  }) as { result?: { value?: Record<string, number> | null } };
  const v = res?.result?.value;
  if (!v || typeof v.width !== "number") return null;
  // Chrome's clip wants integers it can composite; a fractional box loses a
  // sliver off two edges and makes a byte-identical re-capture impossible.
  return {
    x: Math.floor(v.x ?? 0),
    y: Math.floor(v.y ?? 0),
    width: Math.ceil(v.width ?? 0),
    height: Math.ceil(v.height ?? 0),
  };
}

/** Resolve once the page has committed a frame — `true` when it did, `false`
 *  when it did not within `ms`.
 *
 *  Never throws and never blocks the capture: a screenshot of a window that
 *  will not paint is still worth taking, it just cannot be vouched for. The
 *  boolean is what the caller reports, so "I could not confirm this frame is
 *  fresh" is said out loud instead of being indistinguishable from success. */
async function framePainted(
  cdp: { call: (m: string, p?: Record<string, unknown>) => Promise<unknown> },
  ms: number,
): Promise<boolean> {
  const raf =
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))";
  // The loser of the race must be disarmed. A pending `setTimeout` keeps the
  // event loop alive, so a screenshot that painted in 3ms would still have sat
  // there for the rest of the timeout before the CLI could exit.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cdp.call("Runtime.evaluate", {
        expression: raf,
        awaitPromise: true,
        returnByValue: true,
      }).then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), ms);
      }),
    ]);
  } catch {
    // aio-ok: a page that refuses Runtime.evaluate (navigating, crashed) still
    // gets its screenshot; the caller reports the frame as unconfirmed, which
    // is the honest answer and the one this function exists to give.
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
