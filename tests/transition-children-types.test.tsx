// `<Transition>` and `<TransitionGroup>` typed `children` as an ARRAY, so the
// form `Transition`'s own JSDoc shows — `{show.value && <Modal />}`, one child
// — failed `deno check` (TS2745, and `false` was not admitted), as did a
// `<TransitionGroup>` holding a fixed item beside a mapped list. JSX hands
// one child over as-is; this file type-checks only when both forms do, and
// the runtime half pins that they render.
import { assertEquals } from "@std/assert";
import { fade, signal, Transition, TransitionGroup } from "../src/air.ts";
import { testUI } from "../src/testing/ui-test.ts";

const show = signal(true);
const items = signal(["a", "b"]);

const App = () => (
  <div>
    <div class="one">
      <Transition enter={fade} exit={fade} options={{ duration: 1 }}>
        {show.value && <b>T</b>}
      </Transition>
    </div>
    <div class="list">
      <TransitionGroup enter={fade} exit={fade} options={{ duration: 1 }}>
        <p key="head">head</p>
        {items.value.map((i) => <p key={i}>{i}</p>)}
      </TransitionGroup>
    </div>
  </div>
);

testUI(
  App,
  "single-child Transition and mixed TransitionGroup children",
  async (ui) => {
    const d = ui.document;
    const list = () =>
      [...d.querySelectorAll(".list p")].map((e) => e.textContent).join(",");
    assertEquals(d.querySelectorAll(".one b").length, 1);
    assertEquals(list(), "head,a,b");
    show.set(false);
    items.set(["b"]);
    await ui.settle();
    await new Promise((r) => setTimeout(r, 50));
    await ui.settle();
    assertEquals(d.querySelectorAll(".one b").length, 0);
    assertEquals(list(), "head,b");
  },
);
