// Every UI symbol `aio/air` exports must exist on the android/standalone
// runtime too — per-target export-surface drift, gated.
//
// The android bundle aliases `aio`/`aio/air` → standalone-air.ts. A wallet's
// field report (RIS-11) shipped code that type-checked green and failed only
// at APK bundle time because the alias was missing onMount/onCleanup/useId —
// the drift is invisible to every per-target check because each target is
// internally consistent. Comparing the two surfaces directly is the whole
// gate; a symbol added to air.ts lands here the day it ships or this fails.
import { assert } from "@std/assert";

Deno.test("standalone-air carries every browser-facing air export", async () => {
  const air = await import("../src/air.ts");
  const standalone = await import("../src/standalone-air.ts");
  // Two lists, two meanings.
  //
  // EXEMPT: no standalone counterpart CAN exist — server/browser-transport
  // concerns. Additions here need the same scrutiny.
  const EXEMPT = new Set([
    "useConnected", // standalone has no transport to be connected to
    "useProjection", // browser-protocol sharing; standalone reads cells direct
    "testGen", // test-time codegen, never bundled
    "testgen",
    "generateUITypes",
    "asyncSignal", // browser-transport async data; app code uses cells there
    "useServerSignal",
    "renderToStream", // SSR — a server concern by definition
    "connectDevTools", // devtools attach to the browser transport
    "connectAioDevTools",
    "disconnectDevTools",
    "isConnectionDegraded", // transport health; standalone has no transport
    "setDocument", // browser mount plumbing; standalone owns its document
  ]);
  // KNOWN DRIFT (RIS-11) — the debt this gate was written against, enumerated
  // rather than scattered. Each symbol type-checks in an android app today and
  // dies at APK bundle time. The router pulls `ensureConnected` (the WS
  // transport) so re-exporting it into standalone is a real port, not a
  // re-export line; auth UI needs a story for a serverless WebView; islands
  // are react interop. Shrink this list — never grow it: a NEW air export
  // missing from standalone fails this test the day it ships.
  const KNOWN_DRIFT = new Set([
    "Link",
    "NavLink",
    "Outlet",
    "Redirect",
    "Route",
    "navigate",
    "routePath",
    "routeSearch",
    "useNavigate",
    "useRoute",
    "SignIn",
    "signOut",
    "useUser",
    "island",
    "reactIsland",
    "useTimeTravel",
    "testComponent",
  ]);
  const missing = Object.keys(air).filter((k) =>
    !k.startsWith("_") && !EXEMPT.has(k) && !KNOWN_DRIFT.has(k) &&
    !(k in (standalone as Record<string, unknown>))
  );
  // The ledger must stay honest in the other direction too: a symbol that
  // GETS ported must leave the drift list, or the list rots into an exemption.
  const cured = [...KNOWN_DRIFT].filter((k) =>
    k in (standalone as Record<string, unknown>)
  );
  assert(
    cured.length === 0,
    `KNOWN_DRIFT entries now exported by standalone — remove them from the ` +
      `ledger: ${cured.join(", ")}`,
  );
  assert(
    missing.length === 0,
    `aio/air exports missing from standalone-air (the android alias): ` +
      `${missing.join(", ")} — a component using ${
        missing[0]
      } type-checks green and dies at APK bundle time (RIS-11).`,
  );
});
