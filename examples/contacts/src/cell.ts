// Cell — CRUD over a SQLite-backed list.
//
// The pieces are each documented elsewhere; this is the integration: one array
// in cell state, one `db:` table of the same name, and four ordinary methods.
// The framework syncs the two (Immer gives a new array reference on every
// mutation, which is the change signal), so nothing here writes SQL and
// nothing here is transport code.
import { cell } from "aio";

export type Contact = {
  id: number;
  name: string;
  email: string;
  note: string;
};

/** Validation lives with the data, in plain code — a method that refuses does
 *  so by throwing, and the caller's `await` rejects with this message. */
function assertValid(c: { name: string; email: string }): void {
  if (!c.name.trim()) throw new Error("name is required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) {
    throw new Error(`not an email address: ${c.email}`);
  }
}

type State = { contacts: Contact[]; nextId: number };

export const contacts = cell("contacts", {
  // The slice `db: { contacts: table(...) }` maps to. It must be an array.
  state: { contacts: [] as Contact[], nextId: 1 },

  methods: {
    create(s, input: { name: string; email: string; note?: string }) {
      assertValid(input);
      s.contacts.push({
        id: s.nextId++,
        name: input.name.trim(),
        email: input.email.trim(),
        note: input.note?.trim() ?? "",
      });
    },

    update(s, id: number, patch: Partial<Omit<Contact, "id">>) {
      const row = s.contacts.find((c) => c.id === id);
      if (!row) throw new Error(`no contact ${id}`);
      // Take only the editable fields. The type forbids `id`, but a call from
      // `am dispatch`, a CLI or another client's JSON is not type-checked —
      // `{ ...row, ...patch }` let `{ id: 2 }` put two rows on one primary
      // key, and the table then refused to persist this cell at all.
      const next = {
        id: row.id,
        name: (patch.name ?? row.name).trim(),
        email: (patch.email ?? row.email).trim(),
        note: (patch.note ?? row.note).trim(),
      };
      assertValid(next);
      Object.assign(row, next);
    },

    remove(s, id: number) {
      const before = s.contacts.length;
      s.contacts = s.contacts.filter((c) => c.id !== id);
      if (s.contacts.length === before) throw new Error(`no contact ${id}`);
    },
  },

  selectors: {
    /** Parameterized selector — call it with an argument from anywhere. */
    byId: (s: State, id: number) => s.contacts.find((c) => c.id === id) ?? null,
    sorted: (s: State) =>
      [...s.contacts].sort((a, b) => a.name.localeCompare(b.name)),
  },
});
