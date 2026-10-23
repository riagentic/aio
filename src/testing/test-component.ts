// test-component.ts — public harness for testing AIR components, symmetric with
// testCell for cells. Wraps the renderer's mount + document wiring so tests no
// longer reach into the underscore-prefixed internals.

import {
  acceptHostEvents,
  repairLabelActivation,
  repairProxiedSiblings,
} from "./happy-dom-repair.ts";
import { _setContrastCascadeProbe } from "../air/contrast-audit.ts";
import { contrastCascadeNotice } from "../air/contrast-cascade.ts";
import { _setDocument, _unmount, mount } from "../air/aio-renderer.ts";
import {
  _containedErrorSink,
  _setContainedErrorSink,
} from "../air/hook-error.ts";
import {
  _renderErrorSinkInPlace,
  _setRenderErrorSink,
} from "../air/renderer-rerender.ts";
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
  // happy-dom answers `null` for a `<form>`'s or `<select>`'s siblings, and the
  // keyed diff positions rows by walking siblings. `testUI` has repaired this
  // since it owned a window; a caller's own document needs the same repair
  // (it proves the defect first, so a working DOM is left untouched).
  repairProxiedSiblings((doc as { defaultView?: unknown }).defaultView);
  acceptHostEvents((doc as { defaultView?: unknown }).defaultView);
  repairLabelActivation((doc as { defaultView?: unknown }).defaultView);
  // …and the contrast walk must not believe a cascade that is not a
  // browser's (see contrast-cascade.ts). The same install `testUI` does.
  _setContrastCascadeProbe(contrastCascadeNotice);
  setDocument(doc);
  const root = opts.root ?? doc.createElement("div");
  if (!root.parentNode && doc.body) doc.body.appendChild(root);
  // An event handler that throws and a RE-render that throws are contained
  // (production keeps the last good output and carries on), so both reached
  // only `console.error` and the test passed on stale content. `testUI` turns
  // them into failures; so does this harness, at its observation points
  // (`html()` and `unmount()`). Chained, so an enclosing harness hears them too.
  const failures: Error[] = [];
  const prevContained = _containedErrorSink();
  const prevRender = _renderErrorSinkInPlace();
  _setContainedErrorSink((kind, e, component) => {
    failures.push(
      new Error(
        `[aio:testComponent] ${kind}${
          component ? ` in <${component}>` : ""
        } threw. The framework CONTAINS this so production keeps rendering; ` +
          `a test must not pass on it: ${
            e instanceof Error ? e.message : String(e)
          }`,
        { cause: e },
      ),
    );
    prevContained?.(kind, e, component);
  });
  _setRenderErrorSink((err, component) => {
    failures.push(
      new Error(
        `[aio:testComponent] <${component}> threw while re-rendering, so the ` +
          `UI is showing STALE content: ${err.message}`,
        { cause: err },
      ),
    );
    prevRender?.(err, component);
  });
  const restore = () => {
    _setContainedErrorSink(prevContained);
    _setRenderErrorSink(prevRender);
  };
  const raise = () => {
    if (failures.length === 0) return;
    const errs = failures.splice(0);
    throw errs.length === 1
      ? errs[0]
      : new AggregateError(errs, errs.map((e) => e.message).join("\n"));
  };
  let handle: ReturnType<typeof mount>;
  try {
    handle = mount(root, App);
  } catch (e) {
    restore();
    throw e;
  }
  return {
    root,
    html: () => {
      raise();
      return root.innerHTML;
    },
    unmount: () => {
      try {
        _unmount(handle);
      } finally {
        restore();
      }
      raise();
    },
  };
}
