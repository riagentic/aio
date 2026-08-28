// dir-permissions.ts — "may something private live in this directory?"
//
// The rule was written once, for the control key: a secret is never written to
// a directory that cannot keep it, and `mintControlKey` REFUSES rather than
// writing into a mode it does not like. The control SOCKET — a door that lets
// the other end dispatch methods into a running app — got only half of it:
// `lockDir()` chmods 0700 and swallows the failure, so on the one host that
// matters (no `$XDG_RUNTIME_DIR`, base `/tmp`) a directory somebody else
// already owns is used exactly as if the chmod had worked. chmod on a
// directory you do not own returns EPERM; the guarantee was a best effort
// wearing the words of a rule.
//
// So the rule lives here, once, and both doors ask it.

/** Group+other permission bits, or null when the platform has no POSIX mode
 *  (Windows). `null` means "unknown", never "fine". */
export function sharedBits(mode: number | null | undefined): number | null {
  return typeof mode === "number" ? mode & 0o077 : null;
}

/** `0700`-style rendering of a mode, `"?"` when there is none. */
export function octal(mode: number | null | undefined): string {
  return typeof mode === "number"
    ? (mode & 0o777).toString(8).padStart(3, "0")
    : "?";
}

/** This process's uid, or null when `--allow-sys` was not granted.
 *  Null means "cannot tell", and a check that cannot tell must not refuse. */
export function selfUid(): number | null {
  try {
    return Deno.uid?.() ?? null;
  } catch {
    return null;
  }
}

/** Why `dir` cannot hold something private, or null when it can.
 *
 *  Two ways it cannot, and they fail differently in the field:
 *  - group or other can reach it — anyone local walks in;
 *  - it belongs to another account — we cannot narrow it, and on a mode we
 *    would otherwise accept (0700, theirs) we cannot even write.
 *
 *  A `null` mode is Windows, where the ACLs of the user's own profile
 *  directory are the boundary and there are no bits to read. */
export function privateDirRefusal(
  dir: string,
  mode: number | null,
  ownerUid?: number | null,
  selfUidValue: number | null = selfUid(),
): string | null {
  const shared = sharedBits(mode);
  if (shared !== null && shared !== 0) {
    return `${dir} is mode ${octal(mode)} (not owner-only)`;
  }
  if (
    selfUidValue !== null && ownerUid !== null && ownerUid !== undefined &&
    ownerUid !== selfUidValue
  ) {
    return `${dir} is owned by uid ${ownerUid}, not by you (uid ${selfUidValue})`;
  }
  return null;
}
