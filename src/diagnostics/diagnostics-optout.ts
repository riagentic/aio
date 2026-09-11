/**
 * @module
 * Which cells asked to stay out of the on-disk dev diagnostics.
 *
 * `cell({ diagnostics: false })`. A separate word from `persist` on purpose: a
 * field report read `persist: "none"` as covering the action journal too
 * (trading-app report §7), and it does not — `persist` is about the STATE STORE, the
 * journal is a dev diagnostic that is off in production and lives in the app's
 * own data directory. Making one key silently mean two things is worse than
 * the surprise, so this is the key that means the other one.
 *
 * A REGISTRY rather than a parameter. The cells are known at boot and the
 * diagnostics writer is built before them; threading the list through would
 * have widened `initDiagnostics`, an exported signature, for a fact that is
 * process-global anyway. The setter is called once per boot with the full set,
 * so a second app in the same process replaces rather than accumulates — and
 * the writer asks per action, so a cell registered later is still honoured.
 */

let _optedOut: ReadonlySet<string> = new Set();

/** Replace the opted-out set. Called once per boot with every cell's verdict. */
export function setDiagnosticsOptOut(names: Iterable<string>): void {
  _optedOut = new Set(names);
}

/** Clear it — teardown, and between tests. */
export function resetDiagnosticsOptOut(): void {
  _optedOut = new Set();
}

/** Should this action stay out of the on-disk record?
 *
 *  `type` is `"<cell>:<method>"`. A type with no colon belongs to no cell and
 *  is never excluded: the opt-out is a statement about one cell, and silently
 *  widening it to framework-level actions would hide the very entries that
 *  explain what happened around the excluded ones. */
export function isDiagnosticsOptOut(type: string): boolean {
  if (_optedOut.size === 0) return false;
  const i = type.indexOf(":");
  if (i <= 0) return false;
  return _optedOut.has(type.slice(0, i));
}
