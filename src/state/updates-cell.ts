// updates-cell.ts — the built-in `updates` cell.
//
// Detecting an update is in-process; applying one is not. This cell is the
// in-process half: it holds what the app knows about newer versions and offers
// the five verbs a UI needs. The work behind those verbs — network, signature
// verification, swapping files, restarting — is injected by the server at boot
// (`installUpdatesRuntime`), so this module stays in the isomorphic core and
// carries no import of anything platform-shaped.
//
// It is a cell rather than an API because a cell is already everything this
// needs: reactive binding in the UI, automatic sync to every connected client,
// testCell/testUI coverage, visibility in `am state`, and persistence of the
// dismissal across restarts. An app author learns no new concept — the update
// state is state, and it is read like all other state.
import { cell } from "./cell.ts";
import type { MethodDraftMeta } from "./cell-impl.ts";
import type { CellDef } from "./cell-types.ts";

/** A release the app could move to. */
export type AvailableUpdate = {
  version: string;
  /** Why it is being offered, in the words the user sees.
   *
   *  Not decoration: the offer can carry the version the app is ALREADY
   *  running, because a re-published build of `1.2.3` is a real update with
   *  different bytes. "1.2.3 is available" next to "you are running 1.2.3"
   *  reads as a bug unless something says "same version, new build". */
  reason: string;
  /** One line, or a link to the changelog — whatever the publisher wrote. */
  notes: string | null;
  /** Bytes, when the source knows (a manifest does; a git ref does not). */
  size: number | null;
  releasedAt: string | null;
  /** Installing it will migrate persisted data, so a backup is taken first. */
  migrates: boolean;
  /** Was the release signed, and verified under a key this install trusts?
   *
   *  Shown, not just checked. `allowUnsigned` is a legitimate configuration for
   *  a private build, and an app that took that option should be able to tell
   *  its user that THIS release is the unauthenticated kind — otherwise the
   *  opt-in is invisible everywhere except the log nobody reads. */
  signed: boolean;
  /** Short fingerprint of the key that signed it, or null when unsigned. The
   *  one thing a human can compare against what the publisher announced. */
  keyFingerprint: string | null;
  /** Survivable caveats worth showing next to the Yes button. */
  warnings: string[];
};

/** A newer release that CANNOT be installed over this app's data.
 *
 *  Kept separate from `available` on purpose. Hiding it would read to the user
 *  as "you are up to date", which is false; putting it in `available` would
 *  offer them a button that must not exist. It is information, and it says
 *  exactly what is in the way. */
export type BlockedUpdate = { version: string; blockers: string[] };

/** Where the built-in updater currently is.
 *
 *  Every member is REACHABLE and observable by a client — the cell publishes
 *  mid-method (`s.$commit()`) precisely so `checking`, `downloading` and
 *  `applying` are states a UI can render rather than words in a type nobody can
 *  ever see. `tests/updates-cell.test.ts` pins that every one of them is
 *  assigned somewhere in `src/`. */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "blocked"
  | "downloading"
  | "staged"
  | "applying"
  | "error";

/** What the server injects so this cell can do its job. Absent in the browser
 *  and in any test that does not opt in — the cell then reports itself
 *  disabled rather than pretending to poll. */
export type UpdatesRuntime = {
  /** Check the source; returns the new cell state fragment. The cell passes
   *  what only it knows — the version the user said No to — so a dismissal
   *  holds across polls instead of being re-offered a minute later. */
  check(opts: CheckOptions): Promise<CheckResult>;
  /** Download, verify, stage and swap, then hand over to the new build.
   *
   *  Resolves once the artifact is STAGED and the handover is scheduled — the
   *  restart itself happens after this method's dispatch has settled, which is
   *  the whole point: `apply()` is a cell method, so a shutdown driven from
   *  inside it would have the app waiting on the very call that asked for it
   *  (and then reporting "writes are lost" on every successful update). */
  apply(opts?: ApplyOptions): Promise<void>;
  /** The restart `apply()` scheduled, once it has scheduled one. Null before
   *  that. Nothing in production awaits it — by the time it settles this
   *  process is gone — but a test that drives a real swap can. */
  readonly handover?: Promise<void> | null;
  /** Report an install phase into the cell. Wired by the runtime so the applier
   *  can say what it is doing without a second transport. */
  setPhase?(phase: "downloading" | "applying"): void;
  /** Report the pre-migration backup path into the cell, same wiring. */
  setBackupPath?(path: string): void;
  /** Repoint at another channel (a ref, for a git source). */
  setChannel(channel: string): Promise<void>;
  /** True when the app is reachable from off this machine. */
  exposed: boolean;
  channel: string;
  current: string;
  kind: "manifest" | "git";
};

/** What the cell hands the runtime on every check. */
export type CheckOptions = {
  /** The version (or commit) the user dismissed; null when nothing was. */
  dismissed: string | null;
};

/** What the caller of `apply()` decided. */
export type ApplyOptions = {
  /** Install a BLOCKED release and start on an EMPTY profile: the current one
   *  is moved whole to `<home>/archive/…` at handover, never deleted. */
  retireData?: boolean;
  /** Install a release the DATA GATE blocked.
   *
   *  The gate is right almost always, and when it is wrong it is wrong
   *  permanently: a contract published with a mistake blocks that app's every
   *  future release, on every install, forever, with no way out that does not
   *  involve the user reinstalling by hand. That is its own kind of data loss,
   *  so there is a door — and it is heavy. The override refuses unless a backup
   *  can actually be taken, takes it BEFORE anything is downloaded, logs every
   *  blocker at error level, and names the file it wrote. */
  acceptDataLoss?: boolean;
};

/** What a check found — the whole answer, in one discriminated union.
 *
 *  `offer` is the only shape that can be installed; `blocked` is a NEWER
 *  release the data on disk would not survive, reported rather than offered;
 *  `current` and `error` say why nothing is on the table. A caller decides on
 *  `kind` alone, so "nothing found" can never be confused with "found and
 *  refused". */
export type CheckResult =
  | { kind: "current"; reason: string }
  | { kind: "offer"; update: AvailableUpdate }
  | { kind: "blocked"; blocked: BlockedUpdate }
  | { kind: "error"; error: string };

let runtime: UpdatesRuntime | null = null;

/** Install the platform half. Called once by the server at boot, only when the
 *  app configured `updates`. */
export function installUpdatesRuntime(r: UpdatesRuntime | null): void {
  runtime = r;
  // Removing the runtime is a fact about the cell, not just about this module.
  // Publishing it needs a dispatch, and this function is called from places
  // that are not in one (boot, a test's setup), so it is best-effort — the
  // cell's own `ready()` reads `runtime` again and agrees either way.
  if (r === null && _updates) {
    try {
      void Promise.resolve(
        (_updates as unknown as { ready?: () => unknown }).ready?.(),
      ).catch(() => {});
    } catch {
      // aio-ok: publishing "no runtime" is observation; the cell is not always
      // bound when a stub is removed, and `ready()` re-reads `runtime` anyway.
    }
  }
}

/** The runtime, for the server's own scheduled check. */
export function updatesRuntime(): UpdatesRuntime | null {
  return runtime;
}

/** Publish the CONFIGURATION into the cell, before any check has run.
 *
 *  Called by the boot path the moment the cells are bound. `enabled`, `kind`,
 *  `channel` and `current` are facts about how the app was configured, knowable
 *  the instant `installUpdatesRuntime` happens — but a cell method cannot be
 *  dispatched until binding is done, so this is the first legal moment.
 *
 *  Without it those fields waited for the first check to ANSWER: a chip bound
 *  to `updates.enabled` was blank for a network round-trip at every boot, and
 *  for an app with `check: false` — which never runs a boot check at all — it
 *  was blank forever. */
export function readyUpdates(): void {
  if (!runtime) return;
  const cell = _updates as unknown as { ready?: () => void } | null;
  cell?.ready?.();
}

/** The update state an app reads. Every field is a plain value on the bound
 *  cell — `updates.available`, `updates.status` — like any other cell. */
export type UpdatesState = {
  /** True once the app configured `updates` (a runtime is installed); false in
   *  an app that never configured it, and in a test that did not install a
   *  runtime. Set the moment a check BEGINS, not when it answers. */
  enabled: boolean;
  kind: "manifest" | "git";
  channel: string;
  current: string;
  status: UpdateStatus;
  available: AvailableUpdate | null;
  blocked: BlockedUpdate | null;
  progress: number;
  lastChecked: string | null;
  error: string | null;
  dismissed: string | null;
  /** The pre-migration backup taken by the install in flight, or null. */
  backupPath: string | null;
};

/** The whole public surface of the built-in updates cell.
 *
 *  Written out rather than inferred: this is a published API, and an app author
 *  reading it should see exactly what they can call and read without chasing
 *  the cell() generics. */
export type UpdatesCell = Readonly<UpdatesState> & CellDef & {
  /** Ask the source what it has. Safe at any time; returns what it found. */
  check(): Promise<CheckResult>;
  /** Install the offered release and restart. Returns only on failure — or,
   *  with `{ acceptDataLoss: true }`, on a blocked release the operator chose
   *  to take anyway. */
  apply(opts?: ApplyOptions): Promise<void>;
  /** Download progress, 0..1 — called by the applier. */
  setProgress(fraction: number): void;
  /** The phase of an in-flight install — called by the applier. */
  setPhase(phase: "downloading" | "applying"): void;
  /** The pre-migration backup an install just took — called by the applier. */
  setBackupPath(path: string): void;
  /** Publish the configuration before the first check answers — called by the
   *  boot path (`readyUpdates`), not by app code. */
  ready(): void;
  /** "Not now", until a newer version appears. Works on a blocked release too:
   *  a notice with no way to hide it is a notice people learn to ignore. */
  dismiss(): void;
  /** Undo a `dismiss()` — the release the user said no to becomes offerable
   *  again on the next check. Without it "Not now" was permanent for that
   *  version, which is not what those two words mean. */
  undismiss(): void;
  /** Follow a different channel (a ref, for a git source). */
  setChannel(channel: string): Promise<void>;
};

/** Names the fix, not just the fact. "updates are not configured" sent people
 *  looking for a missing file; the configuration is one key in `aio.run`. */
const NOT_CONFIGURED =
  "updates are not configured for this app — pass `updates` to aio.run, " +
  'e.g. aio.run({ cells, updates: "https://releases.example.com/myapp" }) ' +
  "(or the object form, updates: { source, channel, auto }).";

/** The draft an async method receives on a transactional cell: the state, plus
 *  the framework's own `$commit`/`$live` (see MethodDraftMeta). */
type Draft = UpdatesState & Partial<MethodDraftMeta<UpdatesState>>;

let _updates: UpdatesCell | null = null;

/** Create (once) the built-in `updates` cell.
 *
 *  A FACTORY, not a module-level `cell(…)`, and that distinction is
 *  load-bearing. `cell()` self-registers on evaluation, so a module that builds
 *  it at import time can only be pulled in for its SIDE EFFECT — which is what
 *  `aio.run()` used to do, with `await import(…)` from inside the call an app
 *  top-level-awaits. A dynamic import of a module whose graph is still
 *  evaluating cannot complete, and Deno reports it as
 *  "module evaluation is still pending … This is a bug in Deno": the app hangs
 *  at boot with no banner and nothing to search for.
 *
 *  Registering on CALL instead keeps the property the dynamic import existed
 *  for — an app that never asked for updates never gets the cell — and lets
 *  every caller use a plain static import. Memoised because the cell binds to
 *  exactly one app (D2): `aio/updates` and the boot path must get the same
 *  object, not two. */
export function createUpdatesCell(): UpdatesCell {
  if (_updates) return _updates;
  _updates = cell("updates", {
    state: {
      /** False until the runtime the server installs starts its first check —
       *  a UI can hide itself entirely rather than render a permanently idle
       *  widget. Written by `check()` and published before the network call
       *  (`$commit`), because the cell is created at `import "aio/updates"`,
       *  before the boot configures anything, so it cannot be an initial
       *  value — but it must not wait a round-trip either. */
      enabled: false,
      /** "manifest" (published artifacts) or "git" (a repository). */
      kind: "manifest" as "manifest" | "git",
      /** The channel being followed — a directory, or a git ref. */
      channel: "",
      /** The version running right now. */
      current: "",
      status: "idle" as UpdateStatus,
      available: null as AvailableUpdate | null,
      blocked: null as BlockedUpdate | null,
      /** 0..1 while downloading. */
      progress: 0,
      lastChecked: null as string | null,
      error: null as string | null,
      /** The version the user said No to; cleared when a newer one appears. */
      dismissed: null as string | null,
      /** The pre-migration backup this install took, once one exists.
       *
       *  The applier already computes it, logs it, and writes it into the
       *  pending marker so a rollback can name it — and it stopped there, so a
       *  UI could not show it. After a rollback, or after an
       *  `acceptDataLoss` install, the file holding the user's data was named
       *  only in a log line. For an app holding anything a person would miss,
       *  that is the one sentence you want on screen. */
      backupPath: null as string | null,
    },

    // Only `dismissed` is worth surviving a restart. Everything else describes
    // the world as of a moment ago and is re-derived by the check on boot —
    // persisting it would resurrect a stale "update available" for a release
    // that has since been pulled.
    persist: { include: ["dismissed"] },

    // Read side, stated explicitly (an access predicate does not imply one, and
    // leaving it undeclared is a boot refusal under --expose). All of it is
    // public by nature: the version on offer, the channel, and the release URL in
    // an error are things the release location already serves to anybody. Nothing
    // secret is put here — the backup path and the signing key are logged and
    // stored, never broadcast.
    visible: "all",

    // Snapshot reads + one atomic commit: a check that throws or is cancelled
    // mid-flight must not leave the cell claiming "checking" forever, or
    // half-write an offer.
    //
    // `serialize` is the in-flight guard, and it guards something concrete. The
    // runtime holds ONE `offered` manifest — the release the user was shown and
    // agreed to — and both `check()` and `apply()` read and write it across an
    // `await`. Two overlapping checks (the boot check plus a click on Check
    // now) could therefore hand `apply()` a manifest nobody was ever shown, and
    // two overlapping applies would download the same release twice into one
    // staged path. One at a time removes the whole class; the status guards
    // inside the methods handle the SEQUENTIAL case the mutex still allows (a
    // second apply queued behind the first, a poll firing mid-install).
    //
    // Sync methods are not held off, which is what keeps `setProgress` and
    // `setPhase` — the applier reporting on itself — flowing while `apply()`
    // holds the mutex.
    transaction: { serialize: true },

    // Who may drive an update over the network. On a normal desktop or service
    // install aio binds 127.0.0.1, so every client is already on this machine and
    // there is nobody else to gate. Once the app is --expose'd that stops being
    // true, and "restart this app" is not a verb an anonymous visitor gets.
    access: (user) => !runtime?.exposed || !!user,

    methods: {
      /** Publish the configuration: what updates are on, from where, for which
       *  version. Facts, not findings — see `readyUpdates`. */
      ready(s) {
        // Symmetry with `installUpdatesRuntime(null)`: `enabled` is "a runtime
        // is installed", and nothing ever set it back. A test that installed a
        // stub, checked, then removed the stub kept `enabled: true` — so a UI
        // gated on it could be tested for its presence and never its absence,
        // which is the half that regresses silently.
        if (!runtime) {
          s.enabled = false;
          return;
        }
        s.enabled = true;
        s.kind = runtime.kind;
        s.channel = runtime.channel;
        s.current = runtime.current;
      },

      /** Ask the source what it has. Safe to call at any time. */
      async check(s: Draft) {
        if (!runtime) {
          const error = NOT_CONFIGURED;
          s.error = error;
          s.status = "error";
          return { kind: "error", error } as CheckResult;
        }
        // Never re-check while an install of this app is in flight. The poll
        // timer does not stop for an apply, and a check that lands mid-install
        // clears the runtime's `offered` manifest out from under the applier.
        const busy = s.$live?.status ?? s.status;
        if (
          busy === "downloading" || busy === "applying" || busy === "staged"
        ) {
          const reason = `an update is being installed (${busy}) — ` +
            `not checking for another one until it finishes`;
          return { kind: "current", reason } as CheckResult;
        }
        s.status = "checking";
        s.error = null;
        // Configured, and by what. `enabled` is a fact about the
        // CONFIGURATION, not about the network, so it is true the moment a
        // check begins rather than one round-trip later — a chip that is blank
        // until the first answer arrives is a chip that lies at every boot.
        s.enabled = true;
        s.kind = runtime.kind;
        s.channel = runtime.channel;
        s.current = runtime.current;
        // Publish NOW, mid-method. Without this the whole write-set commits
        // once at return (`transaction`), so `status: "checking"` existed only
        // inside this function: no client ever saw it, and a spinner bound to
        // it could never render. The type said the state existed; nothing could
        // observe it.
        s.$commit?.();
        // Guarded like `apply()` is. Without this a throwing `runtime.check()`
        // rolled the "checking" write back (transaction) and propagated to
        // the caller — so a UI that calls `updates.check()` without awaiting saw
        // NOTHING: no error in state, no status change, no trace that a check had
        // even been attempted. Two sibling methods, two different answers to the
        // same failure.
        let r: CheckResult;
        try {
          // `s.dismissed` is read from the snapshot: the version the user said
          // No to, persisted across restarts, and the only input the runtime
          // cannot know on its own.
          r = await runtime.check({ dismissed: s.dismissed });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          s.status = "error";
          s.error = error;
          s.lastChecked = new Date().toISOString();
          return { kind: "error", error } as CheckResult;
        }
        s.lastChecked = new Date().toISOString();
        if (r.kind === "error") {
          s.status = "error";
          s.error = r.error;
          return r;
        }
        if (r.kind === "current") {
          s.status = "idle";
          s.available = null;
          s.blocked = null;
          return r;
        }
        if (r.kind === "blocked") {
          s.status = "blocked";
          s.available = null;
          s.blocked = r.blocked;
          return r;
        }
        s.status = "available";
        s.blocked = null;
        s.available = r.update;
        return r;
      },

      /** Install what `check` found, then restart. Returns only on failure —
       *  a successful apply ends with the process being replaced. */
      async apply(s: Draft, opts?: ApplyOptions) {
        if (!runtime) {
          s.error = NOT_CONFIGURED;
          s.status = "error";
          return;
        }
        // Re-entry guard. A double click used to mean two downloads racing into
        // one staged path; the mutex (`serialize`) makes them sequential, and
        // this makes the second one a refusal instead of a second download of
        // something already installed.
        const phase = s.$live?.status ?? s.status;
        if (
          phase === "downloading" || phase === "applying" || phase === "staged"
        ) {
          s.error = `an update is already being installed (${phase}) — ` +
            `wait for it to finish or restart the app`;
          return;
        }

        const accept = opts?.acceptDataLoss === true;
        if (!s.available && !(accept && s.blocked)) {
          // Never install something the user was not shown. A `blocked` release
          // lands here too unless the caller deliberately opened the one-way
          // door — and then it is told which door, in the same sentence.
          s.error = s.blocked
            ? `${s.blocked.version} is blocked: ${
              s.blocked.blockers.join("; ")
            }. It is not installed by default because your data may not ` +
              `survive it. If that verdict is wrong (a mis-published data ` +
              `contract), take it deliberately with ` +
              `updates.apply({ acceptDataLoss: true }) — that refuses unless a ` +
              `backup can be taken, and takes one first.`
            : "no update is available to apply — call updates.check() first";
          s.status = "error";
          return;
        }
        s.status = "downloading";
        s.progress = 0;
        s.error = null;
        // Publish the reset BEFORE the download starts. Buffered to the end (as
        // it was), `progress = 0` committed AFTER every `setProgress` the
        // applier had dispatched — so a failed apply visibly rewound the bar to
        // zero, and a successful one never showed a bar at all.
        s.$commit?.();
        try {
          await runtime.apply({ acceptDataLoss: accept });
          // Reached only when the swap is done and the handover is scheduled
          // but has not happened yet: the artifact is staged, the process is
          // about to be replaced. Saying "idle" here would be a lie for the
          // last moments of this process's life.
          s.status = "staged";
          s.progress = 1;
        } catch (e) {
          s.status = "error";
          s.error = e instanceof Error ? e.message : String(e);
        }
      },

      /** Download progress, 0..1. Called by the applier; it reaches every
       *  connected client through the normal state channel, so a progress bar is
       *  a bound read like anything else. */
      setProgress(s, fraction: number) {
        s.progress = Math.max(0, Math.min(1, fraction));
      },

      /** The phase of an in-flight install, reported by the applier.
       *
       *  Two phases and no more, because these are the two that take real time
       *  and are meaningfully different to a person watching: bytes arriving,
       *  and the swap happening. Deliberately not "set any status you like" —
       *  every other status is decided by the method that owns the transition. */
      setPhase(s, phase: "downloading" | "applying") {
        if (phase !== "downloading" && phase !== "applying") {
          throw new Error(
            `[updates] setPhase("${phase}") is not a phase the applier ` +
              `reports — use "downloading" or "applying".`,
          );
        }
        s.status = phase;
      },

      /** The pre-migration backup this install took. Reported by the applier
       *  the moment it exists, which is BEFORE the swap — so a UI can name the
       *  file while the install is still in flight, and still name it if the
       *  install then fails and rolls back. */
      setBackupPath(s, path: string) {
        if (typeof path !== "string" || path === "") {
          throw new Error(
            `[updates] setBackupPath(${
              JSON.stringify(path)
            }) — a backup path is a non-empty string; pass the path the ` +
              `snapshot was written to.`,
          );
        }
        s.backupPath = path;
      },

      /** "Not now." Sticks until a version newer than this one appears.
       *
       *  Accepts a BLOCKED release as its subject too. A blocked notice is
       *  information the user cannot act on, and until this there was no way to
       *  put it away — it sat there on every boot, forever, for a release that
       *  was never going to become installable. */
      dismiss(s) {
        const subject = s.available ?? s.blocked;
        if (!subject) return;
        s.dismissed = subject.version;
        s.available = null;
        s.blocked = null;
        s.status = "idle";
      },

      /** Undo a dismissal. The next check offers the release again.
       *
       *  The inverse `dismiss()` never had. Without it, "Not now" was a
       *  permanent, irreversible No for that version — and, because a dismissal
       *  makes `decide` answer "current", it also poisoned nothing else: the
       *  user simply never saw that release again from inside the app. */
      undismiss(s) {
        s.dismissed = null;
        s.error = null;
      },

      /** Follow a different channel. Clears everything derived from the old one —
       *  a dismissal on prod says nothing about test, and a version comparison
       *  across channels can legitimately go backwards. */
      async setChannel(s: Draft, channel: string) {
        if (!runtime) {
          s.error = NOT_CONFIGURED;
          s.status = "error";
          return;
        }
        await runtime.setChannel(channel);
        s.channel = channel;
        s.available = null;
        s.blocked = null;
        s.dismissed = null;
        s.status = "idle";
        s.error = null;
        s.backupPath = null;
      },
    },
  }) as unknown as UpdatesCell;
  return _updates;
}
