// Cells — pure state + methods; UI and server both import from here
import { cell } from "aio";

export type Todo = { id: number; text: string; done: boolean };
export type Filter = "all" | "active" | "done";

export const todo = cell("todo", {
  state: {
    items: [] as Todo[],
    nextId: 1,
  },
  methods: {
    add(s, text: string) {
      s.items.push({ id: s.nextId++, text, done: false });
    },
    toggle(s, id: number) {
      const item = s.items.find((t) => t.id === id);
      if (item) item.done = !item.done;
    },
    remove(s, id: number) {
      s.items = s.items.filter((t) => t.id !== id);
    },
    edit(s, id: number, text: string) {
      const item = s.items.find((t) => t.id === id);
      if (item) item.text = text;
    },
    clearDone(s) {
      s.items = s.items.filter((t) => !t.done);
    },
  },
});

// Per-tab UI state — client-scoped cell: never syncs, never persists to KV.
// Two tabs filter independently while `todo.items` stays in sync (AIO-5.1).
export const view = cell("view", {
  scope: "client",
  state: { filter: "all" as Filter },
  methods: {
    setFilter(s, filter: Filter) {
      s.filter = filter;
    },
  },
});
