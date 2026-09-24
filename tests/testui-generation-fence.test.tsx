// The `testUI` half of the generation fence (tests/bootcells-generation-fence
// is the `bootCells` half): a method an `onInit` started and nobody awaited
// must not commit into the NEXT test's mount. The cells are module singletons,
// so without the fence the orphan's write lands in whatever test is running
// when it wakes up (feedback cc §2).
//
// Both ways a late method reaches state are fenced: its own writes (the
// retired boot's dispatch refuses them) and a call it makes to ANOTHER method
// through the cell handle (`c.add(...)`) — the handle is bound to the CURRENT
// boot, so that one used to commit into the next mount, silently.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";

type S = { rows: string[] };
let armed = false;
let release: () => void = () => {};
let gate = Promise.resolve();

const c = cell("uibleed", {
  state: { rows: [] as string[] },
  onInit(app) {
    if (armed) {
      app.dispatch({ type: "uibleed:bootstrap", payload: { args: [] } });
      app.dispatch({ type: "uibleed:viaHandle", payload: { args: [] } });
    }
  },
  methods: {
    async bootstrap(s: S) {
      await gate; // still running when the first mount is disposed
      s.rows.push("from the FIRST mount");
    },
    add(s: S, row: string) {
      s.rows.push(row);
    },
    async viaHandle(_s: S) {
      await gate;
      // A sibling through the cell HANDLE, not `s.$call`.
      (c as unknown as { add(r: string): Promise<void> }).add(
        "from the FIRST mount, via the handle",
      );
    },
  },
});
const C = c as unknown as S;
const App = () => <div>{String(C.rows.length)}</div>;

Deno.test("testUI generation fence: a call a disposed mount started never commits into the next mount, and it is said", async () => {
  // Phase A — a boot whose onInit call outlives its dispose.
  {
    armed = true;
    gate = new Promise<void>((r) => release = r);
    const warn = console.warn;
    console.warn = () => {};
    // aio-ok: the orphan may be reported at dispose; phase B is the assertion.
    try {
      const ui = await testUI(App as never);
      assertEquals(C.rows, []);
      await ui.dispose();
    } catch {
    } finally {
      console.warn = warn;
      armed = false;
    }
  }
  // Phase B — the next boot must never see A's late commit, and it is said.
  {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      await using ui = await testUI(App as never);
      // A live commit first: the retired boot's refused drain must not
      // overwrite what THIS boot's reads return with its own stale state.
      await (c as unknown as { add(r: string): Promise<void> }).add("live");
      release(); // mount A's bootstrap wakes up and commits…
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 1));
      await ui.settle();
      assertEquals(
        C.rows,
        ["live"],
        "a method started by the PREVIOUS mount committed into this one, or clobbered this one's reads",
      );
    } finally {
      console.error = realError;
    }
    const said = errors.find((e) => e.includes("torn-down runtime"));
    assert(
      said,
      `the refused late commit was silent: ${JSON.stringify(errors)}`,
    );
    assert(said.includes("uibleed:"), `the action is not named: ${said}`);
    assert(
      errors.some((e) =>
        e.includes("torn-down runtime") && e.includes('"uibleed:add"')
      ),
      `the late HANDLE call was not refused by name: ${JSON.stringify(errors)}`,
    );
  }
});
