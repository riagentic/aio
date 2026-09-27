// A real timer a disposed mount armed must never write into a LATER mount, and
// its refusal must name where it was armed (field report: a desktop wallet
// app, "x:y was dispatched into a torn-down runtime" landing on an innocent
// test with nothing to say which timer did it).
//
// Two ways a timer outlives its mount:
// - armed by a COMPONENT (the test body's context, no boot fence): its cell
//   call went through the handle — re-bound to the next mount — and committed
//   there, silently;
// - armed by a METHOD (inside the boot's fence): refused, but the refusal
//   named only the boot, never the timer.
// Both now run inside the fence of the mount that armed them, and the refusal
// says which timer, armed where — as a REJECTED call a `.catch` sees, never a
// synchronous throw out of the timer that killed the file.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { cell } from "../mod.ts";
import { onMount } from "../src/air/renderer-lifecycle.ts";
import { testUI } from "../src/testing/ui-test.ts";

type S = { rows: string[] };
type H = { add(r: string): Promise<void>; arm(): Promise<void> };
const ARM_MS = 60;
let armed = false;
// The timers fire only once the NEXT mount is up and its errors are captured:
// a fixed delay raced the dispose + reboot under load. Each re-arms from its
// own callback (same line, same fence) until released.
let released = false;
const refused: unknown[] = [];
const caught = (p: Promise<unknown>) => void p.catch((e) => refused.push(e));

const c = cell("tfence", {
  state: { rows: [] as string[] },
  methods: {
    add(s: S, row: string) {
      s.rows.push(row);
    },
    arm(_s: S) {
      const t = () =>
        released ? caught(h.add("method timer")) : setTimeout(t, 5); // METHOD-ARM
      setTimeout(t, ARM_MS); // METHOD-ARM
    },
  },
});
const h = c as unknown as H;
const C = c as unknown as S;
const App = () => {
  onMount(() => {
    const t = () =>
      released ? caught(h.add("component timer")) : setTimeout(t, 5); // COMP-ARM
    if (armed) setTimeout(t, ARM_MS); // COMP-ARM
  });
  return <div>{String(C.rows.length)}</div>;
};

// A timer re-arms until released, so the one that fires was armed on either
// line carrying the tag.
const lines = (tag: string): number[] =>
  Deno.readTextFileSync(new URL(import.meta.url)).split("\n")
    .flatMap((l, i) => l.includes(`// ${tag}`) ? [i + 1] : []);

Deno.test("testUI: a timer a disposed mount armed never writes into the next mount, and its refusal names where it was armed", async () => {
  // Mount A arms both timers and is disposed before either fires.
  armed = true;
  {
    await using ui = await testUI(App as never);
    await h.arm();
    await ui.settle();
  }
  armed = false;

  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    await using ui = await testUI(App as never);
    await h.add("live");
    released = true;
    for (let i = 0; refused.length < 2 && i < 400; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await ui.settle();
    assertEquals(
      C.rows,
      ["live"],
      "a timer the PREVIOUS mount armed committed into this one",
    );
  } finally {
    console.error = realError;
  }
  assertEquals(refused.length, 2, "each refusal is the call's rejection");
  const refusal = (tag: string) =>
    errors.find((e) =>
      e.includes("torn-down runtime") &&
      lines(tag).some((n) => e.includes(`testui-timer-fence.test.tsx:${n}:`))
    );
  const comp = refusal("COMP-ARM");
  assert(comp, `component timer: no refusal naming its arm site: ${errors}`);
  assertMatch(comp, /setTimeout armed at /);
  const method = refusal("METHOD-ARM");
  assert(method, `method timer: no refusal naming its arm site: ${errors}`);
  assertMatch(method, /inside "tfence:arm"/);
  // Boots SINCE the refused one, not the running total.
  assertMatch(method, /; 1 since\)/);
});
