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

/** An aborted scan leaves the spinner alone unless it is still the CURRENT one.
 *
 *  This is the rule that makes concurrent runs safe, and it is worth stating
 *  once: after an `await`, a method is writing into state that other calls have
 *  moved on from. Cancelled by the user → this scan still owns `s.path`, so it
 *  clears the flag. Superseded by a newer `open()` → `s.path` belongs to that
 *  one now, and clearing its spinner would be a lie about work still running. */
function done(s: DiskState, target: string): void {
  if (s.path === target) s.scanning = false;
}

export const disk = cell("disk", {
  // Live measurements — a size read five minutes ago is a lie, so nothing is
  // worth restoring. One word, and this app never persists a byte.
  persist: "none",

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

  methods: {
    /** Scan a folder. Minutes-long on a big tree — hence everything below. */
    async open(s: DiskState & Partial<MethodDraftMeta>, path?: string) {
      const io = await import("./disk.server.ts");
      const target = path ?? io.homeDir();

      // Before the first await: the UI shows a spinner from here on.
      s.path = target;
      s.entries = [];
      s.error = null;
      s.scanning = true;

      try {
        const entries = await io.scanFolders(target, s.$signal!);
        // Superseded or cancelled while we were away? Then these results are
        // for a folder the user has already left — dropping them is the whole
        // discipline of long-running work.
        if (s.$signal!.aborted) return done(s, target);
        s.entries = entries;
      } catch (e) {
        if (s.$signal!.aborted) return done(s, target);
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
