// UI — export default; the framework mounts it.
//
// No stylesheet: app.ts opted into aio's default theme (`ui.theme: "auto"`),
// which styles semantic HTML and a handful of classes, keyed to this app's
// name. Write `src/style.css` and it steps aside entirely. See
// docs/ui/theme.md.
//
// `JSX.Element` needs the type import below; `aio` re-exports it so this is
// the only line to remember.
import type { JSX } from "aio";
import { counter } from "./cell.ts";

export default function App(): JSX.Element {
  return (
    <main>
      <h1>AIO Counter</h1>
      <div class="card stack" style={{ alignItems: "center" }}>
        <div style={{ fontSize: "3.5rem", fontWeight: 700 }}>
          {counter.count}
        </div>
        <div class="row">
          <button type="button" t="minus" onClick={() => counter.decrement()}>
            −
          </button>
          <button type="button" class="ghost" onClick={() => counter.reset()}>
            Reset
          </button>
          <button
            type="button"
            t="plus"
            class="primary"
            onClick={() => counter.increment()}
          >
            +
          </button>
        </div>
      </div>
      <p class="muted">
        State lives in <code>src/cell.ts</code>. Change it and this updates.
      </p>
    </main>
  );
}
