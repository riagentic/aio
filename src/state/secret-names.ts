// secret-names.ts — ONE answer to "does this field NAME look like a credential?"
//
// THE PROBLEM THIS COLLAPSES. The rule was written twice: `aio.run()`'s boot
// refusal (`server/aio-composition.ts`) and `aiol`'s static port of it
// (`aiol/checks.ts`), with a comment in the linter saying the regexes "MUST
// stay byte-identical" and a test comparing them as TEXT. That test is the
// right instinct and the wrong mechanism: it can only catch drift after
// someone writes it, it cannot catch a difference in how the two USE the same
// regex, and it makes any improvement to the rule a two-file edit that a
// refactor silently breaks — which is exactly what happened the first time the
// substring bug was fixed.
//
// So the fact lives here, once, and both sides import it. `state/` is
// dependency-light and reachable from `server/` and from the linter.
//
// THE RULE, and why it is shaped like this. A field name that mentions a secret
// concept is a SOFT warning (each of these words is also an ordinary noun
// somewhere: a musical `key`, a sampler `seed`). A name that unambiguously
// spells a credential is a boot REFUSAL. Both read WORDS, never substrings —
// as a substring, `key` fired inside `monkey`, `keyboard`, `donkey` and
// `whiskey`, `seed` inside `seedling`, `priv` inside `privacy`, and `password`
// inside `passwordless`, which is an ordinary field on any auth screen and
// which the REFUSAL tier would not let boot.
//
// A field report on a music app had three of about twenty fields flagged, and
// named the cost exactly: "by hour four I was skimming warnings instead of
// reading them." A security warning that cries wolf is worse than none, because
// the one that matters arrives looking identical to the ones that did not.

// Field names that usually hold secrets — used for the UI-exposure heuristic.
//
// `enc` is matched at a WORD BOUNDARY only, never as a bare substring. As a
// substring it fires on `latency`, `sequence`, `currency`, `reference`,
// `influence`, `agency`, `cadence` — ordinary words with an `enc` in the
// middle. A field report hit it with `lastLatencyMs`, a millisecond count that
// belongs on screen; a heuristic that cries wolf on measurements teaches
// people to reach for the escape hatch without reading, which is the one
// outcome a security warning must never produce.
//
// Two patterns because the boundary differs by case: lowercase `enc` counts
// at the start of a name or after a separator, and a capital `Enc` is a
// camelCase hump anywhere (`dataEnc`, `seedEncKey`). CAMEL_ENC is
// deliberately case-SENSITIVE — folding it would match the middle of
// `latency` again and undo the whole fix.
export const WORD_START_ENC = /(^|[^a-zA-Z])enc/i;
export const CAMEL_ENC = /Enc/;
/** A field name split into its WORDS — the segments a developer actually
 *  writes: `apiKey` → ["api","key"], `private_key` → ["private","key"],
 *  `SEED_2` → ["seed","2"], `monkey` → ["monkey"].
 *
 *  Everything below reads these instead of testing substrings, and that is the
 *  whole fix. As substrings, `key` matched inside `monkey`, `keyboard`,
 *  `donkey` and `whiskey`; `seed` inside `seedling`; `priv` inside `privacy`;
 *  and `password` inside `passwordless`, which is a plausible field on any auth
 *  screen and which the HARD matcher escalated to a boot REFUSAL. A field
 *  report on a music app had three of about twenty fields flagged, and named
 *  the real cost: "by hour four I was skimming warnings instead of reading
 *  them." A security warning that cries wolf is worse than none, because the
 *  one that matters arrives looking exactly like the ones that did not.
 *
 *  Splitting beats a cleverer regex here because the boundary rules differ by
 *  case (a lowercase word needs a separator, a capitalised one is a camel hump,
 *  an all-caps one is neither) and three interlocking lookarounds is a thing
 *  nobody can read or extend correctly. */
export function fieldWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Words that mark a field as secret-ISH — a soft warning, because each of
 *  them is also an ordinary noun somewhere (a musical `key`, a sampler `seed`).
 *  No name-based rule can tell those apart, which is what
 *  `visible: { publicFields: [...] }` is for. */
export const SECRET_WORDS: ReadonlySet<string> = new Set([
  "secret",
  "priv",
  "key",
  "seed",
  "mnemonic",
  "passphrase",
  "password",
  "passwrd",
]);

/** True when a field name mentions a secret-ish concept at all (before the
 *  public-hint and suffix filters below refine it). */
export function mentionsSecret(key: string): boolean {
  if (WORD_START_ENC.test(key) || CAMEL_ENC.test(key)) return true;
  return fieldWords(key).some((w) => SECRET_WORDS.has(w));
}
// Unambiguous CREDENTIAL names — an exposed value is almost certainly a real
// leak, so this is escalated from a warning to a boot REFUSAL in dev. Compound forms only (private_key, api_key,
// secret_key, access_token…) so feature names like "secretSanta"/"tokenList"
// don't false-fatal; bare `secret`/`key`/`token` stay soft warnings. `password`,
// `passphrase`, `mnemonic` are unambiguous on their own. (SECRET_FIELD_RE missed
// `password` entirely before this — a silent gap.)
/** Unambiguous CREDENTIAL names — an exposed value is almost certainly a real
 *  leak, so this is escalated from a warning to a boot REFUSAL in dev.
 *
 *  Compound forms only (private key, api key, secret key, access token, auth
 *  token) so feature names like `secretSanta` / `tokenList` do not false-fatal;
 *  bare `secret`/`key`/`token` stay soft warnings. `password`, `passphrase` and
 *  `mnemonic` are unambiguous on their own.
 *
 *  Matched against `_fieldWords`, not the raw name. As a substring regex this
 *  refused to boot an app with a field called `passwordless` — an ordinary
 *  thing to have on an auth screen, and a refusal is not a warning somebody can
 *  choose to ignore. */
export const HARD_SECRET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["private", "key"],
  ["api", "key"],
  ["secret", "key"],
  ["access", "token"],
  ["auth", "token"],
];
export const HARD_SECRET_SINGLES: ReadonlySet<string> = new Set([
  "password",
  "passwrd",
  "passphrase",
  "mnemonic",
]);

/** True when the name is an unambiguous credential (see HARD_SECRET_PAIRS). */
export function isHardSecret(key: string): boolean {
  const w = fieldWords(key);
  if (w.some((x) => HARD_SECRET_SINGLES.has(x))) return true;
  return HARD_SECRET_PAIRS.some(([a, b]) =>
    w.some((x, i) => x === a && w[i + 1] === b)
  );
}
// …but a "public" hint (pubKey, publicKey) means it's meant to be shared.
//
// ANCHORED to a word boundary, because an unanchored /pub(lic)?/i matched the
// substring ANYWHERE: `pubsubSecretKey`, `republishedApiKey` and
// `epubPassword` all silently claimed the exemption and walked past a gate
// that exists to refuse exactly those names. An exemption that any substring
// can claim is not an exemption, it is a bypass — so the hint has to be the
// START of the name or the start of a camelCase/underscore/dash word inside
// it, which is how `pubKey`, `publicKey` and `owner_public_key` are actually
// spelled and how `pubsub` is not.
export const PUBLIC_HINT_RE =
  /(?:^|[_-])(?:pub|public|Pub|Public|PUB|PUBLIC)(?![a-z])|[a-z0-9](?:Pub|Public)(?![a-z])/;
// …and these suffixes mark identifiers/metadata, not the secret itself:
// seedId, seedPathType, keyName, encMode — nav state, not a leaked secret
//.
// …plus MEASUREMENT suffixes: a quantity is a reading, not a credential.
// `lastLatencyMs` was warned about in a field report — it is a millisecond
// count from Send to first token and belongs on screen.
export const NONSECRET_SUFFIX_RE =
  /(Id|Ids|Type|Name|Count|Index|Idx|At|Ref|Kind|Length|Len|Path|Mode|Status|Flag|Enabled|Visible|Label|Order|Version|Ms|Sec|Secs|Seconds|Bytes|Kb|Mb|Gb|Hz|Pct|Percent|Ratio|Rate|Total|Avg|Min|Max|Size|Width|Height|Duration|Elapsed)$/;

/** True when a field NAME looks like it holds a secret meant to stay private.
 *  Skips public-key-style names and identifier/metadata suffixes to avoid the
 *  false positives that made the old heuristic cry wolf. */
export function looksSecret(key: string): boolean {
  if (!mentionsSecret(key)) return false;
  if (PUBLIC_HINT_RE.test(key)) return false;
  if (NONSECRET_SUFFIX_RE.test(key)) return false;
  return true;
}

/** True when the name is a credential the boot REFUSES to expose.
 *
 *  THE COMPOSITE, not its parts. Both callers needed
 *  `isHardSecret(k) && !PUBLIC_HINT_RE.test(k) && !NONSECRET_SUFFIX_RE.test(k)`
 *  and each re-assembled it from three exported regexes — which is how they
 *  drifted, and what a byte-comparison test could never have caught: the
 *  regexes can be identical while the expressions around them are not. One
 *  function is one fact. */
export function isRefusableCredential(key: string): boolean {
  return isHardSecret(key) && !PUBLIC_HINT_RE.test(key) &&
    !NONSECRET_SUFFIX_RE.test(key);
}
