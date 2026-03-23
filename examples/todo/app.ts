// Entry point — todo app with CRUD, filtering, persistence
import { aio, feature } from "aio";

export type Todo = { id: number; text: string; done: boolean };
export type Filter = "all" | "active" | "done";

export const todo = feature("todo", {
  state: {
    items: [] as Todo[],
    nextId: 1,
    filter: "all" as Filter,
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
    setFilter(s, filter: Filter) {
      s.filter = filter;
    },
  },
  persist: { exclude: ["filter"] },
});

await aio.run({
  appId: "todo",
  appVersion: "1.0.0",
  features: [todo],
  baseDir: import.meta.dirname!,
});
