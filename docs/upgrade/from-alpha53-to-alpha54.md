# alpha53 → alpha54

**Nothing in your app breaks.** Everything new is opt-in and off by default: an
app that adds nothing to its config behaves exactly as it did on alpha53.

One thing changes for anyone who already used `aio ship`, and it changes on
purpose — see the last section.

## New: keep your app up to date

```ts
aio.run({
  cells: [wallet],
  updates: "https://releases.example.com/wallet",
});
```

The update state is a cell, so your UI binds it like any other state:

```tsx
import { updates } from "aio/updates";

{
  updates.available && (
    <button onClick={() => updates.apply()}>
      Update to {updates.available.version}
    </button>
  );
}
```

Publish with `aio ship`, or let CI do it:

```sh
deno run -A jsr:@riagentic/aio/ship github --channel=prod
```

Full guide: [docs/deploy/updates.md](../deploy/updates.md).

### What it will refuse to do

An update is only ever **offered** when the release can migrate the data already
on disk. That is decided from a signed data contract derived from your cells:

| Your cell                        | An install holding v1 data  |
| -------------------------------- | --------------------------- |
| `version: 2` **and** `onMigrate` | offered, backup taken first |
| `version: 2`, **no** `onMigrate` | **never offered**           |

If you bump a cell version without writing the migration, users on the old shape
are not offered the release at all — it appears as `updates.blocked` with the
reason. This is deliberate, and it is the one rule the whole feature exists to
serve. Write the `onMigrate`, or declare that the old shape is unsupported and
accept that those installs stay put.

## New: problem reports

```ts
aio.run({ cells: [wallet], feedback: true });
```

Captures a report — build identity, environment, state, timeline, diagnostics,
log tail — into `<data>/reports/`, both when a user asks and automatically when
the app breaks. Read them with `am report list` / `am report show <id>`.

If your app declares `redactActions`, reports honour that same list: a redacted
cell's slice is withheld whole and named in `redactedCells`. **Check your
`redactActions` before enabling this**, because a report carries state and is
meant to be sent to you.

Guide: [docs/debugging/feedback.md](../debugging/feedback.md).

## New: `aio/ship`

`aio ship` is now a published entry, so it works from your app:

```sh
deno run -A jsr:@riagentic/aio/ship ./dist/my-app --channel=prod --key=key.json
```

Previously it existed only inside the aio repo.

## BREAKING (only if you already published `ship` manifests)

**Manifests produced before alpha54 are refused, and must be re-published.**

A v1 manifest signed only the binary's SHA-256. That authenticated the bytes and
none of the release coordinates — so a genuine, correctly-signed **test** build
copied onto the **prod** path verified perfectly and would install. The channel,
target, platform and data contract are now inside the signature, and a
pre-alpha54 manifest is refused with a message saying exactly that rather than
silently accepted (accepting it would hand back the guarantee the format exists
to provide).

Two further tightenings in the same area:

- **Unsigned manifests are refused** unless the client passes `allowUnsigned`,
  and are refused outright once a key is pinned — stripping a signature must not
  downgrade an install that already trusts a key.
- **Verification requires a _trusted_ key.** A manifest signed by a key shipped
  alongside it is internally consistent and proves nothing; the first verified
  release pins its key (loudly) and every later one must match.

### What to do

```sh
# regenerate every published manifest with the same key
deno run -A jsr:@riagentic/aio/ship ./dist/my-app --channel=prod --key=key.json
# copy the artifact + <os>-<arch>.json into <base>/prod/ again
```

Use the **same signing key** you published with before if any client has already
pinned it. If you have lost that key, every existing install will refuse
everything signed by the new one — they have to be reinstalled by hand. Nothing
else recovers from a lost signing key, which is why the workflow generator says
so at the top.

If you have never run `aio ship`, there is nothing to do.
