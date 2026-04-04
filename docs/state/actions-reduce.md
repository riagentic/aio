# Actions & Reduce — Explicit Control Style

> **Not the starting point.** Use `feature({ methods })` for most features. This
> style gives full explicit control — reach for it when methods can't express
> what you need.

## Full example

```ts
import { feature } from "aio";

export const counter = feature("counter", {
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

Handlers receive an Immer draft — mutate in place. The reduce object cannot
return effects — use `execute` for side effects.

---

## Function-form reduce

For foreign action handling, dynamic routing, or shared logic:

```ts
reduce(state, action, { on, emit }) {
  on(counter.increment, (payload) => { state.watchedCount = payload.by })
  if (action.type === 'myFeature:save') {
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
- `app.dispatch(otherFeature.action())` — blocked unless declared in
  `dispatchTo`
- `app.getState()` — returns this feature's slice only
- `app.getFullState?.()` — returns entire app state (in `init`, `destroy`,
  `execute`)

---

## dispatchTo

```ts
import { wallet } from "../wallet";

const te = feature("te", {
  dispatchTo: [wallet, fleet],
  execute: {
    transferComplete(app, payload) {
      app.dispatch(wallet.credit(payload.amount)); // allowed
    },
  },
});
```

Blocked dispatches log:
`[te] dispatch('wallet:credit') blocked — add wallet to dispatchTo`

---

## Selectors

Receive the feature's own state slice:

```ts
selectors: {
  isPositive: (s: { count: number }) => s.count > 0,
},

// After aio.run():
counter.isPositive(); // → boolean
```

---

## Foreign actions

A feature can react to another feature's actions:

### With listensTo

```ts
const analytics = feature("analytics", {
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
const analytics = feature("analytics", {
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
export const backup = feature("backup", {
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
