# Upgrade from v1.0.0-alpha9 to v1.0.0-alpha10

### No breaking changes

Alpha10 is fully additive. No API renames, no config changes, no migration
required for existing code. Upgrade by bumping your version and restarting.

### New: CRDT sync module

Offline-first, server-authoritative collaborative state sync. Enable per
feature:

```ts
const doc = feature("doc", {
  state: { title: "", body: "", editCount: 0 },
  sync: {
    merge: {
      title: "lww",
      body: "lww",
      editCount: "counter",
    },
  },
  methods: {
    setTitle(s, title: string) {
      s.title = title;
    },
    setBody(s, body: string) {
      s.body = body;
    },
    bumpEdits(s) {
      s.editCount++;
    },
  },
});
```

**Merge strategies:**

| Strategy      | Behavior                               |
| ------------- | -------------------------------------- |
| `lww`         | Last-write-wins by HLC timestamp       |
| `counter`     | Additive delta merge (CRDTs counter)   |
| `lww-per-key` | Object union with per-key LWW conflict |
| `set-add`     | Append-only set                        |
| `set-remove`  | Set with tombstone-based removal       |

**What gets created:**

- Hybrid Logical Clock (HLC) per client for causal ordering
- Op buffer in IndexedDB (500 pending ops cap, 4h retention)
- Rebase engine replays unconfirmed ops on confirmed state
- Client sync engine handles op stamping, ack, reconnect
- Server persists ops to SQLite, compacts after 1000 ops
- Wire protocol: `__op` (send op), `__sync` (request sync)

**Persistence behavior:** Sync features use SQLite op-log instead of Deno.Kv. KV
persistence automatically excludes sync-enabled features. Both modes coexist.

**Full docs:** [CRDT](../persistence/crdt.md) |
[Protocol](../persistence/crdt-protocol.md)

### New: Client log forwarding

Console output from browser clients is forwarded to the server log:

```ts
import { installConsoleIntercept } from "aio/air";

installConsoleIntercept(); // intercepts console.log/info/warn/error/debug
```

- Forwards as `__log: { level, msg, ts }` wire messages
- Captures global `error` and `unhandledrejection` events
- Max 4KB message, 2KB stack trace
- Original console methods still work
- Idempotent install/uninstall

### New: DOM snapshot and interaction

Server-side UI inspection and remote interaction:

```ts
import { interact, snapshotDOM } from "aio/air";

// Capture semantic UI state
const nodes = snapshotDOM();
// nodes: UINode[] — tag, text, value, selector, aria, classes, etc.

// Remote interaction
const result = interact({ action: "click", selector: "#submit-btn" });
const result2 = interact({ action: "type", selector: "#name", value: "Alice" });
```

**Snapshot:** Walks DOM (max 5000 nodes, depth 50), captures semantic state
(text, values, aria, data attributes, visibility), collapses wrapper divs,
generates unique selectors (id > data-testid > data-component > nth-of-type).

**Interact actions:** click, type (with optional clear), select, focus, blur,
scroll, hover. Validates selector, visibility, disabled state before dispatch.

### New: Sync config in feature API

The `feature()` config now accepts a `sync` option:

```ts
feature("name", {
  state: { ... },
  sync: true,                    // enable with default LWW merge
  sync: { merge: { ... } },     // enable with custom merge strategies
  // ...
});
```

See [Features config](../state/features.md) for the full config table.

### Internal changes (no action required)

- `_syncFeatureIds` added to valid config keys (internal plumbing)
- Server routes `__op`/`__sync` messages before regular action dispatch
- Nuclear audit: 40 findings fixed across sync, server, client, DOM modules
- Renderer fix included in release prep

### Upgrade steps

1. Bump version to `1.0.0-alpha10`
2. Restart the server (`aio` does not hot-reload server code)
3. Optionally enable `sync` on features that need collaborative editing
4. Optionally add `installConsoleIntercept()` to your browser entry point
