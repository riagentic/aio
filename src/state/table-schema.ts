// `db:` schema builders — `table()` and its column helpers, plus the types
// they produce. PURE data constructors with no imports, so they are
// isomorphic: the browser entry ships them too, because a table is declared
// beside the cell whose rows it stores and the UI imports that module
// (docs/persistence/sqlite.md). `src/server/sql.ts` re-exports every name, so
// all existing import paths keep resolving to these same objects.

/** Column options — nullable, unique, and default value */
export type ColumnOpts = {
  nullable?: boolean;
  unique?: boolean;
  default?: unknown;
};

/** Internal column definition produced by column helpers (pk, text, integer, real, ref) */
export type ColumnDef = {
  sqlType: string;
  pk?: boolean;
  ref?: string;
  nullable?: boolean;
  unique?: boolean;
  default?: unknown;
};

/** Table schema produced by table() — passed to aio.run({ db: { schema } }) */
export type TableDef = {
  columns: Record<string, ColumnDef>;
  /** How the bound state value holds its rows — stamped onto the resolved
   *  schema by `resolveDbBindings` from the `db:` mapping's `shape`, and read
   *  by the row diff. `"array"` (default) or `"map"` (a plain object keyed by
   *  the row's pk). Not something `table()` takes: the shape belongs to the
   *  BINDING, not to the table. */
  shape?: DbBoundShape;
};

/** The shape of a state value a `db:` table is bound to. */
export type DbBoundShape = "array" | "map";

/** The object-shaped form of a `db:` entry — `db: { key: TableDef }` says
 *  "this whole array field is this table"; this form says WHICH value and in
 *  WHAT shape (docs/persistence/sqlite.md → "Object-shaped bindings"):
 *
 *  ```ts
 *  db: {
 *    // a map keyed by pk: state.wallet.byMint = { [mint]: Holding }
 *    "wallet.byMint": { table: holdings, shape: "map" },
 *    // a subset deeper than one field: state.ledger.book.entries
 *    "ledger.entries": { table: entries, path: "book.entries" },
 *  }
 *  ```
 *
 *  Additive: a bare `TableDef` still means `{ table, shape: "array" }`. */
export type DbMapping = {
  table: TableDef;
  /** `"array"` (default): the bound value is an array of rows.
   *  `"map"`: the bound value is a plain object whose VALUES are the rows and
   *  whose KEYS are their primary keys (`String(row[pk])`) — the table needs a
   *  `pk()` column, and a key that disagrees with its row's pk is refused at
   *  write time (the next boot would key the row by the pk). */
  shape?: DbBoundShape;
  /** Dotted path INSIDE the cell to bind (a subset of the slice deeper than
   *  one field), e.g. `"book.entries"`. Default: the key's `<field>`. Only
   *  meaningful with an explicit `"<cell>.<field>"` key — the SQL table is
   *  still named `<cell>_<field>`. */
  path?: string;
};

// ── Column helpers ──────────────────────────────────────────────────

/** Primary key column — INTEGER PRIMARY KEY (auto-increment) */
export function pk(): ColumnDef {
  return { sqlType: "INTEGER", pk: true };
}

/** TEXT column */
export function text(opts?: ColumnOpts): ColumnDef {
  return { sqlType: "TEXT", ...opts };
}

/** INTEGER column */
export function integer(opts?: ColumnOpts): ColumnDef {
  return { sqlType: "INTEGER", ...opts };
}

/** REAL (float) column */
export function real(opts?: ColumnOpts): ColumnDef {
  return { sqlType: "REAL", ...opts };
}

/** Foreign key reference — INTEGER column pointing to another table's pk */
export function ref(refTable: string, opts?: ColumnOpts): ColumnDef {
  return { sqlType: "INTEGER", ref: refTable, ...opts };
}

/** Define a table schema — pass to aio.run({ db: { tableName: table({...}) } }) */
export function table(columns: Record<string, ColumnDef>): TableDef {
  // Two pk() columns render `CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER
  // PRIMARY KEY)`, which SQLite refuses at CREATE ("more than one primary
  // key") — at BOOT, in a message that names neither the schema key nor the
  // second column. Worse, `pkColumn` answers with the FIRST one, so the row
  // diff and every `ref()` to this table quietly agree on a key the table was
  // never going to have. Refuse at declaration, where both names are in hand.
  const pks = Object.entries(columns).filter(([, c]) => c?.pk).map(([n]) => n);
  if (pks.length > 1) {
    throw new Error(
      `table(): ${pks.length} primary keys declared (${
        pks.join(", ")
      }) — SQLite accepts exactly one. Keep one pk() and make the others ` +
        `text({ unique: true }) / integer({ unique: true }).`,
    );
  }
  return { columns };
}
