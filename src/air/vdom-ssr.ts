// VDOM SSR — renderToString and SSR lifecycle hooks.
// Renders a VNode tree to an HTML string without requiring a DOM environment.

import { resolveSignalProp } from "./signal-binding.ts";
import {
  attrNameOf,
  camelToKebab as _camelToKebab,
  escapeAttr as _escapeAttr,
  escapeHtml as _escapeHtml,
  RAW_TEXT_ELEMENTS,
  rawTextContent,
  resolveClassName as _resolveClassName,
  ssrCloseSelect,
  ssrOpenSelect,
  ssrOptionProps,
  styleValue as _styleValue,
  VOID_ELEMENTS,
} from "./ssr-utils.ts";
import { isDevMode } from "../state/dev-flag.ts";
import {
  _assertAttrName,
  _classProp,
  _propAttr,
  _RESERVED_PROPS,
  _STRING_FALSE_ATTRS,
} from "./prop-write.ts";
import {
  _ssrLateRouteSiteOnce,
  _ssrRenderEnter,
  _ssrRenderEpoch,
  _ssrRenderFinish,
  _ssrRenderNew,
  _ssrRenderOf,
  _ssrRenderSetUp,
  _ssrRenderStart,
  SSR_RENDER_KEY,
  type SsrRender,
} from "./ssr-render.ts";
import type { Signal } from "../state/signal.ts";
import type { ComponentFn, VNode } from "./vdom-types.ts";
import {
  _hasRawHtml,
  _LAZY_PENDING,
  _Null,
  _SignalText,
  ErrorBoundary,
  Fragment,
  Portal,
  Suspense,
} from "./vdom-types.ts";
import { _notANode } from "./vdom-create.ts";
import { _sigText } from "./vdom-helpers.ts";

// The SSR start hook that used to live here is gone. It existed to RESET the
// module-level id counter, `<head>` list and `<select>` stack at the start of
// every top-level render — which is the same thing as saying those three were
// shared by every render at once, and resetting them is what made two
// concurrent streams corrupt each other (see ssr-render.ts). Each render owns
// them now, so there is nothing to reset and nothing to forget.

// ── Attribute serialization — the ONE decider both SSR writers use ────

/** Which tags actually OWN each boolean form property.
 *
 *  `applyProps` decides "is this a boolean DOM property?" by asking the element
 *  (`k in el && _DOM_PROPS.has(k)`), so it writes `checked`/`disabled`/… as a
 *  property on a form control and as a PLAIN ATTRIBUTE on anything else —
 *  `<div disabled>` becomes `disabled="true"`. SSR answered by name alone and
 *  emitted the bare boolean token `disabled` for every tag, so the server sent
 *  `<div disabled="">` where the client builds `<div disabled="true">`: the
 *  same vnode, two documents, and an attribute selector that matches on one
 *  render and not the other. Same question, one answer.
 *
 *  Keyed by the ATTRIBUTE name, because that is what the lookup below holds —
 *  `_propAttr` has already mapped the JSX name to it. The one entry that was
 *  keyed by its JSX name instead (`readOnly`, whose attribute is `readonly`)
 *  could therefore never be found: `<input readOnly>` fell through to the
 *  generic branch and shipped `readonly="true"` where mount builds
 *  `readonly=""`. That is a divergence hydration then REPORTS — the renderer's
 *  loudest dev warning, fired on correct code. `defaultChecked` needs no entry
 *  of its own: `_propAttr` maps it to `checked`, which is here. */
const _BOOL_ATTR_TAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  checked: new Set(["input"]),
  selected: new Set(["option"]),
  disabled: new Set([
    "button",
    "fieldset",
    "input",
    "optgroup",
    "option",
    "select",
    "textarea",
  ]),
  readonly: new Set(["input", "textarea"]),
  multiple: new Set(["input", "select"]),
};

/** Serialize an element's props to an HTML attribute string.
 *
 *  `renderToString` and `renderToStream` are two entry points to the SAME
 *  document; each used to carry its own copy of this loop, and the copies drifted
 *  — the streaming writer kept emitting the `t` semantic marker for a whole
 *  release after the string writer stopped, so a streamed page shipped
 *  attributes the client renderer never produces and hydration could not
 *  reconcile. There is one rule for how a prop becomes an attribute; it lives
 *  here, and both writers call it. */
export function _renderPropsHtml(
  props: Record<string, unknown>,
  tag?: string,
): string {
  let html = "";
  // `class` and `className` are ONE attribute — the later key wins, exactly as
  // `_writeProp` resolves it on the client. Emitting both produced invalid
  // markup whose parser kept the FIRST, i.e. the opposite class from mount.
  const classKey = _classProp(props);
  for (const [k, rawV] of Object.entries(props)) {
    if ((k === "class" || k === "className") && k !== classKey) continue;
    if (
      // Framework metadata — the same set the client renderer refuses to write,
      // `t` (the semantic marker) included.
      _RESERVED_PROPS.has(k) ||
      k === "dangerouslySetInnerHTML" ||
      // `t` is the SEMANTIC marker (testUI / `am surface` read it from the
      // component tree, never from the DOM). The client renderer already
      // skips it; SSR used to emit it, so server HTML and the live DOM
      // disagreed — and every DOM-probing tool that looked for it found
      // nothing once hydration replaced the markup.
      k === "t"
    ) continue;
    if (k.startsWith("on")) continue; // Skip event handlers in SSR
    // A DOM-property prop is written under the attribute that expresses it —
    // `<select value>` and `<textarea value>` have none, so they emit nothing
    // (the textarea's value is emitted as its TEXT by `_ssrTextareaText`).
    const mapped = _propAttr(tag ?? "", k);
    if (mapped === null) continue;
    const name = mapped ?? k;
    // A name the DOM would refuse. `setAttribute` throws
    // `InvalidCharacterError` for it on the client, while SSR used to paste it
    // into the tag verbatim — so `{...{"x onload=alert(1)": 1}}` shipped
    // `<div x onload=alert(1)="1">`, an event handler an HTML parser reads and
    // runs. ONE decider, shared with `_writeProp`: see `_assertAttrName`.
    _assertAttrName(attrNameOf(name), tag ?? "");
    // AIO-109: resolve signals to current value for SSR
    const v = resolveSignalProp(rawV);

    if (k === "className") {
      const cls = _resolveClassName(v);
      if (cls) html += ` class="${_escapeAttr(cls)}"`;
    } else if (k === "style" && typeof v === "string") {
      if (v) html += ` style="${_escapeAttr(v)}"`;
    } else if (k === "style" && typeof v === "object" && v !== null) {
      // A declaration whose value resolves to "" is NO declaration — the rule
      // `styleValue` defines and the client applies via `setProperty(k, "")`.
      // Filtering the raw value (`!= null`, AIO-164) missed `false` and a
      // signal that resolves to null, and emitted `display:false`.
      const pairs = Object.entries(v as Record<string, unknown>)
        .map(([sk, sv]) => [sk, _styleValue(sk, resolveSignalProp(sv))])
        .filter(([_, sv]) => sv !== "")
        .map(([sk, sv]) => `${_camelToKebab(sk!)}:${sv}`)
        .join(";");
      if (pairs) html += ` style="${_escapeAttr(pairs)}"`;
    } else if (_BOOL_ATTR_TAGS[name]?.has(tag ?? "")) {
      if (v) html += ` ${name}`;
    } else if (v === false && _STRING_FALSE_ATTRS(name)) {
      // `false` is a VALUE for `aria-*` and the enumerated attributes, not an
      // absence — the same rule the client patcher applies, so the server does
      // not hydrate into a different accessibility tree. See
      // `_STRING_FALSE_ATTRS`.
      html += ` ${attrNameOf(name)}="false"`;
    } else if (v !== false && v != null) {
      // AIO-187: render all non-boolean attrs with explicit value
      // (known boolean attrs like checked/disabled handled above)
      html += ` ${attrNameOf(name)}="${_escapeAttr(String(v))}"`;
    }
  }
  return html;
}

/** The text a `<textarea value={…}>` must carry in markup, or null when the
 *  element has no value prop (or has explicit children, which win).
 *
 *  A textarea has no `value` content attribute: its value IS its child text.
 *  `<textarea value={state.body}>` — the shape `docs/examples/04-electron-app.md`
 *  documents — therefore server-rendered as an EMPTY box with a meaningless
 *  `value="…"` attribute, and hydration never wrote the property, so the editor
 *  stayed empty. Typing into it and letting the `onChange` write back then
 *  replaced the stored note with what was typed into a blank textarea.
 *
 *  All three SSR element writers (`renderToString`, `renderToStream` and its
 *  sync fallback) call this, so there is one answer to "what is inside a
 *  textarea". */
export function _ssrTextareaText(vnode: VNode): string | null {
  if (vnode.tag !== "textarea" || vnode.children.length > 0) return null;
  const raw = vnode.props.value ?? vnode.props.defaultValue;
  const v = resolveSignalProp(raw);
  return v == null ? null : _escapeHtml(String(v));
}

/** AIO-195 parity: an empty Fragment / ErrorBoundary / Suspense gets a comment
 *  ANCHOR when built by `createDom`, because it must keep its slot among its
 *  siblings. SSR emitted nothing, so a hydrated empty container had no `_dom` at
 *  all and its next diff anchored at the parent's FIRST child — a list that
 *  starts empty and then fills rendered its rows ABOVE the header. Server HTML
 *  and client DOM must be the same document. */
const _EMPTY_ANCHOR = "<!---->";

/** How many DOM nodes the markup written so far stands for — threaded through
 *  every SSR writer so a region can tell "nothing here" from "here, but it
 *  serializes to nothing". */
export interface SsrNodes {
  n: number;
}

/** The markup of a region (Fragment / ErrorBoundary / Suspense children) —
 *  the ONE rule for when a region is empty and holds its slot with an anchor.
 *
 *  "Empty" means NO REALIZED NODE, not an empty string: `createDom` makes a
 *  text node for `""` and none for a Portal, so `<>{""}</>` is a one-node
 *  region and `<><Portal/></>` a zero-node one. The writers used to ask
 *  `html === ""` instead, which is the wrong question on both counts — a
 *  Fragment whose only child was `""` shipped an anchor the client never
 *  builds, and hydration then claimed the comment for a text child and fell
 *  out of step for the rest of the parent. */
export function _regionHtml(html: string, nodes: number): string {
  return nodes === 0 ? _EMPTY_ANCHOR : html;
}

// ── SSR depth counter ──────────────────────────────────────────────
let _ssrDepth = 0;

/** @internal True while a top-level `renderToString` / `renderToStream` is
 *  running — the branch a hook takes when there is no component instance
 *  (SSR calls component functions directly) and no document. */
export function _isSsrRendering(): boolean {
  return _ssrDepth > 0;
}

/** Mark a server render as in progress for a span that is NOT one synchronous
 *  `renderToString` call.
 *
 *  `renderToStream` is an async generator, so it cannot use the try/finally
 *  below; it never marked SSR at all, and everything that asks
 *  `_isSsrRendering()` took the CLIENT branch for a streamed page. `useHead`
 *  was the visible casualty: a streamed page shipped with no title, no
 *  description and no canonical, silently in production and in dev with a
 *  warning that blamed the author for calling `useHead` "outside a component
 *  render" when they had done exactly the right thing. A nested
 *  `renderToString` inside a stream also looked top-level, so it re-fired the
 *  SSR start hook and wiped the head collected so far. */
export function _enterSsr(): void {
  _ssrDepth++;
}

/** End the span opened by {@linkcode _enterSsr}. */
export function _exitSsr(): void {
  if (_ssrDepth > 0) _ssrDepth--;
}

// ── SSR context scope ──────────────────────────────────────────────
//
// On the client a `<Provider>` writes its value into the component INSTANCE
// that rendered it, and `useContext` walks `_instanceStack` for it. A server
// render has neither — it calls component functions directly — so the Provider
// wrote nowhere and every `useContext` answered the DEFAULT:
// `renderToString(<C.Provider value="provided"><R/></C.Provider>)` shipped
// "default", and a nested `<Route>` shipped an empty `<Outlet>` (the route
// context is a context). Hydration then adopted markup the client does not
// build.
//
// The scope is LEXICAL, threaded through the writers as a parameter, because
// `renderToString` recursion is not the only shape: `renderToStream` is an
// async generator, and two concurrent streams interleave at every `yield`, so a
// module-global push/pop stack would hand one request the other's providers.
// The only global is `_ssrCall` below, and it is set for the SYNCHRONOUS span
// of one component call — no yield can happen inside it.

/** The context values visible to a subtree of a server render: context id →
 *  the value its nearest Provider was given. Null means none. */
export type SsrContexts = ReadonlyMap<symbol, unknown> | null;

/** The component call in progress: what it can see, and what it provided. */
let _ssrCall: {
  visible: SsrContexts;
  provided: Map<symbol, unknown> | null;
} | null = null;

/** No Provider above — distinct from a Provider whose value is `undefined`. */
export const _SSR_NO_CONTEXT: unique symbol = Symbol("aio.ssrNoContext");

/** @internal The value a server render's scope holds for context `id`, or
 *  `_SSR_NO_CONTEXT`. Null when no server component call is in progress — the
 *  caller then asks the client instance stack. */
export function _ssrContextValue(id: symbol): unknown {
  if (!_ssrCall) return null;
  const v = _ssrCall.visible;
  return v !== null && v.has(id) ? v.get(id) : _SSR_NO_CONTEXT;
}

/** @internal Whether a server component call is in progress. */
export function _inSsrCall(): boolean {
  return _ssrCall !== null;
}

/** @internal A Provider rendering on the server records its value for its
 *  children. False when no server component call is in progress. */
export function _ssrProvide(id: symbol, value: unknown): boolean {
  if (!_ssrCall) return false;
  (_ssrCall.provided ??= new Map()).set(id, value);
  return true;
}

/** @internal Run `fn` as a server render step that sees `visible`; returns its
 *  result and the scope its output renders in (`visible` plus whatever a
 *  Provider in `fn` provided). Shared by all three writers so there is one
 *  rule for what a subtree of a server render can see. */
export function _ssrScoped<T>(
  visible: SsrContexts,
  fn: () => T,
): { out: T; scope: SsrContexts } {
  const prev = _ssrCall;
  const call = { visible, provided: null as Map<symbol, unknown> | null };
  _ssrCall = call;
  // …and say WHICH render is executing, for the same synchronous span. The
  // hooks (`useId`, `useHead`) run in a component body and nowhere else, so
  // this is the only moment they need an answer — and no `yield` can happen
  // inside it, which is what keeps one global honest under concurrency.
  const prevRender = _ssrRenderEnter(_ssrRenderOf(visible));
  let out: T;
  try {
    out = fn();
  } finally {
    _ssrCall = prev;
    _ssrRenderEnter(prevRender);
  }
  const provided = call.provided;
  if (provided === null) return { out, scope: visible };
  const scope = new Map(visible ?? []);
  for (const [k, v] of provided) scope.set(k, v);
  return { out, scope };
}

/** @internal Call a component vnode for a server render in `visible`. */
export function _ssrComponent(
  vnode: VNode,
  visible: SsrContexts,
): { out: VNode | string | number | null; scope: SsrContexts } {
  return _ssrScoped(visible, () =>
    (vnode.tag as ComponentFn)({
      ...vnode.props,
      children: vnode.children.length > 0
        ? vnode.children
        : (vnode.props.children ?? vnode.children),
    }));
}

/** Request state a server render SNAPSHOTS when it starts, by id.
 *
 *  A routed app renders the route in the module-level `routePath` signal,
 *  which the request handler sets before rendering. `renderToString` renders
 *  in one synchronous call, so the value it reads is the one just set.
 *  `renderToStream` does not: it calls each component when its chunk is
 *  pulled, so a second request that set `routePath` while the first stream was
 *  still being written re-routed the FIRST response — measured, a stream
 *  started at `/p/42` finished as the `/about` page. The router registers a
 *  capture here; each top-level render reads it once into its root scope, and
 *  every component call of that render sees its own snapshot. */
const _ssrCaptures = new Map<
  symbol,
  { read: () => unknown; same: (a: unknown, b: unknown) => boolean }
>();

/** @internal Snapshot `read()` under `id` at the start of every top-level
 *  server render (read back with `_ssrContextValue(id)`). `same` tells two
 *  snapshots apart (default `Object.is`) — see {@linkcode _ssrStreamSettler}. */
export function _registerSsrCapture(
  id: symbol,
  read: () => unknown,
  same: (a: unknown, b: unknown) => boolean = Object.is,
): void {
  _ssrCaptures.set(id, { read, same });
}

/** @internal The current render epoch (see `_ssrRenderSetUp`). */
export function _ssrRootEpoch(): number {
  return _ssrRenderEpoch();
}

/** The values the most recent top-level set-up snapshotted — what the live
 *  values are EXPECTED to be while nobody sets them after a call. */
let _ssrLatest: ReadonlyMap<symbol, unknown> = new Map();

/** Streams whose request values are not settled yet (see
 *  {@linkcode _ssrStreamSettler}): each hears of every top-level set-up that
 *  follows its own until it settles — at the end of its call's turn, or at
 *  its first pull if that comes sooner — so a set is at most the streams of
 *  one synchronous turn. */
const _ssrUnsettled = new Set<{ since: ReadonlyMap<symbol, unknown>[] }>();

/** @internal Test seam — how many streams are waiting to settle. Zero once
 *  the turn that created them has ended, whatever became of the streams. */
// aio-ok: test seam — read by tests/air-ssr-stream-1-0-9-compat (a stream never outlives its turn)
export function _ssrUnsettledCount(): number {
  return _ssrUnsettled.size;
}

/** The call site of a stream, as the first stack frame outside this module's
 *  own set-up. */
function _siteOf(site: Error): string {
  const frames = (site.stack ?? "").split("\n").slice(1);
  return frames.find((f) => !/ssr-stream\.ts|vdom-ssr\.ts/.test(f))
    ?.trim() ?? "unknown";
}

/** The live re-read CHANGED a value: 1.0.9 honoured it and so does this, but
 *  no timing can tell this stream's own late write from another request's
 *  (two requests resumed by one shared promise run in one turn), so it is
 *  said — once per call site, observe-only, dev and prod alike. */
function _warnLateRouteAt(site: Error): void {
  const at = _siteOf(site);
  if (!_ssrLateRouteSiteOnce(at)) return;
  console.warn(
    "[aio] routePath changed after renderToStream() — set it BEFORE the " +
      "call; under concurrent requests this can render another request's " +
      `route (${at}).`,
  );
}

/** The values changed after this stream's turn and before its first read,
 *  and the change is not another render's set-up: 1.0.9 rendered the new
 *  value, this renders the one it was called with — said, once per call site
 *  (observe-only, dev and prod alike). */
function _warnRouteBeforePullAt(site: Error): void {
  const at = _siteOf(site);
  if (!_ssrLateRouteSiteOnce("pull " + at)) return;
  console.warn(
    "[aio] routePath changed after renderToStream() was called and before " +
      "the stream was first read — the stream renders the route it was " +
      "CALLED with (1.0.9 read it at the first read). Set routePath before " +
      `renderToStream(), with no await in between (${at}).`,
  );
}

/** Whether two snapshots hold the same request values. */
function _ssrSameValues(
  x: ReadonlyMap<symbol, unknown>,
  y: ReadonlyMap<symbol, unknown>,
): boolean {
  for (const [id, { same }] of _ssrCaptures) {
    if (!same(x.get(id), y.get(id))) return false;
  }
  return true;
}

/** The values changed after this stream's call, in the same turn as another
 *  top-level render's set-up that took DIFFERENT values: the snapshot stands.
 *  A live value that is neither this stream's nor any of those renders' was
 *  set after all of them, by nobody who rendered — said once per call site.
 *  A live value that IS one of theirs is correct concurrent code (two requests
 *  resumed by one shared promise, each setting and rendering) and says
 *  nothing. */
function _ssrSameTurnCheck(
  scope: ReadonlyMap<symbol, unknown>,
  since: readonly ReadonlyMap<symbol, unknown>[],
  site: Error,
): void {
  for (const [id, { read, same }] of _ssrCaptures) {
    let now: unknown;
    try {
      now = read();
    } catch {
      continue; // aio-ok: the comparison is observe-only; the snapshot stands
    }
    if (same(scope.get(id), now) || since.some((o) => same(o.get(id), now))) {
      continue;
    }
    const at = _siteOf(site);
    if (!_ssrLateRouteSiteOnce("turn " + at)) return;
    console.warn(
      "[aio] renderToStream(): the route (or another request value) changed " +
        "after renderToStream() was called, in the same turn as another " +
        "render's call — this stream keeps the value it was CALLED with. " +
        `Set routePath before renderToStream(), with no await in between (${at}).`,
    );
    return;
  }
}

/** @internal Settle which request values a top-level stream renders with.
 *
 *  `renderToStream` snapshots them at its call: a handler that awaits between
 *  creating the body and sending it must not render the NEXT request's route.
 *  1.0.9 read them at the first pull instead, and code written against it
 *  creates the stream and THEN sets the route — in the same synchronous turn
 *  (`const body = renderToStream(<App/>); routePath.set(p)`). That one window,
 *  and only that one, is honoured: the values are read again, live, ONCE, at
 *  the end of the call's turn (a microtask) or at the first pull if that comes
 *  sooner — and never again, so a route another request sets later (even one
 *  that has not called `renderToStream` yet: its session read, its reset
 *  token) can never reach this page. If another top-level render set up in
 *  that same turn took DIFFERENT values, the live value may be ITS, so the
 *  snapshot stands, and only a live value that is none of those renders' is
 *  said (once per call site); renders that took this stream's own values
 *  (1.0.9's two streams created before one `routePath.set`) do not count.
 *
 *  A write after the turn is not honoured — it is the other request's as
 *  often as it is this one's — but it is not silent either: at the first pull,
 *  a live value that differs from the settled one while nothing was set up
 *  since the call, or that is not the latest set-up's, is said once per call
 *  site (observe-only, dev and prod alike). 1.0.9 code that creates the
 *  stream, awaits, and then sets the route lands there.
 *
 *  Returns the settle function: idempotent, it gives the scope to render with
 *  and throws what a live read threw (at the first pull, as 1.0.9 did);
 *  `pull` is true for the stream's first pull. */
export function _ssrStreamSettler(
  scope: SsrContexts,
  epoch: number,
  site: Error,
): (pull: boolean) => SsrContexts {
  const pending = { since: [] as ReadonlyMap<symbol, unknown>[] };
  if (scope !== null) _ssrUnsettled.add(pending);
  let done = false;
  let pulled = false;
  let out: SsrContexts = scope;
  let error: { e: unknown } | null = null;
  const settle = (pull: boolean): SsrContexts => {
    if (!done) {
      done = true;
      _ssrUnsettled.delete(pending);
      // Re-read live when nobody else can have set the value: no render was
      // set up since, or every one that was took THIS stream's values (the
      // same request, or one on the same route — 1.0.9's two streams created
      // before one `routePath.set`).
      if (
        scope !== null &&
        pending.since.every((o) => _ssrSameValues(scope, o))
      ) {
        try {
          const fresh = new Map(scope);
          let changed = false;
          for (const [id, { read, same }] of _ssrCaptures) {
            const now = read();
            if (!same(scope.get(id), now)) changed = true;
            fresh.set(id, now);
          }
          out = fresh;
          if (changed) _warnLateRouteAt(site);
        } catch (e) {
          error = { e }; // thrown from the first pull, where 1.0.9 threw it
        }
      } else if (scope !== null) {
        _ssrSameTurnCheck(scope, pending.since, site);
      }
    } else if (pull && !pulled && error === null && out !== null) {
      // Settled at the end of the call's turn; this is the first pull.
      const unchanged = epoch === _ssrRenderEpoch();
      for (const [id, { read, same }] of _ssrCaptures) {
        let now: unknown;
        try {
          now = read();
        } catch {
          continue; // aio-ok: the comparison is observe-only
        }
        if (
          !same(out.get(id), now) &&
          (unchanged || !same(_ssrLatest.get(id), now))
        ) {
          _warnRouteBeforePullAt(site);
          break;
        }
      }
    }
    if (pull) pulled = true;
    if (error) throw error.e;
    return out;
  };
  queueMicrotask(() => {
    try {
      settle(false);
    } catch {
      // aio-ok: held in `error` and rethrown by the stream's first pull
    }
  });
  return settle;
}

/** @internal The scope a top-level writer starts in: the request snapshots
 *  (see `_ssrCaptures`) plus `render`, the state this render owns — or, for a
 *  render nested inside a server component call, what that call sees, WITH the
 *  enclosing render's state. A `renderToString` inside a streamed component is
 *  part of that page: one id sequence, one `<head>`.
 *
 *  The caller can therefore tell top-level from nested by asking whether the
 *  scope came back carrying the render it offered — one question, one answer,
 *  instead of a second depth counter that could disagree with this one. */
export function _ssrRootScope(render: SsrRender): SsrContexts {
  if (_ssrCall) return _ssrCall.visible;
  const scope = new Map<symbol, unknown>();
  for (const [id, { read }] of _ssrCaptures) scope.set(id, read());
  // The map itself, not a copy: a root scope is only ever written here, before
  // it is returned — every later scope is a new Map built from it — so this
  // stays exactly the snapshot it was (read for capture ids only).
  _ssrLatest = scope;
  for (const p of _ssrUnsettled) p.since.push(scope);
  scope.set(SSR_RENDER_KEY, render);
  _ssrRenderSetUp(render);
  return scope;
}

/** Render a VNode tree to an HTML string (no DOM required). */
export function renderToString(
  vnode: VNode | string | number | null,
): string {
  // Every top-level call renders into state of its OWN — the id sequence, the
  // <head> and the <select> stack — so a render that overlaps another (this
  // one called from inside a streamed component, or from a request handler
  // while a stream is mid-flight) can neither read nor reset the other's.
  const render = _ssrRenderNew("string");
  const scope = _ssrRootScope(render);
  const isTopLevel = _ssrRenderOf(scope) === render;
  if (isTopLevel) _ssrRenderStart(render);
  _ssrDepth++;
  try {
    return _rts(vnode, { n: 0 }, scope);
  } finally {
    _ssrDepth--;
    if (isTopLevel) _ssrRenderFinish(render);
  }
}

/** The recursive writer behind `renderToString`; `nodes` counts what it
 *  emitted (see `_regionHtml`). */
function _rts(
  vnode: VNode | string | number | null,
  nodes: SsrNodes,
  scope: SsrContexts,
): string {
  if (vnode == null) return "";
  if (typeof vnode === "string") {
    nodes.n++;
    return _escapeHtml(vnode);
  }
  if (typeof vnode === "number") {
    nodes.n++;
    return String(vnode);
  }
  // Not a node — same check, same message as `createDom`. It used to fall
  // into the element branch and die on `Object.entries(undefined)` with a bare
  // TypeError naming nothing.
  const bad = _notANode(vnode);
  if (bad) throw new Error(bad);

  // Component — execute and render output
  if (typeof vnode.tag === "function") {
    const { out: rendered, scope: inner } = _ssrComponent(vnode, scope);
    // Nothing to render is still a POSITION, on the server exactly as on the
    // client: `renderToString(null)` returns "", which would ship markup one
    // node short of what the client builds — so hydration adopts the wrong
    // node and a null-first component MOVES on its first re-render
    // (R-10). The placeholder makes the two agree.
    if (rendered == null) {
      nodes.n++;
      return "<!---->";
    }
    return _rts(rendered, nodes, inner);
  }

  // Null placeholder — comment node in HTML (AIO-107)
  if (vnode.tag === _Null) {
    nodes.n++;
    return "<!---->";
  }

  // Signal child — its current value, as the text the client will bind.
  if (vnode.tag === _SignalText) {
    nodes.n++;
    return _escapeHtml(_sigText((vnode._sig as Signal<unknown>).peek()));
  }

  // Portal — skip in SSR (no target DOM available)
  if (vnode.tag === Portal) return "";

  // Suspense — try to render children, show fallback if lazy throws
  if (vnode.tag === Suspense) {
    const fallback = vnode.props.fallback as
      | VNode
      | string
      | number
      | null
      | undefined;
    try {
      return _region(vnode, nodes, scope);
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      return _fallbackHtml(fallback, nodes, (v, n) => _rts(v, n, scope));
    }
  }

  // Fragment — render children
  if (vnode.tag === Fragment) return _region(vnode, nodes, scope);

  // ErrorBoundary — render children with error catching
  if (vnode.tag === ErrorBoundary) {
    const fallback = vnode.props.fallback as
      | ((e: Error) => VNode | string | number | null)
      | undefined;
    try {
      return _region(vnode, nodes, scope);
    } catch (error) {
      if (!fallback) throw error;
      const fb = _ssrScoped(scope, () => fallback(error as Error));
      return _fallbackHtml(fb.out, nodes, (v, n) => _rts(v, n, fb.scope));
    }
  }

  // Element
  nodes.n++;
  const tag = vnode.tag as string;
  const selfClosing = VOID_ELEMENTS.has(tag);
  // An <option> inside a <select> whose value it matches gains `selected` —
  // see `ssrOptionProps`. <select> itself has no `value` attribute, so
  // nothing else could express the server's choice.
  // The element's own `value` (or `defaultValue`), signal resolved — read
  // ONCE and used twice: as the option's identity, and as the select's choice.
  const ownValue = resolveSignalProp(
    vnode.props.value ?? vnode.props.defaultValue,
  );
  const render = _ssrRenderOf(scope);
  const props = ssrOptionProps(
    render,
    tag,
    vnode.props,
    vnode.children,
    ownValue,
  );
  let html = `<${tag}${_renderPropsHtml(props, tag)}`;

  html += ">";
  if (selfClosing) return html;

  // Raw html owns the content (see _hasRawHtml); the children are not emitted.
  const areaText = _ssrTextareaText(vnode);
  const inSelect = ssrOpenSelect(render, tag, ownValue);
  try {
    if (_hasRawHtml(vnode.props)) {
      html += (vnode.props.dangerouslySetInnerHTML as { __html: string })
        .__html;
    } else if (areaText !== null) {
      html += areaText;
    } else if (RAW_TEXT_ELEMENTS.has(tag)) {
      // <script>/<style> hold RAW text — see `rawTextContent`.
      const inner: SsrNodes = { n: 0 };
      for (const child of vnode.children) {
        if (typeof child === "string" || typeof child === "number") {
          inner.n++;
          html += rawTextContent(tag, String(child), isDevMode());
        } else {
          html += _rts(child, inner, scope);
        }
      }
    } else {
      const inner: SsrNodes = { n: 0 };
      for (const child of vnode.children) {
        html += _rts(child, inner, scope);
      }
    }
  } finally {
    // A Suspense boundary inside a <select> throws to signal "pending", and
    // that throw is caught ABOVE this frame — without the finally the scope
    // would stay open and mark options in a later, unrelated element.
    ssrCloseSelect(render, inSelect);
  }

  html += `</${tag}>`;
  return html;
}

/** A boundary's fallback as markup. A fallback of nothing still holds the
 *  boundary's slot — the client keeps a placeholder comment there
 *  (`_fallbackSlot`), so the server emits that comment, or hydration would
 *  claim the boundary's NEXT sibling for it. Shared by all three writers. */
export function _fallbackHtml(
  fallback: VNode | string | number | null | undefined,
  nodes: SsrNodes,
  write: (v: VNode | string | number, nodes: SsrNodes) => string,
): string {
  if (fallback == null) {
    nodes.n++;
    return _EMPTY_ANCHOR;
  }
  return write(fallback, nodes);
}

/** A container's children as one region (see `_regionHtml`). A region always
 *  occupies at least one node of its parent — its content or its anchor. */
function _region(vnode: VNode, nodes: SsrNodes, scope: SsrContexts): string {
  const inner: SsrNodes = { n: 0 };
  const html = vnode.children.map((c) => _rts(c, inner, scope)).join("");
  nodes.n++;
  return _regionHtml(html, inner.n);
}
