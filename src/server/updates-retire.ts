// updates-retire.ts — `apply({ retireData: true })`: the one-step "start fresh".
//
// A release the data gate blocks has exactly two honest exits. One is
// `acceptDataLoss` — keep the data, back it up, let the new build try to read
// it. The other is THIS one — keep the data too, but out of the way: the whole
// profile is moved to a named, timestamped archive beside it, an empty profile
// takes its place, and the new build boots clean. Nothing is deleted, ever.
//
// Every app with a data gate wrote ~150 lines of this by hand — a marker beside
// the profile, a rename before persistence opens, a relaunch across two
// processes. It runs here at the ONE moment it is safe: after the shutdown
// contract has closed persistence and before the successor starts, inside the
// same handover an ordinary update uses.
//
// Step by step, each logged, and a failure at any step names that step and
// leaves the previous data exactly where it was:
//
//   ① archive dir  — `<home>/archive/` beside `data/`
//   ② retire       — ONE `rename(data, archive/<name>-<version>-<stamp>)`:
//                    atomic on the same filesystem, so there is no state in
//                    which half a profile has moved
//   ③ fresh data/  — created 0700; if THIS fails the rename is undone
//   ④ carry over   — the update trust store (pinned key, installed digest).
//                    It is the app's identity for updates, not user data;
//                    losing it would make the next check re-pin on first use
//   ⑤ pending      — the rollback marker is re-written into the fresh
//                    profile, pointing at the archived store as its backup,
//                    so the new build still gets two boots to prove itself
import { dirname, join } from "@std/path";
import type { Log } from "../diagnostics/logger-api.ts";
import { readPending, writePending } from "./updates-apply.ts";
import { readTrust, writeTrust } from "./updates-check.ts";

/** Where retired profiles go: a sibling of `data/`, under the app home. */
export function archiveRoot(dataDir: string): string {
  return join(dirname(dataDir), "archive");
}

/** The archive name — self-describing on a directory listing: which app,
 *  which version wrote it, when it was retired. Pure, so the shape is a test.
 *  The stamp is filesystem-safe on every OS (`:` is refused on Windows). */
export function archiveName(
  appName: string | undefined,
  version: string,
  at: Date = new Date(),
): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_") || "app";
  return `${safe(appName ?? "app")}-${safe(version)}-${stamp}`;
}

export type RetireResult = {
  /** Where the previous profile now lives. */
  archive: string;
};

/** A step failed. `step` is the ① … ⑤ name; the previous data is in place. */
export class RetireError extends Error {
  constructor(readonly step: string, cause: unknown) {
    super(
      `retireData step "${step}" failed: ${
        cause instanceof Error ? cause.message : String(cause)
      } — the previous data is still in place`,
    );
    this.name = "RetireError";
  }
}

/** Retire `dataDir` into the archive and leave an empty profile in its place.
 *
 *  MUST run with persistence closed (after the shutdown contract) — a rename
 *  under an open SQLite handle is how a WAL gets orphaned. Throws
 *  `RetireError` naming the step; on any throw the previous data is where it
 *  was (step ③'s failure undoes step ②). */
export async function retireProfile(opts: {
  dataDir: string;
  appName?: string;
  appVersion: string;
  log: Log;
  now?: Date;
}): Promise<RetireResult> {
  const { dataDir, log } = opts;
  const root = archiveRoot(dataDir);
  const archive = join(
    root,
    archiveName(opts.appName, opts.appVersion, opts.now),
  );
  // The rollback marker the swap wrote into the profile about to move — read
  // BEFORE the rename, re-written into the fresh profile at ⑤.
  let pending: ReturnType<typeof readPending> = null;
  try {
    pending = readPending(dataDir);
  } catch { /* no marker, or an unreadable one — nothing to re-arm */ }

  // ① The archive directory. Created before anything moves.
  log.info("updates", `retireData ① archive dir → ${root}`);
  try {
    await Deno.mkdir(root, { recursive: true });
  } catch (e) {
    throw new RetireError("① create archive dir", e);
  }

  // ② The one rename. Refused if the destination already exists — a second
  // retirement in the same second must not merge into the first.
  log.info("updates", `retireData ② retire ${dataDir} → ${archive}`);
  try {
    await Deno.lstat(archive);
    throw new Error(`${archive} already exists`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw new RetireError("② retire data/", e);
    }
  }
  try {
    await Deno.rename(dataDir, archive);
  } catch (e) {
    throw new RetireError("② retire data/", e);
  }

  // ③ A fresh, private profile. If it cannot be made, put the old one back —
  // an app with NO data directory is worse off than one with its old data.
  log.info("updates", `retireData ③ fresh ${dataDir}`);
  try {
    await Deno.mkdir(dataDir, { recursive: false });
    if (Deno.build.os !== "windows") {
      try {
        await Deno.chmod(dataDir, 0o700);
      } catch {
        /* best-effort — a restrictive FS may refuse; the dir exists */
      }
    }
  } catch (e) {
    await Deno.rename(archive, dataDir).catch((undo) =>
      log.error(
        `retireData: could not undo the retirement either (${undo}) — your ` +
          `data is intact at ${archive}; move it back to ${dataDir} by hand`,
      )
    );
    throw new RetireError("③ create fresh data/", e);
  }

  // ④ The update trust store follows the app, not the data. A copy: the
  // archive stays a complete, self-describing profile.
  log.info("updates", "retireData ④ carry the update trust store over");
  try {
    const trust = readTrust(archive);
    if (Object.keys(trust).length > 0) writeTrust(dataDir, trust);
  } catch (e) {
    // The profile HAS moved and a fresh one exists — that is the outcome the
    // operator asked for. Losing the pin costs one re-pin on the next check,
    // which the log says; it never costs data, so this step does not fail the
    // retirement.
    log.warn(
      "updates",
      `retireData ④ could not carry the trust store over (${e}) — the next ` +
        `update check pins the release key again on first use`,
    );
  }

  // ⑤ The rollback marker, so the new build is still held to "come up and
  // serve, or be rolled back" — and the archived store is its named backup.
  if (pending) {
    log.info("updates", "retireData ⑤ re-arm the rollback marker");
    try {
      const store = join(archive, "state.db");
      let backup: string | undefined;
      try {
        await Deno.stat(store);
        backup = store;
      } catch { /* an app with no persistence has no store to name */ }
      writePending(dataDir, { ...pending, backup });
    } catch (e) {
      log.warn(
        "updates",
        `retireData ⑤ could not write the rollback marker (${e}) — the new ` +
          `build starts without a rollback net; the previous profile is ` +
          `intact at ${archive}`,
      );
    }
  }

  log.info("updates", `retireData done — previous profile at ${archive}`);
  return { archive };
}
