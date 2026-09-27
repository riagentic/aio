# Draft release notes — the round after 1.0.12-beta (not yet versioned)

> Draft for the releasing agent: fold into `CHANGELOG.md` under the next
> version's dated heading, and turn "What an app may notice" into
> `docs/upgrade/from-1.0.12-beta-to-<next>.md` (listed where upgrade guides are
> listed). Nothing here is shipped; no version string was bumped.

**Additive for the public surface** — `check:api` is unchanged. Every fix has a
test that fails without it; five class-level differential/property gates were
added so the classes these bugs came from stay closed.

## What an app may notice

- **`useAio().state` reading a `visible`-hidden field now THROWS**, naming the
  cell and field — as `cell.field` always has ("a read throws, dev and prod
  alike"). It used to hand the secret out on the standalone/Android runtime and
  under `testUI`, and returned `undefined` in the browser. Spreads,
  `Object.keys` and `JSON.stringify` of the state never trip it (hidden keys are
  absent). `scope: "client"` cells are not in `useAio().state`.
- **A `scope: "client"` cell's failing method REJECTS its promise** instead of
  throwing synchronously (AIO6: every bound method returns a Promise). Code that
  wrapped the call in a bare `try { c.m() } catch` must `await` it.
- **`auth: { signup: false }` now also refuses unknown OIDC/SSO identities**
  (403 `signup_disabled`, logged with the exact id). Admit one with
  `am auth create "oidc:<issuer>:<sub>" [--role=…]`, or keep SSO account
  creation open with the new `auth.oidc.signup: true`; boot warns once while
  `oidc.signup` is unset. `requireVerified: true` is now enforced on SSO login
  too; an SSO account is marked verified when the provider sends
  `email_verified: true` — one that never does (Entra ID) is refused 403
  `email_unverified` until `am auth verify "<id>"` (the refusal is logged with
  that exact command).
- **Zero-config app identity (appId) is one rule for dev, build and `am`**: for
  a project's DECLARED entry (`deno.json` `entry`, else `src/app.ts`, or a
  `build.targets` entry — what `aio build` compiles) dev now uses the build's
  rule: the project's `deno.json` `appId` → `title` → `name`, else the project
  folder's name — found by walking up from the entry, not from the launch
  directory. A pinned `appId` is honoured when launched from `src/`, and an
  entry at `server/main.ts` is `~/.<project>` in dev as it is once built. Any
  other entry (monorepo `apps/a/main.ts` under a shared root `deno.json`, a
  script below an unrelated `~/deno.json`) keeps the previous rule (the launch
  directory's `deno.json`, now only for an entry inside that directory, else the
  entry's folder), so apps never merge into one data directory;
  `deno run ../appB/src/app.ts` from appA no longer takes appA's id and opens
  its `state.db`. An app whose id CHANGES under the new rule (`~/.server`, or a
  folder with a space: `my%20app` → `my-20app`) keeps booting under its OLD id
  while its data sits there and the new home is empty, with a warning every boot
  naming both paths and both fixes (pin `"appId": "<old>"`, or move the
  directory). Nothing is moved or refused.
- **`--log-budget` under one byte (`0.5`) is refused**; `0` alone still means
  unlimited.
- **`--isolate=` on the command line overrides `aio.run({ isolate })`**, as
  every other flag overrides config.
- **`aiol` reaches further**: server-only imports are found across multi-line
  import statements and at any depth of the browser graph (including `../` hops
  and from cell files), and `jsr:@std/…` is reported as server-only. Apps may
  see new, correct errors. `export type … from` is no longer flagged.
- **A suppression marker (`// aio-ok`) no longer covers the next list sibling**
  — only real openers (`=`, `(`, `[`) continue a statement.
- **Cron patterns are digits only**: `"5,"`, `"9,,17"`, `"0x10"`, `"1e1"`,
  `"1-5-9"`, `"1-5/"` are refused where they are written instead of running at
  the wrong time.
- **`am snapshot save` writes the file owner-only (0600)**, also over an
  existing file — a snapshot is raw state.
- **`am expect eq/ne/contains` compare structurally** (key order no longer
  decides); `contains` on a string searches the text as typed; `am state` paths
  read own properties only and an empty brace pick is a miss.
- **A worker cell runs each call under the action's own user**: `serverUser()`
  inside a `worker: true` cell now matches in-isolate dispatch (a WS caller's
  full user, incl. `resolveUser` extras). An uncloneable user object fails the
  call loudly, naming `_user`.
- **`useOptimistic` does not clear on a failed call** — documented (it never
  did); the docs show the passthrough-counter workaround.

- **The test harnesses reject a refused write** (`testCell`, `bootCells`,
  `testUI` run with `refusalsReject: true`), as the harness docs always
  promised. The standalone/Android runtime now honours an app's own
  `refusalsReject`. Two kinds of existing app test go red:
  - a `testCell`/`bootCells` test that awaits a validate-refused call and then
    asserts the state is unchanged now gets the rejection first — wrap the call
    in `assertRejects` (or `.catch`) before the state assertion;
  - a `testUI` click whose handler hits a refusal and does not catch it now
    fails at the next drain (`settle`/`waitFor`/`expectCell`) — catch it in the
    handler (in the browser it is an unhandled rejection).
- **A call to a disabled cell's SYNC method** is refused like a validate refusal
  (rejects under `refusalsReject`, warns in dev).
- **A mistyped `concurrency` mode** (`"Newest"`, `"latest"`) is refused at
  `cell()`.
- **Static text is served with `charset=utf-8`**; a 416 carries a `text/plain`
  error body, not the file's type.
- **`amui`** restarts a `--home` instance as itself and shows a dispatch's
  short-argument / unsaved warnings.
- **Self-update key trust**: a configured `updates.keys` roster is now the whole
  trust list — a key pinned on first use no longer survives being dropped from
  it (the last step of a rotation), and no key is pinned while a roster is set.
  Key pinning over plain `http:` is allowed only for a literal loopback address
  (`127.x.x.x`, `::1`, `localhost`), not a host name that merely starts with
  `127.`.
- **`ui.theme: "auto"` in dev** notices a `style.css` created or deleted while
  dev runs (next reload). The standalone shell steps aside only for the app's
  own `style.css`, not a font `<link>` from `ui.head`.
- **Generated icons follow the app's identity everywhere**: the Windows `.ico`
  colour is now hashed from the appId (was the title), and the iOS icon's letter
  comes from the title (was the appId) — as every other target. An app with no
  own `icon.png` may see a different colour/letter on those two.
- **UI surface names** (`testUI` / `am surface`): a blank `aria-label`,
  `placeholder` or `name` no longer hides the element's text (it was a bare
  `Button`), and a label with combining marks (Thai/Devanagari vowel signs)
  keeps them (`ปิด` was `ปด`). A test that addressed such an element by its old
  name must use the new one.
- **`<Link to="?x">` / `<Link to="#y">` are active on every page**: `to` is now
  resolved like `navigate` resolves it, so a query- or hash-only link points at
  the current page. Style such links without the active class if that matters.
- **Live queries (`reactiveDB`) refresh on what SQLite does itself**: trigger
  writes (TEMP triggers too), FK cascades and views are followed; `DROP`/`ALTER`
  through the wrapper refresh every live query.
- **`<Link to="#x">`** (a fragment on the current page) is left to the browser:
  it scrolls and fires `hashchange`. **An absolute `to`** (`https://…`,
  `//host/…`) is never active — the server cannot know the origin.
- **The `prefers-contrast: more` token overrides** now apply in `"tokens"` mode
  (the default) too.
- **A `tx` used after its `db.transaction()` callback settled is refused** (it
  ran outside, or inside another, transaction), and so is one whose writer was
  replaced mid-transaction (it ran the rest in autocommit). A request stranded
  by a worker crash is rejected saying its outcome is UNKNOWN — check before
  retrying a write.
- **Blobs are served as stored** (`Cache-Control: …, no-transform`): no gzip on
  a text blob.
- **An unreadable server protocol hello is fatal on the client** (browser and
  `connectCli`), as a version mismatch is.
- **Auth abuse budgets treat an IPv6 /64 as one client** (signup cap, failed
  auth, password-hash work, WS denylist, pairing-PIN attempts). IPv4 and `::1`
  unchanged; a trusted proxy hop's port, brackets and RFC 7239 `for=` wrapping
  no longer make a fresh bucket per connection.
- **`RouteParams`**: `*` inside a segment (`/a*b`) no longer types a `"*"` param
  (types only).

## Fixed (grouped)

**Security / exposure** — sync session-prefix spoof via a dashed clientId;
`__proto__` key turned into a prototype in the lww-per-key merge; client read
seam missed dotted excludes whose head is not the key; include-mode deltas sent
fields the frame never contains; two views sharing a snapshot cache key; SSR
emitted unvalidated tag names (script injection); `useAio().state` leaked hidden
fields (standalone/testUI); logout left the cookie's session alive when a Bearer
token was also sent; OIDC `signup:false` / `requireVerified` bypass; OIDC
subjects differing by case locked out; `.app` bundle path and its recursive
remove escaped the out dir via the title; out-dir guard was case-sensitive
(`--out=Src` wiped `src/` on macOS/Windows); snapshot files world-readable.

**Durability** — UNIQUE-value swap between rows never persisted; a held cell got
the new version stamp (onMigrate skipped); rebuilding an empty table dropped app
indexes/triggers; crash replay ≠ clean restart for deleted declared keys,
undeclared keys and undeclared cells; time-travel `pause`/`resume` rewound live
state; stored keys named like `Object.prototype` members lost in migration;
`scope:"client"` cells persisted on standalone; a live query applied an older
refresh over a newer one.

**Sync** — engine never caught up on page load (boot-before-open); wrong-shape
offline-queue document crashed the cell; server state frames overwrote the
optimistic view; a late ack for an evicted op diverged permanently; a cursor the
server issued judged foreign.

**Runtime & renderer** — `watch()` re-fired on unrelated signals; a listener
removed mid-notify still ran; client cells unfrozen; dispatch loop guard
off-by-one; async `onInit`/`onDestroy` rejections unreported on enable/disable/
shutdown; blocking-worker crash killed the process; standalone `close()` kept
own resources and schedules alive; worker `serverUser()` wrong; worker reseed
race; error reporters threw on unprintable values (crash handler lost the
crash); `useMemo`/`useCallback` compared with `===`; hydrate: text-component
position, error-boundary recovery, late thrower beside a server fallback,
`style=""` parity; `<Link>` relative active state; route matching treated `%2f`
and `%2F` as different paths.

**Self-update** — `127.attacker.example` counted as loopback for key pinning; a
failed swap (disk full) left the pending marker, so a later "rollback" moved the
partial copy over the good binary; a rollback kept the failed build's digest; a
key dropped from the roster stayed trusted via the first-use pin.

**Data** — live queries stale after cascades, trigger writes and writes under a
view; a write landing during a live query's first fill lost; >150k-row live
queries threw; a trigger with `CASE` in `WHEN` refused. The headless-build page
printed the title unescaped.

**Round 12** — one crashed db worker stranded the other workers' requests (and
the writer lock) for 120 s; a gzipped blob shared its strong ETag with the raw
Range reply; a delta before the first state after a reconnect was dropped
without asking for a resync.

**Round 13** — a refused call's re-send cap reset on every socket close (browser
and CLI clients); abuse budgets keyed IPv6 clients per address, so a /64 got
unlimited signups and password-hash work.

**Tooling** — `aiol`: multi-line imports, chain hops, type re-exports,
`--safe-fix` rename offsets and import-list rewriters that broke code, marker
scope; `am`: UDS request hang, `sql` byte cap, state paths, `expect`
comparisons, `record` for hyphenated cells; build: plist `$` patterns,
unorderable ship versions, icon colour/letter on exe and iOS, `.desktop`
escaping; http: compressed-body cache keyed by ETag; `testUI`: `.finally` double
report, `waitFor` never asking at `timeoutMs: 0`, names dropping combining
marks, blank `aria-label`; UI kit avatar initials.

## New class-level gates

- `tests/visible-exclude-seams-property.test.ts` — now generates exclude paths
  whose head is not the state key.
- `tests/journal-crash-equals-clean-differential.test.ts` — SIGKILL restart ==
  clean restart over random write programs (`AIO_CRASH_DIFF_N`).
- `tests/air-ssr-hydrate-mount-differential.test.ts` — SSR string == stream,
  mount == SSR+hydrate, through updates (`AIO_AIR_DIFF_N`).
- `tests/standalone-server-parity-differential.test.ts` — the same cell program
  on standalone and server runtimes (`AIO_PARITY_N`).
- `tests/reporters-never-throw-property.test.ts` — every error reporter over
  hostile values.

## Environment notes for verification

`deno.land` imports were moved to the jsr `@std` import map (`@std/fs` added).
Tests that need git tags (`v1.0.9-beta`, older), Electron, a display, an Android
SDK, non-root file permissions, or a resolvable `immer` for temp projects could
not pass in the session that produced this; each was compared against the
untouched v1.0.12-beta checkout and fails identically there.

## Known gaps left open (found, not fixed)

- HEAD for a buffered text asset carries no ETag while the GET does (the tag is
  a hash of the body a HEAD never builds). HEAD with `Range` answers 206 (an
  existing test pins it; RFC 9110 defines Range for GET only).
- Electron IPC handlers do not check `event.senderFrame`; no `will-redirect`
  guard (unproven without Electron).
- `downloadArtifact` follows redirects by design (CDNs); the signed digest and
  size guard integrity.
- By design, documented: deleting a deduplicated blob removes it for every
  holder (content-addressed, no reference count); `route()` / `blobs.put()`
  bodies have no framework size limit (app code sets one).
- Unconfirmed (auth): a password reset racing an account removal answers 200;
  `totp/disable` answers 401 instead of 429 once the fail budget is spent; with
  `requireVerified`, an expired verification token has no self-service re-send
  (login is refused, `verify/request` needs a session).
