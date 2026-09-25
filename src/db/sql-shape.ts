// sql-shape.ts — the questions the db layer asks of a statement's TEXT:
// "does it write?" and "which tables does it read / write?".
//
// Two callers answered them with separate regexes, and each one was wrong for
// a shape the other had already learned: `query()`'s writer-lock gate read
// only the leading keyword, so `WITH x AS (…) DELETE …` took the read path and
// went down with another caller's ROLLBACK; the live-query parser read
// `FROM main.mail` as the table "main", `FROM [mail]` as nothing, and
// `FROM folders, mail` as "folders" alone — so those views never refreshed.
// One module, one lexer, one answer.

/** `sql` with comments (and, when asked, string literals and quoted
 *  identifiers) blanked out to spaces — same length, so offsets still line
 *  up. Blanking rather than deleting keeps the words on either side apart:
 *  `DELETE/**\/FROM` must not become `DELETEFROM`. */
export function mask(sql: string, literals: boolean): string {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          // A doubled quote is an escaped one; `]` has no escape.
          if (close !== "]" && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const lit = sql.slice(i, j + 1);
      // A literal keeps its quotes so it stays one token; only its inside —
      // where a word like `delete` is text, not a keyword — is blanked.
      out += literals
        ? c + " ".repeat(Math.max(0, lit.length - 2)) +
          (j < sql.length ? close : "")
        : lit;
      i = j;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j - 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const j = end === -1 ? sql.length : end + 2;
      out += " ".repeat(j - i);
      i = j - 1;
      continue;
    }
    out += c;
  }
  return out.slice(0, sql.length);
}

const DML = /\b(?:insert|update|delete|replace(?!\s*\())\b/i;

/** Does this statement change table ROWS (INSERT / UPDATE / DELETE /
 *  REPLACE), wherever the keyword sits — first, or after a `WITH` clause.
 *  Keywords inside strings, quoted identifiers and comments do not count, and
 *  `replace(…)` is the string function, not the statement. */
export function writesRows(sql: string): boolean {
  const m = mask(sql, true).trimStart();
  if (/^(?:insert|update|delete|replace)\b/i.test(m)) return true;
  // `WITH … <DML>` — the CTE prefix hides the verb from a leading-keyword
  // test, and SQLite allows a CTE in front of every DML statement.
  return /^with\b/i.test(m) && DML.test(m);
}

/** Does this statement change the database at all — rows, schema, pragmas,
 *  transaction state? Deliberately generous: its caller (`db.query()`'s
 *  writer-lock gate) pays one turn of the lock for a false positive and a
 *  silently rolled-back write for a false negative. */
export function looksLikeWrite(sql: string): boolean {
  if (writesRows(sql)) return true;
  const m = mask(sql, true);
  if (/^\s*PRAGMA\b/i.test(m)) return !pragmaReads(m);
  return /^\s*(?:CREATE|DROP|ALTER|TRUNCATE|VACUUM|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|REINDEX|ANALYZE|ATTACH|DETACH)\b/i
    .test(m) ||
    // RETURNING only exists on a DML statement, whatever precedes it.
    /\bRETURNING\b/i.test(m);
}

/** The statement's first keyword, uppercased (`WITH`, `DELETE`, `PRAGMA`) —
 *  comments skipped — or `""`. What a once-per-kind warning keys on. */
export function statementVerb(sql: string): string {
  const m = /^\s*([A-Za-z]+)/.exec(mask(sql, true));
  return m ? m[1]!.toUpperCase() : "";
}

/** Pragmas that CHANGE something when run bare — no `=`, no argument — so the
 *  bare form is not the "report the value" form it is for every other pragma. */
const PRAGMA_BARE_WRITES = new Set([
  "optimize",
  "wal_checkpoint",
  "incremental_vacuum",
  "shrink_memory",
]);

/** Pragmas whose parenthesised argument NAMES something (a table, an index, a
 *  row limit) rather than setting a value. `PRAGMA name(value)` is SQLite's
 *  other spelling of `PRAGMA name = value` — `PRAGMA user_version(5)` writes
 *  — so the argument form is a read only for these. */
const PRAGMA_ARG_READS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_info",
  "index_xinfo",
  "index_list",
  "foreign_key_list",
  "foreign_key_check",
  "integrity_check",
  "quick_check",
]);

/** `[schema.]name`, then whatever follows — on the MASKED text, so a quoted
 *  argument is quotes around blanks and a comment is blanks. A quoted schema
 *  or pragma name does not match, and falls to "writes". */
const PRAGMA_SHAPE =
  /^\s*PRAGMA\s+(?:[A-Za-z_]\w*\s*\.\s*)?([A-Za-z_]\w*)\s*(.*?)\s*;?\s*$/is;

/** Is this PRAGMA only a question? Every PRAGMA used to count as a write,
 *  so `deno task dev` of a correct app printed "db.query() was given a
 *  statement that WRITES (PRAGMA table_info(contacts)…)" on every boot — the
 *  framework's own schema reconcile asking what columns a table has — and
 *  queued that question behind the writer lock.
 *
 *  Reads: the bare form (`PRAGMA journal_mode`, `PRAGMA main.user_version`)
 *  unless it is one of {@link PRAGMA_BARE_WRITES}, and the argument form only
 *  for {@link PRAGMA_ARG_READS}. Everything else — `=`, a setting in
 *  parentheses, a shape this does not recognise — writes. */
function pragmaReads(masked: string): boolean {
  const p = PRAGMA_SHAPE.exec(masked);
  if (!p) return false;
  const name = p[1]!.toLowerCase();
  const tail = p[2]!;
  if (tail === "") return !PRAGMA_BARE_WRITES.has(name);
  return /^\([^()]*\)$/.test(tail) && PRAGMA_ARG_READS.has(name);
}

/** One table name — bare, or quoted any of SQLite's four ways. */
const NAME = String
  .raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|'(?:[^']|'')+'|[A-Za-z_][\w$]*)`;
const QUALIFIED = new RegExp(String.raw`^\s*(${NAME})(?:\s*\.\s*(${NAME}))?`);

function unquote(name: string): string {
  const q = name[0];
  if (q === '"' || q === "'" || q === "`") {
    return name.slice(1, -1).replaceAll(q + q, q).toLowerCase();
  }
  if (q === "[") return name.slice(1, -1).toLowerCase();
  return name.toLowerCase();
}

/** Words that end a table reference — after them there is no alias. */
const CLAUSE = new Set([
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "outer",
  "cross",
  "natural",
  "on",
  "using",
  "group",
  "order",
  "limit",
  "having",
  "window",
  "union",
  "except",
  "intersect",
  "indexed",
  "not",
  "returning",
  "set",
  "values",
  "default",
  "select",
  "as",
]);

export type ReadTables = {
  /** Lowercased table names the statement reads. */
  tables: Set<string>;
  /** True when a `FROM`/`JOIN` was present but no table could be named — the
   *  live query built on it would never refresh, and that must be said. A
   *  table-valued function (`FROM json_each(?)`) or a subquery counts as
   *  named: neither is a table a write can change through this wrapper. */
  unattributed: boolean;
};

/** Tables named by every `FROM` / `JOIN` in `sql`, including the second and
 *  later tables of a comma join and the table half of `schema.table`. */
export function readTablesIn(sql: string): ReadTables {
  // Comments only: `FROM 'mail'` is legal SQLite, so literals stay intact for
  // the names. Parentheses are matched on the fully masked copy (same length,
  // same offsets), where a `)` inside a string is not a `)`.
  const m = mask(sql, false);
  const bare = mask(sql, true);
  const tables = new Set<string>();
  let sources = 0;
  let named = 0;
  /** The offset just past the `)` closing the `(` at `open`. */
  const closeParen = (open: number): number => {
    let depth = 0;
    for (let i = open; i < bare.length; i++) {
      if (bare[i] === "(") depth++;
      else if (bare[i] === ")" && --depth === 0) return i + 1;
    }
    return bare.length;
  };
  const alias = new RegExp(String.raw`^\s*(?:as\s+)?(${NAME})`, "i");
  for (const kw of m.matchAll(/\b(?:from|join)\b/gi)) {
    sources++;
    let at = kw.index! + kw[0].length;
    for (;;) {
      const lead = /^\s*/.exec(m.slice(at))![0].length;
      if (m[at + lead] === "(") {
        // A subquery (its own FROM is matched by the outer loop). Skip it so
        // a comma join AFTER it — `FROM (…) s, mail` — still reaches `mail`.
        named++;
        at = closeParen(at + lead);
      } else {
        const ref = QUALIFIED.exec(m.slice(at));
        if (!ref) break;
        const word = ref[1]!;
        if (!ref[2] && CLAUSE.has(word.toLowerCase())) break;
        at += ref[0].length;
        named++;
        // `name(` is a table-valued function, not a table.
        if (/^\s*\(/.test(m.slice(at))) break;
        tables.add(unquote(ref[2] ?? word));
      }
      // Optional alias: `AS x` or a bare word that does not start a clause.
      const a = alias.exec(m.slice(at));
      if (a && !CLAUSE.has(a[1]!.toLowerCase())) at += a[0].length;
      const comma = /^\s*,/.exec(m.slice(at));
      if (!comma) break;
      at += comma[0].length;
    }
  }
  return { tables, unattributed: sources > 0 && named === 0 };
}

const WRITE_TARGET = new RegExp(
  String
    .raw`\b(?:insert(?:\s+or\s+\w+)?\s+into|update(?:\s+or\s+\w+)?|delete\s+from|replace\s+into)\s+(${NAME})(?:\s*\.\s*(${NAME}))?`,
  "gi",
);

/** Lowercased tables every INSERT / UPDATE / DELETE / REPLACE in `sql`
 *  writes — `schema.table` and quoted names included, conflict clauses
 *  (`INSERT OR IGNORE INTO`, `UPDATE OR ROLLBACK`) allowed. */
export function writeTablesIn(sql: string): Set<string> {
  const out = new Set<string>();
  for (const w of mask(sql, false).matchAll(WRITE_TARGET)) {
    out.add(unquote(w[2] ?? w[1]!));
  }
  return out;
}
