# Big Data: The Four Tiers

Cell state is serialized to JSON on every persist flush and broadcast to every
connected client on change. That is exactly right for a working set and exactly
wrong for bulk data: a 100MB cell boots fine and then fails at _delivery_ — slow
flushes, oversized WS frames — far from the write that caused it.

So aio guards the tier boundary at **write time**: a cell whose serialized state
exceeds **1MB** gets a one-time warning naming the cell and this page; a cell
over **16MB** is reported as an error on **every** flush. The write is never
dropped — data is never lost to a guardrail — but the app stays loud until the
data moves to the right tier, or until the app declares the size on purpose with
`budgets: { cellState }` — see
[Legitimately large state](#legitimately-large-state).

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

If a cell trips the size warning by accident, the fix is one of the three tiers
below. If the working set really is that big, read
[Legitimately large state](#legitimately-large-state) before raising anything.

## Tier 2 — Structured bulk: `db:` tables + windowed queries

Rows belong in SQLite. Two ways in, one file (`state.db`):

- **Bound table** — `db: { contacts: contactsTable }` mirrors a state array into
  a table. Right for datasets that are ALSO the working set (thousands of rows,
  not millions): the array stays in state, so it still rides every connect frame
  and counts against the full-state frame line (not the persist lines — SQLite
  writes it row by row, outside the snapshot). Write it through state, never by
  SQL: with `journal: true` a direct write to a bound table reads as a foreign
  save, and the next boot sets the journal aside.
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
await app.blobs!.stream(info.id, { start: 0, end: 1024 }); // bytes [0, 1024) — non-negative integers
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
      // request.body → blobs.put — hashed and spooled chunk by chunk.
      // (Deno hands even a bodyless POST a stream, so `!ctx.req.body` never
      // fires: an empty upload is caught by its SIZE, after the put.)
      const info = await app.blobs!.put(ctx.req.body ?? new Uint8Array(), {
        name: ctx.params.name,
      });
      if (info.size === 0) {
        await app.blobs!.delete(info.id);
        return ctx.json({ error: "empty body" }, { status: 400 });
      }
      // Metadata into state (tiny); bytes stay on disk.
      await files.record({
        id: info.id,
        name: ctx.params.name ?? info.id,
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
persist: cell "inbox" serializes to 4.2 MB (warn threshold 1.0 MB). Cell state
is the reactive working set — it is serialized on every persist flush and
broadcast to every client. Fix: keep bulk rows in db: tables and page them into
state; if this size is intended, declare it: aio.run({ budgets: { cellState:
"7MB", payload: "7MB" } }) — see
docs/persistence/big-data.md#legitimately-large-state.
```

- **Warn (>1MB, once per cell)** — the app works; move the bulk before it hurts.
  Usually: the dataset is an array in state → Tier 2 window recipe.
- **Error (>16MB, every flush)** — the app is measurably degraded; the write
  still lands (nothing is dropped), and the same message repeats until the data
  moves.
- The broadcast seam mirrors the warning for full-state frames over 1MB, naming
  the largest cell(s) — same fix, same tiers. It fires on the frame every client
  gets when it connects, on both transports (WS and the desktop socket).
- Every size message ends with the same **Fix:** line: the tier, the exact
  `budgets` declaration sized to what was measured (×1.5, rounded up to a whole
  MB), and a link to the chapter below. The text is identical in dev and prod.

## Legitimately large state

Some apps are big on purpose: a catalog the user scrolls, a document, a
spreadsheet, a local-first desktop tool whose whole dataset IS the working set.
The 1MB line is aio's guess for an app that said nothing — not a wall. This
chapter says what each number actually governs, what a big state costs
(measured), and how to hold one without paying for it on every keystroke.

### What the numbers govern

The size is always the cell's JSON in **UTF-8 bytes** (a CJK string is ~3× its
character count). Nothing below refuses or drops **state** except the one 64 MiB
runtime ceiling for Deno peers.

| Limit                            | Default                 | Where / what happens                                                                                                                            | Raise it with                                      |
| -------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Persist warn                     | 1 MiB per cell          | `persistence.ts` — one WARN per cell per process                                                                                                | `budgets: { cellState }`                           |
| Persist hard                     | 16 MiB per cell         | `persistence.ts` — ERROR on every flush; the write still lands                                                                                  | `budgets: { cellState }` above 16MB lifts it       |
| Full-state frame warn            | 1 MiB per frame         | `server-broadcast.ts` — one WARN per cell, on connect and on every whole-state send, WS and UDS                                                 | `budgets: { cellState }`                           |
| Payload pressure                 | 500 KB per client send  | `vitals` — throttled `PRESSURE` line + diagnostic event                                                                                         | `budgets: { payload }`                             |
| Bandwidth pressure               | 1 MB/s per client       | `vitals` — throttled `PRESSURE` line                                                                                                            | — (send less: see patterns)                        |
| Patch vs whole state             | patch > 50% of full     | `server-broadcast.ts` — sends the whole view instead of the patch                                                                               | `fullStateThreshold` (0–1)                         |
| Slow-peer backlog                | 4 MiB unread per socket | `write-backlog.ts` — the client's rounds are skipped; it gets the whole state when it drains                                                    | —                                                  |
| Deno peer frame ceiling          | 64 MiB per frame        | `server-ws.ts` — the frame is NOT sent to `connectCli`/`am`/another aio server (the runtime would kill the socket); ERROR, and the peer is told | cannot be raised — page the data                   |
| Inbound WS frame (client → you)  | 1 MB, 5 MB/s            | `server-ws.ts` — a method argument over it is refused with a reason                                                                             | `wsLimits: { maxMessageBytes, bytesPerSec }`       |
| Inbound UDS frame (window → you) | 10 MiB                  | `uds.ts` — the connection is closed; the window reconnects                                                                                      | `wsLimits: { maxMessageBytes }` (never below 10MB) |
| Dev freeze                       | 100 KB declared state   | `immutable.ts` — dev only, INFO once: the extra deep-freeze of a big initial state is skipped                                                   | —                                                  |
| Dev time-travel history          | 128 MiB                 | `time-travel.ts` — oldest actions dropped, WARN once                                                                                            | —                                                  |

Two things the table makes plain:

- **Patches do not care how big the state is.** A change is sent as the ops it
  made (`$p`), so one field changed in a 12 MB cell is a ~100-byte frame. The
  size is paid in full on **connect / reconnect** (every client gets its whole
  view first), whenever a patch would be larger than half the view, after a slow
  client falls behind, and on every change of a `forUser` cell (a per-user view
  cannot be patched).
- **Persist rewrites the whole cell** on every debounce window it changed in —
  unless the big array is a bound `db:` table, which is written row by row and
  kept out of the snapshot (so it never counts against the persist lines).

### What it costs, measured

One cell of N rows (`{ id, name, email, note }`, ~100 B each), `--prod`, a Deno
client on loopback, Linux on 4 pinned cores. "Round trip" is send → the patch
frame back, p50 over 20 calls.

| Measure                                    | 2 MB (21k rows) | 12.5 MB (131k rows) |
| ------------------------------------------ | --------------- | ------------------- |
| boot                                       | 136 ms          | 422 ms              |
| first whole state, WS                      | 13 ms           | 48 ms               |
| first whole state, UDS (desktop socket)    | 22–28 ms        | 189–192 ms          |
| `s.n++` beside the rows, WS                | 1.0 ms          | 1.2 ms              |
| `s.n++` beside the rows, UDS               | 3.4 ms          | 16.8 ms             |
| edit one row inside the array, WS          | 8.3 ms          | 62–82 ms            |
| edit one row inside the array, UDS         | 10.6 ms         | 75 ms               |
| edit one row, array bound to a `db:` table | —               | 52 ms               |
| server heap                                | 70–114 MB       | 284–583 MB          |
| `JSON.stringify` / `JSON.parse` (V8)       | 2.9 / 3.2 ms    | 15.7 / 24.4 ms      |

The UDS rows and the one-row edits were measured before two fixes that took
per-round work out of them: a UDS patch round no longer serializes the whole
view to choose patch vs full (≈23 ms → 0.2 ms per round at 12.5 MB), and the
timeline's per-commit diff no longer walks every row of an edited array (≈38 ms
→ 0.6 ms per commit at 131k rows).

Read it as: a write NEXT TO big data is cheap at any size; a write INSIDE a big
array costs time proportional to the array (copy-on-write, freeze, the change
record) — ~60 ms at 131k rows, which the `BUDGET_REDUCE` line reports. A client
parses the whole state on connect — ~25 ms per 12 MB in V8 before a single
component renders.

### Remote vs local (UDS)

Serializing, diffing and persisting happen before any byte leaves, so the local
socket is not cheaper for big state — measured above, its first frame was slower
than WS on loopback. Both transports choose patch vs full with one decider that
serializes the view only when a patch is near the threshold. What differs is the
**wire**:

- **Local** (Electron over UDS, a browser on `localhost`): the bytes are free;
  the cost is CPU and memory on one machine. A few MB to a few tens of MB is
  workable once declared.
- **Remote** (`--expose`, a phone, a second office): every connect and reconnect
  downloads the whole view. 12.5 MB is ~2 s at 50 Mbit/s and ~10 s at 10 Mbit/s
  — per client, per reconnect, before first paint. Keep a remote client's view
  small with `visible` / `forUser` and paging, whatever you declare.
- **Terminal clients** (`connectCli`, `am`, another aio server) run on Deno,
  whose WebSocket cannot take a frame over 64 MiB. Past that, aio refuses to
  send it and says so; the only fix is a smaller view.
- **Standalone / Android** (no server): the whole state is serialized and
  written on every change — fsync'd on Android (a slow save over 32 ms is
  reported once), debounced into `localStorage` in a desktop browser, whose
  per-origin quota (~5 MB in most browsers) makes a write over it fail.

### Declare it

If the size is the app's design, say so — once, in `aio.run`:

```ts
await aio.run({
  cells: [catalog],
  budgets: { cellState: "20MB", payload: "20MB" },
});
```

- `cellState` moves the persist warn line and the full-state frame line, and —
  set above 16MB — lifts the persist hard line to it.
- `payload` moves the pressure monitor's per-send line (a whole-state frame to a
  WebSocket client trips it too — on connect, `subs`, `resync` — so a big
  working set needs both). The UDS transport (desktop windows) has no pressure
  monitor: its window is local, and its size line is the full-state warning.
- Over a declared budget is no longer a hint: it is a **breach**, recorded on
  `/health` (`status: "degraded"`), so CI can hold the app to it
  ([budgets](../build/scaling.md#limits-your-app-declares-budgets)).

Declaring does not make anything cheaper. It moves the line to where the app's
real number is, so the next warning means something.

### Patterns that make big state cheap

**Write beside the data, not inside it.** Status, selection, counters and
progress live in small fields or a small cell; the big array changes rarely.
Measured above: 1 ms beside 12.5 MB versus ~60 ms inside it.

```ts
const catalog = cell("catalog", {
  state: { items: [] as Item[] }, // big, changes on import only
  methods: {/* import, bulk edit */},
});
const view = cell("view", {
  state: { selected: null as number | null, filter: "" }, // tiny, hot
  methods: {
    select(s, id: number) {
      s.selected = id; // a ~100-byte patch, whatever catalog holds
    },
  },
});
```

**Bind the big array to a `db:` table.** Rows persist incrementally and stay out
of the state snapshot, so the persist lines stop counting them; clients still
get patches. See [SQLite](sqlite.md#framework-integration).

**Keep it in SQLite and page it in** — the
[Tier 2 recipe](#recipe-1m-rows-in-sqlite-50-in-the-ui): the table holds
everything, the cell holds the visible window.

**Keep the big field off the wire.** Rounds after the first go only to clients
whose components read the cell, but the frame a client gets on connect carries
every cell it may see. `visible` is what keeps a server-side working set off the
wire entirely:

```ts
const orders = cell("orders", {
  state: { all: [] as Order[], stats: { open: 0 } },
  visible: {
    exclude: ["all"], // server-side working set, never on the wire
    // or per user — note a forUser cell's change is sent WHOLE, never patched:
    // forUser: (s, user) => ({ ...s, all: s.all.filter((o) => o.owner === user?.id) }),
  },
  methods: {/* … */},
});
```

**Don't persist what can be rebuilt.** `persist: "none"` on a cache or index
cell, `persist: { exclude: ["derived"] }` on a field — they stop costing a
rewrite per change ([cell visibility](../state/cell-visibility.md)).

**Derive, don't store.** A `selectors` value is computed from state on read and
never serialized, persisted or broadcast.

**Grow by appending.** A `push` onto an array travels as its adds, a grown
string as its suffix ([delta](delta.md)) — a log or feed can grow large without
its patches growing.

**Binaries never go in state.** `app.blobs`
([Tier 3](#tier-3--binaries-appblobs)).
