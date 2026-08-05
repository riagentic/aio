// tests/sync/_test-db.ts — a real in-memory SQLite behind the framework `DB`
// interface, with the sync schema applied. Shared by the sync tests that need
// the actual op-log semantics (PK dedup, DELETE, transactions) rather than a
// stub that would agree with whatever the code does.
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult, Tx } from "../../src/db/types.ts";
import { SYNC_SCHEMA } from "../../src/sync/compact.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;

/** A fresh in-memory database with SYNC_SCHEMA applied. */
export function createTestDb(): { db: DB; close: () => void } {
  const sqlite = new DatabaseSync(":memory:");
  for (const stmt of SYNC_SCHEMA) sqlite.exec(stmt);
  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> =>
    Promise.resolve({
      rows: sqlite.prepare(sql).all(..._p(params ?? [])) as T[],
      changes: 0,
      lastInsertRowId: 0n,
    });
  const execute = (sql: string, params?: unknown[]): Promise<QueryResult> => {
    const r = sqlite.prepare(sql).run(..._p(params ?? []));
    return Promise.resolve({
      rows: [],
      changes: Number(r.changes),
      lastInsertRowId: BigInt(r.lastInsertRowid),
    });
  };
  const transaction = (async (arg: unknown) => {
    if (typeof arg === "function") {
      return await (arg as (tx: Tx) => Promise<unknown>)({ query, execute });
    }
    const out: QueryResult[] = [];
    for (const s of arg as { sql: string; params?: unknown[] }[]) {
      out.push(await execute(s.sql, s.params));
    }
    return out;
    // deno-lint-ignore no-explicit-any
  }) as any;
  return {
    db: { query, execute, transaction, close: () => Promise.resolve() },
    close: () => sqlite.close(),
  };
}

/** Collect frames a socket was sent, decoded. */
export function recordingSocket(): {
  socket: WebSocket;
  frames: { t: string; d: Record<string, unknown> }[];
} {
  const frames: { t: string; d: Record<string, unknown> }[] = [];
  const socket = {
    send: (m: string) => frames.push(JSON.parse(m)),
  } as unknown as WebSocket;
  return { socket, frames };
}

/** Wait until `pred()` holds — the sync handler's work is floating async. */
export async function until(
  pred: () => boolean,
  what = "condition",
): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}
