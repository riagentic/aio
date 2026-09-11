// A timeout must print six lines, not a wall.
//
// `waitFor`'s failure dumps the current surface so a reader can see what WAS
// there. The JSON half was capped and the component TREE was not, so a wide app
// turned one timeout into 31 769 characters of names (cc §9.0) — which nobody
// reads, in place of the few lines that would have said what happened.
//
// Bounded the way every other name list in this harness is bounded, with the
// same escape: one environment variable prints all of it. Two spellings of
// "how much do we print" is how they come to disagree.
import { assert, assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";

// A deliberately WIDE app — the shape that produced the 31 769 characters.
const Row = (p: { n: number }) => h("div", { t: `row-${p.n}` }, `row ${p.n}`);
const Wide = () =>
  h(
    "div",
    { class: "root" },
    ...Array.from({ length: 200 }, (_, i) => h(Row as never, { n: i, key: i })),
  );

async function timeoutMessage(): Promise<string> {
  await using ui = await testUI(Wide);
  await ui.settle();
  try {
    await ui.waitFor(() => false, { timeoutMs: 60 });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("waitFor did not time out");
}

Deno.test("a waitFor timeout on a wide app stays readable", async () => {
  const msg = await timeoutMessage();
  assert(msg.includes("waitFor timed out"), msg.slice(0, 200));
  assert(
    msg.length < 4000,
    `the timeout printed ${msg.length} characters — the report's number was ` +
      `31 769, and the point is that nobody reads either`,
  );
  // It still SAYS what is there, and how to see the rest.
  assert(msg.includes("row-"), "it must still show some of the tree");
  assert(
    msg.includes("AIO_TEST_NAMES=all"),
    `a truncated list without its escape hatch is worse than the wall: ${msg}`,
  );
  assert(
    /\d+ more components/.test(msg),
    `it must say how many are hidden: ${msg}`,
  );
});

Deno.test("AIO_TEST_NAMES=all really prints the whole tree", async () => {
  // The escape has to work, or the line offering it is a lie.
  const prev = Deno.env.get("AIO_TEST_NAMES");
  Deno.env.set("AIO_TEST_NAMES", "all");
  try {
    const msg = await timeoutMessage();
    assert(
      msg.length > 4000,
      `with the escape set the whole tree must print: ${msg.length} chars`,
    );
    assert(msg.includes("row-199"), "the LAST row must be in it");
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_TEST_NAMES");
    else Deno.env.set("AIO_TEST_NAMES", prev);
  }
});
