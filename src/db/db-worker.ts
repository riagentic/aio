/// <reference lib="deno.worker" />
// Worker thread — owns the SQLite connection, processes requests sequentially.

// B-1: `node:sqlite` type resolution breaks when a stale `@types/node` (<22.5,
// pulled in transitively under node_modules) shadows Deno's bundled node types
// — that package predates the node:sqlite module. The specifier resolves fine
// at runtime (deno run does not type-check); suppress here so `deno check src/`
// is green regardless of the installed @types/node version. Tracking: B-9 wires
// src/ into the check gate.
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import type { QueryResult, WorkerRequest, WorkerResponse } from "./types.ts";
import { count } from "../diagnostics/fmt.ts";

// node:sqlite requires SupportedValueType — runtime values are always valid SQL params
// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;

let db: DatabaseSync | null = null;
/** Index of the transaction statement currently being run, so a refusal can
 *  name it. Reset per request. */
let failedIndex = -1;

function respond(res: WorkerResponse): void {
  self.postMessage(res);
}

function empty(): QueryResult {
  return { rows: [], changes: 0, lastInsertRowId: 0n };
}

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  const { id, type } = data;
  failedIndex = -1;
  try {
    switch (type) {
      case "open": {
        db = new DatabaseSync(
          data.path,
          data.readonly ? { readOnly: true } : undefined,
        );
        for (const p of data.pragmas ?? []) db.exec(p);
        respond({ id, ok: true, data: empty() });
        break;
      }
      case "query": {
        if (!db) {
          throw new Error(
            "db not open — the worker received a query before open() or after close(). Await app.ready (or db.open()) before querying.",
          );
        }
        const rows = db.prepare(data.sql).all(..._p(data.params ?? []));
        respond({
          id,
          ok: true,
          data: {
            rows: rows as Record<string, unknown>[],
            changes: 0,
            lastInsertRowId: 0n,
          },
        });
        break;
      }
      case "execute": {
        if (!db) {
          throw new Error(
            "db not open — the worker received a query before open() or after close(). Await app.ready (or db.open()) before querying.",
          );
        }
        const r = db.prepare(data.sql).run(..._p(data.params ?? []));
        respond({
          id,
          ok: true,
          data: {
            rows: [],
            changes: Number(r.changes),
            lastInsertRowId: BigInt(r.lastInsertRowid),
          },
        });
        break;
      }
      case "transaction": {
        if (!db) {
          throw new Error(
            "db not open — the worker received a query before open() or after close(). Await app.ready (or db.open()) before querying.",
          );
        }
        const results: QueryResult[] = [];
        db.exec("BEGIN");
        try {
          for (const { sql, params } of data.stmts) {
            failedIndex = results.length; // the one being run right now
            const r = db.prepare(sql).run(..._p(params ?? []));
            results.push({
              rows: [],
              changes: Number(r.changes),
              lastInsertRowId: BigInt(r.lastInsertRowid),
            });
          }
          db.exec("COMMIT");
        } catch (e) {
          try {
            db.exec("ROLLBACK");
          } catch { /* rollback failed — original error is more useful */ }
          throw e;
        }
        respond({ id, ok: true, data: results });
        break;
      }
      case "close": {
        db?.close();
        db = null;
        respond({ id, ok: true, data: empty() });
        // Main thread calls worker.terminate() after receiving this response
        break;
      }
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    // WITH the statement that caused it. SQLite's messages describe a
    // condition, not a call — `too many SQL variables` reached the operator as
    // exactly those four words, from a worker, with no way to tell which of
    // the window's statements produced it or how big it was. The main thread
    // cannot add this: it only knows what it sent, and by then the error is
    // already a bare string on the wire.
    respond({
      id,
      ok: false,
      error: `${err.message}${sqlContext(data)}`,
      stack: err.stack,
    });
  }
};

/** What was being run, appended to a worker error. One statement is quoted
 *  (truncated); a transaction names its size and the statement that failed is
 *  identified by index. */
function sqlContext(data: WorkerRequest): string {
  const clip = (sql: string) =>
    sql.length > 300 ? `${sql.slice(0, 300)}…` : sql;
  const one = (sql: string, params?: unknown[]) =>
    ["", `  sql: ${clip(sql)}`, `  params: ${params?.length ?? 0}`].join("\n");
  if (data.type === "query" || data.type === "execute") {
    return one(data.sql, data.params);
  }
  if (data.type === "transaction") {
    const at = failedIndex;
    const st = at >= 0 ? data.stmts[at] : undefined;
    return [
      "",
      `  in a transaction of ${count(data.stmts.length, "statement")}` +
      (st ? `, at statement ${at + 1}` : ""),
      ...(st
        ? [`  sql: ${clip(st.sql)}`, `  params: ${st.params?.length ?? 0}`]
        : []),
      "  (the whole transaction was rolled back)",
    ].join("\n");
  }
  return "";
}
