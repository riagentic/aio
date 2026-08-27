// A `tick` transition runs USER code on every animation frame. When that code
// throws, the loop used to `resolve()` and return — silently. The element stayed
// wherever the last good frame left it (an enter transition frozen at
// `opacity: 0.37` is invisible-looking and permanent), and nothing in the
// console connected the stuck element to the callback that broke.
//
// Two separate obligations, and it met neither: SAY so, and leave the element on
// the state the transition promised rather than abandoning it mid-flight.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { _runTickTransition } from "../src/air/transition-component.ts";

function env() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const el = doc.createElement("div");
  doc.body.appendChild(el);
  return {
    win,
    el: el as unknown as HTMLElement,
    cleanup: () => win.happyDOM.close(),
  };
}

async function run(direction: "in" | "out"): Promise<{
  errors: string[];
  seen: number[];
}> {
  const { el, cleanup } = env();
  const errors: string[] = [];
  const seen: number[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  try {
    let calls = 0;
    await _runTickTransition(el, {
      duration: 1000,
      tick: (t: number) => {
        seen.push(t);
        // The first frame throws — the shape of a callback that is simply wrong.
        if (calls++ === 0) throw new Error("boom in tick");
      },
    }, direction);
  } finally {
    console.error = orig;
    cleanup();
  }
  return { errors, seen };
}

Deno.test("a throwing transition tick is reported, not swallowed", async () => {
  const { errors } = await run("in");
  assertEquals(
    errors.length,
    1,
    `a tick that throws must say so exactly once — got:\n${errors.join("\n")}`,
  );
  assert(
    errors[0]!.includes("transition enter tick threw"),
    `the report must name what threw and which direction: ${errors[0]}`,
  );
  assert(
    errors[0]!.includes("boom in tick"),
    `the original error must survive into the report: ${errors[0]}`,
  );
});

Deno.test("a throwing transition tick still lands the element on its final state", async () => {
  // in → the element must end fully entered (t = 1); out → fully exited (t = 0).
  for (const [direction, end] of [["in", 1], ["out", 0]] as const) {
    const { seen } = await run(direction);
    assertEquals(
      seen.at(-1),
      end,
      `after a ${direction} tick threw, the last tick must be the transition's ` +
        `end state (${end}) — otherwise the element is frozen mid-flight ` +
        `forever. Saw: ${JSON.stringify(seen)}`,
    );
  }
});
