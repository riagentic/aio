// A cell method called from onMount is not the component reading state.
//
// docs/ui/reactivity-tracking.md lists "a cell method" as not tracked. Under
// testUI the method runs IN-PROCESS, right inside the onMount callback, so its
// own reads of another cell used to land in the component's tracking frame —
// and the dev detector warned "`network` was read inside onMount in <Device>,
// but NOT during its render" about a read the component never made (a field
// report). In the real app the call is an RPC and reads nothing locally.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { onMount } from "../src/air/renderer-lifecycle.ts";
import { _resetUntrackedReadWarnings } from "../src/air/untracked-read.ts";

const network = cell("omr_network", {
  state: { cluster: "demo" },
  methods: {},
});

const hw = cell("omr_hw", {
  state: { found: 0 },
  methods: {
    detect(s) {
      // The read the report was about: another cell's state, inside a method.
      if (network.cluster === "demo") s.found += 1;
    },
  },
});

function Device() {
  onMount(() => {
    void hw.detect();
  });
  return <div class="found">{String(hw.found)}</div>;
}

/** The control: the COMPONENT reads in onMount what its render never read. */
function Sloppy() {
  onMount(() => {
    if (network.cluster === "never") console.log("unreachable");
  });
  return <div class="found">{String(hw.found)}</div>;
}

async function onMountWarnings(
  App: () => unknown,
): Promise<{ warns: string[]; found: number }> {
  _resetUntrackedReadWarnings();
  const warns: string[] = [];
  let found = -1;
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.includes("read inside onMount")) warns.push(line);
    else orig(...a);
  };
  try {
    await using ui = await testUI(App as () => never);
    await ui.settle();
    found = hw.found;
  } finally {
    console.warn = orig;
  }
  return { warns, found };
}

Deno.test("onMount: a cell method's own reads are not blamed on the caller", async () => {
  const { warns, found } = await onMountWarnings(Device);
  assertEquals(warns, [], warns.join("\n"));
  assertEquals(found, 1, "the method really ran, in-process, from onMount");
});

Deno.test("onMount: a read the component itself makes is still reported", async () => {
  const { warns } = await onMountWarnings(Sloppy);
  assertEquals(warns.length, 1, warns.join("\n"));
  assert(
    warns[0]!.includes("omr_network") || warns[0]!.includes("cluster"),
    warns[0],
  );
});
