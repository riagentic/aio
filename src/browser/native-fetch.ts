// native-fetch.ts — `nativeFetch()`: `fetch`, made by the app instead of the
// browser where the runtime can.
//
// A standalone Android APK runs every cell inside its WebView, so every
// request carries `Origin: https://appassets.androidplatform.net` and passes
// CORS — and some public APIs refuse any request with an Origin (a public
// JSON-RPC answering 403, `access-control-allow-origin: backend_traffic`).
// No page code can reach them. The APK therefore installs a native HTTP
// bridge (`AioNativeFetch` in android-template's MainActivity.kt: no Origin,
// no WebView cookie, no CORS), and this is its page half.
//
// Everywhere else it IS `fetch`: on the server Deno sends no Origin already,
// and a browser page has no way around its own rules. Explicit, not a patched
// global: a plain `fetch()` keeps its browser semantics in every runtime.

/** The global a standalone APK installs (`FETCH_GLOBAL` in MainActivity.kt,
 *  through `addWebMessageListener`). Named once here, once there. */
const NATIVE_FETCH_GLOBAL = "AioNativeFetch";
/** The global an aio standalone APK injects its durable store as
 *  (`addJavascriptInterface`, `AioNativeStore` in MainActivity.kt) — THE home
 *  of the name; src/standalone-air.ts reads the store through it. Here,
 *  present means "this is a standalone APK", so a missing fetch bridge next to
 *  it is an error, not a fallback. @internal */
export const NATIVE_STORE_GLOBAL = "AioNativeStore";
/** The global the APK hands the store's per-launch key to the app's OWN page
 *  under (`STORE_KEY_GLOBAL` in MainActivity.kt, a document-start script with
 *  the app's origin as its only rule) — a foreign frame never has it, and
 *  every store method refuses a caller without it. @internal */
export const NATIVE_STORE_KEY_GLOBAL = "__aioNativeStoreKey";
/** Statuses a `Response` may not carry a body for. */
const NULL_BODY = [101, 103, 204, 205, 304];

type Bridge = {
  postMessage(m: string): void;
  addEventListener(t: "message", f: (e: { data: unknown }) => void): void;
};
type Reply = {
  id: number;
  error?: string;
  status?: number;
  statusText?: string;
  headers?: [string, string][];
  body?: string;
};

const b64 = (u: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) {
    s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  }
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let _bridge: Bridge | null = null;
let _seq = 0;
let _pending: Map<number, (r: Reply) => void> | null = null;

async function viaBridge(b: Bridge, req: Request): Promise<Response> {
  // Read the bytes, never test `req.body`: a WebView older than ~M105 has no
  // `Request.body` at all (the bridge needs only ~M82), and every POST went
  // out empty. No bytes is no body, as `body: null` is.
  const bytes = req.method === "GET" || req.method === "HEAD"
    ? null
    : new Uint8Array(await req.arrayBuffer());
  const body = bytes?.length ? b64(bytes) : null;
  // After the read: an abort during it fired its event before anyone listened.
  req.signal.throwIfAborted();
  if (_bridge !== b) {
    _bridge = b;
    _pending = new Map();
    const pending = _pending;
    b.addEventListener("message", (e) => {
      const r = JSON.parse(String(e.data)) as Reply;
      pending.get(r.id)?.(r); // absent: aborted, its answer is dropped
      pending.delete(r.id);
    });
  }
  const pending = _pending!;
  const id = ++_seq;
  return await new Promise<Response>((resolve, reject) => {
    const abort = () => {
      pending.delete(id);
      reject(req.signal.reason);
    };
    req.signal.addEventListener("abort", abort, { once: true });
    pending.set(id, (r) => {
      req.signal.removeEventListener("abort", abort);
      if (r.error !== undefined || r.status === undefined) {
        reject(
          new TypeError(
            `nativeFetch ${req.method} ${req.url}: ${r.error ?? "no status"}`,
          ),
        );
        return;
      }
      // A status or header the Response constructor refuses rejects this
      // call — thrown inside the listener it would leave it pending forever.
      try {
        resolve(
          new Response(
            NULL_BODY.includes(r.status) ? null : unb64(r.body ?? ""),
            {
              status: r.status,
              statusText: r.statusText,
              headers: r.headers,
            },
          ),
        );
      } catch (e) {
        reject(e);
      }
    });
    b.postMessage(JSON.stringify({
      id,
      url: req.url,
      method: req.method,
      headers: [...req.headers],
      body,
    }));
  });
}

/** `fetch`, sent by the app rather than the browser where the runtime can.
 *
 *  In a standalone Android APK the request goes out natively: no `Origin`,
 *  no `Referer`, no WebView cookies, no CORS — for the APIs that refuse any
 *  request from a browser. http(s) only, 15 s to connect, 30 s between bytes,
 *  8 MiB per body; cleartext `http://` is refused as the APK refuses it
 *  everywhere. `signal` aborts; `mode`, `credentials` and `cache` do not
 *  apply. Everywhere else (server, desktop, browser, tests) it is exactly
 *  `fetch(input, init)`. docs/build/targets.md#native-fetch.
 *
 * @example
 * ```ts
 * import { nativeFetch } from "aio/air";
 * const res = await nativeFetch("https://api.example.com/rpc", {
 *   method: "POST",
 *   headers: { "content-type": "application/json" },
 *   body: JSON.stringify({ method: "getHealth" }),
 * });
 * console.log(res.status, await res.json());
 * ```
 */
export function nativeFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const g = globalThis as Record<string, unknown>;
  const b = g[NATIVE_FETCH_GLOBAL] as Bridge | undefined;
  if (b) {
    try {
      return viaBridge(b, new Request(input, init));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  if (g[NATIVE_STORE_GLOBAL]) {
    return Promise.reject(
      new TypeError(
        `nativeFetch: this standalone APK has no native fetch bridge ` +
          `(${NATIVE_FETCH_GLOBAL}) — its WebView is too old for ` +
          `addWebMessageListener (update Android System WebView), or an ` +
          `android/ overlay replaced MainActivity.kt without it. A plain ` +
          `fetch() here would carry an Origin header, so it is not used.`,
      ),
    );
  }
  return fetch(input, init);
}
