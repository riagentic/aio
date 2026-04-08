// UI — todo list with inline editing, filtering, keyboard support
import { useCell, useLocal } from "aio/air";
import { type Filter, type Todo, todo } from "./app.ts";

const FILTERS: Filter[] = ["all", "active", "done"];

export default function App() {
  const { state, send } = useCell(todo);
  const { local: input, set: setInput } = useLocal("");
  const { local: editing, set: setEditing } = useLocal<number | null>(null);
  const { local: editText, set: setEditText } = useLocal("");

  if (!state) return <div style={{ padding: "2rem" }}>Connecting...</div>;

  const filtered: Todo[] = state.items.filter((t: Todo) =>
    state.filter === "all" ? true : state.filter === "done" ? t.done : !t.done
  );
  const remaining = state.items.filter((t: Todo) => !t.done).length;

  return (
    <div
      style={{
        maxWidth: 480,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ textAlign: "center", color: "#c77" }}>todos</h1>

      {/* Add */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) {
            send.add(input.trim());
            setInput("");
          }
        }}
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}
      >
        <input
          value={input}
          onChange={(e) => setInput((e.target as HTMLInputElement).value)}
          placeholder="What needs to be done?"
          style={{ flex: 1, padding: "0.5rem", fontSize: "1rem" }}
        />
        <button type="submit" style={{ padding: "0.5rem 1rem" }}>Add</button>
      </form>

      {/* List */}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {filtered.map((t) => (
          <li
            key={t.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.5rem 0",
              borderBottom: "1px solid #eee",
            }}
          >
            <input
              type="checkbox"
              checked={t.done}
              onChange={() => send.toggle(t.id)}
            />
            {editing === t.id
              ? (
                <input
                  value={editText}
                  onChange={(e) =>
                    setEditText((e.target as HTMLInputElement).value)}
                  onBlur={() => {
                    if (editText.trim()) send.edit(t.id, editText.trim());
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (editText.trim()) send.edit(t.id, editText.trim());
                      setEditing(null);
                    }
                    if (e.key === "Escape") setEditing(null);
                  }}
                  autoFocus
                  style={{ flex: 1, padding: "0.25rem" }}
                />
              )
              : (
                <span
                  onDblClick={() => {
                    setEditing(t.id);
                    setEditText(t.text);
                  }}
                  style={{
                    flex: 1,
                    textDecoration: t.done ? "line-through" : "none",
                    color: t.done ? "#999" : "inherit",
                    cursor: "pointer",
                  }}
                >
                  {t.text}
                </span>
              )}
            <button
              type="button"
              onClick={() => send.remove(t.id)}
              style={{
                color: "#c44",
                border: "none",
                background: "none",
                cursor: "pointer",
              }}
            >
              x
            </button>
          </li>
        ))}
      </ul>

      {/* Footer */}
      {state.items.length > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "0.5rem",
            fontSize: "0.85rem",
            color: "#888",
          }}
        >
          <span>{remaining} item{remaining !== 1 ? "s" : ""} left</span>
          <div style={{ display: "flex", gap: "0.25rem" }}>
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => send.setFilter(f)}
                style={{
                  padding: "0.2rem 0.5rem",
                  border: state.filter === f
                    ? "1px solid #c77"
                    : "1px solid transparent",
                  background: "none",
                  cursor: "pointer",
                  borderRadius: 3,
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => send.clearDone()}
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              color: "#888",
            }}
          >
            Clear done
          </button>
        </div>
      )}
    </div>
  );
}
