/** The `<webview>` host-key contract, shared by the renderer (`<Browser
 *  hostKeys>`, `src/ui/browser.ts`) and the Electron main process (the relay
 *  in `src/electron/electron-shared.ts`). One home, so the two sides cannot
 *  drift. Pure, dependency-free. @internal */

/** The attribute a `<webview>` declares its host keys in: a JSON array of
 *  `KeyboardEvent.key` values. */
export const HOST_KEYS_ATTR = "data-aio-host-keys";
/** The event the host's `<webview>` element receives for a relayed key. */
export const HOST_KEY_EVENT = "aio:hostkey";
/** Caps on a declaration — a host-key list is a handful of escape hatches,
 *  never a keylogger for the embedded page. */
export const HOST_KEYS_MAX = 16;
/** The longest `KeyboardEvent.key` name a declaration may hold. */
export const HOST_KEY_MAX_LEN = 32;

/** True when `keys` is a valid declaration: 1..{@link HOST_KEYS_MAX}
 *  non-empty strings of at most {@link HOST_KEY_MAX_LEN} chars. Pure. */
export function isHostKeyList(keys: unknown): keys is string[] {
  return Array.isArray(keys) && keys.length > 0 &&
    keys.length <= HOST_KEYS_MAX &&
    keys.every((k) =>
      typeof k === "string" && k.length > 0 && k.length <= HOST_KEY_MAX_LEN
    );
}
