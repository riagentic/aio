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

/** Does `Deno.stat().mode` carry real POSIX permission bits on this platform?
 *
 *  THE ONE DECIDER. Every door that reads a mode asks this first, so a
 *  platform can never be POSIX to one check and not to another.
 *
 *  MEASURED on w11pro (Windows 11 build 26200, Deno 2.9.6), 2026-09-21:
 *
 *      Deno.statSync(<a fresh temp dir>).mode === 16822 === 0o40666
 *      Deno.statSync("C:\\Users\\dev").mode   === 16822 === 0o40666
 *
 *  The user's own ACL-private profile directory and a scratch directory report
 *  the SAME number, because Windows synthesizes the field from the read-only
 *  attribute alone. Two things follow, and this module used to get both wrong:
 *
 *   • the mode is NOT `null` on Windows — the old comment here said it was,
 *     and every caller was written against that;
 *   • `0o40666 & 0o077` is `0o66`, so "group or other can reach it" was TRUE
 *     for every directory on Windows. `mintControlKey` therefore refused to
 *     mint at all and `readControlKey` refused to read: the control plane and
 *     the trojan gate were unusable on Windows, and 8 `local-control` cases
 *     failed there for that one reason.
 *
 *  So the bits are consulted only where they are bits. On Windows the boundary
 *  is the profile directory's ACL, which Deno exposes no way to read — this
 *  check ABSTAINS there, by name, rather than reading a constant as if it were
 *  evidence. Abstaining is stated here once instead of being spelled `null` at
 *  four call sites that each believed something different. */
export function modeBitsAreMeaningful(
  os: typeof Deno.build.os = Deno.build.os,
): boolean {
  return os !== "windows";
}

/** Group+other permission bits, or null when they are not knowable here —
 *  Windows (see {@linkcode modeBitsAreMeaningful}), or a stat that carried no
 *  mode at all. `null` means "unknown", never "fine": a caller that treats it
 *  as a pass is deciding to abstain, and `privateDirRefusal` is where that
 *  decision is made once. */
export function sharedBits(
  mode: number | null | undefined,
  os: typeof Deno.build.os = Deno.build.os,
): number | null {
  if (!modeBitsAreMeaningful(os)) return null;
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
 *  On Windows the mode field is not evidence of either (it is the same number
 *  for every directory — {@linkcode modeBitsAreMeaningful} has the
 *  measurement), so the bit test abstains there and the ACLs of the user's own
 *  profile directory are the boundary. The PLATFORM says so, never a `null`
 *  mode: those are different facts and conflating them is what broke Windows.
 *
 *  Which leaves the third case LOUD. On a platform whose modes are real, a
 *  stat that carried no mode is not "fine", it is "cannot tell" — and a
 *  privacy check that cannot tell must say so rather than wave the directory
 *  through. No live caller can reach it (every one passes a mode straight from
 *  `statSync`), which is exactly why it would have rotted in silence. */
export function privateDirRefusal(
  dir: string,
  mode: number | null,
  ownerUid?: number | null,
  selfUidValue: number | null = selfUid(),
  os: typeof Deno.build.os = Deno.build.os,
): string | null {
  if (modeBitsAreMeaningful(os) && typeof mode !== "number") {
    return `${dir}: stat returned no permission mode on ${os}, where modes ` +
      `are real — cannot tell whether another local user can reach it`;
  }
  const shared = sharedBits(mode, os);
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
