# Release signing

An aio app updates itself by fetching a **ship manifest** and, if it likes what
it says, the artifact the manifest describes. The manifest is what a release
_is_: identity, integrity, coordinates, and what the build promises about the
data already on disk. Signing is what makes it worth believing.

[Keeping an app up to date](updates.md) covers the client side — channels,
sources, the update banner, `canApply`. This page is the **publishing and
verification API**: what `deno task ship` calls, and what you call if you build
or check a release yourself.

Everything here is exported from `aio/ship` — and only from there (alpha70: one
import path per symbol; the `aio/build` re-exports are gone, and
`aiol --safe-fix` rewrites an old `import { shipApp } from "aio/build"`).

## The short version

```sh
deno task ship keygen                    # once, ever — writes it outside the repo
deno task publish --key=~/.aio/keys/<app>-release-key.json
```

`keygen` writes the private key to `~/.aio/keys/<app>-release-key.json` and
prints that path with the PUBLIC half.

**Do not redirect it.** Sending its output to a file captures the printed
summary — valid JSON, a `publicKey`, and no private half — which looks like a
key and signs nothing. Use the file at the printed path, or `keygen --stdout` to
pipe the real pair somewhere (that is the form for a CI secret).

The long way, one artifact at a time:

```sh
deno task compile
deno task ship dist/wallet --channel=prod   # --key defaults to ~/.aio/keys/<app>-release-key.json (what `ship keygen` wrote)
```

That writes the manifest twice next to the artifact: `<binary>.ship.json` (the
name a human recognises) and `<os>-<arch>.json` (the name the client literally
requests). Copy the artifact and the second file into
`<release-base>/<channel>/`.

`deno task ship github --channel=prod` writes a GitHub Actions workflow that
does all of it on three platforms and publishes to GitHub Pages.

## Keys

```ts
import { generateSigningKey, keyFingerprint } from "aio/ship";

const { privateKey, publicKey } = await generateSigningKey();
console.log(keyFingerprint(publicKey)); // e.g. "9f2c1a4b7de0"
```

| API                               | Returns                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `generateSigningKey()`            | `Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }>` |
| `keyFingerprint(jwk: JsonWebKey)` | `string` — 12 lowercase hex characters                       |

Ed25519, exported as JWKs. `deno task ship keygen` prints exactly the JSON
`generateSigningKey()` returns, which is also the shape `--key=` reads.

Keep the **private** JWK out of the repository — a key file with restrictive
permissions, a secret manager, or the CI secret `AIO_SIGNING_KEY`. The public
half needs no protection: it rides inside every manifest.

`keyFingerprint` is the short form a human is shown — in the boot report, in the
update prompt, in `am`. It is computed over the canonical `{ kty, crv, x }`
triple rather than the whole JWK, because the same key re-exported by a
different runtime differs in `key_ops`/`ext`/`alg`, and a fingerprint that
changed on a re-export would train people to ignore it. It is synchronous, so a
render path can call it.

### Losing the key bricks updates. Rotate before you have to.

The first release an install verifies **pins** its signing key (trust on first
use, with a loud one-time line). Every release after that must be signed by a
key the install already trusts, so a lost key means no future release can ever
be accepted — and the refusal is indistinguishable from an attack, which is the
correct behaviour and no comfort at all.

Rotation is an ordinary release, done in this order:

1. Publish release N **signed by the OLD key**, with the app configured
   `updates: { keys: [oldPublicJwk, newPublicJwk] }`.
2. Wait for installs to pick it up.
3. Sign release N+1 with the new key. Every install already trusts it.

The roster is not a recovery mechanism: it has to reach the install _before_ the
old key stops signing.

## Building a manifest

`shipApp` is the whole command as a function — read the binary, scan the
sources, probe the data contract, sign, write both file names, optionally
assemble the channel directory:

| Option                  | Default                                                 |
| ----------------------- | ------------------------------------------------------- |
| `binaryPath` (required) | —                                                       |
| `sourceDir`             | the app entry's directory (from `deno.json`)            |
| `name` / `version`      | `deno.json`; a missing `version` **throws**             |
| `keyPath`               | unsigned                                                |
| `out`                   | `<binaryPath>.ship.json`                                |
| `channel`               | `deno.json` `build.channel`, else `"prod"`              |
| `target`                | inferred from the artifact's extension                  |
| `url`                   | the artifact's file name (resolves beside the manifest) |
| `notes` / `minFrom`     | omitted                                                 |
| `dataPath` / `noData`   | probe the binary itself                                 |
| `channelDir`            | also write `<dir>/<channel>/<os>-<arch>.json`           |

It returns the `ShipManifest` it wrote. Two of its refusals are worth knowing,
because they catch a bad release at publish time rather than on a user's
machine:

- **no version** — neither `--version` nor a `version` in `deno.json`. It throws
  rather than defaulting, because a manifest that says 0.0.0 identifies nothing.
- **no `.ts`/`.tsx` sources under the scan directory** — a capability claim that
  was never measured is not signed. Point at the sources with `--src=DIR`.

`buildShipManifest` is the pure half, for a pipeline that already holds the
bytes:

```ts
import { buildShipManifest, generateSigningKey } from "aio/ship";

const sign = await generateSigningKey();
const manifest = await buildShipManifest({
  name: "wallet",
  version: "1.4.0",
  binary: await Deno.readFile("./dist/wallet"),
  sources: [{ content: await Deno.readTextFile("./src/app.ts") }],
  channel: "prod",
  target: "binary",
  notes: "Faster sync",
  sign,
});
console.log(manifest.sha256, manifest.runFlags);
```

`sources` is what the capability scanner reads to derive `capabilities` and the
least-privilege `runFlags`. Pass `updates: true` when the app configures
`updates` — it forces the `net` capability on, because a purely local app scans
to `net: false` and its least-privilege binary then cannot reach its own release
host: a failure that appears in production only, silently, at the moment a user
most needs the update.

`target` is one of `UPDATE_TARGETS`: `"binary"`, `"appimage"`,
`"electron-appimage"`, `"electron-zip"`, `"android"`, `"source"`. Validate a
string with `isUpdateTarget(v)` rather than casting — `--target=binry` used to
sail through as a `UpdateTarget` and produce a perfectly signed manifest that
every client refused with "target mismatch", days later, on someone else's
machine.

## What the signature covers — `manifestCore`

`manifestCore(manifest)` is the canonical string that gets signed. It is a
deterministic JSON serialization of the fields a human or a client **decides
on**:

format version · name · version · sha256 · size · channel · target · os · arch ·
url · minFrom · data contract (cell ids sorted) · notes · releasedAt

Everything a client is allowed to refuse on is inside it, and that is the point:

- signing only the digest would authenticate the bytes but none of the
  coordinates, so a genuine, correctly-signed **test** build copied onto the
  **prod** path would verify perfectly and install
- leaving the notes and the release date outside would let anyone who can write
  to the release path rewrite the sentence a human agrees to ("routine security
  fix") or backdate the release, and every client would still report the
  signature as valid

The data contract's cell ids are **sorted** before serialization, so two builds
that promise the same thing sign identically regardless of the order their cells
were registered.

Manifest formats 1 and 2 are refused rather than downgraded to: only
`manifestVersion: 3` binds all of the above.

## Verifying

Two functions, split by cost:

| API                                             | Checks                                   |
| ----------------------------------------------- | ---------------------------------------- |
| `verifyManifestClaims(manifest, expect?)`       | everything except the bytes              |
| `verifyShipManifest(binary, manifest, expect?)` | the claims, then the SHA-256 of `binary` |

Both return `Promise<{ ok: boolean; reason: string }>` — never a throw, and
`reason` is filled on success too
(`"signature verified against the pinned
key"`, `"sha256 + …"`). The split
exists because a client checks the claims the moment it fetches a manifest, long
before it has spent a download finding out whether the release is even meant for
it.

```ts
import { verifyShipManifest } from "aio/ship";
import type { ShipManifest } from "aio/ship";

const manifest = JSON.parse(
  await Deno.readTextFile("./dist/linux-x86_64.json"),
) as ShipManifest;
const trusted = JSON.parse(
  await Deno.readTextFile("./trusted-key.json"),
) as JsonWebKey;

const v = await verifyShipManifest(
  await Deno.readFile("./dist/wallet"),
  manifest,
  {
    name: "wallet",
    channel: "prod",
    target: "binary",
    platform: { os: "linux", arch: "x86_64" },
    key: trusted,
  },
);
if (!v.ok) throw new Error(`refusing this release: ${v.reason}`);
```

`ShipExpectations` — every field optional, every one of them checked against a
value that is inside the signature:

| Field           | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `name`          | the app this install IS; a manifest naming another app is refused first |
| `channel`       | the channel the client asked for                                        |
| `target`        | the install strategy the client can actually perform                    |
| `platform`      | `{ os, arch }` the client runs on                                       |
| `key`           | the trusted public JWK (pinned, or trusted on first use)                |
| `keys`          | additional trusted JWKs — the rotation roster                           |
| `allowUnsigned` | accept an unsigned manifest (a private LAN build)                       |

The order of refusals is deliberate. Identity and coordinates are checked before
the signature, because "this is a release for another app" and "a build was
published to the wrong path" are sentences the publisher can act on, where
"untrusted key" sends them looking for an attacker who is not there.

Three rules that are not obvious from the field list:

- **`key`/`keys` are what makes a signature mean anything.** With no trusted key
  the signature is verified against the key the manifest carries — which proves
  only that the manifest is internally consistent, something any forger can
  arrange. That path returns `ok: true` with the reason
  `"signature verified
  (key trusted on first use)"`; pin the key from then on.
- **An unsigned manifest is refused whenever a key is pinned**, `allowUnsigned`
  or not. Stripping a signature is the first thing an attacker tries, so it can
  never be a downgrade path.
- **`allowUnsigned` never goes quiet.** It succeeds with the reason
  `"claims accepted (UNSIGNED — not authenticated)"`.

### Identity fields are validated first — `SAFE_TOKEN`

`name`, `version` and `channel` do not stay inside the manifest: they become
filesystem path segments (a staging directory, an `.old-<version>` sibling, a
versioned install layout), part of a shell string on the electron-zip swap, and
a positional argument to `git ls-remote`. A manifest is attacker-influenced
input, so `verifyManifestClaims` applies one charset to all three before
anything else reads them:

```
SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
```

Leading alphanumeric, then alphanumerics and `.` `_` `+` `-`, at most 64
characters. No slash, no `..`, no whitespace, no shell metacharacter, no leading
`-` (which is how a positional becomes a flag).

`safeTokenReason(field, value)` is that rule as a function: `null` when the
value is fine, otherwise the sentence explaining why not — with the offending
value echoed back, truncated to 48 characters and JSON-escaped. Use it to reject
a bad `--channel` before you build anything, rather than discovering it
downstream:

```ts
import { safeTokenReason } from "aio/ship";

const channel = Deno.args[0] ?? "prod";
const bad = safeTokenReason("channel", channel);
if (bad) {
  console.error(bad);
  Deno.exit(1);
}
```

This is THE decider — nothing downstream re-validates, so a second copy of the
rule somewhere else is how the two spellings drift apart.

## Publishing helpers

| API                                  | Returns                                          |
| ------------------------------------ | ------------------------------------------------ |
| `manifestFileName({ os, arch })`     | `"<os>-<arch>.json"` — the name a client FETCHES |
| `githubWorkflow({ name, channel? })` | a GitHub Actions release workflow, as a string   |
| `sha256Hex(bytes)`                   | `Promise<string>` — lowercase hex SHA-256        |

`manifestFileName` is not a convention, it is the request: a client asks for
`<base>/<channel>/<os>-<arch>.json`. Publishing only `<binary>.ship.json`
produces a channel directory with no file at the name the client asks for, and
the symptom is a permanent, silent "no updates available" — which is why the
tool writes the fetched name itself instead of leaving it to a copy step in a
doc.

`githubWorkflow` is **emitted, not integrated**. Talking to a forge's API from
the framework would buy a dependency on somebody else's moving target for
something a workflow file does natively, and the layout — not the transport — is
the part aio owns. The result is a normal file in your repo; edit it freely.

`sha256Hex` is the digest function the manifest's `sha256` field is built with,
exported so a verifier outside the framework computes it the same way.

## Related

- [Keeping an app up to date](updates.md) — channels, sources, the banner,
  `canApply`, and the client-side security summary
- [Build targets](../build/targets.md) — what `deno task build` produces for
  each target
