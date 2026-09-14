/**
 * @module
 * The Chrome DevTools Protocol as `am shot` / `am eval` reach it: the target
 * list over HTTP, and which targets are the app's windows. Commands and events
 * go through the one client in `media/cdp.ts`.
 */

/** One entry of `GET /json` — the page targets Chromium exposes. */
export type CdpTarget = {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl: string;
};

/** The targets a CDP endpoint on `127.0.0.1:<port>` exposes. */
export async function cdpTargets(
  port: number,
  timeoutMs = 3000,
): Promise<CdpTarget[]> {
  const r = await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`CDP /json answered ${r.status}`);
  return await r.json() as CdpTarget[];
}

/** Pure: the page targets that ARE the app — its `aio://` shell or its own
 *  http(s) origin on `port`. DevTools' own pages and about:blank are not. */
export function appPageTargets(
  targets: readonly CdpTarget[],
  port: number,
): CdpTarget[] {
  const origins = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `https://localhost:${port}`,
    `https://127.0.0.1:${port}`,
  ];
  return targets.filter((t) =>
    t.type === "page" &&
    (t.url.startsWith("aio://") ||
      origins.some((o) =>
        t.url === o || t.url.startsWith(o + "/") ||
        t.url.startsWith(o + "?")
      ))
  );
}

/** A CDP session — THE client in `media/cdp.ts`, re-exported so `am shot`,
 *  `am eval` and the video recorders speak through one implementation. */
export { cdpConnect, type CdpSession } from "../media/cdp.ts";
