// THE patch-vs-full decider, one for both transports (server-broadcast.ts for
// WS, uds.ts for the desktop socket). Two copies of this rule drifted before:
// WS learned to skip the full serialization when a size estimate already
// answers the question; UDS kept serializing the WHOLE view every patch round
// just to compare lengths — 16 ms a round at 12.5 MB, to send a 50-byte patch.

/** What the round sends one client, and the full-state text serialized to
 *  decide it (when it had to be). */
export type PatchOrFull = {
  /** True → send the whole state (`fullJson`, always set); false → the patch. */
  sendFull: boolean;
  /** The view serialized for THIS decision, or undefined when the estimate
   *  answered it without one (or the snapshot failed). A caller reuses it
   *  rather than serializing again. */
  fullJson: string | undefined;
};

/** Patch or full, for a patch of `patchLen` chars.
 *
 *  The full state is serialized ONLY when the decision needs it: the length of
 *  the last full text this client was sent or measured (`knownFullLen`) stands
 *  in as the estimate, and a patch clearly under `threshold` × it is sent
 *  without measuring. The estimate can be stale, but only in the SAFE
 *  direction — a patch is always a correct frame; the worst case is a patch
 *  larger than an ideal full resend, never a wrong state. A patch near the
 *  threshold (or no estimate yet) measures, and the measured text is returned
 *  so the caller refreshes its estimate from it. */
export function decidePatchOrFull(
  patchLen: number,
  knownFullLen: number | undefined,
  threshold: number,
  snapshot: () => string | undefined,
): PatchOrFull {
  const fullJson =
    knownFullLen === undefined || patchLen > knownFullLen * threshold
      ? snapshot()
      : undefined;
  return {
    sendFull: fullJson !== undefined && patchLen > fullJson.length * threshold,
    fullJson,
  };
}
