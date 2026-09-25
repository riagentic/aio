// `transaction` was read by SHAPE — `true` or an object turns it on — so any
// other value silently left it OFF (`transaction: "yes"`, `"serializable"`),
// a typo'd key never took effect (`{ serialise: true }`), and a misspelled
// `conflict` ("Abort") fell through to the commit-anyway branch. Every one of
// them is a ledger cell that believes it is protected and is not.
import { assertStringIncludes, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";

Deno.test("cell(): a malformed transaction setting is refused, not silently read as off", () => {
  const methods = {
    // deno-lint-ignore require-await
    async pay(s: { n: number }) {
      s.n++;
    },
  };
  let i = 0;
  for (
    const [tx, says] of [
      ["yes", 'transaction: "yes" is not a transaction setting'],
      ["serializable", "is not a transaction setting"],
      [1, "transaction: 1 is not a transaction setting"],
      [null, "transaction: null is not a transaction setting"],
      [{ serialise: true }, 'unknown key "serialise"'],
      [{ serialize: "true" }, "transaction.serialize must be a boolean"],
      [{ conflict: "Abort" }, 'transaction.conflict must be "abort" or "warn"'],
    ] as const
  ) {
    const m = assertThrows(
      () =>
        cell(`txBad${i++}`, {
          state: { n: 0 },
          methods,
          transaction: tx as never,
        }),
      Error,
    ).message;
    assertStringIncludes(m, says);
  }
  // Every documented spelling still builds.
  for (
    const tx of [
      true,
      false,
      undefined,
      { serialize: true },
      { conflict: "warn" as const },
      { serialize: true, conflict: "abort" as const },
    ]
  ) {
    cell(`txOk${i++}`, { state: { n: 0 }, methods, transaction: tx });
  }
});
