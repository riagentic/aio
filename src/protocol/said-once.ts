// said-once.ts — what a PRODUCTION client says about the app doing the wrong
// thing: one line, once.
//
// The renderer's diagnostics were written for `deno task dev`: every one sat
// behind `isDevMode()`, so the same defect in a packaged app — a hydration
// that fell back to a client render, a duplicate key, a hook called where it
// is dropped — left nothing in `client.log`. A field report found each of
// them only by driving the built app. The rule (CLAUDE.md, dev == prod): a
// line that reports a DEFECT is not a dev nicety. Dev keeps its prose and its
// own repetition rule; prod says the fact, briefly, once per kind.
//
// Here rather than in `state/` because `ui` may not import `state` (the folder
// matrix) and every client folder may import `protocol`. No dev check inside:
// the caller already asked (`isDevMode()`, or `__aioDev` read off globalThis
// where the matrix forbids the import).

/** Kinds already said. Cleared by `_resetAioRuntime` (through
 *  `_resetActionWarnings`, state/action-encode.ts) — a "have I said this?"
 *  memory that outlives a test makes the next test's diagnostics
 *  order-dependent. */
export const _said: Set<string> = new Set();

/** Ceiling on remembered kinds: a key may carry a tag or component name, and
 *  a page that generates those must not grow the set for its whole life. At
 *  the cap the memory is dropped whole — a line said twice is the harmless
 *  direction. */
const MAX = 200;

/** First time for `key`? Records it. */
export function firstTime(key: string): boolean {
  if (_said.has(key)) return false;
  if (_said.size >= MAX) _said.clear();
  _said.add(key);
  return true;
}

/** Say `msg` once per `key`, on the page's console — which the console
 *  forwarder carries to `client.log`, so a packaged app's log has the line.
 *  Observe-only: nothing the page renders or sends depends on it. */
export function saysOnce(msg: string, key: string = msg): void {
  // aio-ok: the PAGE's console — every caller is renderer or client code,
  // which has no logger; server code takes `firstTime` and its own `log`.
  if (firstTime(key)) console.warn("[aio] " + msg);
}
