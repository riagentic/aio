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
import {
  _resetSsrRenders,
  _ssrRenderCurrent,
  _ssrRenderForKey,
  _ssrRenderLast,
  _ssrRenderLastEnded,
  type SsrRender,
} from "./ssr-render.ts";
import { attrNameOf, escapeAttr, escapeHtml } from "./ssr-utils.ts";
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
/** The entries collected by each server render, keyed by the render itself.
 *
 *  ONE list per module was the shape, and every top-level render CLEARED it on
 *  the way in. Two `renderToStream`s interleave at every `yield`, so measured,
 *  a page rendered for one visitor answered `collectHead()` with the other
 *  visitor's `<title>`, description and canonical URL — a response carrying
 *  another response's head. Per render, there is nothing to clear and nothing
 *  to leak; weak, so a render nobody kept is collected with its entries. */
const _ssrHeads = new WeakMap<SsrRender, HeadInput[]>();

/** The entries of a render, created on first use. */
function _entriesOf(render: SsrRender): HeadInput[] {
  let list = _ssrHeads.get(render);
  if (!list) _ssrHeads.set(render, list = []);
  return list;
}
/** Each document's own title before the first owner set one; restored when
 *  that document's last owner unmounts. Absent = nothing overridden. Per
 *  document, because one process can mount apps into several (Electron child
 *  windows, `testUI(App, { document })`). */
let _baseTitles = new WeakMap<Document, string>();
const ATTR = "data-aio-head";
const ONE_PER_PAGE = new Set(["canonical", "manifest", "icon"]);

/** The attributes that give a `<meta>` its identity, in priority order. */
const META_ID_ATTRS = [
  "name",
  "property",
  "http-equiv",
  "charset",
  "itemprop",
] as const;

/** A `<meta>`'s identity: WHICH attribute names it and what that attribute
 *  says — `name=description`, not `description`.
 *
 *  The value alone was the key, so two tags that name DIFFERENT things through
 *  different attributes collided and one of them was silently dropped. The
 *  pair Google's own markup asks for —
 *  `<meta name="description">` beside `<meta itemprop="description">` — shipped
 *  as ONE tag, and so did `{ name: "twitter:title" }` beside
 *  `{ property: "twitter:title" }`. The docs list the attributes as
 *  alternative identity SOURCES; an identity is one of them plus its value. */
function _metaId(t: HeadTag): string | undefined {
  for (const a of META_ID_ATTRS) {
    const v = t[a];
    // An attribute the writers omit (`undefined`/`false`) is not an identity.
    if (v !== undefined && v !== false) return `${a}=${String(v)}`;
  }
  return undefined;
}

/** A tag with its attribute names as HTML spells them.
 *
 *  `httpEquiv` is the camelCase spelling `_tagKey` has always accepted as a
 *  `<meta>`'s identity — the one aio uses everywhere else (`htmlFor` → `for`,
 *  `stopColor` → `stop-color`), and the one a React user types from muscle
 *  memory. Both writers emitted the key VERBATIM, so the tag shipped as
 *  `<meta httpEquiv="refresh">`: attribute names are case-insensitive but not
 *  hyphen-insensitive, so that is `httpequiv`, which no browser reads. The
 *  refresh never fired, the CSP was never applied, and nothing said so — the
 *  silent no-op `htmlFor` had before `_ATTR_NAME` fixed it in ssr-utils.ts.
 *
 *  Through {@linkcode attrNameOf}, the ONE table the client patcher,
 *  hydration and both SSR writers already share — not a second rule for one
 *  key beside it. Two deciders only ever disagree, and this pair did: a
 *  mapping added to the table never reached `<head>`, and the hand-written
 *  rule asked whether the hyphenated key was absent and then re-applied the
 *  tag's own `"http-equiv": undefined` over its own answer, so a tag built by
 *  spreading a base that mentions the key lost the attribute entirely.
 *
 *  Normalized ONCE, here, so `collectHead()` and the live document cannot
 *  disagree — and so a tag that spells it both ways still writes exactly one
 *  attribute, with the hyphenated (explicit) one winning. */
function _htmlAttrs(t: HeadTag): HeadTag {
  let renamed = false;
  for (const k of Object.keys(t)) {
    if (attrNameOf(k) !== k) {
      renamed = true;
      break;
    }
  }
  if (!renamed) return t;
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(t)) {
    const name = attrNameOf(k);
    // The explicit HTML spelling in the same tag wins, and neither spelling
    // is written twice.
    if (name !== k && t[name] !== undefined) continue;
    out[name] = v;
  }
  return out;
}

function _tagKey(kind: "meta" | "link", t: HeadTag): string {
  if (kind === "meta") {
    const id = _metaId(t);
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
    // Normalized BEFORE the key is taken, so the identity and the attribute
    // that carries it are the same name (see `_htmlAttrs`).
    for (const t of e.meta ?? []) {
      const attrs = _htmlAttrs(t);
      tags.set(_tagKey("meta", attrs), { kind: "meta", attrs });
    }
    for (const t of e.link ?? []) {
      const attrs = _htmlAttrs(t);
      tags.set(_tagKey("link", attrs), { kind: "link", attrs });
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
 *  @tier Kit */
export function useHead(input: HeadInput): void {
  // The EXECUTING server render, and not `_isSsrRendering()`, the same
  // question every other hook asks: the latter is true for the WHOLE span of a
  // `renderToStream`,
  // including the async gaps between chunks, so a `useHead` from a timer, a
  // promise continuation or an event handler was silently accepted and what
  // it asked for went into the head of whatever page happened to be streaming
  // — the title of a response changed by code with nothing to do with it, in
  // the one hook whose entire job is the head of a page. This is true only
  // for the synchronous span of one server component call, which is exactly
  // when a component body runs (both writers call components through
  // `_ssrComponent`) — and it identifies WHICH render, so two pages being
  // written at once collect into two lists.
  const render = _ssrRenderCurrent();
  if (render) {
    _entriesOf(render).push(input);
    // Said on the render itself, so the no-argument answer can tell a page
    // that owns a head from one that never asked for one — see
    // `_ssrRenderFinish`.
    render.hasHead = true;
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
 * The `<head>` markup the components of a server render asked for —
 * `<title>`, `<meta>` and `<link>` tags, escaped, each marked `data-aio-head`
 * so the client takes them over on hydration.
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
 * With no argument it answers for the most recent top-level render, which is
 * exactly what the pattern above needs: `renderToString` is synchronous, so
 * nothing can render in between. A `renderToStream` is not — its head is only
 * complete once the stream has ended, and another request may have started
 * rendering in the meantime. Name the render and the answer is exact however
 * many overlapped it: pass the same object to both calls.
 *
 * ```ts
 * for await (const chunk of renderToStream(<App />, req)) write(chunk);
 * const head = collectHead(req);   // this response's head, never another's
 * ```
 *
 * Empty string when no component used {@linkcode useHead}.
 *
 * @param key The object this render was named with in
 * {@linkcode renderToStream} — the `Request` is the natural one. Omitted, the
 * most recent top-level render answers; and if that render is a stream that
 * overlapped another, there is no honest answer and this THROWS rather than
 * hand one page's title to another.
 */
export function collectHead(key?: object): string {
  const render = key === undefined ? _collectTarget() : _ssrRenderForKey(key);
  // A KEY THAT NAMES NOTHING is the mistake this form invites, and its result
  // is indistinguishable from success: an empty string, which is also what a
  // page with no `useHead` answers. So `collectHead(res)` instead of
  // `collectHead(req)`, a `Request` that was cloned between the two calls, or
  // a key passed to `collectHead` but never to `renderToStream`, shipped every
  // page with no title, no description and no canonical — in silence, which is
  // the one thing this module may not do. Observe-only: prod returns the same
  // empty head it always did.
  if (key !== undefined && render === null && isDevMode()) {
    console.warn(
      "[aio-dev] collectHead(key) was given an object that names no server " +
        "render, so the head came back EMPTY. Pass the SAME object to both " +
        "calls — `renderToStream(<App/>, req)` … `collectHead(req)` — or call " +
        "collectHead() with no argument.",
    );
  }
  // Asked for and answered: this render's caller is no longer one that might
  // still be about to ask, so the render that finishes next is not taking its
  // answer away (see `_ssrRenderFinish`).
  if (render) render.collected = true;
  const entries = render ? _ssrHeads.get(render) : undefined;
  const { title, tags } = _merge(entries ?? []);
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

/** Which render a no-argument {@linkcode collectHead} answers for.
 *
 *  A component asking mid-render means its own page. Otherwise it is the most
 *  recently FINISHED top-level render, because a caller always asks after its
 *  own render has ended — start order answers with a render that began after
 *  the caller's had already finished, which is never the caller's (see
 *  `_lastEnded` in ssr-render.ts, where that measured leak is written down).
 *  The fallback to the most recently started one covers the only case with
 *  nothing finished yet: a collect from inside the first render still open.
 *
 *  The one case end order cannot separate is a stream that finished and whose
 *  caller had not asked yet when the next render finished: from then on the
 *  same answer belongs to two callers, so there is no honest one. Guessing
 *  means serving one visitor's title, description and canonical URL inside
 *  another visitor's page. aio's first rule is to fail loud rather than
 *  quietly hand back the wrong thing, and the fix fits in the message.
 *
 *  The refusal is limited to a STREAM's answer for the same reason the whole
 *  ambiguity is: `renderToString` returns before anything else can run, so
 *  its caller's next statement is still its own render's. */
function _collectTarget(): SsrRender | null {
  const current = _ssrRenderCurrent();
  if (current) return current;
  const last = _ssrRenderLastEnded() ?? _ssrRenderLast();
  if (last && last.kind === "stream" && last.superseded) {
    // Reported once for this render, not cascaded onto the next one: the
    // answer has been refused, so the render that finishes after this is
    // taking nothing away from anybody.
    last.collected = true;
    throw new Error(
      "[aio] collectHead() cannot tell which page's head you mean: another " +
        "server render finished while this one's head had not been asked " +
        "for, so the same answer belongs to two responses. Name the render " +
        "and ask for it by name — `renderToStream(<App/>, req)` … " +
        "`collectHead(req)`, with any object that identifies this response.",
    );
  }
  return last;
}

/** @internal Test seam — forget every owner and the remembered base title. */
// aio-ok: a test-only seam; a page never forgets its own head
export function _resetHead(): void {
  _live.clear();
  // The server half too: the renders themselves, so a `collectHead()` in a
  // test that rendered nothing cannot answer with the previous test's page.
  _resetSsrRenders();
  _baseTitles = new WeakMap();
  // The owner sequence too, or it is not a reset: the numbers only have to be
  // relative, but a counter that survives teardown is module state nobody
  // owns, which is what the reset ledger exists to refuse.
  _nextSeq = 0;
}
