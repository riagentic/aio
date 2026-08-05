/**
 * @module
 * One definition of "this action's arguments must never be retained".
 *
 * An action's payload is its ARGUMENTS, and for some methods the arguments are
 * the secret that protects everything else: a wallet's `unlockWith(passphrase)`,
 * `addSeed({mnemonic})`, `importPk({secretKeyBase58})`, or a crypto worker's
 * `encrypt({plaintext, passphrase})`. Anything that retains payloads — the
 * durable journal, the in-memory timeline behind `am timeline`, the optional
 * action log — has to honour the same list, or the app plugs one leak and keeps
 * another. That happened here: the journal was redacted and the timeline was
 * not, so `am timeline` still printed a live passphrase.
 *
 * A trailing `*` matches by PREFIX. Naming methods one by one is the list that
 * goes stale the day another is added, and it already had: a first version
 * listed only the unlock method, leaving a seed phrase and a raw private key to
 * be written in cleartext. Whole cells are the safer unit.
 */

/** What a redacted payload becomes. Kept as a value so every sink agrees. */
export const REDACTED = "[redacted]";

/** Decides whether an action type's payload must be dropped.
 *
 *  It also carries the set of CELLS it touches, because one sink cannot work
 *  from the action type alone: the diagnostic checkpoint writes whole cell
 *  slices of CURRENT state, with no action attached. A cell that has any
 *  redacted action holds values the app asked to keep nowhere, so the whole
 *  slice is withheld. Hanging it off the redactor keeps the promise that ONE
 *  list governs every sink and they cannot disagree. */
export type Redactor = ((type: string) => boolean) & {
  /** Cells with at least one redacted action. Empty when nothing is redacted. */
  readonly cells: ReadonlySet<string>;
};

/** Redacts nothing — the default for apps that never ask. */
export const noRedaction: Redactor = Object.assign(() => false, {
  cells: new Set<string>() as ReadonlySet<string>,
});

/** Does this recorded action have to lose its payload?
 *
 *  ONE decider, because an async method reaches the sinks TWICE under two
 *  different type strings: the call (`vault:unlockWith`) and the write-set
 *  commit that carries what it wrote (`vault:__setUnlockWith`). An exact
 *  pattern like `"vault:unlockWith"` matches the first and not the second, so
 *  checking the type alone would have redacted the arguments and then written
 *  the same passphrase out again as a mutation value. `origin` is the
 *  originating action type of a write-set; either one matching redacts both. */
export function isRedactedAction(
  redact: Redactor,
  type: string,
  origin?: string,
): boolean {
  return redact(type) || (origin !== undefined && redact(origin));
}

/** Build a redactor from patterns like `"unlock:*"` or `"cell:method"`. */
export function makeRedactor(patterns: readonly string[] = []): Redactor {
  if (patterns.length === 0) return noRedaction;
  const exact = new Set(patterns.filter((p) => !p.endsWith("*")));
  const prefixes = patterns
    .filter((p) => p.endsWith("*"))
    .map((p) => p.slice(0, -1));
  // The cell half of every pattern: `"vault:*"` and `"vault:unlockWith"` both
  // name the cell `vault`. A pattern with no colon (a bare prefix like
  // `"vault"`) is treated as naming the cell too — the safe direction.
  const cells = new Set<string>();
  for (const p of patterns) {
    const ci = p.indexOf(":");
    const name = ci >= 0 ? p.slice(0, ci) : p.replace(/\*$/, "");
    if (name) cells.add(name);
  }
  return Object.assign(
    (type: string) =>
      exact.has(type) || prefixes.some((p) => type.startsWith(p)),
    { cells: cells as ReadonlySet<string> },
  );
}
