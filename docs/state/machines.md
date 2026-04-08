# State Machines — Guards and Transitions

A state machine guards actions. Only certain actions are allowed in certain
states. Actions that aren't listed for the current status are **silently
dropped** — no error, no state change.

## Basic example

```ts
const door = cell("door", {
  state: { isOpen: false },
  machine: {
    initial: "closed",
    states: {
      closed: { open: "open" }, // only 'open' allowed when closed
      open: { close: "closed" }, // only 'close' allowed when open
    },
  },
  methods: {
    open(s) {
      s.isOpen = true;
    },
    close(s) {
      s.isOpen = false;
    },
  },
});

door.open(); // Works → machine moves to 'open'
door.open(); // Dropped! 'open' not allowed in 'open' state
door.close(); // Works → machine moves to 'closed'
```

## How to read the machine config

```ts
machine: {
  initial: 'closed',              // start in 'closed' state
  states: {
    closed: {                     // when in 'closed' state:
      open: 'open'                //   'open' action → move to 'open' state
    },
    open: {                       // when in 'open' state:
      close: 'closed'             //   'close' action → move to 'closed' state
    }
  }
}
```

---

## Realistic example — upload workflow

```ts
const upload = cell("upload", {
  state: { progress: 0, error: null as string | null },
  machine: {
    initial: "idle",
    states: {
      idle: { start: "uploading" },
      uploading: { complete: "idle", fail: "error" },
      error: { retry: "uploading", dismiss: "idle" },
    },
  },
  methods: {
    async start(s) {
      const file = await pickFile();
      await uploadFile(file, (pct) => {
        s.progress = pct;
      });
    },
    complete(s) {
      s.progress = 100;
    },
    fail(s, err: string) {
      s.error = err;
    },
    retry(s) {
      s.progress = 0;
      s.error = null;
    },
    dismiss(s) {
      s.error = null;
      s.progress = 0;
    },
  },
});
```

---

## Machine-gated async writes

Async Proxy writes dispatch method-tagged `__setMethodName` actions (e.g.,
`__setStart`). The framework auto-injects self-loop transitions in the target
state — so if `start` transitions `idle→uploading`, then `__setStart` writes are
allowed in `uploading`.

For strict per-step machine control on async workflows, use `generators` instead
— each `yield*` checkpoint is a named action.

---

## Validation at definition time

- Initial state must exist in declared states
- All transition targets must be declared states
- All referenced action keys must be declared (own or foreign)
- Unreachable states are flagged
- Dead-end states (no outgoing transitions) get a console warning

---

## Check status in UI

```tsx
const { status } = useCell(door);
// status is 'closed' or 'open' (string)
```

In tests: `t.expect.status('idle')`. Never read `__aio_status` directly — use
`registry.status()` or `useCell().status` in UI.

---

## Foreign actions in machines

A machine can declare actions from other cells:

```ts
const analytics = cell("analytics", {
  state: { events: [] as string[] },
  actions: { clear: () => ({}) },
  machine: {
    initial: "active",
    states: {
      active: {
        clear: "active",
        [counter.increment.type]: "active", // foreign action
        [counter.reset.type]: "active",
      },
    },
  },
  reduce: {
    [counter.increment.type](state) {
      state.events.push("incremented");
    },
  },
});
```

Foreign actions are routed to both the owning cell and all listeners. Always use
`.type` or pass functions directly — never raw strings.

---

## No machine needed?

```ts
// Omit machine entirely — all actions always allowed
// or explicitly:
machine: false;
```
