/**
 * @module
 * THE Chrome DevTools Protocol client — commands and events over one target's
 * WebSocket. `am shot`/`am eval` and the video recorder all speak through it;
 * every protocol error is thrown, never swallowed.
 */

/** A connected CDP session. */
export type CdpSession = {
  /** Run a command; resolves with its result, rejects with the protocol's
   *  error message. */
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** Listen for an event (`"Page.screencastFrame"`). Returns the unsubscribe. */
  on: (event: string, fn: (params: unknown) => void) => () => void;
  /** Close the socket; resolves once it IS closed (a test that ends on a
   *  half-closed socket leaks an op). */
  close: () => Promise<void>;
  /** Resolves when the socket closes for ANY reason — the target going away
   *  (a window closed mid-recording) included. */
  closed: Promise<void>;
};

/** Connect to a target's `webSocketDebuggerUrl`. */
export async function cdpConnect(
  wsUrl: string,
  timeoutMs = 5000,
): Promise<CdpSession> {
  const ws = new WebSocket(wsUrl);
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const listeners = new Map<string, Set<(params: unknown) => void>>();
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
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    if (m.id === undefined) {
      if (m.method) {
        for (const fn of listeners.get(m.method) ?? []) fn(m.params);
      }
      return;
    }
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (!p) return;
    if (m.error) p.reject(new Error(`CDP: ${m.error.message}`));
    else p.resolve(m.result);
  };
  const closed = new Promise<void>((resolve) => {
    ws.onclose = () => {
      for (const p of pending.values()) {
        p.reject(new Error("CDP socket closed"));
      }
      pending.clear();
      resolve();
    };
  });
  return {
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error("CDP socket closed"));
          return;
        }
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    on: (event, fn) => {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return () => set.delete(fn);
    },
    close: () => {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
      return closed;
    },
    closed,
  };
}
