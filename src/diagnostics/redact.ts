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

/** Decides whether an action type's payload must be dropped. */
export type Redactor = (type: string) => boolean;

/** Redacts nothing — the default for apps that never ask. */
export const noRedaction: Redactor = () => false;

/** Build a redactor from patterns like `"unlock:*"` or `"cell:method"`. */
export function makeRedactor(patterns: readonly string[] = []): Redactor {
  if (patterns.length === 0) return noRedaction;
  const exact = new Set(patterns.filter((p) => !p.endsWith("*")));
  const prefixes = patterns
    .filter((p) => p.endsWith("*"))
    .map((p) => p.slice(0, -1));
  return (type: string) =>
    exact.has(type) || prefixes.some((p) => type.startsWith(p));
}
