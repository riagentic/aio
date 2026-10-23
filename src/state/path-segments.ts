// Dependency-free on purpose: `cell-helpers.ts` (in the test-strict graph,
// type-checked with `--no-config`) and `state-filter.ts` both read it, and
// state-filter's graph reaches a bare `immer`.

/** Does an exclude path segment name key `k`? With `wildcard` (a persist
 *  filter's paths), the segment `*` names every key — one whole segment,
 *  never a pattern inside a name — EXCEPT in an object whose `"*"` is a
 *  literal key (`literalStar`, decided from the declared shape — see
 *  state-filter.ts `starAt`): there `*` keeps the meaning it had before
 *  wildcards existed and names that key only, so `{ "*": "read", alice }` +
 *  `"perms.*"` still stores `alice`. Pure. @internal */
export function segNames(
  seg: string | undefined,
  k: string,
  wildcard = false,
  literalStar = false,
): boolean {
  return seg === k || (wildcard && !literalStar && seg === "*");
}
