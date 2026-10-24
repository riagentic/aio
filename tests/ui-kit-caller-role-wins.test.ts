// A caller's `role` / `aria-live` on <Alert> and <ToastHost> wins — the kit's
// promise that extra attributes "never fight your markup", kept by Spinner,
// Avatar and Pagination and broken here: the kit's own value was spread
// AFTER the caller's, so `<Alert variant="success" role="status">Saved` (the
// way a callout is announced politely) silently stayed a mute "note".
import { assertStringIncludes } from "@std/assert";
import { h, renderToString } from "../src/air/vdom.ts";
import { Alert, ToastHost } from "../src/ui/mod.ts";

Deno.test("Alert: the caller's role wins; the variant's is the default", () => {
  assertStringIncludes(
    renderToString(h(Alert, { variant: "success", role: "status" }, "Saved")),
    'role="status"',
  );
  assertStringIncludes(
    renderToString(h(Alert, { variant: "success" }, "Saved")),
    'role="note"',
  );
  assertStringIncludes(
    renderToString(h(Alert, { variant: "error", role: undefined }, "x")),
    'role="alert"',
  );
});

Deno.test("ToastHost: the caller's role / aria-live win", () => {
  const out = renderToString(h(ToastHost, { role: "log", "aria-live": "off" }));
  assertStringIncludes(out, 'role="log"');
  assertStringIncludes(out, 'aria-live="off"');
  assertStringIncludes(renderToString(h(ToastHost, {})), 'aria-live="polite"');
});
