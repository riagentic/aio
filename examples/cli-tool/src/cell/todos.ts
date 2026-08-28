// The list — one cell, shared by the server that owns it and the commands
// that talk to it. Persists by default (restart the server, the list is back).
import { cell } from "aio";

/** One todo. */
export type Todo = { id: number; text: string; done: boolean };

export const todos = cell("todos", {
  state: { items: [] as Todo[], next: 1 },
  methods: {
    add(s, text: string) {
      const t = text.trim();
      if (!t) throw new Error("a todo needs some text");
      s.items.push({ id: s.next++, text: t, done: false });
    },
    done(s, id: number) {
      const t = s.items.find((x) => x.id === id);
      if (!t) throw new Error(`no todo #${id}`);
      t.done = true;
    },
    clear(s) {
      s.items = s.items.filter((x) => !x.done);
    },
  },
});
