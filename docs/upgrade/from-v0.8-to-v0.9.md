# Upgrade from v0.8 to v0.9

### Breaking changes

**`AioDB` / `AioTable<T>` removed — async `DB` replaces sync ORM**

All `app.db` calls must be awaited. The old synchronous API is gone.

```ts
// BEFORE (v0.8)
const users = app.db!.users.findAll();
app.db!.users.insert({ name: "Alice" });

// AFTER (v0.9)
const { rows: users } = await app.db!.query<User>("SELECT * FROM users");
await app.db!.execute("INSERT INTO users (name) VALUES (?)", ["Alice"]);
```

**`openDb()` / `loadTables()` / `syncTables()` / `reloadTable()` removed from
public API**

These are now private internals. Schema is still declared the same way under
`db:` in `aio.run()`.

**`lastInsertRowId` is now `bigint`** (was `number`)

```ts
// if you use lastInsertRowId, coerce it:
const id = Number(result.lastInsertRowId);
```

**Permissions: `--allow-ffi` no longer required**

Remove `--allow-ffi` from any launch scripts — it causes an error on some Deno
versions now.

### New in v0.9

**Read replicas** — pass `readers: N` to `createDB()` for parallel query
workers:

```ts
const db = await createDB("./data.db", { readers: 4 });
```

**`log` public singleton** — import and use anywhere after `aio.run()`:

```ts
import { log } from "aio";
log.info("payments", "charge processed", { amount: 99 });
```

**UI sync rate** — `ui.syncRate` added (default `10` ms = 100fps cap). Set
`syncRate: 0` for the old unbounded behavior.

### Upgrade steps

1. Update `deno.json` — replace `"aio": "./dep/aio/mod.ts"` with
   `"aio": "jsr:@riagentic/aio@^0.9"` and update task commands to use
   `jsr:@riagentic/aio@^0.9/src/am` / `jsr:@riagentic/aio@^0.9/src/build`
2. Remove `dep/aio/` from your project (no longer needed)
3. Remove `--allow-ffi` from any launch scripts
4. Await all `app.db` calls (now async)
5. Coerce `lastInsertRowId` to `Number()` if used
6. Run `deno install && deno task dev`
