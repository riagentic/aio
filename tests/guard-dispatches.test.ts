// a field report Bad #3 (crash-only, piece 2): with `guardDispatches: true`
// an unhandled promise rejection (a fire-and-forget cell dispatch that rejects)
// is logged loudly and the process SURVIVES — the crash handler preventDefault()s
// the rejection instead of letting it terminate. Scoped to rejections; a real
// synchronous throw is still fatal. Never silent — always logged first.
import { assert, assertEquals } from "@std/assert";
import { installCrashHandler } from "../src/diagnostics/crash-handler.ts";

function fireRejection(): boolean {
  // A cancelable synthetic event drives the registered listener without touching
  // Deno's real unhandled-rejection machinery (which would kill the test).
  const ev = new Event("unhandledrejection", { cancelable: true }) as Event & {
    reason?: unknown;
  };
  ev.reason = new Error("fire-and-forget boom");
  globalThis.dispatchEvent(ev);
  return ev.defaultPrevented;
}

Deno.test("guardDispatches: a rejection is logged AND prevented from crashing", () => {
  let logged = "";
  const uninstall = installCrashHandler({
    guardRejections: true,
    log: {
      error: (m) => {
        logged = m;
      },
    },
    getHealthData: () => ({ cells: {} }),
    writeEmergencyCheckpoint: () => {},
  });
  try {
    const prevented = fireRejection();
    assert(
      prevented,
      "the rejection must be preventDefault()'d (process survives)",
    );
    assert(logged.includes("boom"), "the failure must still be logged loudly");
  } finally {
    uninstall();
  }
});

Deno.test("guardRejections OFF (explicit fail-fast): logged but NOT prevented", () => {
  let logged = "";
  const uninstall = installCrashHandler({
    // guardRejections omitted → default crash behavior preserved
    log: {
      error: (m) => {
        logged = m;
      },
    },
    getHealthData: () => ({ cells: {} }),
    writeEmergencyCheckpoint: () => {},
  });
  try {
    const prevented = fireRejection();
    assertEquals(prevented, false, "default must not swallow the crash");
    assert(logged.includes("boom"), "still logged");
  } finally {
    uninstall();
  }
});
