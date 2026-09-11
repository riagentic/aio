/**
 * @module
 * One suppression marker, with a scope.
 *
 * There were two, one letter apart, honoured by different checkers (vidtune
 * §8.1). `aiol-ok` worked for the project linter and for nothing else;
 * `aio-ok` worked for every script gate and, since alpha77, for the linter
 * too. Both are placed by copying a nearby line, so the wrong one is silent —
 * you write `aiol-ok` next to a `check:silent-catch` finding and the gate
 * simply keeps failing, with no hint that the marker was addressed to someone
 * else.
 *
 * So: BOTH SPELLINGS, EVERYWHERE. `aio-ok` and `aiol-ok` are the same marker,
 * and a reader never has to know which checker is asking.
 *
 * And a scope, because the old marker had none. `// aio-ok: reason` still
 * silences whichever gate is looking at that line — that is what every
 * existing marker in the repo means and it keeps meaning it. But
 * `// aio-ok(silent-catch): reason` silences ONLY `check:silent-catch`, so a
 * justification written for one finding cannot quietly cover a different one
 * that lands on the same line later.
 *
 * A reason is required either way. A bare `aio-ok` is not a justification.
 */

/** `aio-ok` / `aiol-ok`, optional `(scope[,scope])`, then a real reason. */
const MARKER = /\baiol?-ok\b(?:\(([^)]*)\))?\s*[:\-—]\s*(\S)/;

/** Is `line` a justification that the gate named `rule` must honour?
 *
 *  `rule` is the gate's own short name (`"silent-catch"`, `"vacuous"`, …).
 *  Pass nothing and any scoped marker is refused — a caller that cannot say
 *  who it is has no business claiming a scoped suppression. */
// aio-ok: the script gates' seam — scripts/check-*.ts are the callers, and src/ uses the strict justifiedFor instead.
export function justified(line: string, rule?: string): boolean {
  const m = MARKER.exec(line);
  if (!m) return false;
  const scope = m[1];
  if (scope === undefined) return true; // unscoped: whoever is looking
  if (rule === undefined) return false;
  return scope.split(",").map((s) => s.trim()).filter(Boolean).includes(rule);
}

/** The same scoping, without demanding a reason.
 *
 *  `aiol` has always accepted a bare `// aiol-ok`, and dozens of lines in this
 *  repo are written that way. Tightening that would be a silent behaviour
 *  change to a linter people already rely on, for no finding — so the reason
 *  stays optional HERE and stays required for the script gates, which have
 *  always demanded one. What this shares with {@linkcode justified} is the
 *  part that was actually broken: both spellings, and a scope that means
 *  something. */
// aio-ok: the peer linter's seam — `aiol` is the only caller and must not be reached from src/.
export function justifiedLoose(line: string, rule?: string): boolean {
  const m = /\baiol?-ok\b(?:\(([^)]*)\))?/.exec(line);
  if (!m) return false;
  const scope = m[1];
  if (scope === undefined) return true;
  if (rule === undefined) return false;
  return scope.split(",").map((s) => s.trim()).filter(Boolean).includes(rule);
}

/** Like {@linkcode justified}, but the scope is REQUIRED.
 *
 *  Most gates take an unscoped `// aio-ok: reason` — that is what the hundreds
 *  of existing markers in this repo mean and it has to keep meaning it. A few
 *  rules cannot afford that. `graph-validator`'s server-only check is one: its
 *  neighbours are BLOCKING categories, a guaranteed blank screen, and a marker
 *  written for some other finding on the same line must never reach it. Its own
 *  test says so — "a marker for one rule must not quietly cover another" — and
 *  routing it through the permissive form broke exactly that.
 *
 *  The legacy spelling `// aio-ok: server-only` names its category in the
 *  REASON rather than in parentheses, and predates the grammar; callers that
 *  have one keep accepting it themselves. */
export function justifiedFor(line: string, rule: string): boolean {
  const m = /\baiol?-ok\b\(([^)]*)\)\s*[:\-—]\s*(\S)/.exec(line);
  if (!m) return false;
  return m[1]!.split(",").map((s) => s.trim()).filter(Boolean).includes(rule);
}
