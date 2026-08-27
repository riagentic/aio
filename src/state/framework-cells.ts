/**
 * @module
 * Which cells are AIO'S OWN, not the app's.
 *
 * `updates` and `feedback` are registered by the framework when the app turns
 * the feature on (`aio.run({ updates: … })`). They are cells like any other —
 * they dispatch, they persist, they show up in the composition report — but
 * their methods are not the app author's code, and a diagnostic that asks the
 * author to act on them asks for something they cannot do.
 *
 * ONE list, so every such decision agrees. Today the perf budget reads it: an
 * otherwise healthy hello-world printed a red framework ERROR three times
 * (`[BUDGET_EFFECT] updates:check exceeded budget: 5.5ms > 5ms`) telling the
 * developer to add a `perfBudget` override for a method they do not own — for
 * one network check, at boot, that is supposed to take milliseconds.
 */

/** Cell ids the FRAMEWORK registers on the app's behalf. */
export const FRAMEWORK_CELLS: ReadonlySet<string> = new Set([
  "updates",
  "feedback",
]);

/** Is `cellName` one of aio's own cells (rather than the app's)? */
export function isFrameworkCell(cellName: string | undefined): boolean {
  return cellName !== undefined && FRAMEWORK_CELLS.has(cellName);
}
