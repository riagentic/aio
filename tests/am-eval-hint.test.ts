// `am eval` takes ONE expression. A statement form fails to parse, and the
// bare "SyntaxError: Unexpected token ';'" read like a bug in the probe rather
// than a usage rule (a field report). The hint names the rule and the fix.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { evalErrorHint, evalOutcome } from "../src/am/am-cmd-eval.ts";

Deno.test("am eval: a SyntaxError carries the one-expression hint", () => {
  // What Chromium actually answers for `a(); 1` inside the paren wrap.
  const out = evalOutcome({
    exceptionDetails: {
      text: "Uncaught",
      lineNumber: 0,
      columnNumber: 80,
      exception: { description: "SyntaxError: Unexpected token ';'" },
    },
  });
  assertEquals(out.ok, false);
  const hint = evalErrorHint((out as { error: string }).error);
  assertStringIncludes(hint, "ONE expression");
  assertStringIncludes(hint, "(() => {");
});

Deno.test("am eval: any other error gets no hint", () => {
  assertEquals(evalErrorHint("TypeError: x is not a function (at 0:3)"), "");
  assertEquals(
    evalErrorHint("ReferenceError: SyntaxErrorish is not defined"),
    "",
  );
});
