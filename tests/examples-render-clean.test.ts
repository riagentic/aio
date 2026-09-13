// Every example aio ships renders with ZERO dev warnings.
//
// The examples are what a newcomer reads first, and four of the five tripped
// the framework's own tripwires on their very first render:
//
//   todo      <input> has no label association.
//   contacts  <input> has no label association. (×1)
//             <h1> is unreadable on its background: 2.87:1, AA needs 4.5:1.
//   disk      <h1> is unreadable on its background: 2.87:1.
//   updates   <p>/<strong>/<button> unreadable: 3.32:1.
//
// Every one of them was a hard-coded colour or a missing `aria-label` in the
// example's own TSX, not a framework defect — which is exactly why it matters.
// A reader who copies the shipped example copies the warning, and a reader who
// sees the framework's own apps warn on boot learns that the warnings are
// noise. That is the tripwires' whole value, spent.
//
// One test per example, because `testUI` registers its own `Deno.test` and a
// failure must name which example is dirty.
import { assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import Contacts from "../examples/contacts/src/App.tsx";
import Counter from "../examples/counter/src/App.tsx";
import Disk from "../examples/disk/src/App.tsx";
import Todo from "../examples/todo/src/App.tsx";
import Updates from "../examples/updates/src/App.tsx";

// Collected at module scope: `testUI` owns the test body, so there is no
// enclosing scope to install the capture in. Warnings are re-emitted, so a
// real one is still visible in the run's output.
const WARNS: string[] = [];
const _origWarn = console.warn;
console.warn = (...a: unknown[]) => {
  WARNS.push(a.map(String).join(" "));
  _origWarn(...a);
};

// deno-lint-ignore no-explicit-any
function clean(name: string, App: any): void {
  testUI(App, `${name} renders with no dev warnings`, async (ui) => {
    await ui.settle();
    // `splice(0)`, not a mark-and-slice: the first render happens when
    // `testUI` MOUNTS, which is before this body runs, so a count taken here
    // is already past every warning the mount produced. The first version did
    // exactly that and reported 0 new warnings for all five examples while the
    // buffer was visibly filling up — a gate that could not fail. Tests run in
    // order and each one drains the buffer, so what is here is this example's.
    const dev = WARNS.splice(0)
      .filter((w) => w.includes("[aio-dev]"))
      .map((w) => w.split("\n")[0]);
    assertEquals(
      dev,
      [],
      `examples/${name} trips the framework's own tripwires on first render. ` +
        `Fix the EXAMPLE — a reader copies it:\n  ` + dev.join("\n  "),
    );
  });
}

clean("todo", Todo);
clean("contacts", Contacts);
clean("counter", Counter);
clean("disk", Disk);
clean("updates", Updates);
