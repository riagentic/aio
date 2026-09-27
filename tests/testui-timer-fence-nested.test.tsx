// A timer the TEST BODY arms (no boot's code) while a testUI is nested inside
// another belongs to no boot: it was fenced to the INNERMOST mount open at that
// moment, so once that mount was disposed its cell call was refused as a
// "torn-down runtime" (and "0 since") although the outer mount still lived —
// thrown synchronously from the timer, where no `.catch` could see it.
//
// …and the converse: a timer the INNER mount's own code arms (its component on
// mount, a click it handles, a timer one of those armed) is that mount's. It
// went to the outer mount and, once the inner one closed, committed there —
// silently. It is refused, naming the line that armed it.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { cell } from "../mod.ts";
import { onMount } from "../src/air/renderer-lifecycle.ts";
import { testUI } from "../src/testing/ui-test.ts";

type S = { n: number };
const c = cell("tfencenest", {
  state: { n: 0 },
  methods: {
    inc(s: S) {
      s.n++;
    },
    arm(_s: S) {
      late = new Promise((resolve) =>
        setTimeout(() => resolve(h.inc().catch((e) => e)), 20)
      );
    },
  },
});
let late: Promise<unknown> | undefined;
const h = c as unknown as { inc(): Promise<void>; arm(): Promise<void> };
const C = c as unknown as S;
const App = () => <div>{String(C.n)}</div>;
const Other = () => <span>other</span>;

const DELAY = 300;
const late2: Promise<unknown>[] = [];
const later = (arm: () => void) => arm();
const fire = () =>
  late2.push(
    new Promise((resolve) =>
      setTimeout(() => resolve(h.inc().catch((e) => e)), DELAY) // FIRE
    ),
  );
let renderArm = -1;
// a re-render the TEST BODY's write caused, arming inside the inner mount
const Count = () => {
  if (C.n === renderArm) {
    renderArm = -1;
    fire();
  }
  return <span>{String(C.n)}</span>;
};
const Inner = () => {
  onMount(() => fire()); // on mount
  return (
    <div>
      <Count />
      <button type="button" onClick={() => fire()}>Arm</button>
      <button
        type="button"
        onClick={() => setTimeout(() => later(fire), 5)} // CHAIN
      >
        Chain
      </button>
    </div>
  );
};

Deno.test("testUI: a test-body timer armed inside a nested mount reaches the live outer mount", async () => {
  await using ui = await testUI(App as never);
  let fired!: Promise<unknown>;
  {
    await using _inner = await testUI(Other as never);
    fired = new Promise((resolve) =>
      setTimeout(() => resolve(h.inc().catch((e) => e)), 20)
    );
  }
  assertEquals(await fired, undefined);
  await ui.settle();
  assertEquals(C.n, 1);
});

Deno.test("testUI: a timer the nested mount's METHOD armed is refused once that mount closes — the outer mount untouched, 'none since'", async () => {
  await using ui = await testUI(App as never);
  const before = C.n;
  const realError = console.error;
  console.error = () => {};
  try {
    {
      await using _inner = await testUI(Other as never);
      await h.arm();
    }
    const e = await late;
    assertMatch(String(e), /torn-down runtime \(boot #\d+, .*; none since\)/);
    assertMatch(String(e), /inside "tfencenest:arm"/);
  } finally {
    console.error = realError;
  }
  await ui.settle();
  assertEquals(C.n, before);
});

Deno.test("testUI: a timer the INNER mount's component armed (on mount, from a click, from its own timer) is refused once it closes — never committed into the outer mount", async () => {
  await using ui = await testUI(App as never);
  const before = C.n; // the OUTER mount's count
  const realError = console.error;
  console.error = () => {};
  try {
    {
      await using inner = await testUI(Inner as never);
      inner.ArmButton.click();
      inner.ChainButton.click();
      await inner.settle();
      renderArm = C.n + 1;
      await h.inc(); // test body writes; the INNER mount re-renders and arms
      await new Promise((r) => setTimeout(r, 10)); // re-render + the chain's hop
      assertEquals(renderArm, -1, "the re-render never ran");
    }
    const results = await Promise.all(late2);
    assertEquals(results.length, 4);
    for (const [i, e] of results.entries()) {
      const which =
        ["on mount", "a click", "a re-render", "a timer's chain"][i];
      assert(
        e instanceof Error,
        `the inner mount's timer (${which}) committed`,
      );
      assertMatch(e.message, /torn-down runtime/);
      assertMatch(e.message, /setTimeout armed at .*testui-timer-fence-nested/);
    }
  } finally {
    console.error = realError;
  }
  await ui.settle();
  assertEquals(C.n, before, "an inner mount's timer wrote into the outer one");
});
