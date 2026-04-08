/// <reference lib="deno.worker" />
// Worker thread — owns the SQLite connection, processes requests sequentially

import { DatabaseSync } from "node:sqlite";
import type { QueryResult, WorkerRequest, WorkerResponse } from "./types.ts";

// node:sqlite requires SupportedValueType — runtime values are always valid SQL params
// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;

let db: DatabaseSync | null = null;

function respond(res: WorkerResponse): void {
  self.postMessage(res);
}

function empty(): QueryResult {
  return { rows: [], changes: 0, lastInsertRowId: 0n };
}

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  const { id, type } = data;
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
        if (!db) throw new Error("db not open");
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
        if (!db) throw new Error("db not open");
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
        if (!db) throw new Error("db not open");
        const results: QueryResult[] = [];
        db.exec("BEGIN");
        try {
          for (const { sql, params } of data.stmts) {
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
    respond({ id, ok: false, error: err.message, stack: err.stack });
  }
};
