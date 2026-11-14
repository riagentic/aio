# Support & maintenance

aio 1.0 is the last line of the TypeScript/Deno framework. Its successor,
**aio-rs**, is a rewrite in Rust that is developed in a separate repository.
This repository moves to maintenance: aio stays in use for the work it suits,
and an app built on it keeps building and running. New features go to aio-rs
instead.

This page says what maintenance covers, what it does not, and how the platforms
under aio are kept current. The compatibility contract itself is
[the versioning policy](semver-policy.md).

## What a 1.0.x release contains

A maintenance release bumps PATCH (`1.0.28` → `1.0.29`) and carries only:

- **Fixes for wrong behaviour**: lost or corrupted data, a crash, a security
  defect, a failure that was silent. As before, a fix may turn a silent wrong
  answer into a loud refusal. It never turns a working app into a broken one.
- **Platform upkeep** that an app needs in order to keep shipping. That means a
  newer Electron patch, an Android target level Google Play requires, and a Deno
  release that changed underneath aio (see [Upkeep](#upkeep)).
- **Error messages and docs** that name a cause or a fix more precisely.

It does not contain new options, new exports, new targets, or a changed default.
The surface stays frozen exactly as through the betas: `deno task check:api`
refuses any change that is not additive, and a maintenance release adds nothing.

## What will not happen

- **No aio 2.0 in this repository.** A fix that would need a breaking change is
  recorded as design input for aio-rs. It is not queued for an aio major.
- **No default flips.** The safer behaviours that shipped as opt-ins stay
  opt-ins:
  - `effect(fn, { rerunOnSelfWrite: true })`
  - `pairing: { pake: true }`
  - `TestUIOptions.wire.strict`
  - deno.json `"neutral": "soft"`
  - `build.android.strict`

  A new scaffold may write them. An existing app never has them switched on for
  it.
- **`@experimental` stays experimental.** The Peer API (`peer`, `Peer*`,
  `emitChunk`, `ResolvePeerFn`) is not promoted to the stable promise. It is
  changed only to fix a defect, and that change is listed in the changelog. An
  app that depends on it should pin its aio version.

## What is proven, and where

`deno task check:proof` prints which targets have been run, when, and at which
commit. The rows with no gate are checked by hand or not at all, so the final
release does not claim them:

- the packaged app started by a double-click on a real Windows or macOS desktop
- the Windows exe's security doors
- an off-box remote client

The README's "Honestly" section keeps the human summary.

## Upkeep

What moves under aio while aio stands still. Each item has its check, its place
in the code, and what a bump costs.

### Deno

- The floor is `MIN_DENO` in `src/server/deno-version.ts`.
- CI runs weekly on the newest Deno 2.x (`.github/workflows/ci.yml`,
  `schedule`), as well as on every push.
- A red scheduled run with nothing pushed means a Deno release changed
  something. Fix it in a patch release. If the fix needs time, say in the README
  which Deno version is the newest one tested.

### Electron

- The version is `DEFAULT_ELECTRON_VERSION` in
  `src/electron/electron-runtime-fetch.ts`. Every pin of `npm:electron@…`
  follows it: `amui/deno.json` and its lock, and the Electron examples'
  `deno.json`.
- Electron releases a major about every eight weeks and patches only the newest
  three. A shipped app keeps getting Chromium security fixes only if aio moves.
- `deno task check:release` asks the registry and prints an advisory when
  upstream has moved.
- A **patch** bump inside the same major is routine. Run `test:electron` and
  `test:build`.
- A **major** bump is a tested change of its own: `test:electron`, `test:build`
  and the Windows and macOS suites, then the proof rows.
- Deno's minimum dependency age refuses a version published in the last 24
  hours, so pin one that is a day old.

### Android

- The template is `src/build/android-template.ts`, and it is currently:
  - `compileSdk`/`targetSdk` 36
  - `minSdk` 29
  - Android Gradle Plugin 8.13.2 on Gradle 8.14.3, the wrapper pinned in
    `src/build/build-android.ts`
- Google Play raises the target level it accepts for new apps and updates every
  year, on August 31: API 36 since 2026. An app below the floor cannot publish
  an update.
- Raise `targetSdk` before each deadline. Read that Android version's behaviour
  changes for apps targeting it. API 36 stopped calling `onBackPressed`, which
  is why the template takes Back through an `OnBackPressedCallback`.
- Then run `deno task test:android` on an emulator and on a device, and record
  both proof rows.

### npm packages

`immer`, `happy-dom`, `esbuild`, `react` and `react-dom` (the compat layer's
tests) are pinned to exact versions in `deno.json`. Bump one only to fix a
defect, as its own change, with the full suite.
