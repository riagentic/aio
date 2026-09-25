// Cell — long-running server work, done the way the framework wants it:
// a cancel path, a "still working" flag, and no stale write ever landing.
//
// Nothing here is browser-specific or server-specific to look at: the UI reads
// this state and calls these methods, and the only line that knows a filesystem
// exists is the dynamic `./disk.server.ts` import (docs/build/imports.md §2).
import { cell, type MethodDraftMeta } from "aio";

/** `partial`: that folder's own walk hit the budget — `bytes` is a floor. */
export type Entry = {
  name: string;
  path: string;
  bytes: number;
  partial: boolean;
};

type DiskState = {
  path: string;
  entries: Entry[];
  scanning: boolean;
  error: string | null;
  /** True when the scan hit its budget (see `ScanLimits` in disk.server.ts)
   *  and these numbers are a floor, not a total. Shown, never swallowed. */
  partial: boolean;
  /** Children the scan never reached. `more()` goes on from there — a capped
   *  answer the user cannot get past is only a politer kind of wrong. */
  hasMore: boolean;
};

/** The folder one level up — POSIX (`/a/b`), drive (`C:\a`, `C:/a`) and UNC
 *  (`\\srv\share\a`) paths alike; a root is its own parent. A POSIX-only
 *  regex here made ↑ Up a silent no-op on every Windows path. Pure, so it is
 *  tested with Windows-shaped strings on any OS. */
export function parentOf(path: string): string {
  const root =
    /^(?:[A-Za-z]:[\\/]?|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?|[\\/])/.exec(path)
      ?.[0] ?? "";
  const rest = path.slice(root.length).replace(/[\\/]+$/, "");
  const cut = Math.max(rest.lastIndexOf("/"), rest.lastIndexOf("\\"));
  if (cut < 0) return root || path;
  return root + rest.slice(0, cut);
}

export const disk = cell("disk", {
  // Live measurements — a size read five minutes ago is a lie, so nothing is
  // worth restoring. One word, and this app never persists a byte.
  persist: "none",

  // Opt in to the transactional model (alpha57 made it opt-in again). It earns
  // its line HERE and rarely elsewhere: a scan runs for minutes and can be
  // superseded mid-flight, and under a transaction a cancelled call's buffered
  // writes are discarded wholesale — no stale write can land, by construction,
  // instead of the "check the signal, then carefully un-write" dance.
  //
  // It is also what makes `s.$commit()` below real: without this line
  // `$commit` resolves to a no-op, and the spinner it publishes would never
  // reach the client.
  transaction: true,

  state: {
    path: "",
    entries: [] as Entry[],
    scanning: false,
    error: null as string | null,
    partial: false,
    hasMore: false,
  },

  // "self": opening a new folder aborts the scan still running — newest wins.
  // "disk:stop" is the Cancel button. Both are plain strings here because a
  // cell's own bound methods don't exist yet inside its own literal. `more`
  // goes on with the CURRENT folder, so opening another one ends it too.
  cancelOn: {
    open: ["self", "disk:stop", "disk:more"],
    more: ["self", "disk:stop", "disk:open"],
  },

  // A filesystem walk is long-running BY NATURE, so say it here, on the
  // method, where a rename follows it and `cell()` checks it against the
  // method list. The old spelling —
  // `perfBudget: { methods: { "disk:open": { timeout: 0 } } }` in app.ts —
  // is a string in another file that nothing checks; this example taught it,
  // and two field reports copied it into their apps (one of them accumulating
  // three entries one runtime failure at a time, on a project started AFTER
  // `long:` existed). Examples are what people copy.
  long: ["open", "more"],

  methods: {
    /** Scan a folder. Minutes-long on a big tree — hence everything below.
     *
     *  This cell asked for `transaction: true` (see the config above), so a
     *  cancelled or superseded call's buffered writes are discarded wholesale:
     *  no stale write can land, by construction, and the old "check the signal,
     *  then carefully un-write" dance is gone. */
    //
    // `= undefined` rather than `path?:`: a TS `?` is erased at runtime, so
    // aio's arity tripwire counts the parameter and warns on every call that
    // omits it. A default is what makes the optionality visible there — which
    // is exactly what that warning asks for.
    async open(
      s: DiskState & MethodDraftMeta,
      path: string | undefined = undefined,
    ) {
      const io = await import("./disk.server.ts");
      // `||`, not `??`. Rescan passes the CURRENT path, which is `""` before
      // the first scan — and `??` lets an empty string through, so the button
      // answered `readdir '': No such file or directory` instead of opening
      // the home directory. An empty string is not a path.
      const target = path || io.homeDir();

      // Already cancelled or superseded during the import await? Then this
      // call owns nothing — publishing its spinner would overwrite the state
      // of whoever cancelled it.
      if (s.$signal.aborted) return;

      // The spinner idiom: publish the "working" state NOW, mid-transaction —
      // without $commit the write-set would buffer until the scan finishes.
      s.path = target;
      s.entries = [];
      s.error = null;
      s.partial = false;
      s.hasMore = false;
      s.scanning = true;
      s.$commit();

      try {
        const r = await io.scanFolders(target, s.$signal);
        // Superseded or cancelled while we were away? Just leave: the
        // transaction discards everything this call buffered after $commit —
        // the newer open() (or stop()) owns the state now.
        if (s.$signal.aborted) return;
        s.entries = r.entries;
        // A capped scan reports that it was capped. The alternative — showing
        // a floor as if it were a total — is the quiet failure this whole
        // example is a lesson against.
        s.partial = r.partial;
        s.hasMore = r.more;
      } catch (e) {
        if (s.$signal.aborted) return;
        s.error = e instanceof Error ? e.message : String(e);
      }
      s.scanning = false;
    },

    /** "Scan more": size the children the last scan did not reach and ADD
     *  them. Rescanning cannot do this — it repeats the same walk and stops at
     *  the same child — so the folders already listed are handed back as the
     *  names to skip. */
    async more(s: DiskState & MethodDraftMeta<DiskState>) {
      const io = await import("./disk.server.ts");
      // Read through `$live`: under `transaction: true` a plain `s.x` read is
      // pinned at entry, and this one is decided AFTER the import await — a
      // pinned read of `scanning` there would be a conflict waiting for the
      // first click that overlaps a scan.
      const now = s.$live;
      if (s.$signal.aborted || !now.hasMore || now.scanning) return;
      const path = now.path;
      const listed = now.entries;
      s.scanning = true;
      s.$commit();
      try {
        const r = await io.scanFolders(
          path,
          s.$signal,
          io.DEFAULT_LIMITS,
          new Set(listed.map((e) => e.name)),
        );
        if (s.$signal.aborted) return;
        s.entries = [...listed, ...r.entries].sort((a, b) => b.bytes - a.bytes);
        s.hasMore = r.more;
        s.partial = r.more || s.entries.some((e) => e.partial);
      } catch (e) {
        if (s.$signal.aborted) return;
        s.error = e instanceof Error ? e.message : String(e);
      }
      s.scanning = false;
    },

    /** Cancel button. The abort itself is `cancelOn`'s job — this dispatch is
     *  the trigger. Clearing the flag here makes the UI respond on the click
     *  rather than when the walk next looks at the signal. */
    stop(s: DiskState) {
      s.scanning = false;
    },

    /** Up one level — a normal call, which supersedes any running scan. */
    async up(s: DiskState & MethodDraftMeta) {
      const parent = parentOf(s.path);
      if (parent !== s.path) await disk.open(parent);
    },

    /** Show the folder in the desktop file manager: a subprocess, from a cell. */
    async reveal(_s: DiskState, path: string) {
      const io = await import("./disk.server.ts");
      await io.reveal(path);
    },
  },

  selectors: {
    /** Largest child, for scaling the bars. Selectors are pure and derived —
     *  never store what you can compute. */
    largest: (s: DiskState) => s.entries[0]?.bytes ?? 0,
  },
});
