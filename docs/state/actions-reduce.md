# Actions & Reduce — Explicit Control Style

> **Advanced — most apps don't need this.** Use `cell({ methods })` for most
> cells, and [generators](generators.md) for sequential workflows. This style
> gives full explicit control — reach for it when you need action replay, audit
> trails, or strict pure/impure separation.

## Full example

```ts
import { cell } from "aio";

export const counter = cell("counter", {
  state: { count: 0, lastUpdatedAt: 0, error: null as string | null },

  actions: {
    increment: (by = 1) => ({ by }),
    decrement: (by = 1) => ({ by }),
    reset: () => ({}),
    save: () => ({}),
    saved: () => ({}),
    saveFailed: (error: string) => ({ error }),
    retry: () => ({}),
    dismiss: () => ({}),
  },

  effects: {
    persist: (value: number) => ({ value }),
    log: (message: string) => ({ message }),
  },

  machine: {
    initial: "idle",
    states: {
      idle: {
        increment: "idle",
        decrement: "idle",
        reset: "idle",
        save: "saving",
      },
      saving: { saved: "idle", saveFailed: "error" },
      error: { retry: "saving", dismiss: "idle" },
    },
  },

  reduce: {
    increment(state, payload) {
      state.count += payload.by;
      state.lastUpdatedAt = Date.now();
    },
    decrement(state, payload) {
      state.count -= payload.by;
      state.lastUpdatedAt = Date.now();
    },
    reset(state) {
      state.count = 0;
    },
    saveFailed(state, payload) {
      state.error = payload.error;
    },
  },

  execute: {
    persist(app, payload) {
      fetch("/api/save", {
        method: "POST",
        body: JSON.stringify({ value: payload.value }),
      })
        .then(() => app.dispatch(counter.saved()))
        .catch((e) => app.dispatch(counter.saveFailed(e.message)));
    },
    log(_app, payload) {
      console.log(payload.message);
    },
  },
});
```

---

## Named reduce handlers

The object form: one method per action key, `payload` typed from the action
creator:

```ts
reduce: {
  increment(state, payload) { state.count += payload.by },
  reset(state) { state.count = 0 },
  saveFailed(state, payload) { state.error = payload.error },
},
```

Handlers receive an Immer draft — mutate in place. To trigger side effects,
return effect objects using `cell.fx`:

```ts
reduce: {
  save(state) {
    state.status = "saving";
    return [counter.fx.persist(state.count)];
  },
},
```

`cell.fx` is the public effect catalog — typed, with autocomplete.

> **Effect payloads can reference state.** aio clones effects inside `produce()`
> before Immer revokes the draft, so state refs in effect payloads work. Stick
> to plain serializable values (no functions, symbols, or circular refs).

---

## Function-form reduce

For foreign action handling, dynamic routing, or shared logic:

```ts
reduce(state, action, { on, emit }) {
  on(counter.increment, (payload) => { state.watchedCount = payload.by })
  if (action.type === 'myCell:save') {
    emit('persist', { value: state.count })
  }
},
```

Use `{ on }` for foreign actions, `{ emit }` for effects.

---

## Named execute handlers

One method per effect key. Receives `app` (scoped dispatch) and typed `payload`:

```ts
execute: {
  persist(app, payload) {
    fetch('/api/save', { method: 'POST', body: JSON.stringify({ value: payload.value }) })
      .then(() => app.dispatch(counter.saved()))
      .catch(e => app.dispatch(counter.saveFailed(e.message)))
  },
},
```

**Scoped dispatch rules:**

- `app.dispatch(ownAction())` — always allowed
- `app.getState()` — returns this cell's slice only
- `app.getFullState?.()` — returns entire app state (in `init`, `destroy`,
  `execute`)

---

## Selectors

Receive the cell's own state slice:

```ts
selectors: {
  isPositive: (s: { count: number }) => s.count > 0,
},

// After aio.run():
counter.isPositive(); // → boolean
```

---

## Foreign actions

A cell can react to another cell's actions:

### With listensTo

```ts
const analytics = cell("analytics", {
  state: { events: [] as string[] },
  listensTo: [counter.increment, counter.reset],
  reduce: {
    clear(state) {
      state.events = [];
    },
  },
});
```

### With explicit machine

```ts
const analytics = cell("analytics", {
  state: { events: [] as string[] },
  actions: { clear: () => ({}) },
  machine: {
    initial: "active",
    states: {
      active: {
        clear: "active",
        [counter.increment.type]: "active",
        [counter.reset.type]: "active",
      },
    },
  },
  reduce(state, action, { on }) {
    on(counter.increment, () => {
      (state.events as string[]).push("incremented");
    });
    on(counter.reset, () => {
      (state.events as string[]).push("reset");
    });
    if (action.type === "analytics:clear") state.events = [];
  },
});
```

**Object-form reduce with computed keys** — no function form needed:

```ts
reduce: {
  track(state, payload) { state.events.push(payload.event) },
  [counter.increment.type](state, payload) {
    state.events.push(`counter incremented by ${payload.by}`)
  },
},
```

---

## Lifecycle hooks

```ts
onInit(app) {
  const config = (app.getFullState?.()?.config as { url?: string })?.url;
  connectWebSocket(config ?? "ws://localhost");
},
onDestroy(app) { closeWebSocket() },
```

Init runs in dependency order. Destroy runs in reverse.

---

## Server-only executors

When execute needs server-only imports, use an async method with dynamic
`import()`:

```ts
export const backup = cell("backup", {
  state: { lastBackup: null as string | null },
  methods: {
    async run(s) {
      const data = JSON.stringify(s);
      await Deno.writeTextFile("./backup.json", data);
      s.lastBackup = new Date().toISOString();
    },
  },
});
```

The browser never runs async method bodies — it dispatches via WebSocket.
