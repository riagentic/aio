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
// The second thing it pins (cc §10): the nested display is the USER's, not the
// machine's. `:77` being up said nothing about whose it was, and `am start`
// put one account's app on another account's screen — an open one, started
// with `-ac`. Now another user's display is skipped for the next free number,
// and every child gets the display's cookie.
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
import { clientOpensTabs } from "../src/am/am-cmd-process.ts";

const COOKIE = "/run/user/1000/aio/xephyr-77.auth";

/** A desktop with this user's nested display already running, cookie on file. */
const UP: DisplayProbe = {
  pick: () => ({ display: AIO_NESTED_DISPLAY, up: true, secured: true }),
  start: () => {
    throw new Error("must not start one that is already up");
  },
  cookie: (d) => d === AIO_NESTED_DISPLAY ? COOKIE : null,
  hasParent: () => true,
};
/** A desktop with no nested display yet, and Xephyr installed. */
const CAN_START: DisplayProbe = {
  pick: () => ({ display: AIO_NESTED_DISPLAY, up: false, secured: true }),
  start: () => ({ ok: true }),
  cookie: (d) => d === AIO_NESTED_DISPLAY ? COOKIE : null,
  hasParent: () => true,
};
/** A desktop with no Xephyr on it. */
const NO_XEPHYR: DisplayProbe = {
  pick: () => ({ display: AIO_NESTED_DISPLAY, up: false, secured: true }),
  start: () => ({ ok: false }),
  cookie: () => null,
  hasParent: () => true,
};
/** A headless box — nothing to nest in, nothing to steal focus from. */
const HEADLESS: DisplayProbe = {
  pick: () => {
    throw new Error("must not probe displays with no parent display");
  },
  start: () => {
    throw new Error("must not spawn Xephyr with no parent display");
  },
  cookie: () => null,
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

Deno.test("an agent's window goes to the nested display when one is up — with its cookie", () => {
  const plan = planDisplay({
    choice: "auto",
    gui: true,
    interactive: false,
    probe: UP,
  });
  assertEquals(plan.env.DISPLAY, AIO_NESTED_DISPLAY);
  assertEquals(plan.env.AIO_NO_OPEN, "1");
  // The server runs with access control: a child without the cookie is
  // refused and its window never appears.
  assertEquals(plan.env.XAUTHORITY, COOKIE);
  assert(plan.note?.includes("not your desktop"), plan.note);
  assert(!plan.note?.includes("no access cookie"), "secured — no caveat");
});

Deno.test("…and one is started when it is not, exactly once, on the picked number", () => {
  const starts: string[] = [];
  const probe: DisplayProbe = {
    ...CAN_START,
    start: (d) => (starts.push(d), { ok: true }),
  };
  const plan = planDisplay({
    choice: "auto",
    gui: true,
    interactive: false,
    probe,
  });
  assertEquals(starts, [AIO_NESTED_DISPLAY]);
  assertEquals(plan.env.DISPLAY, AIO_NESTED_DISPLAY);
  assertEquals(plan.env.XAUTHORITY, COOKIE);
  assertEquals(plan.level, "note");
  assert(plan.note?.includes("stays up on purpose"), plan.note);
});

Deno.test("another user's :77 is never reused — the next free number is this user's (cc §10)", () => {
  const starts: string[] = [];
  const probe: DisplayProbe = {
    pick: () => ({ display: ":78", up: false, secured: true }),
    start: (d) => (starts.push(d), { ok: true }),
    cookie: (d) => d === ":78" ? "/run/user/1001/aio/xephyr-78.auth" : null,
    hasParent: () => true,
  };
  const plan = planDisplay({
    choice: "auto",
    gui: true,
    interactive: false,
    probe,
  });
  assertEquals(starts, [":78"], "started on the picked number, not :77");
  assertEquals(plan.env.DISPLAY, ":78");
  assertEquals(plan.env.XAUTHORITY, "/run/user/1001/aio/xephyr-78.auth");
  assert(plan.note?.includes(":78"), plan.note);
});

Deno.test("every candidate taken by other users: the launch proceeds, and WARNS where the window goes", () => {
  const plan = planDisplay({
    choice: "auto",
    gui: true,
    interactive: false,
    probe: {
      ...NO_XEPHYR,
      pick: () => null,
      start: () => {
        throw new Error("nothing to start on — every number is someone else's");
      },
    },
  });
  assertEquals(plan.env.DISPLAY, undefined, "no override — the app still runs");
  assertEquals(plan.env.AIO_NO_OPEN, "1");
  assertEquals(plan.level, "warn");
  assert(plan.note?.includes("belongs to another user"), plan.note);
  assert(plan.note?.includes("--display=:N"), "the way out must be named");
});

Deno.test("a display up WITHOUT a cookie on file is used, and the note says it may be open", () => {
  // Started by hand or by an older aio (`-ac`): still this user's, still
  // contained — but the reader must learn it is not access-controlled.
  const plan = planDisplay({
    choice: "auto",
    gui: true,
    interactive: false,
    probe: {
      ...UP,
      pick: () => ({ display: AIO_NESTED_DISPLAY, up: true, secured: false }),
      cookie: () => null,
    },
  });
  assertEquals(plan.env.DISPLAY, AIO_NESTED_DISPLAY);
  assertEquals(plan.env.XAUTHORITY, undefined, "no cookie to hand over");
  assert(plan.note?.includes("no access cookie"), plan.note);
});

Deno.test("a start that came up without access control is a WARNING, not a note", () => {
  const plan = planDisplay({
    choice: "auto",
    gui: true,
    interactive: false,
    probe: {
      ...CAN_START,
      start: () => ({
        ok: true,
        warning: ":77 is up WITHOUT access control — no private runtime dir",
      }),
      cookie: () => null,
    },
  });
  assertEquals(plan.env.DISPLAY, AIO_NESTED_DISPLAY);
  assertEquals(plan.level, "warn");
  assert(plan.note?.includes("WITHOUT access control"), plan.note);
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
  assertEquals(plan.env.XAUTHORITY, COOKIE);
});

Deno.test("--display=:N is taken at its word — nothing probed, nothing started", () => {
  const plan = planDisplay({
    choice: ":9",
    gui: true,
    interactive: true,
    probe: HEADLESS, // would throw if the policy tried to start anything
  });
  assertEquals(plan.env.DISPLAY, ":9");
  assertEquals(plan.env.XAUTHORITY, undefined, "not ours — no cookie to add");
});

Deno.test("--display=:77 names OUR nested display: its cookie rides along", () => {
  // A human pointing at the agent's screen to watch it — without the cookie
  // the window is refused and never appears.
  const plan = planDisplay({
    choice: AIO_NESTED_DISPLAY,
    gui: true,
    interactive: true,
    probe: { ...UP, pick: HEADLESS.pick, start: HEADLESS.start },
  });
  assertEquals(plan.env.DISPLAY, AIO_NESTED_DISPLAY);
  assertEquals(plan.env.XAUTHORITY, COOKIE);
});

Deno.test("an inherited DISPLAY=:77 (a human's shell) gets the cookie, and nothing else", () => {
  // `DISPLAY=:77 am start` is the documented way to watch the agent's
  // display. The launch stays uncontained — no DISPLAY override, no note —
  // but the child must be able to get in.
  for (const choice of ["auto", "current"]) {
    const plan = planDisplay({
      choice,
      gui: true,
      interactive: true,
      probe: { ...UP, pick: HEADLESS.pick, start: HEADLESS.start },
      inheritedDisplay: AIO_NESTED_DISPLAY,
    });
    assertEquals(plan.env, { XAUTHORITY: COOKIE }, choice);
    assertEquals(plan.note, undefined, "still not narrated");
  }
  // …unless the shell already carries an XAUTHORITY of its own, or the
  // display is not one of ours: then byte-for-byte the old launch.
  assertEquals(
    planDisplay({
      choice: "auto",
      gui: true,
      interactive: true,
      probe: UP,
      inheritedDisplay: AIO_NESTED_DISPLAY,
      inheritedXauthority: "/home/me/.Xauthority",
    }).env,
    {},
  );
  assertEquals(
    planDisplay({
      choice: "auto",
      gui: true,
      interactive: true,
      probe: UP,
      inheritedDisplay: ":0",
    }).env,
    {},
  );
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

Deno.test("a client that never opens a tab gets no 'tabs suppressed' note", () => {
  // `am start --client=server-only` printed "browser tabs suppressed" — a
  // note about an event that could not happen. The env stays (one rule), the
  // sentence goes.
  const plan = planDisplay({
    choice: "auto",
    gui: false,
    interactive: false,
    probe: CAN_START,
    tabs: false,
  });
  assertEquals(plan.env, { AIO_NO_OPEN: "1" });
  assertEquals(plan.note, undefined);
  // The rule that feeds it, from am start's side.
  assertEquals(clientOpensTabs("server-only"), false);
  assertEquals(clientOpensTabs("cli"), false);
  assertEquals(clientOpensTabs("browser"), true);
  assertEquals(clientOpensTabs("electron"), true);
  assertEquals(clientOpensTabs(undefined), true, "framework default = browser");
});
