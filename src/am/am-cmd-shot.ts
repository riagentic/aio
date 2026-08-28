/**
 * @module
 * `am shot` — a PNG of the live Electron window, headlessly, over the Chrome
 * DevTools Protocol the app opened with `--cdp`.
 */

import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { liveLock, resolveAmAppId } from "./am-utils.ts";
import { appPageTargets, cdpConnect, cdpTargets } from "./am-cdp.ts";

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

/** Pure: the exact instruction when the running app opened no CDP port. */
export function noCdpMessage(appId: string): string {
  return `${appId} is running without the DevTools Protocol — a screenshot ` +
    `needs it. Restart with the flag: am restart ${appId} --cdp ` +
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
  if (!pf.cdpPort) {
    outError(noCdpMessage(appId), mode);
    Deno.exit(1);
  }
  const idxRaw = args.find((a) => !a.startsWith("--"));
  const idx = idxRaw === undefined ? 0 : Number(idxRaw);
  if (!Number.isInteger(idx) || idx < 0) {
    outError(`invalid window index: ${idxRaw} — a non-negative integer`, mode);
    Deno.exit(1);
  }
  const full = args.includes("--full");
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
    const r = await cdp.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: full,
    }) as { data?: string };
    if (!r?.data) throw new Error("Page.captureScreenshot returned no data");
    const png = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    await Deno.writeFile(outFile, png);
    const result = { file: outFile, bytes: png.byteLength, url: target.url };
    out(
      mode === "pretty"
        ? `wrote ${outFile} (${png.byteLength} bytes) — ${target.url}`
        : result,
      mode,
    );
  } finally {
    cdp.close();
  }
}
