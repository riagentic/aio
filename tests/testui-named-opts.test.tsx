// a field report #12 + #13 — two harness papercuts that both punished the common
// case:
//
//  #12 the named wrapper form (auto-teardown, what a whole test file uses) had
//      no options parameter, so adopting `seed` — the feature that finally makes
//      machine-dependent UI testable — meant rewriting every one-line test into
//      the handle form by hand.
//  #13 a waitFor timeout stringified the ENTIRE surface, pretty-printed and
//      uncapped: tens of KB per failure on a real page, with the assertion
//      message itself scrolled away.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";

const hw = cell("named-opts-hw", {
  state: { gpus: [] as string[] },
  methods: {
    clear(s: { gpus: string[] }) {
      s.gpus = [];
    },
  },
});

function App() {
  return <div class="n">{hw.gpus.length}</div>;
}

// The whole point: a one-liner that also seeds. No `await using`, no rewrite.
testUI(App, "named form accepts options", {
  seed: { "named-opts-hw": { gpus: ["a", "b"] } },
}, (ui) => {
  assertEquals(
    ui.html().match(/class="n"[^>]*>([^<]*)</)?.[1],
    "2",
    "the seed reached the mount through the named form",
  );
});

// …and the plain named form still works unchanged.
testUI(App, "named form without options still works", (ui) => {
  assertEquals(ui.html().match(/class="n"[^>]*>([^<]*)</)?.[1], "0");
});

Deno.test("waitFor timeout: names what's there without dumping the whole tree", async () => {
  await using ui = await testUI(App);
  let msg = "";
  try {
    await ui.waitFor(() => false, { timeoutMs: 60, msg: "never happens" });
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes("never happens"), "the reason stays visible");
  assert(msg.includes("App"), "the component tree is summarised by name");
  assert(
    msg.length < 2500,
    `a failure message must stay readable; got ${msg.length} chars`,
  );
});
