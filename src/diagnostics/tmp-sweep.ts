// tmp-sweep.ts — clear the tmp files an atomic rewrite (tmp → rename) left
// behind when the process died between the two steps.
//
// The tmp names are random (a fixed name could be pre-planted as a symlink —
// see `replaceFileSync` in server/journal.ts and the checkpoint writer), so a
// crash leaves one orphan per crash instead of reusing one: measured, 50
// SIGKILLs left 50. Each owner sweeps its own at open — and ONLY its own:
// the exact name pattern next to a file it owns, a regular file (never a
// symlink, never followed), owned by this user, and older than this process.
// A tmp a live writer is using right now is younger than that.

/** The UUID `crypto.randomUUID()` puts in a tmp name. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exactly `name` — the fixed tmp an older build wrote. */
export function exactName(name: string): RegExp {
  return new RegExp(`^${escape(name)}$`);
}

/** `<name>.<uuid>.tmp` — the journal's `replaceFileSync` shape. */
export function uuidTmpBefore(name: string): RegExp {
  return new RegExp(`^${escape(name)}\\.${UUID}\\.tmp$`);
}

/** `<prefix>.<uuid>` — the checkpoint's shape (`checkpoint.json.tmp.<uuid>`),
 *  and the bare `<prefix>` an older build used. */
export function uuidTmpAfter(prefix: string): RegExp {
  return new RegExp(`^${escape(prefix)}(\\.${UUID})?$`);
}

/** Remove, in `dir`, every file whose name matches one of `patterns` and
 *  that is a regular file owned by this user and last modified before this
 *  process started. Returns the names removed. Never throws: a sweep that
 *  cannot run leaves orphans, which is what not sweeping did. */
export function sweepStaleTmps(dir: string, patterns: RegExp[]): string[] {
  const removed: string[] = [];
  const bootMs = performance.timeOrigin;
  let uid: number | null = null;
  try {
    uid = Deno.uid();
  } catch {
    /* aio-ok: no uid on this OS (Windows) — ownership is not checked */
  }
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return removed; // aio-ok: no directory yet — nothing to sweep
  }
  for (const e of entries) {
    if (!e.isFile || !patterns.some((p) => p.test(e.name))) continue;
    const path = `${dir}/${e.name}`;
    try {
      const st = Deno.lstatSync(path);
      if (!st.isFile) continue; // a symlink (or anything else): never touched
      if (uid !== null && st.uid !== null && st.uid !== uid) continue;
      if (st.mtime === null || st.mtime.getTime() >= bootMs) continue;
      Deno.removeSync(path);
      removed.push(e.name);
    } catch {
      // aio-ok: gone meanwhile, or not ours to remove — left as it is
    }
  }
  return removed;
}
