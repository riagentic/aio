// The Module Errors page says "Auto-reloads when fixed". A dev server that
// BOOTED with a red graph never saw it turn red in its watcher, so the fix of
// the UI entry went out as a `patch` (the in-place swap of the root
// component) — a frame the page ignored. The tab sat on the error page with
// the app fixed behind it. The page has no app to patch: any update reloads.
import { assertEquals } from "@std/assert";
import { generateDiagnosticHTML } from "../src/server/server-html-diagnostic.ts";
import { enc } from "../src/protocol/envelope.ts";

function runPage(frame: string): number {
  const html = generateDiagnosticHTML([], "t");
  const src = html.slice(
    html.indexOf("<script>") + "<script>".length,
    html.indexOf("</script>"),
  );
  let reloads = 0;
  let sock: { onmessage?: (e: { data: string }) => void } = {};
  const location = {
    protocol: "http:",
    host: "x",
    search: "",
    reload: () => void reloads++,
  };
  function WebSocket() {
    sock = {};
    return sock;
  }
  new Function("location", "WebSocket", "URLSearchParams", src)(
    location,
    WebSocket,
    URLSearchParams,
  );
  sock.onmessage!({ data: frame });
  return reloads;
}

Deno.test("diagnostic page reloads on a patch, a css swap, a reload and graph-clear", () => {
  assertEquals(runPage(enc("patch", { path: "/App.tsx", v: 1 })), 1);
  assertEquals(runPage(enc("css")), 1);
  assertEquals(runPage(enc("reload")), 1);
  assertEquals(runPage(enc("graph-clear")), 1);
});

Deno.test("diagnostic page stays put on graph-error", () => {
  assertEquals(runPage(enc("graph-error", [])), 0);
});
