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
