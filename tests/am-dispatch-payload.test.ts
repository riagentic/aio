// `am dispatch` speaks two protocols, and guessing wrong looked like an app bug.
//
// A plain action carries its payload directly; a CELL METHOD is called with
// positional arguments, so the wire form is `{args: [...]}`. Before this,
// `am dispatch nav:setPanelType panel=0 type=x` sent `{panel: 0, type: "x"}` to
// a method reading `payload.args` and failed with "Cannot read properties of
// undefined", and `--body '{…}'` (space form) passed the literal string
// "--body" as the method's first argument and failed inside Immer. Both read as
// defects in the cell — one of them cost a real detour chasing a bug that was
// never there.
import { assertEquals } from "@std/assert";
import { parseGlobalFlags } from "../src/am/am-utils.ts";
import { envelopePayload } from "../src/am/am-cmd-state.ts";

Deno.test("am dispatch: a cell method gets positional args, an action gets its payload", () => {
  // `cell:method` is unambiguous in the type itself — no app lookup needed.
  assertEquals(
    envelopePayload("nav:setPanelType", { panel: 0, type: "nfts" }),
    { args: [{ panel: 0, type: "nfts" }] },
  );
  // A plain redux-style action keeps the payload it was given.
  assertEquals(envelopePayload("Increment", { by: 1 }), { by: 1 });
});

Deno.test("am flags: a value flag accepts --k=v and --k v alike", () => {
  const eq = parseGlobalFlags(["dispatch", "x", '--body={"a":1}']);
  const sp = parseGlobalFlags(["dispatch", "x", "--body", '{"a":1}']);
  assertEquals(eq.flags.jsonBody, '{"a":1}');
  assertEquals(sp.flags.jsonBody, '{"a":1}', "the space form is not swallowed");
  // …and the value never leaks into the positional args, which is what made
  // the method receive "--body" as its first argument.
  assertEquals(eq.args, ["x"]);
  assertEquals(sp.args, ["x"]);

  assertEquals(
    parseGlobalFlags(["status", "--app", "a field report"]).flags.app,
    "a field report",
  );
  assertEquals(parseGlobalFlags(["status", "--port", "4000"]).flags.port, 4000);
});

Deno.test("am flags: optional-value flags keep their bare meaning", () => {
  // `--wait` and `--client` may stand alone, so they must NOT consume the next
  // token — `am dispatch --wait Increment` still dispatches Increment.
  const w = parseGlobalFlags(["dispatch", "--wait", "Increment"]);
  assertEquals(w.flags.wait, 0);
  assertEquals(w.args, ["Increment"]);

  const c = parseGlobalFlags(["surface", "--client", "App"]);
  assertEquals(c.flags.client, 0);
  assertEquals(c.args, ["App"]);
});

Deno.test("am flags: a trailing value flag with nothing after it is not a crash", () => {
  const t = parseGlobalFlags(["dispatch", "x", "--body"]);
  assertEquals(t.flags.jsonBody, undefined);
  assertEquals(
    t.args,
    ["x", "--body"],
    "left as-is rather than eating undefined",
  );
});
