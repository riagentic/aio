// dev-keys.ts — the key checks over a child list: missing, mixed, duplicate.
// Dev layer (air/dev-air.ts). The caller asked `isDevMode()` and that the
// list has more than one child.
import { _devWarn, _Null } from "./vdom-types.ts";
import type { VNode } from "./vdom-types.ts";
import { _isFromArray } from "./vdom-create.ts";

/** Where a keys warning points. The warning used to name a TAG and nothing
 *  else — "4 <div> children without keys" — which in any real app is a grep
 *  through every component for a parent with four divs; the visual app
 *  manager has dozens, and the one that fired was found by elimination over
 *  three boots. The parent DOM node is right here, and so are the children:
 *  name the parent (`tag#id.class`), then the first text each child renders,
 *  which is how the reader will recognise the spot on screen. Dev-only,
 *  observe-only — this string is never read by anything but a person. */
function _whereInTree(
  parent: Node,
  children: (VNode | string | number)[],
): string {
  const el = parent as Partial<Element> & Node;
  const tag = String(el.nodeName ?? "?").toLowerCase();
  const id = typeof el.id === "string" && el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className
    ? `.${el.className.split(/\s+/)[0]}`
    : "";
  const firstText = (c: VNode | string | number): string => {
    if (typeof c !== "object") return String(c);
    for (const k of c.children ?? []) {
      if (typeof k === "string" || typeof k === "number") return String(k);
      const t = firstText(k);
      if (t) return t;
    }
    return "";
  };
  const samples = children.slice(0, 4).map((c) => {
    const t = firstText(c).trim().replace(/\s+/g, " ").slice(0, 24);
    return t ? JSON.stringify(t) : "(no text)";
  });
  return ` — inside <${tag}${id}${cls}>, children start: ${
    samples.join(", ")
  }` +
    (children.length > 4 ? `, … (${children.length} total)` : "");
}

/** Parents already told about a list shift — once per SITE: the warning's
 *  text quotes the children, which the shift itself changes. */
const _shifted = new WeakSet<Node>();

export function _checkKeys(
  parent: Node,
  nextChildren: (VNode | string | number)[],
  hasKeys: boolean,
  oldChildren: (VNode | string | number)[] = [],
): void {
  // A `_Null` slot is not a sibling with a missing key — it is the absence of
  // one. `{cond ? <span key="x"/> : null}` beside a keyed sibling is the most
  // ordinary conditional JSX there is, and it warned "Mixed keyed and unkeyed
  // children" naming `(no text)` as the offender. A field report silenced it
  // by rendering a hidden placeholder — worse code than the warning
  // prevented, which is the tell that the warning was wrong. Null slots carry
  // no identity, so there is nothing for a key to say about them.
  const real = nextChildren.filter(
    (c) => !(typeof c === "object" && (c as VNode).tag === _Null),
  );
  const someKeyed = real.some(
    (c) => typeof c === "object" && c.key !== undefined,
  );
  const someUnkeyed = real.some(
    (c) => typeof c === "object" && c.key === undefined,
  );
  // AIO-69: Warn when multiple element children have no keys at all — but
  // only for children that came out of an ARRAY EXPRESSION (a `.map`
  // result, or any nested array the runtime flattened; see `_isFromArray`).
  // Positional reconciliation of siblings written out by hand is always
  // right and no key would change it, yet the check counted them too: a
  // sidebar of four literal `<div>` panes warned on every boot of the
  // visual app manager, and the reader learned to skip the channel.
  if (!someKeyed && someUnkeyed && real.length > 2) {
    const vnodeChildren = real.filter(
      (c) =>
        typeof c === "object" && typeof c.tag !== "undefined" &&
        _isFromArray(c),
    );
    if (vnodeChildren.length > 2) {
      const tags = new Set(vnodeChildren.map((c) => (c as VNode).tag));
      if (tags.size === 1) {
        // Deduped per SITE, not per kind: on a fixed id a page with three
        // offending parents reported the first and the next surfaced only
        // once that one was fixed (measured on the visual app manager —
        // fix one, reboot, a different one appears). The location suffix
        // IS the site, so it is the id; each distinct one warns once, and
        // all of them show up on the first boot.
        const where = _whereInTree(parent, nextChildren);
        _devWarn(
          `missing-keys${where}`,
          `${vnodeChildren.length} <${
            String([...tags][0])
          }> children without keys. Add key props for correct reconciliation.${where}`,
        );
      }
    }
  }
  // MIXED means mixed INSIDE A LIST — an array expression whose items are
  // partly keyed. `<h2/>{items.map((i) => <li key={i.id}/>)}<input/>`, the
  // docs' own shape, is not that: `diffKeyed` matches unkeyed children
  // positionally among the UNKEYED ones (AIO-114), so the heading is always
  // unkeyed #0 and the input #1 however the rows move, and no key on them
  // would change a thing. It warned anyway, on every render of the most
  // ordinary list layout there is. A `.map` that keys some rows and not
  // others is the case that does go wrong: its unkeyed rows shift slots when
  // a keyed row is added or removed. (Array identity is not recorded, only
  // "came from an array", so two ADJACENT arrays — one keyed, one not — still
  // read as one mixed list.)
  const fromArray = real.filter(
    (c) => typeof c === "object" && _isFromArray(c),
  ) as VNode[];
  const arrayKeyed = someKeyed && fromArray.some((c) => c.key !== undefined);
  const arrayUnkeyed = someUnkeyed &&
    fromArray.some((c) => c.key === undefined);
  if (arrayKeyed && arrayUnkeyed) {
    const where = _whereInTree(parent, nextChildren);
    _devWarn(
      `mixed-keys${where}`,
      "Mixed keyed and unkeyed children — all siblings should have keys or none." +
        where,
    );
  }
  // An UNKEYED list that changed length shifts every sibling written after it
  // by position: `{errors.map((e) => <p>{e}</p>)}<input/>` re-creates the
  // input when the first error appears — the caret and the typed text gone
  // mid-word, silently. One or two rows are below the missing-keys count
  // above, so it said nothing. Said when it HAPPENS: a hand-written sibling
  // reconciled against a list row, or a list row against one.
  const oldKeyed = oldChildren.some(
    (c) => typeof c === "object" && c !== null && c.key !== undefined,
  );
  // The SAME hand-written siblings on both sides — `{rows.length ? rows :
  // <Empty/>}` swaps the list for a node no key would keep, and says nothing.
  const literals = (l: (VNode | string | number)[]) =>
    l.filter((c) =>
      typeof c === "object" && c !== null && c.tag !== _Null && !_isFromArray(c)
    ).length;
  if (
    !hasKeys && !oldKeyed && literals(nextChildren) > 0 &&
    literals(nextChildren) === literals(oldChildren)
  ) {
    const n = Math.min(nextChildren.length, oldChildren.length);
    for (let i = 0; i < n; i++) {
      const a = nextChildren[i]!, b = oldChildren[i]!;
      if (
        typeof a !== "object" || typeof b !== "object" || b === null ||
        _isFromArray(a) === _isFromArray(b) ||
        a.tag === _Null || b.tag === _Null
      ) continue;
      if (_shifted.has(parent)) break;
      _shifted.add(parent);
      const where = _whereInTree(parent, nextChildren);
      _devWarn(
        `list-shift${where}`,
        "An unkeyed list changed length, so the siblings written after it " +
          "were matched against list rows by position — they are re-created " +
          "(focus, caret and typed text lost) or patched with a row's state. " +
          "Give the list's items keys (key={item.id})." + where,
      );
      break;
    }
  }
  if (hasKeys) {
    const keys = new Set<string | number>();
    for (const c of nextChildren) {
      if (typeof c === "object" && c.key !== undefined) {
        if (keys.has(c.key)) {
          _devWarn(
            `dup-key-${String(c.key)}`,
            `Duplicate key "${String(c.key)}" in children list.`,
          );
        }
        keys.add(c.key);
      }
    }
  }
}
