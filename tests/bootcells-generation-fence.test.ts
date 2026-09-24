// `bootCells` teardown orphaned a method an `onInit` had started; the cell is a
// module singleton, so when the next test booted the same cell the orphan's
// commit landed in the NEXT test's state (feedback cc §2: a stray project row,
// two bootstrap() runs live inside one test, a 6/20 flake). A write from a
// disposed boot is never the one wanted: the standalone runtime fences each
// boot's dispatch by generation, and a late commit is refused loudly, naming
// the action and the boot it came from.
//
// Both ways a late method reaches state are fenced: its own writes (the
// retired boot's dispatch refuses them) and a call it makes to ANOTHER method
// through the cell handle (`c.add(...)`) — the handle is bound to the CURRENT
// boot, so that one used to commit into the next test, silently.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

type S = { rows: string[] };
let armed = false;
let release: () => void = () => {};
let gate = Promise.resolve();

const c = cell("bleed", {
  state: { rows: [] as string[] },
  onInit(app) {
    // What cc's `workspace` does: the FRAMEWORK starts the call, at boot — the
    // test author never holds its promise.
    if (armed) {
      app.dispatch({ type: "bleed:bootstrap", payload: { args: [] } });
      app.dispatch({ type: "bleed:viaHandle", payload: { args: [] } });
    }
  },
  methods: {
    async bootstrap(s: S) {
      await gate; // a CLI probe, a disk read — still running at dispose()
      s.rows.push("from the FIRST test's boot");
    },
    add(s: S, row: string) {
      s.rows.push(row);
    },
    async viaHandle(_s: S) {
      await gate;
      // A sibling through the cell HANDLE, not `s.$call` — the field report's
      // `bootstrap()` calling other methods.
      (c as unknown as { add(r: string): Promise<void> }).add(
        "from the FIRST test's boot, via the handle",
      );
    },
  },
});
const C = c as unknown as S;

Deno.test("generation fence: a call a disposed boot started never commits into the next boot, and it is said", async () => {
  // Phase A — a boot whose onInit call outlives its dispose.
  {
    armed = true;
    gate = new Promise<void>((r) => release = r);
    const h = await bootCells([c]);
    assertEquals(C.rows, []);
    // Plain sync dispose, the shape cc had 60 of: the orphan is still parked.
    const warn = console.warn;
    console.warn = () => {};
    try {
      h.dispose();
    } finally {
      console.warn = warn;
    }
    armed = false;
  }
  // Phase B — the next boot must never see A's late commit, and it is said.
  {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      await using h = await bootCells([c]);
      // A live commit first: the retired boot's refused drain must not
      // overwrite what THIS boot's reads return with its own stale state.
      await (c as unknown as { add(r: string): Promise<void> }).add("live");
      release(); // test A's bootstrap wakes up and commits…
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 1));
      await h.settle();
      assertEquals(
        C.rows,
        ["live"],
        "a method started by the PREVIOUS test's boot committed into this one, or clobbered this one's reads",
      );
    } finally {
      console.error = realError;
    }
    const said = errors.find((e) => e.includes("torn-down runtime"));
    assert(
      said,
      `the refused late commit was silent: ${JSON.stringify(errors)}`,
    );
    assert(said.includes("bleed:"), `the action is not named: ${said}`);
    assert(
      errors.some((e) =>
        e.includes("torn-down runtime") && e.includes('"bleed:add"')
      ),
      `the late HANDLE call was not refused by name: ${JSON.stringify(errors)}`,
    );
    // …and the retired boot's OWN late write, refused by its own fence — the
    // handle refusal above cannot stand in for it (its state is never
    // published, so only this line says the write was dropped).
    assert(
      errors.some((e) =>
        e.includes("torn-down runtime") && e.includes('"bleed:__setBootstrap"')
      ),
      `the retired boot's own late write was not refused by name: ${
        JSON.stringify(errors)
      }`,
    );
    assert(
      said.includes("bootcells-generation-fence.test.ts"),
      `the boot site is not named: ${said}`,
    );
  }
});
