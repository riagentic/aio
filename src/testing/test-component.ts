// test-component.ts — public harness for testing AIR components, symmetric with
// testCell for cells. Wraps the renderer's mount + document wiring so tests no
// longer reach into the underscore-prefixed internals.

import { _setDocument, _unmount, mount } from "../air/aio-renderer.ts";
import { _armTestStrict } from "./test-strict.ts";
import type { ComponentFn } from "../air/vdom-types.ts";

// deno-lint-ignore no-explicit-any
type AnyDoc = any;

/** Point the AIR renderer at a specific `document` — pass a happy-dom / jsdom
 *  document in tests or SSR. Public alias of the renderer's internal setter. */
export function setDocument(doc: AnyDoc): void {
  _setDocument(doc);
}

/** Options for {@link testComponent}. */
export interface TestComponentOptions {
  /** Document to render into. Provide a happy-dom / jsdom document (keeps test
   *  DOM deps out of the framework). Falls back to `globalThis.document`. */
  document?: AnyDoc;
  /** Existing root element to mount into; one is created on `document.body`
   *  when omitted. */
  // deno-lint-ignore no-explicit-any
  root?: any;
}

/** Handle returned by {@link testComponent}. */
export interface TestComponentHandle {
  /** The root element the component is mounted into. */
  // deno-lint-ignore no-explicit-any
  root: any;
  /** Current `innerHTML` of the root — convenience for assertions. */
  html(): string;
  /** Unmount and run cleanups (`onCleanup` + mount-cleanups). */
  unmount(): void;
}

/**
 * Mount an AIR component into a DOM for testing — the component analogue of
 * `testCell`. Sets the renderer document, mounts `App`, and returns a handle
 * with the root, an `html()` snapshot, and `unmount()`.
 *
 * Bring your own DOM (happy-dom / jsdom) so the framework stays free of test-only
 * deps. To drive `requestAnimationFrame`/`useRaf`, stub `globalThis.requestAnimationFrame`
 * before mounting and flush frames manually.
 *
 * ```ts
 * import { Window } from "happy-dom";
 * import { testComponent } from "aio/air";
 *
 * const win = new Window();
 * const t = testComponent(App, { document: win.document });
 * assertEquals(t.html(), "<div>hi</div>");
 * t.unmount();
 * ```
 */
export function testComponent(
  App: ComponentFn,
  opts: TestComponentOptions = {},
): TestComponentHandle {
  _armTestStrict(); // tests are the strictest environment, never the most permissive
  const doc = opts.document ?? (globalThis as { document?: AnyDoc }).document;
  if (!doc) {
    throw new Error(
      "testComponent: no document — pass { document } (e.g. a happy-dom " +
        "document) or run where globalThis.document exists",
    );
  }
  setDocument(doc);
  const root = opts.root ?? doc.createElement("div");
  if (!root.parentNode && doc.body) doc.body.appendChild(root);
  const handle = mount(root, App);
  return {
    root,
    html: () => root.innerHTML,
    unmount: () => _unmount(handle),
  };
}
