# Big Data: The Four Tiers

Cell state is serialized to JSON on every persist flush and broadcast to every
connected client on change. That is exactly right for a working set and exactly
wrong for bulk data: a 100MB cell boots fine and then fails at _delivery_ — slow
flushes, oversized WS frames — far from the write that caused it.

So aio guards the tier boundary at **write time**: a cell whose serialized state
exceeds **1MB** gets a one-time warning naming the cell and this page; a cell
over **16MB** is reported as an error on **every** flush. The write is never
dropped — data is never lost to a guardrail — but the app stays loud until the
data moves to the right tier. (The thresholds are exported as
`PERSIST_CELL_WARN_BYTES` / `PERSIST_CELL_HARD_BYTES`; a config knob lands in
alpha53.)

Pick the tier by what the data _is_:

| Data                            | Tier                    | Mechanism                                   |
| ------------------------------- | ----------------------- | ------------------------------------------- |
| What the UI works with NOW      | **Cell state**          | `cell({ state })` — reactive, synced, ≤~1MB |
| Structured bulk (rows)          | **`db:` tables**        | SQLite via `db:` bindings + `app.db` SQL    |
| Binaries (images, media, dumps) | **Blobs**               | `app.blobs` — content-addressed, streamed   |
| Heavy compute over data         | **`.server.ts` module** | Pipeline outside state, progress IN state   |

## Tier 1 — Cell state: the reactive working set

State is what every client sees and every change re-syncs. Keep it to what the
UI is working with _right now_: the visible window, the selection, the form, the
counters. Rule of thumb: **≤~1MB per cell** (the guarded threshold — one default
WS frame).

```ts
const inbox = cell("inbox", {
  state: {
    page: [] as Msg[], // the visible 50 — NOT all 1M rows
    offset: 0,
    total: 0,
    query: "",
  },
  methods: {/* … */},
});
```

If a cell trips the size warning, the fix is never "raise the threshold" — it is
one of the three tiers below.

## Tier 2 — Structured bulk: `db:` tables + windowed queries

Rows belong in SQLite. Two ways in, one file (`state.db`):

- **Bound table** — `db: { contacts: contactsTable }` mirrors a state array into
  a table. Right for datasets that are ALSO the working set (thousands of rows,
  not millions): the array stays in state, so it still counts against the
  cell-size guardrail.
- **SQL-only table** — declare a table no state array binds to. It is created
  and yours via `app.db`, and its rows never enter state, never serialize on a
  flush, never ride a broadcast. This is the bulk tier.

### Recipe: 1M rows in SQLite, 50 in the UI

The table holds everything; the cell holds one window. Paging is a parameterized
query, and the UI stays reactive because the _window_ is state:

```ts
import { aio, cell, integer, pk, table, text } from "aio";

type Row = { id: number; sender: string; subject: string; at: number };

const inbox = cell("inbox", {
  state: { page: [] as Row[], offset: 0, total: 0, query: "" },
  methods: {
    async load(s, opts: { offset?: number; query?: string }) {
      s.offset = opts.offset ?? s.offset;
      s.query = opts.query ?? s.query;
      const like = `%${s.query}%`;
      // Parameterized, windowed — SQLite scans an index, state gets 50 rows.
      const { rows } = await app.db!.query<Row>(
        `SELECT id, sender, subject, at FROM messages
          WHERE subject LIKE ? ORDER BY at DESC LIMIT 50 OFFSET ?`,
        [like, s.offset],
      );
      const total = await app.db!.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages WHERE subject LIKE ?`,
        [like],
      );
      s.page = rows; // ← the ONLY part that syncs to clients
      s.total = total.rows[0]?.n ?? 0;
    },
  },
});

const app = await aio.run({
  appId: "mail",
  cells: [inbox],
  db: {
    // SQL-only: no cell has a `messages` array, so the rows live ONLY in
    // SQLite — boot logs "table messages is SQL-only".
    messages: table({
      id: pk(),
      sender: text(),
      subject: text(),
      at: integer(),
    }),
  },
});
```

Writes go through `app.db.execute` / `transaction` (or a bound table for the
small, hot subset). Selectors stay cheap because they derive from the 50-row
window, not the dataset.

See [SQLite](sqlite.md) for schema helpers, binding resolution and integrity
tooling.

## Tier 3 — Binaries: `app.blobs`

Bytes do not belong in JSON at all — a 5MB image in state is base64 in every
flush and every broadcast. `app.blobs` is the binary tier: a content-addressed
store under `appDirs(appId).files/blobs/` (inside the
[one backup dir](where-files-live.md)). The _metadata_ (id, name, whatever your
app knows about the file) lives in SQLite or state; the _bytes_ live in the
store and travel over HTTP only — they never ride the WS/UDS state channel.

```ts
const info = await app.blobs!.put(bytes, { name: "cat.png" });
// → { id: "9f86d0…", size: 51234, name: "cat.png" } — id = sha256 of content

app.blobs!.url(info.id); // "/__aio/blobs/9f86d0…" — hand it to an <img>/<video>
await app.blobs!.info(info.id); // { id, size, name? } | null
await app.blobs!.stream(info.id); // ReadableStream<Uint8Array>
await app.blobs!.list(); // every stored blob
await app.blobs!.delete(info.id); // true when something was removed
```

What the design buys:

- **Content-addressed** — the id is the sha256 of the bytes, so identical
  content is stored once (dedup by construction) and `blobs.url(id)` is served
  with `Cache-Control: immutable`: a browser never re-downloads a blob it has.
- **Streamed, never buffered** — `put()` accepts a `ReadableStream` and hashes
  chunks while spooling them to a temp file, then renames onto the hash. A
  multi-GB upload costs one chunk of memory, and a crash mid-put leaves no
  half-blob (the rename is the commit).
- **`Range` support** — `/__aio/blobs/<id>` answers single-range requests with
  `206`/`416`, so `<video>`/`<audio>` scrubbing works out of the box.
- **Auth-gated like the app** — on a keyed or per-user app, blob bytes require
  the same credential every other app resource does (an anonymous client on an
  `auth:` app gets 401, even though the login shell is public).

Uploads are a streaming `route()` — the request body is already a stream, so it
pipes straight into the store:

```ts
import { aio, type AioApp, cell, route } from "aio";

const files = cell("files", {
  state: { items: [] as { id: string; name: string; size: number }[] },
  methods: {
    record(s, item: { id: string; name: string; size: number }) {
      if (!s.items.some((f) => f.id === item.id)) s.items.push(item);
    },
  },
});

// Annotated: the route closure below reads `app`, so the circular
// inference is broken with an explicit type (aio.run is generic since alpha52).
const app: AioApp = await aio.run({
  appId: "mail",
  cells: [files],
  routes: {
    "/upload/:name": route(async (ctx) => {
      if (!ctx.req.body) {
        return ctx.json({ error: "empty body" }, { status: 400 });
      }
      // request.body → blobs.put — hashed and spooled chunk by chunk.
      const info = await app.blobs!.put(ctx.req.body, {
        name: ctx.params.name,
      });
      // Metadata into state (tiny); bytes stay on disk.
      await files.record({
        id: info.id,
        name: ctx.params.name,
        size: info.size,
      });
      // The client renders it via the immutable, Range-capable blob URL.
      return ctx.json({ ...info, url: app.blobs!.url(info.id) });
    }, { method: "POST" }),
  },
});
```

Headless (a CLI, a pipeline, a test seeding fixtures) opens the same store
without booting a server:

```ts
import { openBlobStore } from "aio/server";
const blobs = openBlobStore("mail"); // same dir `app.blobs` uses
```

## Tier 4 — Pipelines: `.server.ts` + progress in state

Heavy compute over big data (imports, exports, indexing, transcoding) runs in a
[`.server.ts` module](../build/imports.md) — server-only, never bundled to the
browser. The pipeline streams from files/SQLite to files/SQLite; **state carries
the progress, not the data**:

```ts
// import-pipeline.server.ts
export async function importDump(
  path: string,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
) {
  // read the dump in chunks → INSERT batches via app.db.transaction([...])
  // call onProgress(...) as batches land; check signal.aborted between batches
}
```

```ts
const importer = cell("importer", {
  state: { running: false, done: 0, total: 0 },
  methods: {
    async start(s, path: string) {
      s.running = true;
      const pipe = await import("./import-pipeline.server.ts");
      // s.$signal aborts when the call is cancelled — the pipeline stops
      // between batches instead of orphaning a half-import.
      await pipe.importDump(path, (done: number, total: number) => {
        s.done = done; // tiny writes — each syncs as a tiny patch
        s.total = total;
      }, s.$signal);
      s.running = false;
    },
  },
});
```

Every client watches `done/total` live for the cost of two numbers per patch —
the gigabytes never touch state, the flush, or the wire.

## When the guardrail fires

```
persist: cell "inbox" serializes to 4.2MB (warn threshold 1.0MB). Cell state
is the reactive working set — it is serialized on every persist flush and
broadcast to every client. Bulk rows belong in db: tables, binaries in
files — see docs/persistence/big-data.md.
```

- **Warn (>1MB, once per cell)** — the app works; move the bulk before it hurts.
  Usually: the dataset is an array in state → Tier 2 window recipe.
- **Error (>16MB, every flush)** — the app is measurably degraded; the write
  still lands (nothing is dropped), and the same message repeats until the data
  moves.
- The broadcast seam mirrors the warning for full-state frames over 1MB, naming
  the largest cell(s) — same fix, same tiers.
