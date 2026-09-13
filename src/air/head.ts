// head.ts — per-page <head>: the title, meta and link tags a component owns.
//
// THE GAP THIS CLOSES. `ui.head` is one string for the whole app, decided at
// boot; nothing in AIR could say "this page is called X" — so a notes app
// showed "notes" on every tab, a shared link had no description, and the
// README's "not for content sites" rested on exactly this. The primitive is
// small and it is the only one that was missing.
//
// ONE MECHANISM, TWO SIDES. A component calls `useHead({ title, meta, link })`
// in its body, like any other hook. On the client the entries of every LIVE
// component are merged — innermost/most recently mounted wins the title, tags
// deduplicate by identity — and written to the document each time one is set
// or removed; unmounting the last owner restores the title the page came with.
// On the server (`renderToString` / `renderToStream`) there is no document, so
// the entries are collected and `collectHead()` returns them as markup for the
// caller's own `<head>` — the same contract `collectCss()` has. AIR's render is
// synchronous, so the body render is enough to know the head; no second pass.
//
// WHY RENDER-DRIVEN, NOT ROUTER-DRIVEN. The title of a page is a function of
// what is rendered — a route, a tab, a `page()` state, a modal — and the
// renderer already knows when that changes: the component re-renders or
// unmounts. Hooking the router would have covered one of those cases and
// silently missed the rest. This covers every one, with no router coupling.
//
// NO COLLECTOR ON THE SERVER. SSR calls a component function directly, with no
// instance to attach cleanups to (`useRef`/`onCleanup` would warn in dev and
// drop). So the server path never touches those: it appends to a per-render
// list that the SSR start hook clears.

import { _inRender, onCleanup, useRef } from "./renderer-lifecycle.ts";
import { _activeRoot } from "./renderer-state.ts";
import { _isSsrRendering } from "./vdom-ssr.ts";
import { escapeAttr, escapeHtml } from "./ssr-utils.ts";
import { isDevMode } from "../state/dev-flag.ts";

/** One `<meta>` or `<link>` as attributes: `{ name: "description", content }`,
 *  `{ property: "og:title", content }`, `{ rel: "canonical", href }`. A
 *  `true` value is a bare attribute; `false`/`undefined` omit it. */
export type HeadTag = Readonly<
  Record<string, string | number | boolean | undefined>
>;

/** What a component asks for in `<head>`. Every field is optional; a
 *  component that owns only the title passes only `title`. */
export interface HeadInput {
  /** `document.title` while this component is mounted. Innermost wins. */
  readonly title?: string;
  /** `<meta>` tags. Deduplicated by `name` / `property` / `http-equiv` /
   *  `charset` / `itemprop` — a page's `description` replaces a layout's. */
  readonly meta?: readonly HeadTag[];
  /** `<link>` tags. Deduplicated by `rel` + `href`, except `canonical`,
   *  `manifest` and `icon`, which are one per page and deduplicate by `rel`. */
  readonly link?: readonly HeadTag[];
}

type Merged = {
  title: string | undefined;
  tags: { kind: "meta" | "link"; attrs: HeadTag }[];
};

/** Live client entries, keyed by component instance.
 *
 *  INSERTION ORDER IS NOT MOUNT ORDER, which is the trap this comment used to
 *  walk into. `useHead` registers its cleanup in the component BODY, and a
 *  body cleanup runs before every re-render as well as on unmount — so each
 *  re-render deletes the entry and re-adds it, moving that owner to the END
 *  of the Map. `_merge` is "later wins", so a layout that re-rendered for a
 *  reason of its own (a theme signal, an unread count) jumped ahead of the
 *  page inside it and took the title, the description and the canonical with
 *  it, permanently, until something else happened to re-render. SSR, which
 *  renders parent before child in one pass, got it right — so the same app
 *  disagreed with itself either side of hydration.
 *
 *  So each owner carries the sequence number it was FIRST seen with, and
 *  `_merge` reads them in that order. Components render outside-in, so first
 *  registration IS depth order, and re-registration cannot change it. */
const _live = new Map<HeadOwner, HeadInput>();
/** A component instance that owns part of `<head>`, with its mount order and
 *  the document it was rendered into. */
type HeadOwner = { seq: number; doc?: Document };
let _nextSeq = 0;

/** Live entries of the owners rendered into `doc`, oldest owner first. */
function _liveInOrder(doc: Document): HeadInput[] {
  return [..._live.entries()]
    .filter(([owner]) => owner.doc === doc)
    .sort((a, b) => a[0].seq - b[0].seq)
    .map(([, input]) => input);
}
/** Entries of the SSR render in progress. */
let _ssr: HeadInput[] = [];
/** Each document's own title before the first owner set one; restored when
 *  that document's last owner unmounts. Absent = nothing overridden. Per
 *  document, because one process can mount apps into several (Electron child
 *  windows, `testUI(App, { document })`). */
let _baseTitles = new WeakMap<Document, string>();
const ATTR = "data-aio-head";
const ONE_PER_PAGE = new Set(["canonical", "manifest", "icon"]);

function _tagKey(kind: "meta" | "link", t: HeadTag): string {
  if (kind === "meta") {
    const id = t.name ?? t.property ?? t["http-equiv"] ?? t.httpEquiv ??
      t.charset ?? t.itemprop;
    return id === undefined ? `meta:${JSON.stringify(t)}` : `meta:${id}`;
  }
  const rel = String(t.rel ?? "");
  return ONE_PER_PAGE.has(rel) ? `link:${rel}` : `link:${rel}:${t.href ?? ""}`;
}

/** Merge entries in order: the later title wins; a later tag with the same
 *  identity replaces the earlier one IN PLACE (its position is the first
 *  owner's, so a layout's order is kept and a page's value is used). */
function _merge(entries: Iterable<HeadInput>): Merged {
  let title: string | undefined;
  const tags = new Map<string, Merged["tags"][number]>();
  for (const e of entries) {
    if (e.title !== undefined) title = e.title;
    for (const t of e.meta ?? []) {
      tags.set(_tagKey("meta", t), { kind: "meta", attrs: t });
    }
    for (const t of e.link ?? []) {
      tags.set(_tagKey("link", t), { kind: "link", attrs: t });
    }
  }
  return { title, tags: [...tags.values()] };
}

/** Write the merged head to the live document. Replaces every tag this
 *  module owns (`data-aio-head`) rather than diffing: a page has a handful of
 *  them, and "remove ours, add ours" cannot leave a stale one behind. Tags the
 *  shell or the author put in `<head>` are never touched. */
function _apply(doc: Document | undefined): void {
  if (!doc?.head) return;
  const { title, tags } = _merge(_liveInOrder(doc));
  const base = _baseTitles.get(doc);
  if (title !== undefined) {
    if (base === undefined) _baseTitles.set(doc, doc.title);
    if (doc.title !== title) doc.title = title;
  } else if (base !== undefined) {
    doc.title = base;
    _baseTitles.delete(doc);
  }
  for (const el of Array.from(doc.head.querySelectorAll(`[${ATTR}]`))) {
    el.remove();
  }
  for (const t of tags) {
    const el = doc.createElement(t.kind);
    for (const [k, v] of Object.entries(t.attrs)) {
      if (v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? "" : String(v));
    }
    el.setAttribute(ATTR, "");
    doc.head.appendChild(el);
  }
}

/** The document the component rendering RIGHT NOW is mounted in. */
function _renderDoc(): Document | undefined {
  // The MOUNTED document, not the ambient global — the rule every other hook
  // in this renderer follows (`onGlobalKey`/`onWindowEvent` resolve it the
  // same way, and their comments name Electron child windows and `<webview>`
  // for the reason).
  //
  // Reading `globalThis.document` had two costs. In a multi-window Electron
  // app it retitled the WRONG window: measured, the app mounted in window B
  // and `useHead({ title: "Invoice #42" })` set window A's title and put the
  // meta tags in A's head. And under the supported `testUI(App, { document })`
  // path there is no ambient global at all, so the hook RAN, returned
  // normally, wrote nothing and warned nothing — a silent no-op, in a
  // framework whose first rule is "fail loud, never silent". A `useHead` test
  // written that way passed while asserting nothing.
  //
  // …and asked at RENDER time, where the root is known. The cleanup that hands
  // the title back runs at unmount, when no root is active: resolving the
  // document there fell back to the global, so a root `_unmount` left a BYO
  // document's title and tags in place forever, and in a two-window app wrote
  // window B's saved title into window A.
  return (_activeRoot?.root?.ownerDocument ??
    (globalThis as { document?: Document }).document) as Document | undefined;
}

/**
 * Own part of `<head>` for as long as this component is mounted.
 *
 * ```tsx
 * function Post({ id }: { id: string }) {
 *   const post = blog.posts[id];
 *   useHead({
 *     title: `${post.title} — My Blog`,
 *     meta: [{ name: "description", content: post.summary }],
 *     link: [{ rel: "canonical", href: `https://example.com/p/${id}` }],
 *   });
 *   return <article>…</article>;
 * }
 * ```
 *
 * Reads are reactive like any render: when `post.title` changes the component
 * re-renders and the title follows. A layout can set a default title and a
 * page inside it overrides it; unmount the page and the layout's is back;
 * unmount them all and the document's original title is restored.
 *
 * On the server, inside `renderToString`, nothing is written — call
 * {@linkcode collectHead} afterwards and put the result in your `<head>`.
 */
export function useHead(input: HeadInput): void {
  if (_isSsrRendering()) {
    _ssr.push(input);
    return;
  }
  if (!_inRender()) {
    if (isDevMode()) {
      console.warn(
        "[aio-dev] useHead() called outside a component render — there is no " +
          "component to bind the title's lifetime to, so it was DROPPED. Call " +
          "it in a component body.",
      );
    }
    return;
  }
  // A stable identity per component INSTANCE, not per call: two `<Post/>`s
  // are two owners, and a re-render of one is the same owner. The sequence
  // number is stamped on FIRST render and never moves — see `_live`.
  const owner = useRef<HeadOwner>({ seq: -1 }).current;
  if (owner.seq < 0) owner.seq = _nextSeq++;
  const doc = _renderDoc();
  owner.doc = doc;
  _live.set(owner, input);
  onCleanup(() => {
    _live.delete(owner);
    _apply(doc);
  });
  _apply(doc);
}

/**
 * The `<head>` markup the components rendered by the last top-level
 * `renderToString` / `renderToStream` asked for — `<title>`, `<meta>` and
 * `<link>` tags, escaped, each marked `data-aio-head` so the client takes
 * them over on hydration.
 *
 * ```ts
 * const body = renderToString(<App />);
 * const head = collectHead();   // after the body: render is sync, so it is known
 * // collectHead() returns MARKUP; collectCss() returns CSS, so it needs a
 * // <style> around it — bare, a browser treats it as text and applies none.
 * return `<!doctype html><html><head>${head}<style>${collectCss()}</style>` +
 *   `</head><body>${body}</body></html>`;
 * ```
 *
 * Empty string when no component used {@linkcode useHead}. With
 * `renderToStream` the head is complete only when the stream has ended, so
 * either render the page once with `renderToString` for its head, or write
 * the head after the stream.
 */
export function collectHead(): string {
  const { title, tags } = _merge(_ssr);
  const out: string[] = [];
  if (title !== undefined) out.push(`<title>${escapeHtml(title)}</title>`);
  for (const t of tags) {
    let attrs = "";
    for (const [k, v] of Object.entries(t.attrs)) {
      if (v === undefined || v === false) continue;
      attrs += v === true ? ` ${k}` : ` ${k}="${escapeAttr(String(v))}"`;
    }
    out.push(`<${t.kind}${attrs} ${ATTR}>`);
  }
  return out.join("");
}

/** @internal Called at the start of every top-level SSR render, so one
 *  request's head never leaks into the next. */
export function _resetHeadSsr(): void {
  _ssr = [];
}

/** @internal Test seam — forget every owner and the remembered base title. */
// aio-ok: a test-only seam; a page never forgets its own head
export function _resetHead(): void {
  _live.clear();
  _ssr = [];
  _baseTitles = new WeakMap();
  // The owner sequence too, or it is not a reset: the numbers only have to be
  // relative, but a counter that survives teardown is module state nobody
  // owns, which is what the reset ledger exists to refuse.
  _nextSeq = 0;
}
