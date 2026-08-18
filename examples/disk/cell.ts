// Cell — long-running server work, done the way the framework wants it:
// a cancel path, a "still working" flag, and no stale write ever landing.
//
// Nothing here is browser-specific or server-specific to look at: the UI reads
// this state and calls these methods, and the only line that knows a filesystem
// exists is the dynamic `./disk.server.ts` import (docs/build/imports.md §2).
import { cell, type MethodDraftMeta } from "aio";

export type Entry = { name: string; path: string; bytes: number };

type DiskState = {
  path: string;
  entries: Entry[];
  scanning: boolean;
  error: string | null;
};

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
  // It is also what makes `s.$commit!()` below real: without this line
  // `$commit` resolves to a no-op, and the spinner it publishes would never
  // reach the client.
  transaction: true,

  state: {
    path: "",
    entries: [] as Entry[],
    scanning: false,
    error: null as string | null,
  },

  // "self": opening a new folder aborts the scan still running — newest wins.
  // "disk:stop" is the Cancel button. Both are plain strings here because a
  // cell's own bound methods don't exist yet inside its own literal.
  cancelOn: { open: ["self", "disk:stop"] },

  // A filesystem walk is long-running BY NATURE, so say it here, on the
  // method, where a rename follows it and `cell()` checks it against the
  // method list. The old spelling —
  // `perfBudget: { methods: { "disk:open": { timeout: 0 } } }` in app.ts —
  // is a string in another file that nothing checks; this example taught it,
  // and two field reports copied it into their apps (one of them accumulating
  // three entries one runtime failure at a time, on a project started AFTER
  // `long:` existed). Examples are what people copy.
  long: ["open"],

  methods: {
    /** Scan a folder. Minutes-long on a big tree — hence everything below.
     *
     *  This cell asked for `transaction: true` (see the config above), so a
     *  cancelled or superseded call's buffered writes are discarded wholesale:
     *  no stale write can land, by construction, and the old "check the signal,
     *  then carefully un-write" dance is gone. */
    async open(s: DiskState & Partial<MethodDraftMeta>, path?: string) {
      const io = await import("./disk.server.ts");
      const target = path ?? io.homeDir();

      // Already cancelled or superseded during the import await? Then this
      // call owns nothing — publishing its spinner would overwrite the state
      // of whoever cancelled it.
      if (s.$signal!.aborted) return;

      // The spinner idiom: publish the "working" state NOW, mid-transaction —
      // without $commit the write-set would buffer until the scan finishes.
      s.path = target;
      s.entries = [];
      s.error = null;
      s.scanning = true;
      s.$commit!();

      try {
        const entries = await io.scanFolders(target, s.$signal!);
        // Superseded or cancelled while we were away? Just leave: the
        // transaction discards everything this call buffered after $commit —
        // the newer open() (or stop()) owns the state now.
        if (s.$signal!.aborted) return;
        s.entries = entries;
      } catch (e) {
        if (s.$signal!.aborted) return;
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
    async up(s: DiskState & Partial<MethodDraftMeta>) {
      const parent = s.path.replace(/\/[^/]+\/?$/, "") || "/";
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
