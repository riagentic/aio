// deno-version.ts — enforce the minimum Deno version aio is built against.
//
// aio targets the latest stable Deno and uses ≥2.9 behavior directly — e.g.
// reading WS headers before `Deno.upgradeWebSocket` (2.9 closes the request on
// upgrade), `node:dgram` LAN discovery, and stable `Deno.Kv`. On older Deno
// these fail cryptically mid-run, so gate it at boot with one clear message.

/** Minimum Deno version aio supports. */
export const MIN_DENO = "2.9.0";

/** Parse a dotted version ("2.9.1", "2.10.0-rc.1") → [major, minor, patch]. */
function parseVersion(v: string): [number, number, number] {
  const parts = v.split(".").map((p) => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** True when `have` is at least `want` (numeric major.minor.patch compare). */
export function meetsMinDeno(have: string, want: string = MIN_DENO): boolean {
  const [h0, h1, h2] = parseVersion(have);
  const [w0, w1, w2] = parseVersion(want);
  if (h0 !== w0) return h0 > w0;
  if (h1 !== w1) return h1 > w1;
  return h2 >= w2;
}

/** Throw a clear, actionable error if the running Deno is too old for aio.
 *  Called once at the top of `aio.run()`. Defaults to the live Deno version. */
export function assertDenoVersion(have: string = Deno.version.deno): void {
  if (!meetsMinDeno(have)) {
    throw new Error(
      `aio requires Deno ${MIN_DENO}+ — you're running ${have}. ` +
        `Upgrade with: deno upgrade`,
    );
  }
}
