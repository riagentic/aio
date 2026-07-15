# Secrets & observability — what crosses the wire, what gets recorded

aio's core promise is *"everything through a method is an observable, loggable
action, and state syncs everywhere."* That's the feature — and, for anything
secret (keys, seeds, tokens, passwords), it's exactly what you must reason about
hardest. This page makes the invisible explicit: **what leaves the server, what
gets recorded, and the blessed patterns for handling secrets.**

## The two channels a value can escape through

| Channel | What flows | Reaches |
| --- | --- | --- |
| **Sync (`ui`)** | Each cell's state slice, filtered by `ui: { include/exclude/forUser }` | **Every connected client** |
| **Action log** | Every method call's **arguments** + the resulting state patches | Time-travel, dev tools, `am tt`, and any `onAction` hook |

A field is safe only when it's out of **both**. They're independent:

```ts
cell("settings", {
  state: { theme: "dark", apiKey: "" },
  persist: { exclude: ["apiKey"] }, // not written to the KV store
  ui: { exclude: ["apiKey"] },      // not synced to clients
});
```

> The `ui`/`persist` filters are validated at cell creation — a key that matches
> no state field (a typo, or a nested path in `include`) **throws**, because a
> filter that silently matches nothing is a silent leak. Nested `exclude`
> (dot-paths like `"accounts.encSecKey"`) is supported.

## The rule for plaintext secrets

**A plaintext secret must never be a method argument or live in cell state.**

- **Method arguments are recorded.** `wallet.unlock(passphrase)` puts the
  passphrase in the action log. Instead, take the secret in a **module-level
  function** (not a cell method), derive what you need, and only ever let a
  *non-secret* result (a boolean, a public key, ciphertext) touch a method.
- **Cell state is synced + persisted.** Keep the plaintext in a module-level
  vault holder (a closure variable), never in `state:`. Put only ciphertext or
  public material in the cell.

```ts
// vault.ts — plaintext never enters a cell or an action payload
let _key: CryptoKey | null = null;

export async function unlock(passphrase: string): Promise<boolean> {
  _key = await deriveKey(passphrase); // passphrase stays in this module
  wallet.setUnlocked(true);           // only a boolean crosses the wire/log
  return true;
}
export function sign(tx: Tx): Signed {
  if (!_key) throw new Error("locked");
  return signWith(_key, tx);          // _key never leaves this module
}
```

## Guard state that must only change under authority

Because any method is callable, a harmless-looking `setUnlocked(true)` can flip
an invariant. Guard it — validate the precondition inside the method (or route
the transition only through the vault module above), so "unlocked" can't be set
without the passphrase path having run.

## Testing network / device code — the transport seam

Code that does `new Connection(url)` or touches `navigator.hid` **inside** a
function can't be unit-tested without a live endpoint or a device. Inject the
transport instead, so tests pass a double:

```ts
// Instead of: function balance(addr) { return new Connection(RPC).getBalance(addr); }
export function makeRpc(conn: Connection = new Connection(RPC)) {
  return { balance: (addr: string) => conn.getBalance(addr) };
}
// test: makeRpc(fakeConn).balance(addr)
```

`fetch`-based calls are trivially mockable the same way (pass a `fetch`
parameter defaulting to the global). Keep the seam at the module boundary and
the network-touching lines become coverable.

## Checklist

- [ ] No plaintext secret in any `state:` — module vault holder instead.
- [ ] No plaintext secret as a method argument — module function instead.
- [ ] Secret fields `ui: { exclude }` **and** `persist: { exclude }`.
- [ ] Authority-changing methods validate their precondition.
- [ ] Network/device calls take an injectable transport for tests.
- [ ] `/__aio/snapshot` returns **raw** state — treat snapshots as backups.
