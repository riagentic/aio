// Where an agent's window goes, and whether it may open a tab in the human's
// browser.
//
// The behaviour this pins is mostly about what it does NOT do. A person who
// types `am start` at a terminal must get byte-for-byte the launch they got
// before — same display, same tab. Nested displays are one developer's
// preference, not a house style, and a framework that imposed one would have
// traded a focus-stealing bug for an "it opened somewhere I cannot see it"
// bug. So containment happens only when there is no human in the loop to want
// the window, and `--display=current` turns all of it off in one spelling.
//
// The probe is injected, so these run on a box with no X at all — the policy
// is the part that has bugs, and a test that needs a desktop is a test CI
// skips.
import { assert, assertEquals } from "@std/assert";
import {
  displayChoice,
  type DisplayProbe,
  planDisplay,
  readDisplayFlag,
  validDisplayChoice,
} from "../src/am/am-display.ts";
import { AIO_NESTED_DISPLAY } from "../src/server/nested-display.ts";

/** A desktop with the nested display already running. */
const UP: DisplayProbe = {
  isUp: (d) => d === AIO_NESTED_DISPLAY,
  start: () => {
    throw new Error("must not start one that is already up");
  },
  hasParent: () => true,
};
/** A desktop with no nested display yet, and Xephyr installed. */
const CAN_START: DisplayProbe = {
  isUp: () => false,
  start: () => true,
  hasParent: () => true,
};
/** A desktop with no Xephyr on it. */
const NO_XEPHYR: DisplayProbe = {
  isUp: () => false,
  start: () => false,
  hasParent: () => true,
};
/** A headless box — nothing to nest in, nothing to steal focus from. */
const HEADLESS: DisplayProbe = {
  isUp: () => false,
  start: () => {
    throw new Error("must not spawn Xephyr with no parent display");
  },
  hasParent: () => false,
};

Deno.test("a human at a terminal gets exactly what they got before", () => {
  for (const gui of [true, false]) {
    const plan = planDisplay({
      choice: "auto",
      gui,
      interactive: true,
      probe: UP,
    });
    assertEquals(plan.env, {}, "an interactive launch must not be touched");
    assertEquals(plan.note, undefined, "…and must not be narrated");
  }
});

Deno.test("--display=current is a full opt-out, human or not", () => {
  const plan = planDisplay({
    choice: "current",
    gui: true,
    interactive: false,
    probe: UP,
  });
  assertEquals(plan.env, {}, "no display override");
  assertEquals(plan.note, undefined, "nothing to say — nothing happened");
});

Deno.test("an agent's window goes to the nested display when one is up", () => {
  const plan = planDisplay({
    choice: "auto",
    gui: true,
    interactive: false,
    probe: UP,
  });
  assertEquals(plan.env.DISPLAY, AIO_NESTED_DISPLAY);
  assertEquals(plan.env.AIO_NO_OPEN, "1");
  assert(plan.note?.includes("not your desktop"), plan.note);
});

Deno.test("…and one is started when it is not, exactly once", () => {
  let starts = 0;
  const probe: DisplayProbe = {
    isUp: () => false,
    start: () => (starts++, true),
    hasParent: () => true,
  };
  const plan = planDisplay({
    choice: "auto",
    gui: true,
    interactive: false,
    probe,
  });
  assertEquals(starts, 1);
  assertEquals(plan.env.DISPLAY, AIO_NESTED_DISPLAY);
  assert(plan.note?.includes("stays up on purpose"), plan.note);
});

Deno.test("no Xephyr: the app still starts, and says where the window went", () => {
  const plan = planDisplay({
    choice: "auto",
    gui: true,
    interactive: false,
    probe: NO_XEPHYR,
  });
  // The load-bearing half: no DISPLAY override, so the launch proceeds. A
  // refusal here would trade a stolen focus for an app that will not run.
  assertEquals(plan.env.DISPLAY, undefined);
  assertEquals(plan.env.AIO_NO_OPEN, "1", "the tab is still containable");
  assert(plan.note?.includes("Xephyr not found"), plan.note);
  assert(plan.note?.includes("apt install"), "the note must name the fix");
});

Deno.test("headless: nothing is nested, and no doomed spawn is attempted", () => {
  // HEADLESS.start throws, so this test fails loudly if the policy ever tries.
  const plan = planDisplay({
    choice: "auto",
    gui: true,
    interactive: false,
    probe: HEADLESS,
  });
  assertEquals(plan.env.DISPLAY, undefined);
  assertEquals(plan.env.AIO_NO_OPEN, "1");
});

Deno.test("a non-GUI agent launch still cannot stack browser tabs", () => {
  // The case the nested display does NOT cover: `--client=browser` opens a
  // tab in the user's real browser through xdg-open, and aio can never close
  // it. One per launch is the failure people actually report.
  const plan = planDisplay({
    choice: "auto",
    gui: false,
    interactive: false,
    probe: CAN_START,
  });
  assertEquals(plan.env, { AIO_NO_OPEN: "1" });
  assert(plan.note?.includes("--display=current"), "the opt-out must be named");
});

Deno.test("--display=isolated contains even an interactive launch", () => {
  const plan = planDisplay({
    choice: "isolated",
    gui: true,
    interactive: true,
    probe: UP,
  });
  assertEquals(plan.env.DISPLAY, AIO_NESTED_DISPLAY);
});

Deno.test("--display=:N is taken at its word — nothing probed, nothing started", () => {
  const plan = planDisplay({
    choice: ":9",
    gui: true,
    interactive: true,
    probe: HEADLESS, // would throw if the policy tried to start anything
  });
  assertEquals(plan.env.DISPLAY, ":9");
});

Deno.test("the flag beats the env, and both beat the default", () => {
  assertEquals(displayChoice("current", "isolated"), "current");
  assertEquals(displayChoice(null, "isolated"), "isolated");
  assertEquals(displayChoice(null, undefined), "auto");
  assertEquals(displayChoice(null, ""), "auto", "an empty env is not a choice");
  assertEquals(readDisplayFlag(["--port=1", "--display=:3"]), ":3");
  assertEquals(readDisplayFlag(["--port=1"]), null);
});

Deno.test("a spelling we cannot read is refused, never treated as auto", () => {
  const good = ["auto", "isolated", "current", ":0", ":77", ":1.0"];
  const bad = ["", "yes", "xephyr", "77", "true", "nested", ":x"];
  assert(good.length > 4 && bad.length > 4, "nothing to check");
  for (const c of good) assert(validDisplayChoice(c), `${c} should be valid`);
  for (const c of bad) assert(!validDisplayChoice(c), `${c} should be refused`);
});
