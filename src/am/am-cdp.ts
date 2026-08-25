/**
 * @module
 * A minimal Chrome DevTools Protocol client — `am shot` and any test that
 * drives an Electron window through `--cdp`. Target list over HTTP, commands
 * over the target's WebSocket; every protocol error is thrown, never swallowed.
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

/** A CDP session: `call(method, params)` resolves with the command's result
 *  and rejects with the protocol's error message. */
export async function cdpConnect(
  wsUrl: string,
  timeoutMs = 5000,
): Promise<{
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
}> {
  const ws = new WebSocket(wsUrl);
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let id = 0;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`CDP connect timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error(`CDP connect failed: ${wsUrl}`));
    };
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (m.id === undefined) return; // an event — not ours
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (!p) return;
    if (m.error) p.reject(new Error(`CDP: ${m.error.message}`));
    else p.resolve(m.result);
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error("CDP socket closed"));
    pending.clear();
  };
  return {
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    close: () => ws.close(),
  };
}
