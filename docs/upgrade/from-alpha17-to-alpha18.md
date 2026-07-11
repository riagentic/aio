# Upgrade: 1.0.0-alpha17 → 1.0.0-alpha18

Alpha18 is additive (no exports removed, no config renamed) — most apps upgrade
with **zero changes**. Three behavior changes deserve a read.

## 1. Async methods are read-your-writes now

Reads through the `s` proxy see committed state **with your pending writes
overlaid** — straight-line code behaves like sync code:

```ts
async poll(s) {
  s.cpu = readCpu();
  s.history.push({ cpu: s.cpu }); // pushes the NEW value (was: the old one)
}
```

- If you worked around the old stale reads with local variables or `getState()`,
  that code still works — but you can delete the workaround.
- If anything _relied_ on reading the pre-write value after a write (rare, and
  almost certainly a latent bug), read what you need **before** writing.

## 2. `forUser` infers — remove your annotations

The old `CellVisibility` union forced `forUser: (s: {…filtered shape}) => …`
annotations. The type is now a single shape and `(s, user) => …` fully infers,
with `s` typed as the **full** cell state (at runtime it still carries only the
filtered fields).

A narrow explicit annotation from the workaround era may now fail to type-check
(parameter contravariance) — the fix is deletion:

```ts
// before (workaround)
forUser: (s: { accounts: Account[] }) => ({ ... })
// after
forUser: (s) => ({ ... })
```

## 3. Lazy components surface under their real names

Resolved `lazy()` components used to appear as `LazyWrapper` on the semantic UI
surface; they now report the loaded component's name. Any `am trigger` script or
test addressing a `…/LazyWrapper…` path must switch to the real component name
(run `am surface <idx>` to see the current tree).

## New in alpha18 (all additive)

- **Semantic UI testing** — `testUI` (`aio/testing`), `testgen` typed clients,
  `am surface` / `am trigger` on live apps, gestures (`scroll`, `dragTo`),
  chromium-verified. [Guide](../testing/ui-testing.md).
- **Custom HTTP routes** — `aio.run({ routes })` for uploads/webhooks/APIs.
- **Prometheus metrics** — `GET /__aio/metrics`.
- **CRDT conflicts are real** — `sync.onConflict` fires; per-field `merge`
  strategies apply to the client view. [Docs](../persistence/crdt.md).
- **Deep-path excludes** — `ui/persist: { exclude: ["accounts.encSecKey"] }`
  strips nested fields from broadcasts AND patch payloads. (A dotted `include`
  now warns — it was always a silent no-op.)
- **Offline-capable dev** — the framework's `immer` is served locally; esm.sh is
  only a fallback. No action needed.
- **Dashboard scaffold template** — `aio create --template=Dashboard`.
