// UI — a filterable todo list.
//
// No stylesheet: app.ts opted into aio's default theme (`ui.theme: "auto"`),
// which styles semantic HTML and the classes used here (card / row / stack /
// badge / muted). Add src/style.css and it steps aside. See docs/ui/theme.md.
import type { JSX } from "aio";
import { useLocal } from "aio/air";
import { type Filter, type Todo, todo, view } from "./cell.ts";

const FILTERS: Filter[] = ["all", "active", "done"];

export default function App(): JSX.Element {
  const { local: input, set: setInput } = useLocal("");

  const filtered: Todo[] = todo.items.filter((t: Todo) =>
    view.filter === "all" ? true : view.filter === "done" ? t.done : !t.done
  );
  const remaining = todo.items.filter((t: Todo) => !t.done).length;

  return (
    <main style={{ maxWidth: "36rem" }}>
      <h1>todos</h1>

      <form
        class="row"
        onSubmit={() => {
          if (input.trim()) {
            todo.add(input.trim());
            setInput("");
          }
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          placeholder="What needs to be done?"
          style={{ flex: 1 }}
        />
        <button type="submit">Add</button>
      </form>

      <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
        {filtered.map((t) => (
          <li key={t.id} class="row" style={{ padding: "0.4rem 0" }}>
            <input
              type="checkbox"
              checked={t.done}
              onChange={() =>
                todo.toggle(t.id)}
            />
            <span
              style={{
                flex: 1,
                textDecoration: t.done ? "line-through" : "none",
              }}
              class={t.done ? "muted" : ""}
            >
              {t.text}
            </span>
            <button
              type="button"
              class="ghost"
              onClick={() =>
                todo.remove(t.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {todo.items.length > 0 && (
        <div class="row" style={{ justifyContent: "space-between" }}>
          <span class="muted">
            {remaining} item{remaining !== 1 ? "s" : ""} left
          </span>
          <div class="row">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                class={view.filter === f ? "primary" : "ghost"}
                onClick={() => view.setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            type="button"
            class="ghost"
            onClick={() =>
              todo.clearDone()}
          >
            Clear done
          </button>
        </div>
      )}
    </main>
  );
}
