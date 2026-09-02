// A TOTP code computed just before a 30-second boundary is stale by the time
// the server checks it.
//
// The shape, seen failing in a full-suite run:
//
//   const step = Math.floor(Date.now() / 30_000);
//   await b.post("totp/enable", { code: await totpCode(secret, step - 1) })
//                                            ↑ window rolls in here
//
// The server validates against ITS current step with a ±1 skew, so a code for
// `step - 1` is fine inside the same window and two windows stale once the
// boundary passes — a 401 that has nothing to do with what the test is
// asserting. It is rare (a ~1-in-N chance per run, worse under load, which is
// when suites are slowest) and it lands on a DIFFERENT test each time, which is
// the property that makes a flake expensive: it reads as a new failure.
//
// Waiting the edge out is deterministic, unlike a retry: at most a few hundred
// ms, and only when a run happens to start near a boundary.

/** Sleep past an imminent TOTP window boundary, so a code computed after this
 *  call is still current when the server validates it. */
export async function awaitStableTotpWindow(marginMs = 3_000): Promise<void> {
  const msLeftInWindow = 30_000 - (Date.now() % 30_000);
  if (msLeftInWindow < marginMs) {
    await new Promise((r) => setTimeout(r, msLeftInWindow + 50));
  }
}
