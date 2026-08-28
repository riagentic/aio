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
    "generateUITypes",
    "asyncSignal", // browser-transport async data; app code uses cells there
    "useServerSignal",
    "renderToStream", // SSR — a server concern by definition
    "connectReduxDevTools", // devtools attach to the browser transport
    "connectAioDevTools",
    "disconnectReduxDevTools",
    "isConnectionDegraded", // transport health; standalone has no transport
    "testComponent", // test-only harness, never bundled; testUI IS the standalone harness
  ]);
  // KNOWN DRIFT (RIS-11) — the debt this gate was written against, enumerated
  // WITH the reason, so an entry is a decision and not a shrug. Each symbol
  // type-checks in an android app today and dies at APK bundle time. Shrink
  // this list — never grow it: a NEW air export missing from standalone fails
  // this test the day it ships, and an entry that stops being true (the symbol
  // appears on standalone) fails it too.
  //
  // Closed in alpha70: the router (src/air/router.ts — routing is state, the
  // WS `ensureConnected` became an injected boot hook), the auth UI (resolved
  // to the anonymous branch, see standalone-air.ts) and islands (client-side
  // framework interop; never touched SSR or the transport).
  const KNOWN_DRIFT: Record<string, string> = {
    // Streams the SERVER's action log over the transport (`_sendTTCmd` sends
    // `tt-cmd` frames; the entries arrive as `tt` frames). A standalone app has
    // no action log outside its own process and no frame to send it on — a
    // local time-travel would be a second implementation, not a port.
    useTimeTravel: "time travel streams from the server's action log",
  };
  const missing = Object.keys(air).filter((k) =>
    !k.startsWith("_") && !EXEMPT.has(k) && !(k in KNOWN_DRIFT) &&
    !(k in (standalone as Record<string, unknown>))
  );
  // The ledger must stay honest in the other direction too: a symbol that
  // GETS ported must leave the drift list, or the list rots into an exemption.
  const cured = Object.keys(KNOWN_DRIFT).filter((k) =>
    k in (standalone as Record<string, unknown>)
  );
  assert(
    cured.length === 0,
    `KNOWN_DRIFT entries now exported by standalone — remove them from the ` +
      `ledger: ${cured.join(", ")}`,
  );
  // …and an entry whose symbol left aio/air is equally stale.
  const gone = Object.keys(KNOWN_DRIFT).filter((k) => !(k in air));
  assert(
    gone.length === 0,
    `KNOWN_DRIFT entries no longer on aio/air: ${gone.join(", ")}`,
  );
  assert(
    missing.length === 0,
    `aio/air exports missing from standalone-air (the android alias): ` +
      `${missing.join(", ")} — a component using ${
        missing[0]
      } type-checks green and dies at APK bundle time (RIS-11).`,
  );
});
