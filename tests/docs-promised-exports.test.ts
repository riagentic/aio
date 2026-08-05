// Anything the docs tell you to CALL must be importable from the entry the
// docs import from.
//
// `isConnectionDegraded()` was documented in two places as the way to drive a
// "reconnecting / slow connection" indicator, and both pages import from
// `aio/air` — which did not export it. The function existed and worked; only
// the door was missing, so following the documentation produced a module
// resolution error. The existing doc-imports gate could not catch it: it scans
// `import` statements inside fenced code blocks, and this promise is made in
// prose.
import { assert } from "@std/assert";

Deno.test("aio/air exports isConnectionDegraded (docs tell users to call it)", async () => {
  const air = await import("../src/air.ts");
  assert(
    typeof air.isConnectionDegraded === "function",
    "docs/persistence/offline.md and docs/clients/browser.md both tell the " +
      "reader to call isConnectionDegraded(); aio/air must export it",
  );
  // It answers before any connection exists — an indicator that throws on a
  // fresh page is worse than no indicator.
  assert(
    typeof air.isConnectionDegraded() === "boolean",
    "isConnectionDegraded() must return a boolean even before connecting",
  );
});

Deno.test("prose-named framework calls in offline/browser docs are importable", async () => {
  // Generalised, so the next prose-only promise is caught too. Names are
  // matched as `name()` in the prose of these two pages and checked against
  // the entry they import from; anything not exported here is either a broken
  // promise or a doc that should not have named it.
  const air = await import("../src/air.ts");
  const pages = [
    "docs/persistence/offline.md",
    "docs/clients/browser.md",
  ];
  // Only names the framework itself owns — the pages also mention user-defined
  // and host APIs, which this gate has no business asserting.
  const OWNED = new Set([
    "isConnectionDegraded",
    "useAio",
    "useLocal",
    "useCell",
  ]);
  const missing: string[] = [];
  for (const page of pages) {
    const text = await Deno.readTextFile(
      new URL(`../${page}`, import.meta.url),
    );
    for (const m of text.matchAll(/`([A-Za-z_$][\w$]*)\(\)`/g)) {
      const name = m[1]!;
      if (!OWNED.has(name)) continue;
      if (typeof (air as Record<string, unknown>)[name] !== "function") {
        missing.push(`${name} (named in ${page})`);
      }
    }
  }
  assert(
    missing.length === 0,
    `these are documented as callable but aio/air does not export them:\n  ` +
      missing.join("\n  "),
  );
});
