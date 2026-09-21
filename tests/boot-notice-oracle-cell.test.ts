// The "hides state, gates no calls" boot notice must fire on the shape it was
// WRITTEN for: a cell with no state, `visible: "none"`, and public methods.
//
// That shape is the audit's origin story — an internal oracle cell holding no
// state of its own, hidden from every client, whose `decrypt`/`sign` methods
// were reachable by any of them, because `visible` gates READS and `access`
// gates CALLS and neither implies the other. The notice built to catch it
// opened with `if (hidden.length === 0) continue;`, and for a stateless cell
// `"none"` hides an empty set — so the one case the feature exists for was the
// one case it skipped, and the boot's silence read as approval.
//
// `"none"` is a blanket over the whole cell, present state and future. An
// empty hidden set means "hides nothing" only for a FILTER (`exclude: []`, an
// `include` naming every key) or a bare `forUser`, which is screened per
// client rather than structurally.
//
// Found by a re-audit that checked the ten wallet findings against the tree
// instead of against their own status lines. The rule is a pure function now,
// because the only reason nobody caught this was that the loop logged directly
// and the sole way to ask it anything was to boot an app and read stderr.

import { assert, assertEquals } from "@std/assert";
import {
  hiddenButCallableReason,
  type HiddenCallableInput,
} from "../src/server/aio-composition.ts";

/** The audit's cell: hidden from every client, two public crypto methods. */
const oracle = (
  over: Partial<HiddenCallableInput> = {},
): HiddenCallableInput => ({
  id: "vault",
  state: {},
  ui: "none",
  access: undefined,
  actionKeys: ["decrypt", "sign"],
  ...over,
});

Deno.test("a STATELESS `visible: none` cell with public methods is flagged", () => {
  const why = hiddenButCallableReason(oracle());
  assert(
    why !== null,
    "the notice skipped a stateless oracle cell — the exact shape it exists " +
      'for. An empty state does not make `visible: "none"` hide nothing.',
  );
  assert(why!.includes("vault"), "the notice must name the cell");
  assert(why!.includes("decrypt"), "the notice must name what stays callable");
  assert(
    why!.includes("`visible` gates READS"),
    "the notice must say why the pairing matters",
  );
});

Deno.test("the same cell WITH state is flagged too (the case that worked)", () => {
  assert(
    hiddenButCallableReason(oracle({ state: { key: "s3cret" } })) !== null,
  );
});

Deno.test("an `access` rule silences it — the notice is about the PAIRING", () => {
  // Any answer counts, including "open on purpose".
  assertEquals(hiddenButCallableReason(oracle({ access: false })), null);
  assertEquals(hiddenButCallableReason(oracle({ access: () => true })), null);
  assertEquals(hiddenButCallableReason(oracle({ access: "admin" })), null);
});

Deno.test("no callable method, no door, no notice", () => {
  // `__`-prefixed framework actions are refused at every wire entry point.
  assertEquals(
    hiddenButCallableReason(oracle({ actionKeys: ["__internal"] })),
    null,
  );
  assertEquals(hiddenButCallableReason(oracle({ actionKeys: [] })), null);
});

Deno.test("nothing secret-shaped in any name, no notice", () => {
  // The anti-cry-wolf rule: a background worker cell hidden behind
  // `visible: "none"` with a `tick` method is an honest, common shape.
  assertEquals(
    hiddenButCallableReason(
      oracle({ id: "queue", actionKeys: ["tick", "drain"] }),
    ),
    null,
  );
});

Deno.test("a filter that hides NOTHING is still skipped", () => {
  // The branch the old condition was right about, and why the fix narrows it
  // rather than deleting it: `exclude: []` takes nothing away, so there is no
  // hidden/callable pairing to warn about.
  assertEquals(
    hiddenButCallableReason(
      oracle({ state: { key: "s3cret" }, ui: { exclude: [] } }),
    ),
    null,
  );
  // …and an `include` naming every key is the same fact spelled the other way.
  assertEquals(
    hiddenButCallableReason(
      oracle({ state: { key: "s3cret" }, ui: { include: ["key"] } }),
    ),
    null,
  );
});

Deno.test("a filter that DOES hide a secret-shaped field is flagged", () => {
  const why = hiddenButCallableReason(
    oracle({
      state: { apiKey: "x", summary: "y" },
      ui: { exclude: ["apiKey"] },
    }),
  );
  assert(why !== null, "an exclude that hides a credential still pairs badly");
  assert(why!.includes("apiKey"), "the notice must name the field it flagged");
});

Deno.test("no filter at all is a different question", () => {
  // `visible: "all"` and an absent `visible` are the exposure heuristic's
  // business, not this one — two findings that read alike are two findings
  // nobody can tell apart.
  assertEquals(hiddenButCallableReason(oracle({ ui: "all" })), null);
  assertEquals(hiddenButCallableReason(oracle({ ui: undefined })), null);
});

Deno.test("the oracle verbs that matter are caught", () => {
  // `decrypt` and `sign` are the two the old rule missed. Encrypting on
  // request leaks little; DECRYPTING on request is the whole attack, and
  // signing on request is the wallet version of it.
  for (
    const m of [
      "decrypt",
      "sign",
      "signTx",
      "signMessage",
      "unlock",
      "unseal",
      "unwrap",
      "derive",
      "deriveKey",
      "reveal",
      "exportKey",
      "exportSeed",
      "encrypt",
    ]
  ) {
    assert(
      hiddenButCallableReason(oracle({ actionKeys: [m] })) !== null,
      `a hidden, ungated cell exposing "${m}" must be flagged`,
    );
  }
});

Deno.test("ordinary words containing the same letters stay quiet", () => {
  // The whole cry-wolf risk of this rule is here. A warning that fires on
  // `signIn` gets muted wholesale, and then it protects nobody.
  for (
    const m of [
      "signIn",
      "signUp",
      "signOut",
      "signal",
      "signature",
      "assign",
      "design",
      "resign",
      "cosign",
      "undo",
      "unmount",
      "deselect",
      "delete",
      "decrement",
      "exportCsv",
      "unreadCount",
    ]
  ) {
    assertEquals(
      hiddenButCallableReason(oracle({ id: "app", actionKeys: [m] })),
      null,
      `"${m}" is an ordinary method name — flagging it teaches people to ` +
        `ignore this notice`,
    );
  }
});
