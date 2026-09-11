// A custom element — `<webview>`, a web component — and its attributes.
//
// newjob §6: `<webview>` is admitted and its attributes are not. Real: the
// intrinsic map's index accepts any tag NAME and hands back `AioHTMLAttributes`,
// a closed set — so the element is admitted in name and refused in every
// property it exists for.
//
// The general fix is to widen that index, and it is REFUSED by the frozen
// surface: `JsxIntrinsicElements`' index type is published, and `check:api`
// does not make exceptions for a widening that provably breaks nobody (the
// value of the promise is that it has none). The optional spelling does not
// type-check either — an optional member is not assignable to a string index
// signature (TS2411).
//
// So the answer an app has TODAY is TypeScript's own interface merging: four
// lines, typed exactly the way the app wants, and it costs aio nothing. This
// file is the proof that it works, because a documented workaround nobody
// tested is a documented guess.
import { assertStringIncludes } from "@std/assert";
import { renderToString } from "../src/air/vdom.ts";

// Exactly what docs/clients/electron.md tells an app to write.
declare module "../src/jsx-runtime.ts" {
  interface JsxIntrinsicElements {
    webview: {
      src?: string;
      partition?: string;
      allowpopups?: boolean;
      preload?: string;
      nodeintegration?: string;
    };
    "my-widget": { tilt?: number; "data-config"?: string };
  }
}

Deno.test("a declared custom element takes its own attributes", () => {
  const html = renderToString(
    <webview
      src="https://example.test"
      partition="persist:session"
      allowpopups
      nodeintegration="false"
      preload="./preload.js"
    />,
  );
  assertStringIncludes(html, "webview");
  assertStringIncludes(html, 'src="https://example.test"');
  // Admitted in NAME and dropped on the way out would be the same defect one
  // layer down, and just as invisible.
  assertStringIncludes(html, 'partition="persist:session"');
  assertStringIncludes(html, 'preload="./preload.js"');
});

Deno.test("any element, not just the one that was reported", () => {
  const html = renderToString(<my-widget tilt={3} data-config='{"a":1}' />);
  assertStringIncludes(html, "my-widget");
  assertStringIncludes(html, 'tilt="3"');
});

Deno.test("an UNDECLARED element still renders — only the types object", () => {
  // The runtime never cared; this is a type-system limitation start to finish.
  // An app in a hurry can reach for a cast and ship.
  // deno-lint-ignore no-explicit-any
  const props = { src: "x" } as any;
  const html = renderToString(<some-other-thing {...props} />);
  assertStringIncludes(html, "some-other-thing");
  assertStringIncludes(html, 'src="x"');
});
