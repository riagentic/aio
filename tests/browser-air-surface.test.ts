// `aio/air` must mean the same thing on every target — the BROWSER half.
//
// The browser build remaps the public specifiers to the raw browser entry:
//   src/build/esbuild-shared.ts → const air = doAndroid
//                                   ? "src/standalone-air.ts" : "src/browser-air.ts"
//                                 … { "aio": air, "aio/air": air }
// so in a shipped browser bundle `import { … } from "aio/air"` resolves to
// src/browser-air.ts — NOT to src/air.ts, the curated surface every editor
// type-checks against. Any name the two disagree on is a bundle that fails (or
// a symbol that appears) only in production. This is the browser twin of
// tests/android-air-surface.test.ts, and it gates BOTH directions:
//
//   1. no `aio/air` export may silently vanish on the browser target — every
//      absence is enumerated here with a reason;
//   2. no export may exist on the browser entry that the curated surface does
//      not know about — every extra is `_`-prefixed internal plumbing (the
//      entry's own comment: "not public API") or enumerated here with a
//      reason. This direction is what buries relics: the alpha27 `actions`/
//      `effects` factory and `bridge()` sat on this entry for 25 releases
//      after the style they served was removed.
import { assert, assertEquals } from "@std/assert";
import * as air from "../src/air.ts";
import * as browser from "../src/browser-air.ts";

// ── 1. no vanishing exports ──────────────────────────────────────────

/** Exports of the curated `aio/air` (src/air.ts) that the browser bundle
 *  entry does not ship, each with the reason. Shrinking this list is always
 *  allowed; growing it is a decision. */
const ABSENT_ON_BROWSER: Record<string, string> = {
  // Known gaps — these are renderer helpers the android entry DOES ship, so a
  // form-using app builds for android and fails the browser esbuild resolve.
  // Closing the gap is an additive surface change (a deliberate release
  // decision), so it is recorded here instead of smuggled in.
  on: "gap: watch/on not re-exported on the browser entry yet",
  watch: "gap: watch/on not re-exported on the browser entry yet",
  useForm: "gap: form helpers not re-exported on the browser entry yet",
  useFieldArray: "gap: form helpers not re-exported on the browser entry yet",
  useVirtualList: "gap: virtual list not re-exported on the browser entry yet",
  renderToString:
    "gap: only the streaming SSR entry (renderToStream) is shipped",
  // Different spelling on this entry, by design.
  connectAioDevTools:
    "the browser entry ships connectDevTools/disconnectDevTools",
  reactIsland: "React interop rides `island` on the raw browser entry",
};

Deno.test("browser aio/air: every absent export is a listed decision", () => {
  const surprises: string[] = [];
  for (const name of Object.keys(air)) {
    if (name in browser) continue;
    if (name in ABSENT_ON_BROWSER) continue;
    surprises.push(name);
  }
  assertEquals(
    surprises,
    [],
    "these `aio/air` exports vanish in a browser bundle with no recorded " +
      "reason — an app that uses them type-checks everywhere and fails only " +
      "at the production esbuild:\n  " + surprises.join("\n  "),
  );
});

Deno.test("browser aio/air: the absent list has no dead entries", () => {
  const stale = Object.keys(ABSENT_ON_BROWSER).filter((n) =>
    !(n in air) || n in browser
  );
  assertEquals(
    stale,
    [],
    "listed as absent but no longer missing (or no longer on aio/air) — the " +
      "ledger has to shrink when the gap does",
  );
});

// ── 2. no unrecorded extras ──────────────────────────────────────────

/** Public (non-`_`) exports the browser entry carries BEYOND the curated
 *  `aio/air` surface, each with the reason it exists. Anything else extra is
 *  a relic in the making — exactly how the dead `actions`/`effects`/`bridge`
 *  trio survived from alpha27 to alpha52. */
const EXTRA_ON_BROWSER: Record<string, string> = {
  // The browser bundle maps the "aio" specifier here too, so the entry must
  // carry the universal (mod.ts-style) names an app.ts imports:
  aio: "the `aio` specifier maps here — aio.run() stub",
  cell: "the `aio` specifier maps here — browser cell() stub",
  msg: "the `aio` specifier maps here — action creator",
  own: "the `aio` specifier maps here — owned-resource effect creators",
  schedule: "the `aio` specifier maps here — browser schedule stub",
  serverFn: "the `aio` specifier maps here — serverFn client proxy",
  serverFns: "the `aio` specifier maps here — serverFn definition passthrough",
  log: "the `aio` specifier maps here — no-op logger shim for shared modules",
  // Client-runtime plumbing consumed by src/* and generated shells, exported
  // for them rather than for app code (air.ts deliberately curates them out).
  client: "low-level client API (subscribe/getState/send) for shells",
  ensureConnected: "bundle entry boot hook — generated shells call it",
  matchPath: "router primitive used by generated code and tests",
  authUser: "reactive identity signal behind useUser",
  setSyncMessageHandler: "sync-engine transport seam",
};

Deno.test("browser aio/air: every extra export is a listed decision", () => {
  const surprises: string[] = [];
  for (const name of Object.keys(browser)) {
    if (name in air) continue;
    if (name.startsWith("_")) continue; // documented internal plumbing
    if (name in EXTRA_ON_BROWSER) continue;
    surprises.push(name);
  }
  assertEquals(
    surprises,
    [],
    "these symbols exist ONLY on the shipped browser entry, with no recorded " +
      "reason — the exact shape of the alpha27 actions/effects/bridge relics:" +
      "\n  " + surprises.join("\n  "),
  );
});

Deno.test("browser aio/air: the extra list has no dead entries", () => {
  const stale = Object.keys(EXTRA_ON_BROWSER).filter((n) =>
    !(n in browser) || n in air
  );
  assertEquals(
    stale,
    [],
    "listed as browser-only but no longer (either gone, or now on the " +
      "curated surface) — the ledger has to shrink when the delta does",
  );
});

// ── shared names are the SAME symbol ─────────────────────────────────

Deno.test("browser aio/air: a shared name is one implementation, not a copy", () => {
  const copies = Object.keys(air).filter((k) =>
    k in browser &&
    (air as Record<string, unknown>)[k] !==
      (browser as Record<string, unknown>)[k]
  );
  assertEquals(
    copies,
    [],
    "two implementations of one public name is the defect itself — a " +
      "contract that agrees today drifts the next time only one is edited",
  );
});
