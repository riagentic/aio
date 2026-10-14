// dev-align.ts — the child-alignment tripwire: after a diff, does the region a
// vnode owns hold its children's nodes in order? It walks the DOM after every
// diff, so it is a dev check (air/dev-air.ts); the failures a desync can lead
// to are said in production at their own sites (`_wrong` in vdom-diff.ts).
import { _advance, _liveFirstDom } from "./vdom-remove.ts";
import { _devWarn, _domNodeCount } from "./vdom-types.ts";
import type { VNode } from "./vdom-types.ts";
import { _componentName } from "./hook-error.ts";
import { _instanceStack } from "./renderer-state.ts";

/** Dev-only reactivity invariant (AIO-412): after a diff, the region a vnode
 *  owns must hold its children's realized nodes IN ORDER — child i's node is
 *  the n-th node of the region, where n = Σ _domNodeCount(children before it).
 *
 *  The original check compared COUNTS only, and only for elements. Every defect
 *  this class produces is an order/identity error at a perfectly correct count
 *  — a text node reconciled into a sibling's slot, a fragment that adopted a
 *  detached anchor, two equal-valued strings swapped — so it fired for one
 *  reproduction in eight and the class shipped. Walking positions catches them
 *  at the source in dev, where the diff that caused it is still on the stack,
 *  instead of via a user's "the value isn't updating" report.
 *
 *  Bare text is verified by node type + content (a primitive has no identity to
 *  compare); everything that carries a `_dom` is verified by identity.
 *
 *  Skipped when the element opts out of vnode-owned children — a `ref` or `use`
 *  action may mutate the DOM imperatively, and dangerouslySetInnerHTML injects
 *  untracked nodes — so the check never cries wolf on legitimate escape hatches.
 *
 *  `exact` (elements only) additionally requires the region to END with the
 *  last child: an element owns ALL of its childNodes, a fragment does not. */
/** @internal Exported as a test seam: the desync it reports is (correctly)
 *  hard to provoke through the public renderer, and the CLAIMS this function
 *  makes — that it names the class, the enclosing component, and the two app
 *  shapes that cause it, and that two different sites are two findings — are
 *  about the MESSAGE, not about when the desync happens. A test that drives a
 *  shape hoping to trip it passes vacuously the day AIR stops tripping. */
export function _assertRegionAlignment(
  nv: VNode,
  first: Node | null,
  exact: boolean,
): void {
  const p = nv.props;
  if (p.ref || p.use || p.dangerouslySetInnerHTML) return;
  // A server-rendered `<textarea value>` carries its value as a TEXT child
  // (that is the only way HTML can say it); the vnode has none. Every
  // re-render of a hydrated textarea reported that node as a desync.
  if (nv.tag === "textarea" && !nv.children.length) return;
  // NAME THE SITE, and key the dedupe by it.
  //
  // This said `<span> holds the wrong node at child 0`, keyed
  // `child-desync-span` — one key for every `<span>` in the application. A
  // field report's numbers say what that cost: ~180 spans across 25
  // components, so "a span, somewhere, at child 0" is not a lead, and they
  // spent two hours bisecting a fuzz run by hand. Worse, they then fixed NINE
  // real shape instabilities in a row and the warning count stayed at exactly
  // 1 the whole time, because the first one silenced the rest — which reads as
  // "nothing I did helped". A count that cannot move is not a diagnostic.
  //
  // Everything needed was already in hand at the call site: `nv.props` carries
  // the class, and the enclosing component is on the instance stack.
  const cls = typeof nv.props.class === "string"
    ? nv.props.class
    : typeof nv.props.className === "string"
    ? nv.props.className
    : "";
  const owner = _instanceStack[_instanceStack.length - 1]?._component;
  const label = `<${_componentName(nv.tag)}${cls ? ` class="${cls}"` : ""}>` +
    (owner ? ` inside <${owner}>` : "");
  const bad = (why: string) =>
    _devWarn(
      `child-desync-${owner ?? "?"}-${String(nv.tag)}-${cls}`,
      `${label} ${why} after diff — the child reconciler desynced (nodes ` +
        `lost/duplicated, or dynamic text written to the wrong slot).\n` +
        // NOT "this is an aio bug". The reported causes were all app shapes,
        // and sending the author to file an issue is the wrong answer in the
        // one message that is supposed to end the hunt. Both shapes below are
        // idiomatic JSX, which is why a careful codebase hit them nine times.
        `      The usual cause is a sibling whose NODE COUNT changes between ` +
        `renders, among static siblings: \`{cond && <Icon/>}\` (a falsy ` +
        `branch still occupies a slot) or \`{v === "" ? "" : v}\` (an empty ` +
        `string renders to no node at all). Give the siblings keys, or render ` +
        `a stable placeholder instead of nothing. If neither applies, this is ` +
        `an aio bug — please report the component's child shape.`,
    );
  let cursor: Node | null = first;
  for (let i = 0; i < nv.children.length; i++) {
    const child = nv.children[i]!;
    const count = _domNodeCount(child);
    if (count === 0) continue; // Portal / component that rendered nothing
    if (!cursor) return bad(`ran out of DOM nodes at child ${i}`);
    if (typeof child === "object") {
      // `_liveFirstDom`, not the vnode's own `_dom`: a component child whose
      // nested component re-rendered on its own and swapped its root still
      // carries the detached node in its copy, and comparing against THAT
      // reported a desync for a render in which nothing was wrong (a field
      // report: "holds the wrong node at child 6", twice, one dialog giving
      // way to the next). A tripwire that fires when nothing is wrong teaches
      // the reader to ignore the real one.
      const d = _liveFirstDom(child);
      if (d && d !== cursor) {
        return bad(`holds the wrong node at child ${i}`);
      }
    } else if (
      cursor.nodeType !== 3 || cursor.textContent !== String(child)
    ) {
      return bad(
        `holds ${
          cursor.nodeType === 3
            ? JSON.stringify(cursor.textContent)
            : `a <${(cursor as Element).nodeName?.toLowerCase()}>`
        } where the text child ${i} (${JSON.stringify(String(child))}) belongs`,
      );
    }
    cursor = _advance(cursor, count);
  }
  if (exact && cursor) bad("has leftover DOM children");
}
