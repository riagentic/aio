# Upgrading from 1.0.7-beta to 1.0.8-beta

**The public surface is unchanged** — `check:api` reports no additions, no
removals and no changed signatures.

```sh
am pin --latest
```

**No app needs a code change.** Nothing here refuses to boot that booted before,
and nothing you call moved. This release is the verify round that attacked
1.0.7-beta's own fixes: three were half-done, one shipped comment turned out to
be factually false, and the largest finding came from asking every TLS verifier
the same question from its own operating system instead of reading what the
documentation says they do.

Two things are worth five minutes of your attention:
[the local root on disk](#your-local-root-is-older-than-this-release-replace-it),
and
[`persist: "none"` on a standalone or Android
build](#an-android-or-standalone-app-now-forgets-what-you-told-it-to-forget).

## Your local root is older than this release: replace it

`am trust` installs a local root so `https://localhost` is a real lock and not a
warning. That root is fenced two ways: it is name-constrained to names the
machine already owns (`localhost`, the `.localhost` suffix, `127.0.0.0/8`, `::1`
and the CGNAT range), and its `extendedKeyUsage` limits it to server and client
authentication. The intent has always been that a stolen root key can mint a
certificate for your own machine and nothing else.

**Measured on macOS 14.8.9, against a control, that was not true.** macOS
Security.framework ignores a trust anchor's `extendedKeyUsage` completely: a
certificate for `ceo@bigbank.com`, signed by the aio root, was accepted for
S/MIME exactly as a control root carrying no EKU at all. RFC 5280 §6.1 starts
path validation _after_ the trust anchor, so a verifier that skips the anchor's
own extensions is within its rights.

The fix is a second lock, on a mechanism macOS does read: the root now
constrains `rfc822Name` and `uniformResourceIdentifier` as well, both to
`.invalid` — a TLD RFC 2606 reserves to never resolve. A name type that is
absent from `permittedSubtrees` is **unrestricted**, so listing only DNS and IP
had left email addresses and URIs wide open.

**A root already on your disk is not upgraded.** `loadOrCreateAioRoot` reuses an
existing root verbatim, forever — which is correct, because your browsers
already trust it and swapping it silently is not a decision a boot should make.
So boot now READS the root and warns once when it is the older shape:

```
[aio] tls: ⚠ the aio root at ~/.aio/tls/aio-root.crt predates this version and
  does not constrain email addresses (rfc822Name) or URIs. Anything holding its
  private key could mint a certificate for any email address, and macOS would
  accept it. To replace it: delete that file and its key, then re-run
  `am trust`.
```

**What to do:** when you see that line, do what it says.

```sh
rm ~/.aio/tls/aio-root.crt ~/.aio/tls/aio-root.key   # your path is in the warning
am trust                                             # generates and installs the new one
```

You will be asked for your password, as the first `am trust` did. Everything
else is unaffected: server certificates are minted fresh from the root each run,
so there is nothing else to regenerate.

**If you never ran `am trust`,** there is nothing on your disk and nothing to
do; the next root you create is already the new shape.

### Why there is no intermediate CA

The textbook answer to "the anchor's own EKU is not always read" is to sign
everything with a constrained intermediate, whose extensions every verifier does
read. It was measured rather than assumed, each stack asked from its own OS,
each against a control:

| verifier                           | name constraints | anchor EKU  |
| ---------------------------------- | ---------------- | ----------- |
| openssl, rustls, NSS (Firefox), Go | enforced         | enforced    |
| Windows CryptoAPI (11 26200)       | enforced         | enforced    |
| macOS Security.framework 14.8.9    | enforced         | **ignored** |
| Java `CertPathValidator`           | ignored          | ignored     |

An intermediate closes exactly one row — Java — and costs a new root plus
`am trust` again on every machine, because the roots already deployed are
`pathlen:0` and cannot sign one. Two locks that everything reads beat a third
that is not read. Android/Conscrypt is the one stack still unmeasured, and says
so in `todo.md` rather than being guessed at.

## An Android or standalone app now forgets what you told it to forget

A standalone or Android build ran its own persistence path, and that path
ignored the cell's `persist` setting:

| what you wrote                    | what `deno task dev` did | what the APK did                       |
| --------------------------------- | ------------------------ | -------------------------------------- |
| `persist: "none"`                 | kept nothing             | wrote it to disk AND restored it       |
| `persist: { exclude: ["draft"] }` | wrote everything but it  | wrote `draft` too                      |
| `persist: { onPersist }`          | wrote what you returned  | wrote the raw state, ignoring the hook |

So the same app kept different data depending on how it was run. Since
1.0.7-beta, which made the Android store durable, that ignored slice was also
`fsync`'d on **every dispatch** — so a cell you had marked as not worth keeping
was the one being written to flash on every keystroke.

Both runtimes share one decider now (`src/state/cell-persist-filter.ts`).

**What to do:** nothing in code. But if you marked a cell `persist: "none"`
because it holds something you did not want on the device — a session token, a
decrypted value, a scratch buffer — **it is on the device now**, written by
earlier builds. It will be dropped the first time the new build saves, and on an
app you consider sensitive you may want to clear the app's storage once rather
than wait for that.

The opposite mistake is also gone: a **failed read** of the native store used to
look exactly like a fresh install, so the runtime overwrote intact durable state
with whatever `localStorage` held and logged the overwrite as a successful
adoption. It asks whether the key exists now, and a read that fails is loud and
changes nothing.

## SSR: `collectHead()` answers for YOUR render

1.0.7-beta gave two concurrent renders their own scopes. What was still wrong
was the part that hands the head back:

- **It answered for the most recently STARTED render.** You always ask after
  your own render has finished, so a render that merely began after yours ended
  took your answer — one visitor's `<title>`, description and canonical URL
  inside another visitor's page. It tracks the most recently **finished** render
  now.
- **One abandoned stream poisoned every later call.** A dropped connection left
  an unfinished render on the stack and `collectHead()` threw for the rest of
  the process, so a single closed tab 500'd every page after it.
- **An unknown key answered `""` in silence** — a page with no title, which
  reads exactly like a page that never set one. It warns in dev and names the
  key.

**What to do:** nothing. Passing a key is still the recommendation if you serve
concurrent streams, and it is unchanged:

```ts
const html = renderToStream(<App />, req);
const head = collectHead(req);
```

## An emoji in an attribute name no longer crashes the render

1.0.7-beta made the server refuse an illegal attribute name, which was right — a
name built from untrusted input becomes raw HTML where escaping the value does
nothing. The pattern was missing the astral plane, so it also refused **legal**
names that `setAttribute` accepts without complaint:

```tsx
<div data-🎉="party" />; // threw in production
```

Only names a browser would genuinely refuse are refused now.

## `onUnmount` called conditionally no longer leaks

`onUnmount` (new in 1.0.7-beta) wrote into the **next** hook's slot when it was
called from inside an `if`, so the cleanup it registered was silently mis-filed
and never ran — the exact failure the hook exists to prevent. It claims its own
slot now, and a conditional call is caught rather than quietly dropped.

**What to do:** nothing. If you moved an `onUnmount` to the top of a component
to work around a cleanup that did not run, you can put it back where it belongs.

## Every page is 13 KB smaller

A production page carried 32,878 bytes raw / 12 KB gzipped of code it could
never run: the `am surface` / `am trigger` engine, the dev error overlay, the
read-only-state hint, and the colour-contrast and `#id`-selector audits. They
all sit behind `isDevMode()`, a runtime read of a flag that only the dev
server's own HTML ever sets — so no bundler could prove the branch dead, and a
production page, an Electron package and a standalone APK had no way to switch
them on.

They moved behind a dynamic import that is real wherever dev is real and 404s in
production. **A whole client — renderer, protocol, offline queue, CRDT merge —
is now 77 KB gzipped, from 90;** the counter app is 80, from 92.

**What to do:** nothing, and every dev tool behaves exactly as it did. If a dev
session ever fails to load the chunk it says so once and names every check that
is therefore not running, rather than leaving you to believe an audit ran.

## Electron refusals now reach you

Two gates were refusing correctly and saying nothing. Both cost a field reporter
a full day, from opposite ends of the same feature.

**A `<webview>` guest preload that is refused now says so.** The rule is
unchanged — a guest preload must resolve (realpath) inside the app directory —
but a refused preload never failed the attach, so the guest loaded, rendered
perfectly, and simply had no bridge:

```
[aio:electron] <webview> preload REFUSED: /elsewhere/bridge.js — a guest preload
  must resolve (realpath) inside the app directory /app — ENOENT: no such file
  or directory. The guest will load with NO preload and NO bridge: it will not
  crash, and nothing else will be logged about it.
```

**What to do:** nothing, unless you see that line. If you do, the path you
passed and the directory in the message are the two halves of the answer — and
the directory is resolved from your app's base dir, not from your server's
`Deno.cwd()`, which is the mismatch that makes this hard to guess.

**`openWindow` now ANSWERS.** It used to be one-way: the main process wrote a
refusal naming the exact config key to add, and the renderer that asked got
`undefined` back.

```ts
// This used to throw a TypeError on `undefined.catch` and take the fallback:
await openWindow(url, opts).catch(() => openInSystemBrowser(url));
```

`openWindow` now returns a promise. It **resolves** with `{ ok: true, url }`, or
**rejects** with the refusal text — the same sentence the main process logs,
including the key to add:

```
openWindow refused — sandbox: false — this app has not opted in. The APP decides
the Chromium sandbox of a window it opens, not the page: add
aio.run({ electron: { unsandboxedChildWindows: true } }) if this page really
must run unsandboxed.
```

**What to do:** nothing — this is additive. A fire-and-forget `openWindow(url)`
behaves as before. If you already had a `.catch` fallback, it now runs for the
right reason and can tell your user why.

## A UI test that passed while proving nothing

`onGlobalKey` deliberately ignores a shortcut while focus is in an `<input>`
(`ignoreInInput`). So this was green, with the handler running **zero times**:

```tsx
await ui.AmountField.press("Enter"); // the shortcut does NOT run — by design
```

The window binding now has its own address in `testUI`, matching the one
`am trigger window press` already had:

```tsx
await ui.window.press("Enter"); // …and keyDown / keyUp, same modifiers
```

and the silent case says so in dev:

```
[aio-dev] press("Enter") on an <input> — window key handlers skip inputs by
  design (ignoreInInput), so nothing ran. Press on a non-input, or address the
  window (testUI: `ui.window.press("Enter")`; am: `am trigger window press Enter`).
```

**What to do:** if a keyboard-shortcut test of yours presses into a field, it
was proving nothing — the warning will point at it. Switch it to
`ui.window.press(...)`. The warning fires only when a binding was really skipped
and none ran, so a press a handler heard stays silent.

## Two testUI messages that pointed the wrong way

- **The same explicit `t=` in two different components** now warns at surface
  time, naming both components, instead of surfacing later as an ambiguity
  throw. Generated names stay per-component, and one component rendered many
  times is still silent.
- **An element action on a component** used to say _"no element or component
  named "click""_ — true, and it reads as "your handle is wrong" when the handle
  was right and its KIND was wrong. It now says so and suggests the child you
  probably meant:

  > `ui.SendSol is a COMPONENT (MemoField), not an element — components have no`
  > `.click(). Did you mean ui.SendSolMemo (its input)? Or a sibling element`
  > `such as ui.SendSolBtn (a button)?`

A genuinely mistyped child name still gets the original listing.

## `memory.maxHeap` now applies when you run the app

This one is a **behaviour change worth knowing about**, not just a message.

`memory.maxHeap` in `deno.json` applied to `deno compile` only. At runtime the
ceiling was always the automatic 25%-of-RAM share, so the key could neither
raise it nor quiet the "approaching the heap ceiling" warning — and moving
`memory` to the top level of `deno.json` earned a second warning whose advice,
if you followed it, threw.

```jsonc
{ "memory": { "maxHeap": "12gb" } }
```

- **`am start` now launches with that ceiling** (floored at 4 GB), the same one
  `deno compile` already baked in. If you declared a large `maxHeap` and relied
  on the process NOT getting it, it gets it now.
- The heap warning measures against your declared number when there is one, and
  when the process did not get it, it says so and names how to.
- A `memory.maxHeap` where it belongs is no longer scolded as misplaced.
- An app that declares nothing sees the warning unchanged, to the byte.

## Retire

Workarounds this release lets an app delete:

- **A `stat` or existence check before every `openWindow`**, or a bare
  `.catch()` fallback written blind because the refusal never arrived. The
  reason comes back with the rejection now (1.0.8-beta).
- **A hand-copied preload path check** mirroring aio's app-directory rule
  because a refusal gave you nothing to compare against (1.0.8-beta).
- **A keyboard-shortcut test that presses a non-obvious element** to dodge
  `ignoreInInput`, or a comment explaining why the obvious one is green but
  meaningless. Use `ui.window.press(...)` (1.0.8-beta).
- **A hand-maintained note about which `t=` handles are taken across
  components**, kept because a collision only showed up as a throw much later
  (1.0.8-beta).
- **A `--v8-flags=--max-old-space-size=…` wrapper script** around `am start`,
  written because `memory.maxHeap` did nothing at runtime (1.0.8-beta).
- **A `memory` block moved to the top level of `deno.json`** on the advice of
  the old misplaced-key warning — move it back under `aio.run` / leave it in
  `deno.json` where the key belongs; the wrong advice is gone (1.0.8-beta).
- **Clearing a `persist: "none"` cell by hand on Android or in a standalone
  build** — an `onInit` that wiped it, or a boot flag that skipped restoring it,
  written because the APK persisted and restored it anyway. The setting is
  honoured by both runtimes now (1.0.8-beta).
- **A shadow copy of your persist filter inside `onPersist`**, or an `exclude`
  list re-applied by hand in the standalone build because the real one was
  dropped there (1.0.8-beta).
- **A `try`/`catch` around `collectHead()`** added so one dropped connection
  could not 500 every later response. One abandoned stream no longer poisons the
  call (1.0.8-beta).
- **Re-rendering, or caching your own `<title>`, to work around a head that
  belonged to another response.** `collectHead()` answers for the render that
  finished, so the unkeyed call is correct for the synchronous pattern again
  (1.0.8-beta).
- **Sanitising attribute names before a spread purely to strip emoji and other
  astral characters.** Validate untrusted keys as before; the legal ones are
  legal again (1.0.8-beta).
- **An `onUnmount` hoisted out of an `if`,** or a hand-kept flag beside it,
  written because a conditional call registered a cleanup that never ran
  (1.0.8-beta).
- **A hand-rolled build step that stripped aio's dev modules** — a `define`, an
  esbuild plugin, or an alias to an empty file — to get the dev overlay and the
  surface engine out of a production bundle. They are not in it (1.0.8-beta).

Nothing else — no API was removed, so no call site has to move.
