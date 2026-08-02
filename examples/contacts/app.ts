// Entry — the only place that knows a database exists.
//
// `db: { contacts: table(...) }` declares the table; the cell slice of the same
// name is kept in step with it. `checkIntegrityOnBoot` is the honest setting
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
