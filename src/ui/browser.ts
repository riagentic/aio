// browser.ts — `<Browser>`: an embedded web page, with the two traps closed.
//
// Electron's `<webview>` is how an aio app shows somebody else's page inside
// its own. It is gated behind `childWindows` (the same opt-in as
// `openWindow` — both are "render remote content inside the app"), and until
// now that gate was documented in exactly one place: a source comment in
// `electron-shared.ts` (newjob §2).
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
//  2. UNMOUNTING DESTROYS THE GUEST. Its scroll position, its form state and
//     its LOGIN go with it — so a tab switch or a conditional render silently
//     signs the user out of the page they were reading. `keepAlive` parks the
//     element instead of dropping it, and hands the same guest back next time.
//
// It renders a plain `<webview>` element, so everything Electron documents
// about the tag is still true and still reachable through `ref`.

import { h } from "../air/vdom.ts";
import type { VNode } from "../air/vdom.ts";

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

/** Guests parked by `keepAlive`, by id. They stay in a detached holder — in
 *  the document, but display:none — because a `<webview>` removed from the
 *  document is destroyed by Electron along with everything it was holding. */
const _parked = new Map<string, WebviewEl>();
/** The holder itself, created on first park. */
let _holder: HTMLElement | null = null;

function holder(): HTMLElement | null {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.body) return null;
  if (_holder?.isConnected) return _holder;
  const el = doc.createElement("div");
  el.id = "aio-webview-park";
  el.style.setProperty("display", "none");
  doc.body.append(el);
  _holder = el;
  return el;
}

/** @internal Test seam: how many guests are parked. */
// aio-ok: a test-only seam; the product never inspects its own park
export function _parkedCount(): number {
  return _parked.size;
}

/** @internal Test seam: drop every parked guest. */
// aio-ok: a test-only seam; parking is for the life of the page
export function _clearParked(): void {
  for (const el of _parked.values()) el.remove();
  _parked.clear();
  _holder?.remove();
  _holder = null;
}

/** Props for {@link Browser}. */
export interface BrowserProps {
  /** The page to show. Changing it navigates; re-rendering with the SAME
   *  value does nothing, which is what stops the navigation loop. */
  src: string;
  /** Keep the guest alive across unmounts, under this id. Without it, leaving
   *  the view destroys the page — scroll, forms and login included. */
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
  const { src, keepAlive, partition, onNavigate, ref } = props;

  // `use` runs with the real element, after it is in the document. Everything
  // below is imperative ON PURPOSE: an attribute would be re-applied by the
  // renderer on every pass, and re-applying `src` is the navigation loop.
  const attach = (el: HTMLElement) => {
    const wv = el as WebviewEl;
    const parked = keepAlive ? _parked.get(keepAlive) : undefined;
    if (parked && parked !== wv) {
      // A guest was parked under this id: put it back where this element is
      // and drop the fresh one. The parked guest keeps its scroll, its forms
      // and its session, which is the entire point.
      el.replaceWith(parked);
      _parked.delete(keepAlive!);
      wire(parked);
      return () => park(parked);
    }
    wire(wv);
    return () => (keepAlive ? park(wv) : undefined);
  };

  const wire = (wv: WebviewEl) => {
    if (partition && !wv.getAttribute("partition")) {
      wv.setAttribute("partition", partition);
    }
    navigate(wv, src);
    if (onNavigate && !(wv as { _aioNav?: boolean })._aioNav) {
      (wv as { _aioNav?: boolean })._aioNav = true;
      // `did-navigate-in-page` as well: a single-page guest changes its URL
      // without a load, and an address bar that only follows full navigations
      // goes stale on exactly the pages people use most.
      for (const ev of ["did-navigate", "did-navigate-in-page"]) {
        wv.addEventListener(ev, () => {
          try {
            const now = wv.getURL?.() ?? wv.src ?? "";
            (wv as { _aioUrl?: string })._aioUrl = now;
            onNavigate(now);
          } catch {
            // aio-ok: a destroyed guest throws from getURL, and a teardown
            // race must not take the page with it.
          }
        });
      }
    }
    ref?.(wv);
  };

  const park = (wv: WebviewEl) => {
    if (!keepAlive) return;
    const hold = holder();
    // Nowhere to park it: dropping it is what would have happened anyway, so
    // this degrades to the default rather than throwing during teardown.
    if (!hold) return;
    hold.append(wv);
    _parked.set(keepAlive, wv);
    ref?.(null);
  };

  return h("webview", {
    ...(partition ? { partition } : {}),
    class: props.class,
    style: props.style,
    use: attach,
  });
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
