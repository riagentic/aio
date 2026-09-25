// browser.ts — `<Browser>`: an embedded web page, with the two traps closed.
//
// Electron's `<webview>` is how an aio app shows somebody else's page inside
// its own. It is gated behind `childWindows` (the same opt-in as
// `openWindow` — both are "render remote content inside the app"), and until
// now that gate was documented in exactly one place: a source comment in
// `electron-shared.ts` (report 5 §2).
//
// TWO TRAPS, and every author meets both in hour one:
//
//  1. A REACTIVE `src` IS AN INFINITE NAVIGATION LOOP. Written as an ordinary
//     attribute, `src={state.url}` is re-applied on every render; setting
//     `src` on a `<webview>` navigates; navigating fires `did-navigate`, which
//     an app naturally writes back to state, which renders again. The page
//     flickers and never settles, and nothing in the stack says why.
//     `<Browser>` sets the URL IMPERATIVELY and only when it actually changed.
//
//  2. UNMOUNTING DESTROYS THE GUEST, and the next mount starts over at `src`
//     — so a tab switch or a conditional render throws away the page the user
//     had browsed to. `keepAlive` remembers where each guest was, and the next
//     mount under the same id opens there. (Electron destroys a `<webview>`
//     that leaves the document, and one MOVED in it too — measured on Electron
//     44, tests/electron-browser-keepalive-e2e.test.ts — so no guest can be
//     kept; its scroll, forms and JS state go with it. Cookies are the
//     partition's session's, not the guest's, and survive regardless.)
//
// It renders a plain `<webview>` element, so everything Electron documents
// about the tag is still true and still reachable through `ref`.

import { h } from "../air/vdom.ts";
import type { VNode } from "../air/vdom.ts";
import {
  HOST_KEY_EVENT,
  HOST_KEYS_ATTR,
  HOST_KEYS_MAX,
  isHostKeyList,
} from "../protocol/host-keys.ts";

/** The bits of Electron's `<webview>` this component drives. Structural, not
 *  an Electron import: `aio/ui` is in the BROWSER graph, and a type-only
 *  dependency on Electron would put a Node package in every app's bundle. */
type WebviewEl = HTMLElement & {
  src?: string;
  loadURL?: (url: string) => Promise<void>;
  getURL?: () => string;
  reload?: () => void;
  goBack?: () => void;
  goForward?: () => void;
  stop?: () => void;
};

/** Where each `keepAlive` id's guest was when it unmounted: `at`, the page it
 *  showed, and `src`, the prop it had been given then.
 *
 *  It used to keep the ELEMENT instead, moved into a display:none holder and
 *  moved back on the next mount. Electron destroys a `<webview>`'s guest on
 *  any move — and one moved with `append` never gets a new one — so every
 *  restore put a dead element on the page: a blank box, for good. */
const _kept = new Map<string, { at: string; src: string }>();

/** @internal Test seam: forget every kept page. */
// aio-ok: a test-only seam; kept pages live for the life of the page
export function _clearKept(): void {
  _kept.clear();
}

/** Props for {@link Browser}. */
export interface BrowserProps {
  /** The page to show. Changing it navigates; re-rendering with the SAME
   *  value does nothing, which is what stops the navigation loop. */
  src: string;
  /** Remember the page across unmounts, under this id: the next mount with it
   *  opens where the last one was (unless `src` changed meanwhile). Without
   *  it, a remount starts over at `src`. Scroll, forms and JS state cannot be
   *  kept — Electron destroys a guest that leaves the document. */
  keepAlive?: string;
  /** `partition` on the underlying tag: which session (cookies, storage) the
   *  guest uses. Two `<Browser>`s with the same partition share a login. */
  partition?: string;
  /** Called after the guest navigates, with the URL it landed on. Write this
   *  to state if you want an address bar — and note that doing so is safe
   *  precisely because `src` is only applied when it differs. */
  onNavigate?: (url: string) => void;
  class?: string;
  style?: Record<string, string | number>;
  /** The element itself, for anything Electron documents that this does not
   *  wrap (`executeJavaScript`, `openDevTools`, the rest of the history API). */
  ref?: (el: WebviewEl | null) => void;
  /** Keys the guest hands back to the app, even while focus is inside one of
   *  its IFRAMEs (a video embed, a captcha) — `KeyboardEvent.key` values,
   *  e.g. `["Escape"]`, at most 16. Keydown only, and the guest still gets the
   *  key. Each arrives as {@link onHostKey} and as a bubbling `aio:hostkey`
   *  event on the element. Read once, when the guest attaches. */
  hostKeys?: readonly string[];
  /** Called for each relayed {@link hostKeys} press. */
  onHostKey?: (key: HostKey) => void;
}

/** A key the guest relayed to the app (`<Browser hostKeys>`): the `detail`
 *  of the `aio:hostkey` event, with the modifiers held at the time. */
export interface HostKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

/** Validate `hostKeys` loudly — a typo here is a key that silently never
 *  arrives, and the main process only warns. */
function hostKeysAttr(keys: readonly string[] | undefined): string | undefined {
  if (keys === undefined) return undefined;
  if (!isHostKeyList(keys)) {
    throw new TypeError(
      `<Browser hostKeys> must be 1..${HOST_KEYS_MAX} KeyboardEvent.key names (e.g. ["Escape"]), got ${
        JSON.stringify(keys)
      }`,
    );
  }
  return JSON.stringify(keys);
}

/**
 * An embedded web page.
 *
 * ```tsx
 * <Browser
 *   src={app.url}
 *   keepAlive="reader"
 *   onNavigate={(url) => app.setUrl(url)}
 *   style={{ width: "100%", height: "100%" }}
 * />
 * ```
 *
 * Requires `childWindows: true` — a `<webview>` without that gate does not
 * render at all, and the gate exists because embedding remote content is a
 * decision an app should make on purpose.
 */
export function Browser(props: BrowserProps): VNode {
  const { partition } = props;
  const hostKeys = hostKeysAttr(props.hostKeys);
  return h("webview", {
    ...(partition ? { partition } : {}),
    // An attribute, set at creation: the main process reads it when the guest
    // attaches, which is after this element exists and before it loads.
    ...(hostKeys ? { [HOST_KEYS_ATTR]: hostKeys } : {}),
    class: props.class,
    style: props.style,
    // The newest props reach the guest through a FRESH ref closure, which the
    // renderer calls on every render; the mount itself is one STABLE action,
    // which it runs once per element. See `mountGuest` for why the two jobs
    // cannot share one closure.
    ref: (el: HTMLElement | null) => {
      if (el) update(el, props);
    },
    use: mountGuest,
  });
}

/** What one rendered `<webview>` element knows: the props of its latest
 *  render, and whether it is live. Keyed by the element. */
interface Mount {
  /** Null until the first render's ref has delivered them. */
  props: BrowserProps | null;
  /** The element, once activated. */
  guest: WebviewEl | null;
  /** Torn down (before or after it activated). */
  gone: boolean;
}
const _mounts = new WeakMap<HTMLElement, Mount>();

function mountOf(el: HTMLElement): Mount {
  let m = _mounts.get(el);
  if (!m) {
    _mounts.set(el, m = { props: null, guest: null, gone: false });
  }
  return m;
}

/** A render's props, delivered to its element. A live guest follows them at
 *  once: `src` navigates when it changed, and the newest callbacks win. */
function update(el: HTMLElement, props: BrowserProps): void {
  const m = mountOf(el);
  m.props = props;
  if (m.guest) wire(m.guest, props, false);
}

/** The mount, ONCE per element.
 *
 *  `use` is re-run whenever the action changes, and a closure written inside
 *  `Browser` was a new function on every render — so every re-render ran the
 *  teardown and the mount again, and a `keepAlive` guest was torn down by the
 *  first `onNavigate` → state write → re-render (the docstring's own
 *  address-bar example). A module-level action has one identity, so the
 *  renderer runs it on mount and its teardown on unmount, and nothing in
 *  between. */
function mountGuest(el: HTMLElement): () => void {
  const m = mountOf(el);
  m.gone = false;
  // The work waits one microtask: refs (which carry the props) are delivered
  // at the END of the commit, after the actions ran.
  queueMicrotask(() => activate(el, m));
  return () => {
    m.gone = true;
    const guest = m.guest;
    m.guest = null;
    const id = m.props?.keepAlive;
    if (!guest || !id) return;
    // The teardown runs before the renderer removes the element, so the guest
    // is still alive to say where it is.
    _kept.set(id, { at: currentUrl(guest), src: m.props!.src });
    m.props?.ref?.(null);
  };
}

/** Where a guest is now: its own answer, or the last URL aio gave it. */
function currentUrl(wv: WebviewEl): string {
  try {
    return wv.getURL?.() || (wv as { _aioUrl?: string })._aioUrl || "";
  } catch {
    // aio-ok: a guest that is already gone throws from getURL; the last URL
    // aio handed it is the best answer left.
    return (wv as { _aioUrl?: string })._aioUrl ?? "";
  }
}

/** Show the guest — at the page a `keepAlive` predecessor was on, when the
 *  app has not changed `src` since. */
function activate(el: HTMLElement, m: Mount): void {
  const props = m.props;
  if (m.gone || m.guest || !props) return;
  const wv = el as WebviewEl;
  m.guest = wv;
  const kept = props.keepAlive ? _kept.get(props.keepAlive) : undefined;
  if (kept && kept.src === props.src && kept.at && kept.at !== props.src) {
    navigate(wv, kept.at);
    // What `navigate` compares the next render's `src` with: the prop, as it
    // was before the unmount — so the unchanged prop does not send the guest
    // back to it, and a changed one still navigates.
    (wv as { _aioUrl?: string })._aioUrl = kept.src;
  }
  wire(wv, props, true);
}

/** Point `wv` at the props (on every render) and hook up its events (once
 *  per element). The caller's `ref` hears about the guest when it MOUNTS,
 *  not on every render. */
function wire(wv: WebviewEl, props: BrowserProps, mounted: boolean): void {
  const { partition, ref } = props;
  if (partition && !wv.getAttribute("partition")) {
    wv.setAttribute("partition", partition);
  }
  navigate(wv, props.src);
  // The listeners read the CURRENT mount's callback when they fire, so a
  // handler that changed between renders is the one that is called.
  const cb = wv as { _aioOnNav?: (url: string) => void; _aioNav?: boolean };
  cb._aioOnNav = props.onNavigate;
  if (props.onNavigate && !cb._aioNav) {
    cb._aioNav = true;
    // `did-navigate-in-page` as well: a single-page guest changes its URL
    // without a load, and an address bar that only follows full navigations
    // goes stale on exactly the pages people use most.
    for (const ev of ["did-navigate", "did-navigate-in-page"]) {
      wv.addEventListener(ev, () => {
        try {
          const now = wv.getURL?.() ?? wv.src ?? "";
          (wv as { _aioUrl?: string })._aioUrl = now;
          cb._aioOnNav?.(now);
        } catch {
          // aio-ok: a destroyed guest throws from getURL, and a teardown
          // race must not take the page with it.
        }
      });
    }
  }
  setHostKeyHandler(wv, props.onHostKey);
  if (mounted) ref?.(wv);
}

/** The newest handler wins; the listener is added once per element. */
function setHostKeyHandler(
  wv: WebviewEl,
  onHostKey: ((k: HostKey) => void) | undefined,
): void {
  const hk = wv as { _aioHostKey?: (k: HostKey) => void; _aioHk?: boolean };
  hk._aioHostKey = onHostKey;
  if (onHostKey && !hk._aioHk) {
    hk._aioHk = true;
    wv.addEventListener(HOST_KEY_EVENT, (e) => {
      hk._aioHostKey?.((e as CustomEvent<HostKey>).detail);
    });
  }
}

/** Point a guest at `url`, and ONLY when that is a change.
 *
 *  The loop this avoids: setting `src` navigates, navigating fires
 *  `did-navigate`, an app writes that to state, state re-renders, and the
 *  render sets `src` again. Comparing first breaks it at the only place it can
 *  be broken — the page never settles otherwise, and nothing in the stack says
 *  why. Exported so a test can drive the rule without an Electron guest. */
export function navigate(wv: WebviewEl, url: string): void {
  if (!url) return;
  const current = (wv as { _aioUrl?: string })._aioUrl ??
    (() => {
      try {
        return wv.getURL?.() || wv.src || "";
      } catch {
        return wv.src || "";
      }
    })();
  if (current === url) return;
  (wv as { _aioUrl?: string })._aioUrl = url;
  // `loadURL` where the guest is attached and ready; `src` before that, which
  // is what the tag itself reads on first paint.
  if (typeof wv.loadURL === "function" && current) {
    void wv.loadURL(url).catch(() => {
      // aio-ok: a navigation the guest refuses (an offline host, a blocked
      // scheme) is the guest's business and shows in its own error page.
    });
  } else {
    wv.src = url;
    wv.setAttribute("src", url);
  }
}
