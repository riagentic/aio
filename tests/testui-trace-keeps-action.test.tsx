// The call trace's wrapper must carry what the method carried.
//
// testUI wraps every cell method twice: once for the unobserved-call ledger,
// once for the failure trace. The ledger's wrapper re-attached the catalog —
// `.action()` and `.type` — and the trace's copy of that loop did not. So
// under testUI, `cell.method.action(id)` was `undefined`, and the idiom the
// docs teach for a scheduled follow-up (`schedule.after(ms,
// toast.dismiss.action(id))`) built nothing: thirty red tests in one field
// app, each pointing at the schedule and none at the cause. The comment on
// `_recordCalls` even said why a second interception is dangerous; what was
// missing was this test. Red on 1.0.0-beta.
import { assertEquals } from "@std/assert";
import { cell, schedule } from "../mod.ts";
import { testUI } from "../src/cell-test.ts";

type S = { items: string[] };
const toast = cell("toastTrace", {
  state: { items: [] as string[] } as S,
  methods: {
    show(s, id: string) {
      s.items.push(id);
      // The documented idiom: build the follow-up from the bound method.
      s.$do(schedule.after(`dismiss:${id}`, 10, toast.dismiss.action(id)));
    },
    dismiss(s, id: string) {
      s.items = s.items.filter((x) => x !== id);
    },
  },
});

function App() {
  return (
    <ul>
      {toast.items.map((i) => <li key={i}>{i}</li>)}
    </ul>
  );
}

testUI(
  App,
  "testUI: a wrapped method still carries .action() and .type",
  async (ui) => {
    assertEquals(
      typeof toast.dismiss.action,
      "function",
      "the trace wrapper dropped the catalog",
    );
    assertEquals(toast.dismiss.type, "toastTrace:dismiss");
    assertEquals(toast.dismiss.action("a"), {
      type: "toastTrace:dismiss",
      payload: { args: ["a"] },
    });
    toast.show("a");
    await ui.expectCell(toast, (t) => t.items.length === 1, "shown");
    await ui.advance(20);
    await ui.expectCell(
      toast,
      (t) => t.items.length === 0,
      "the scheduled dismiss built from .action() ran",
    );
  },
);
