// One `redactActions` pattern used to mean two different things, depending on
// which sink read it. The action half (journal, timeline, actions.jsonl) and
// the cell half (checkpoint, timeline diffs, problem report) were two parsers:
//
//   ["*:unlockWith"]  action vault:unlockWith redacted: false   (passphrase journaled)
//                     checkpoint withheld EVERY cell
//   ["vault*"]        action vaultKeys:add redacted: true
//                     checkpoint {"vaultKeys":{"seed":"abandon …"}}  (seed on disk)
//
// The property pinned here: for every pattern, a cell whose actions are
// redacted is a cell whose state is withheld — the two halves cannot disagree.
import { assert, assertEquals } from "@std/assert";
import { makeRedactor } from "../src/diagnostics/redact.ts";
import { _redactCheckpointState } from "../src/diagnostics/checkpoint.ts";

Deno.test('redact: "*:method" redacts that method in every cell', () => {
  const r = makeRedactor(["*:unlockWith"]);
  assertEquals(r("vault:unlockWith"), true);
  assertEquals(r("wallet:unlockWith"), true);
  assertEquals(r("vault:list"), false, "…and no other method");
  assert(r.redactsCell("vault"));
});

Deno.test('redact: "vault*" withholds the state of every cell it redacts actions of', () => {
  const r = makeRedactor(["vault*"]);
  assertEquals(r("vaultKeys:add"), true);
  assertEquals(r.redactsCell("vaultKeys"), true);
  assertEquals(r.redactsCell("vault"), true);
  assertEquals(r.redactsCell("ui"), false);
  const st = { vaultKeys: { seed: "abandon" }, ui: { x: 1 } };
  const out = _redactCheckpointState(st, r) as Record<string, unknown>;
  assertEquals(out.ui, { x: 1 });
  assert(!JSON.stringify(out).includes("abandon"), JSON.stringify(out));
});

Deno.test("redact: action half ⇒ cell half, for every pattern shape", () => {
  const patterns = [
    "*",
    "*:*",
    ":unlockWith",
    ":",
    "*:unlockWith",
    "*:unlock*",
    "vault",
    "vault:",
    "vault:*",
    "vault*",
    "vault:unlockWith",
    "vault:unlock*",
    "va*:add",
    "vaultKeys:add",
  ];
  const types = [
    "vault:unlockWith",
    "vault:__setUnlockWith",
    "vaultKeys:add",
    "vaultKeys:unlockWith",
    "ui:unlockWith",
    "ui:toggle",
    "wallet:add",
  ];
  for (const p of patterns) {
    const r = makeRedactor([p]);
    for (const t of types) {
      const cell = t.slice(0, t.indexOf(":"));
      if (r(t)) {
        assert(r.redactsCell(cell), `${p}: redacts ${t} but not cell ${cell}`);
      }
    }
  }
  // Controls: narrow patterns stay narrow.
  assertEquals(makeRedactor(["vault:*"])("vaultKeys:add"), false);
  assertEquals(makeRedactor(["vault:*"]).redactsCell("vaultKeys"), false);
  assertEquals(makeRedactor(["vault:unlockWith"])("vault:list"), false);
  assertEquals(makeRedactor(["va*:add"])("vaultKeys:add"), true);
  assertEquals(makeRedactor(["va*:add"])("vaultKeys:del"), false);
});

// An EMPTY cell part still meant two things after the halves shared a parse:
// `[":unlockWith"]` withheld every cell's state while matching no action at
// all (the action half compared "" to the cell name), so the passphrase was
// journaled under a setting that visibly "worked" on the checkpoint. "" is no
// cell's name; it reads as `"*"` in both halves.
Deno.test('redact: an empty cell part is "*" in BOTH halves', () => {
  for (const [short, long] of [[":unlockWith", "*:unlockWith"], [":", "*"]]) {
    const a = makeRedactor([short!]), b = makeRedactor([long!]);
    for (
      const t of [
        "vault:unlockWith",
        "wallet:unlockWith",
        "vault:list",
        "vault:__setUnlockWith",
      ]
    ) {
      assertEquals(a(t), b(t), `${short} vs ${long} on action ${t}`);
    }
    for (const c of ["vault", "wallet", "ui"]) {
      assertEquals(
        a.redactsCell(c),
        b.redactsCell(c),
        `${short} vs ${long} on cell ${c}`,
      );
    }
  }
  const r = makeRedactor([":unlockWith"]);
  assertEquals(r("vault:unlockWith"), true, "the passphrase is not journaled");
  assertEquals(r("vault:list"), false, "…and no other method is redacted");
});
