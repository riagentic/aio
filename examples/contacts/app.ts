// Entry — the only place that knows a database exists.
//
// `db: { contacts: table(...) }` declares the table and binds it to the array
// it stores — the `contacts` field of the cell that declares it
// (`state.contacts.contacts`; boot prints the binding). SQLite owns those rows
// from then on. `checkIntegrityOnBoot` is the honest setting
// for anything a user would miss: a damaged file is quarantined and, if a
// snapshot sits beside it, restored — loudly, never silently.
import { aio, pk, table, text } from "aio";
import "./cell.ts";

await aio.run({
  db: {
    contacts: table({
      id: pk(),
      name: text(),
      email: text(),
      note: text(),
    }),
  },
  checkIntegrityOnBoot: true,
});
