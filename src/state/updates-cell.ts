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
import type { CellEntry } from "./cell-types.ts";

/** A release the app could move to. */
export type AvailableUpdate = {
  version: string;
  /** One line, or a link to the changelog — whatever the publisher wrote. */
  notes: string | null;
  /** Bytes, when the source knows (a manifest does; a git ref does not). */
  size: number | null;
  releasedAt: string | null;
  /** Installing it will migrate persisted data, so a backup is taken first. */
  migrates: boolean;
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
  /** Check the source; returns the new cell state fragment. */
  check(): Promise<CheckResult>;
  /** Download, verify, stage, swap and restart. Does not return on success. */
  apply(): Promise<void>;
  /** Repoint at another channel (a ref, for a git source). */
  setChannel(channel: string): Promise<void>;
  /** True when the app is reachable from off this machine. */
  exposed: boolean;
  channel: string;
  current: string;
  kind: "manifest" | "git";
};

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
}

/** The runtime, for the server's own scheduled check. */
export function updatesRuntime(): UpdatesRuntime | null {
  return runtime;
}

/** The update state an app reads. Every field is a plain value on the bound
 *  cell — `updates.available`, `updates.status` — like any other cell. */
export type UpdatesState = {
  /** False when the app did not configure `updates`. */
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
};

/** The whole public surface of the built-in updates cell.
 *
 *  Written out rather than inferred: this is a published API, and an app author
 *  reading it should see exactly what they can call and read without chasing
 *  the cell() generics. */
export type UpdatesCell = Readonly<UpdatesState> & CellEntry & {
  /** Ask the source what it has. Safe at any time; returns what it found. */
  check(): Promise<CheckResult>;
  /** Install the offered release and restart. Returns only on failure. */
  apply(): Promise<void>;
  /** Download progress, 0..1 — called by the applier. */
  setProgress(fraction: number): void;
  /** "Not now", until a newer version appears. */
  dismiss(): void;
  /** Follow a different channel (a ref, for a git source). */
  setChannel(channel: string): Promise<void>;
};

export const updates: UpdatesCell = cell("updates", {
  state: {
    /** False when the app did not configure `updates` — a UI can hide itself
     *  entirely rather than render a permanently idle widget. */
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

  // Snapshot reads + one atomic commit (the alpha52 default, stated rather
  // than inherited): a check that throws or is cancelled mid-flight must not
  // leave the cell claiming "checking" forever, or half-write an offer.
  transaction: true,

  // Who may drive an update over the network. On a normal desktop or service
  // install aio binds 127.0.0.1, so every client is already on this machine and
  // there is nobody else to gate. Once the app is --expose'd that stops being
  // true, and "restart this app" is not a verb an anonymous visitor gets.
  access: (user) => !runtime?.exposed || !!user,

  methods: {
    /** Ask the source what it has. Safe to call at any time. */
    async check(s) {
      if (!runtime) {
        const error = "updates are not configured for this app";
        s.error = error;
        s.status = "error";
        return { kind: "error", error } as CheckResult;
      }
      s.status = "checking";
      s.error = null;
      // Guarded like `apply()` is. Without this a throwing `runtime.check()`
      // rolled the "checking" write back (transaction: true) and propagated to
      // the caller — so a UI that calls `updates.check()` without awaiting saw
      // NOTHING: no error in state, no status change, no trace that a check had
      // even been attempted. Two sibling methods, two different answers to the
      // same failure.
      let r: CheckResult;
      try {
        r = await runtime.check();
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        s.status = "error";
        s.error = error;
        s.lastChecked = new Date().toISOString();
        return { kind: "error", error } as CheckResult;
      }
      s.lastChecked = new Date().toISOString();
      s.channel = runtime.channel;
      s.current = runtime.current;
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
    async apply(s) {
      if (!runtime) {
        s.error = "updates are not configured for this app";
        s.status = "error";
        return;
      }
      if (!s.available) {
        // Never install something the user was not shown. `blocked` releases
        // land here too, which is the point: there is no path from a blocked
        // release to an installed one.
        s.error = "no update is available to apply";
        s.status = "error";
        return;
      }
      s.status = "downloading";
      s.progress = 0;
      s.error = null;
      try {
        await runtime.apply();
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

    /** "Not now." Sticks until a version newer than this one appears. */
    dismiss(s) {
      if (!s.available) return;
      s.dismissed = s.available.version;
      s.available = null;
      s.status = "idle";
    },

    /** Follow a different channel. Clears everything derived from the old one —
     *  a dismissal on prod says nothing about test, and a version comparison
     *  across channels can legitimately go backwards. */
    async setChannel(s, channel: string) {
      if (!runtime) return;
      await runtime.setChannel(channel);
      s.channel = channel;
      s.available = null;
      s.blocked = null;
      s.dismissed = null;
      s.status = "idle";
      s.error = null;
    },
  },
}) as unknown as UpdatesCell;
