/**
 * @module
 * One definition of what a framework-internal action type IS.
 *
 * The `__`-prefixed action types are not one category. Two of them are decided
 * about, over and over, by every sink that records dispatches:
 *
 *  • `cell:__exec` — a MARKER. It says an async method's body was scheduled; it
 *    carries no writes and changes no state. Recording it adds a line that
 *    answers nothing.
 *  • `cell:__setMethod` — the WRITE-SET. An async or transactional method does
 *    not commit inside its `cell:method` action (that one fires at CALL time,
 *    before the body has written anything); everything it writes is published
 *    later as one atomic write-set commit by the batcher in
 *    `src/state/cell-impl.ts`. It is the opposite of noise — it is the ONLY
 *    record of what the method did.
 *
 * The distinction was made in FOUR places with four private copies of the list
 * (time travel, the journal/timeline hook, the action log, the logger's action
 * observer). Two of them still lumped the write-set in with the marker, so
 * `logs/actions.jsonl` — "replay the action sequence" — and `debug.log` — "all
 * actions dispatched" — showed an async method's call and never its writes,
 * long after the journal, the timeline and time travel had been fixed. A fact
 * written down four times drifts; this is where it is written down once.
 */

/** `cell:__setMethod` — the atomic write-set an async/transactional method
 *  commits. NEVER noise: no other action carries what the method wrote. */
export function isWriteSetAction(type: string): boolean {
  return type.includes(":__set");
}

/** `cell:__exec` — the "body scheduled" marker. Changes nothing, writes
 *  nothing. */
export function isExecMarker(type: string): boolean {
  return type.endsWith(":__exec");
}

/** May a sink that records DISPATCHED ACTIONS drop this type as noise?
 *
 *  Only the pure marker qualifies. Lifecycle (`__init`/`__destroy`) and error
 *  (`__error`) actions are real events a reader is entitled to see; the
 *  write-set is the payload itself. Sinks that REPLAY what they record (the
 *  journal) have a stricter rule of their own — replaying `__init` would reset
 *  a cell on top of a restored snapshot — and state it where they apply it. */
export function isActionNoise(type: string): boolean {
  return isExecMarker(type);
}

/** The `cell:method` an internal action BELONGS to, when it names one:
 *  a write-set commit (`cell:__setFoo`, method in `payload._origin`) or an
 *  async-method error frame (`cell:__error`, method in `payload._method`).
 *  `undefined` for everything else.
 *
 *  Every sink that retains payloads needs this, and needs it identically: an
 *  exact `redactActions: ["vault:unlockWith"]` pattern matches the call and NOT
 *  `vault:__setUnlockWith`, so a sink that checks only the type would redact the
 *  arguments and then write the same secret back out as a mutation value
 *  (`isRedactedAction` in redact.ts takes the origin for exactly this reason). */
export function actionOrigin(
  type: string,
  payload: unknown,
): string | undefined {
  const ci = type.indexOf(":");
  if (ci < 0) return undefined;
  const cell = type.slice(0, ci);
  const rest = type.slice(ci + 1);
  const p = payload as { _origin?: unknown; _method?: unknown } | undefined;
  if (isWriteSetAction(type)) {
    const m = p?._origin;
    return `${cell}:${typeof m === "string" && m ? m : rest}`;
  }
  if (rest === "__error" || rest.startsWith("__error")) {
    const m = p?._method;
    return typeof m === "string" && m ? `${cell}:${m}` : undefined;
  }
  return undefined;
}
