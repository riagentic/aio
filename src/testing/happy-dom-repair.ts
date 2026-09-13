// happy-dom-repair.ts — make the test DOM agree with a real browser about
// where a `<form>` or a `<select>` sits among its siblings.
//
// MEASURED (happy-dom 17.6.3): `form.nextSibling` is `null` even when the form
// is child 1 of a parent with four children and `parent.childNodes[1] === form`
// is true. `previousSibling`, `nextElementSibling` and `previousElementSibling`
// are wrong the same way. A sweep of all 100-odd HTML tags finds exactly two
// affected: `<form>` and `<select>` — the two happy-dom wraps in a named-item
// Proxy so `form.email` resolves a control by name. The sibling getters look
// the node up in an internal array that holds the TARGET while `childNodes`
// hands out the PROXY, so the lookup misses and the getter answers "nothing
// after this".
//
// This is not cosmetic. `_nextLive`/`_firstLive`/`_advance` (src/air) walk
// siblings, and they are the RECONCILER's positional cursor — so under the
// harness the cursor stopped dead at any form or select. AIR's dev tripwire
// then reported `<main> ran out of DOM nodes at child 2 … the child reconciler
// desynced`, ending with "this is an aio bug; please report the component's
// child shape", on a DOM that was in fact perfectly correct. aio's own
// `examples/todo` and `examples/contacts` tripped it on the first click, and
// so would every app with a form in it.
//
// Repairing it here is the harness being MORE faithful to a browser, never
// more permissive: the fixed getters answer exactly what a browser answers, so
// every tripwire that fires in a browser still fires in a test. The repair is
// applied only after PROVING the defect on a throwaway element, so the day
// happy-dom fixes this it becomes a no-op rather than a competing
// implementation.

// deno-lint-ignore-file no-explicit-any

type AnyNode = any;

/** Identity across the Proxy boundary.
 *
 *  A replacement getter runs with `this` bound to the Proxy TARGET, while
 *  `parent.childNodes` hands out the PROXY — so `kids[k] === this` is false
 *  for the very node we are standing on, and a scan by identity finds nothing.
 *  That is the same mismatch that breaks the original getters, so the fix
 *  cannot use identity. A marker written through one view and read through the
 *  other lands on the one object they share. */
const MARK = Symbol.for("aio.happyDomSiblingProbe");

/** The sibling `step` places away, by position in the parent's child list —
 *  the definition a browser uses, and the one the broken getters lost. */
function siblingAt(node: AnyNode, step: number): AnyNode | null {
  const parent = node?.parentNode;
  if (!parent) return null;
  const kids = parent.childNodes;
  if (!kids) return null;
  const token = {};
  node[MARK] = token;
  let i = -1;
  try {
    for (let k = 0; k < kids.length; k++) {
      const kid = kids[k];
      if (kid === node || kid?.[MARK] === token) {
        i = k;
        break;
      }
    }
  } finally {
    delete node[MARK];
  }
  if (i < 0) return null;
  const j = i + step;
  return j >= 0 && j < kids.length ? kids[j] : null;
}

/** The same walk, skipping anything that is not an element (nodeType 1). */
function elementSiblingAt(node: AnyNode, step: number): AnyNode | null {
  let n = siblingAt(node, step);
  while (n && n.nodeType !== 1) n = siblingAt(n, step);
  return n;
}

/** Tag → the window constructor whose prototype carries its sibling getters. */
const PROXIED: Record<string, string> = {
  form: "HTMLFormElement",
  select: "HTMLSelectElement",
};

/**
 * Repair the sibling getters on a happy-dom window, if they are broken.
 *
 * Returns the constructor names actually patched — empty when the DOM already
 * behaves, which is what a fixed happy-dom must produce.
 */
export function repairProxiedSiblings(win: AnyNode): string[] {
  const doc = win?.document;
  if (!doc?.createElement) return [];
  const patched: string[] = [];
  for (const [tag, ctorName] of Object.entries(PROXIED)) {
    const ctor = win[ctorName];
    if (typeof ctor !== "function") continue;

    // PROVE the defect before touching anything: a parent, the element, and a
    // sibling on each side. A harness that quietly reimplements a working DOM
    // is a second source of truth, which is the thing to avoid here.
    const parent = doc.createElement("div");
    const before = doc.createElement("span");
    const probe = doc.createElement(tag);
    const after = doc.createElement("span");
    parent.appendChild(before);
    parent.appendChild(probe);
    parent.appendChild(after);
    if (probe.nextSibling === after && probe.previousSibling === before) {
      continue; // upstream behaves — leave it alone
    }

    const proto = ctor.prototype;
    for (
      const [prop, get] of [
        ["nextSibling", (n: AnyNode) => siblingAt(n, 1)],
        ["previousSibling", (n: AnyNode) => siblingAt(n, -1)],
        ["nextElementSibling", (n: AnyNode) => elementSiblingAt(n, 1)],
        ["previousElementSibling", (n: AnyNode) => elementSiblingAt(n, -1)],
      ] as const
    ) {
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: false,
        get(this: AnyNode) {
          return get(this);
        },
      });
    }
    patched.push(ctorName);
  }
  return patched;
}
