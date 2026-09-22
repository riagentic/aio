// The dev render-burst tripwire ("re-rendered 50 times in under a second — a
// render is WRITING state that the same render READS") fired on `testUI`'s
// own `setValue`, which types one character per synchronous handler→render
// step: a 118-character value was 118 renders, read as a loop, and the advice
// was to move a write that was already in an event handler (field report §11).
//
// The tripwire now counts only renders asked for by something other than an
// event handler running outside a render — and a real loop still trips it.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { signal } from "../src/state/signal.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { afterRender } from "../src/air/renderer-flush.ts";

const form = cell("svrl-form", {
  state: { address: "" },
  methods: {
    setAddress(s: { address: string }, v: string) {
      s.address = v;
    },
  },
});

const SettingsForm = () => (
  <div>
    <input
      aria-label="Address"
      value={form.address}
      onInput={(e: Event) =>
        form.setAddress((e.target as HTMLInputElement).value)}
    />
    <span>{form.address.length}</span>
  </div>
);

function capture(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(String(a[0]));
  return { warns, restore: () => console.warn = real };
}

const LONG = "x".repeat(118);

testUI(
  SettingsForm,
  "render burst: setValue typing a long value is input, not a render loop",
  async (ui) => {
    const { warns, restore } = capture();
    try {
      ui.AddressInput.setValue(LONG);
      await ui.expectCell(form, (c) => c.address === LONG);
    } finally {
      restore();
    }
    assertEquals(warns.filter((w) => w.includes("re-rendered")), []);
  },
);

const ticks = signal(0, "svrl.ticks");
const Looping = () => {
  const n = ticks.value;
  // The loop the tripwire exists for: a post-render write of what the render
  // reads. Bounded so the test ends.
  afterRender(() => {
    if (n > 0 && n < 60) ticks.set(n + 1);
  });
  return <span>{n}</span>;
};

testUI(
  Looping,
  "render burst: a render that writes what it reads still trips it",
  async (ui) => {
    const { warns, restore } = capture();
    try {
      ticks.set(1); // outside any handler: the loop starts here
      await ui.waitFor(() => ticks.value === 60);
    } finally {
      restore();
    }
    assert(
      warns.some((w) => w.includes("Looping re-rendered 50 times")),
      warns.join("\n"),
    );
  },
);

// The same loop, but the write goes THROUGH a synthetic DOM event — an
// afterRender that clicks its own button, whose onClick writes what the
// render read. Every write is then "in an event handler", and the exemption
// above made the tripwire blind to it: 121 renders, 0 warnings. A handler is
// input only when it is the OUTERMOST frame — one a lifecycle callback runs
// is the render writing, one step removed.
const clicks = signal(0, "svrl.clicks");
const ClickLoop = () => {
  const n = clicks.value;
  let btn: HTMLElement | null = null;
  afterRender(() => {
    if (n > 0 && n < 60) btn?.click();
  });
  return (
    <button
      type="button"
      ref={(el: HTMLElement | null) => {
        btn = el;
      }}
      onClick={() => clicks.set(clicks.peek() + 1)}
    >
      {n}
    </button>
  );
};

testUI(
  ClickLoop,
  "render burst: a render loop that writes through a synthetic click still trips it",
  async (ui) => {
    const { warns, restore } = capture();
    try {
      clicks.set(1);
      await ui.waitFor(() => clicks.value === 60);
    } finally {
      restore();
    }
    assert(
      warns.some((w) => w.includes("ClickLoop re-rendered 50 times")),
      warns.join("\n"),
    );
  },
);

const inputs = signal(0, "svrl.inputs");
const InputLoop = () => {
  const n = inputs.value;
  let inp: HTMLElement | null = null;
  afterRender(() => {
    if (n > 0 && n < 60) {
      const View = inp!.ownerDocument.defaultView as unknown as {
        Event: typeof Event;
      };
      inp!.dispatchEvent(new View.Event("input", { bubbles: true }));
    }
  });
  return (
    <input
      aria-label="Loop"
      ref={(el: HTMLElement | null) => {
        inp = el;
      }}
      onInput={() => inputs.set(inputs.peek() + 1)}
      value={String(n)}
    />
  );
};

testUI(
  InputLoop,
  "render burst: a render loop that writes through a dispatched input event still trips it",
  async (ui) => {
    const { warns, restore } = capture();
    try {
      inputs.set(1);
      await ui.waitFor(() => inputs.value === 60);
    } finally {
      restore();
    }
    assert(
      warns.some((w) => w.includes("InputLoop re-rendered 50 times")),
      warns.join("\n"),
    );
  },
);
