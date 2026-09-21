// `am create --help` listed the five templates bare — `--template=<counter|
// todo|cli|canvas|assets>` — while `am agent` could already say that `todo` is
// "a list + a client-scoped view cell + an input form". The surface a PERSON
// reads knew the least about the choice it was asking them to make.
//
// The fix is one sentence per template in the help. The RISK in that fix is a
// second hand-kept copy of those sentences — "a key in 2 of 3 surfaces", the
// trap this repo keeps paying for. So the descriptions live in the leaf
// (`am-help-text.ts`, beside the list they describe) and `am-agent-text.ts`
// re-exports them. This file pins that: same OBJECT, and both surfaces
// actually render it.
import { assert, assertStrictEquals } from "@std/assert";
import {
  BRIEF_TARGETS as AGENT_TARGETS,
  BRIEF_TEMPLATES as AGENT_TEMPLATES,
} from "../src/am/am-agent-text.ts";
import { agentBrief } from "../src/am/am-agent-text.ts";
import {
  BRIEF_TARGETS,
  BRIEF_TEMPLATES,
  HELP_TEXT,
  TARGETS,
  TEMPLATES,
} from "../src/am/am-help-text.ts";
import { helpBlock } from "../src/am/am-cmd-meta.ts";

Deno.test("am create --help and am agent describe templates from ONE object", () => {
  // Not "equal contents" — the SAME object. Two records that happen to match
  // today is exactly the state this test exists to make unshippable.
  assertStrictEquals(AGENT_TEMPLATES, BRIEF_TEMPLATES);
  assertStrictEquals(AGENT_TARGETS, BRIEF_TARGETS);
});

Deno.test("am create --help says what each template IS", () => {
  const block = helpBlock(HELP_TEXT, "create");
  assert(block, "am help create has no block");
  // Count first: a loop over an empty list asserts nothing and passes, which
  // is exactly how a "cannot disagree" gate stops being one.
  assert(TEMPLATES.length >= 5 && TARGETS.length >= 5, "empty template list");
  for (const t of TEMPLATES) {
    // The name is offered…
    assert(block.includes(t), `am create --help never names ${t}`);
    // …and the help says what it gives you, in the one wording there is.
    assert(
      block.includes(BRIEF_TEMPLATES[t]),
      `am create --help does not describe ${t}: expected ${
        JSON.stringify(BRIEF_TEMPLATES[t])
      }`,
    );
  }
  // The same for targets: the prose used to explain three of the five and
  // leave `cli` and `server` unsaid.
  for (const t of TARGETS) {
    assert(
      block.includes(BRIEF_TARGETS[t]),
      `am create --help does not say what --target=${t} needs`,
    );
  }
});

Deno.test("am agent still carries the same sentences", () => {
  // The other reader of that one object. If a future edit gives the help its
  // own copy, one of these two tests fails whichever copy drifts.
  const page = agentBrief({ version: "test", task: "all" });
  // Count first: a loop over an empty list asserts nothing and passes, which
  // is exactly how a "cannot disagree" gate stops being one.
  assert(TEMPLATES.length >= 5 && TARGETS.length >= 5, "empty template list");
  for (const t of TEMPLATES) {
    assert(page.includes(BRIEF_TEMPLATES[t]), `am agent lost ${t}`);
  }
  for (const t of TARGETS) {
    assert(page.includes(BRIEF_TARGETS[t]), `am agent lost target ${t}`);
  }
});
