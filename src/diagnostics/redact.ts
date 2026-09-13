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
  /** Cells named by a pattern. Empty when nothing is redacted — and ALSO
   *  empty for `"*"`, which names every cell rather than any one of them, so
   *  ask `redactsCell` / `redactsAnyCell` instead of reading this. */
  readonly cells: ReadonlySet<string>;
  /** Is this cell's STATE redacted? Handles `"*"`, which `cells` cannot. */
  readonly redactsCell: (cell: string) => boolean;
  /** Is ANY cell's state redacted? The honest form of `cells.size > 0`. */
  readonly redactsAnyCell: () => boolean;
};

/** Redacts nothing — the default for apps that never ask. */
export const noRedaction: Redactor = Object.assign(() => false, {
  cells: new Set<string>() as ReadonlySet<string>,
  redactsCell: () => false,
  redactsAnyCell: () => false,
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

/** Build a redactor from patterns like `"unlock:*"` or `"cell:method"`.
 *
 *  A pattern with NO COLON names a whole cell, and it now redacts that cell's
 *  actions as well as marking the cell. It used to do only the marking: the
 *  checkpoint withheld the slice — so a security sweep confirmed the setting
 *  worked — while the predicate matched no action at all, and the journal,
 *  `am timeline` and `logs/actions.jsonl` kept writing the payload in
 *  cleartext. Measured on `redactActions: ["vault"]`: `cells` held `vault`
 *  and both `vault:unlockWith` and `vault:__setUnlockWith` came back false.
 *  Plugging one leak and keeping another is the exact failure this module's
 *  header says it exists to end.
 *
 *  `"vault"` therefore means `"vault:*"`. That is the safe direction and the
 *  one the `cells` half already took. */
export function makeRedactor(patterns: readonly string[] = []): Redactor {
  if (patterns.length === 0) return noRedaction;
  // A bare cell name is expanded FIRST, so the exact/prefix split below sees
  // one vocabulary rather than two.
  const expanded = patterns.map((p) => {
    if (p.endsWith("*")) return p;
    // `"vault"` and `"vault:"` both name a cell and neither names a method,
    // so both mean every action of it. The second had the identical hole: it
    // marked the cell and matched nothing.
    if (p.endsWith(":")) return `${p}*`;
    return p.includes(":") ? p : `${p}:*`;
  });
  // ONE parse of every pattern into a (cell, method) pair, and BOTH halves —
  // "is this action redacted" and "is this cell's state redacted" — are read
  // off that same pair. They used to be two parsers, and they disagreed in
  // both directions: `"*:unlockWith"` withheld every cell's state while
  // matching no action (a literal `*` never equals a cell name), so the
  // passphrase went to the journal; and `"vault*"` redacted `vaultKeys:add`
  // while the checkpoint withheld only a cell literally named `vault`, so the
  // seed went to `logs/checkpoint.json`. One pattern, one meaning, every sink.
  //
  // The cell half: `"*"` (or empty) is every cell, a trailing `*` is a name
  // PREFIX, anything else an exact name. The method half: a trailing `*` is a
  // prefix, anything else exact. A colon-less pattern is a whole-type prefix,
  // i.e. a cell-name prefix with every method.
  //
  // An EMPTY cell part is `"*"`, in both halves. `":unlockWith"` was still
  // two meanings after the split above: the cell half read "" as every cell
  // (every slice withheld), while the action half compared "" to the cell
  // name, matched nothing, and journaled the passphrase. No cell is named "",
  // so the only reading both halves can share is the one the cell half took:
  // `":unlockWith"` is `"*:unlockWith"`, and `":"` / `""` are `"*"`.
  const parsed = expanded.map((p) => {
    const ci = p.indexOf(":");
    const cell = ci >= 0 ? p.slice(0, ci) : p;
    const method = ci >= 0 ? p.slice(ci + 1) : "*";
    return { cell: cell === "" ? "*" : cell, method };
  });
  const nameMatches = (pat: string, name: string) =>
    pat.endsWith("*") ? name.startsWith(pat.slice(0, -1)) : name === pat;
  const matchesType = (type: string) => {
    const ci = type.indexOf(":");
    const cell = ci >= 0 ? type.slice(0, ci) : type;
    const method = ci >= 0 ? type.slice(ci + 1) : "";
    return parsed.some((p) =>
      nameMatches(p.cell, cell) && nameMatches(p.method, method)
    );
  };
  // The cell half of every pattern: `"vault:*"` and `"vault:unlockWith"` both
  // name the cell `vault`, and `"vault*"` names every cell whose name starts
  // with `vault` — the same cells its action half matches.
  const cells = new Set<string>();
  // `"*"` means EVERY cell, and it is the broadest thing an operator can
  // write. It used to name none (`"*".replace(/\*$/, "")` is `""`, dropped by
  // an `if (name)` guard), so with `redactActions: ["*"]` the passphrase sat in
  // cleartext in `logs/checkpoint.json` while the NARROWER `["vault:*"]`
  // redacted it. See tests/redact-star-covers-everything.test.ts.
  let all = false;
  const cellPrefixes: string[] = [];
  for (const { cell } of parsed) {
    // `"*"`, `"*:*"` and `"*:anything"` all name every cell.
    if (cell === "" || cell === "*") all = true;
    else if (cell.endsWith("*")) {
      // The stem stays in `cells` (it always was, and it is itself a match);
      // the prefix is what makes `vaultKeys` withheld as well.
      cells.add(cell.slice(0, -1));
      cellPrefixes.push(cell.slice(0, -1));
    } else cells.add(cell);
  }
  return Object.assign(
    matchesType,
    {
      cells: cells as ReadonlySet<string>,
      /** Is this cell's STATE redacted? The question every cells-scoped sink
       *  actually has, and the one `cells` alone cannot answer for `"*"`.
       *  `cells` stays exactly as it was for anything already reading it. */
      redactsCell: (cell: string) =>
        all || cells.has(cell) ||
        cellPrefixes.some((p) => cell.startsWith(p)),
      /** Is ANY cell's state redacted? The `size === 0` early-outs mean "there
       *  is nothing to do"; with `"*"` there is everything to do. */
      redactsAnyCell: () => all || cells.size > 0 || cellPrefixes.length > 0,
    },
  );
}
