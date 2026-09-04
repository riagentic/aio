// `am auth` — operator console for the built-in auth (AUTH-2/3).
//
//   am auth users                     list accounts (role, email, 2FA, locked)
//   am auth create <id> [--password=…] [--role=admin] [--email=…]
//   am auth passwd <id> [--password=…]     (omit --password → generate + print)
//   am auth role <id> <role>
//   am auth unlock <id>               clear a lockout (the rescue path)
//   am auth totp <id> off             clear a second factor (lost device)
//   am auth verify <id>               mark the email verified by hand
//   am auth revoke <id>               kill every session of a user
//   am auth rm <id>
//
// Works directly on the app's auth.db (data dir) — no running server needed,
// which is the whole point: this is how you get back in when you're locked
// out or seeding the first admin before the app ever boots.

import { resolveAmAppId } from "./am-utils.ts";
import { openUserStore, type UserStore } from "../server/auth-users.ts";
import { openSessionStore, type SessionStore } from "../server/sessions.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError, usage } from "./am-output.ts";
import { appDirs } from "../server/app-dirs.ts";
import { count } from "../diagnostics/fmt.ts";

const USAGE = `am auth — manage the built-in auth (auth: true) of this app

  am auth users                     list accounts
  am auth create <id> [--password=…] [--role=…] [--email=…]
  am auth passwd <id> [--password=…]
  am auth role <id> <role>
  am auth unlock <id>               clear a lockout
  am auth totp <id> off             clear the second factor (lost device)
  am auth verify <id>               mark email verified
  am auth revoke <id>               revoke every session of a user
  am auth rm <id>

Omitting --password generates a strong one and prints it once.
"am auth passwd" also clears the lockout and kills every session.`;

/** Random 16-char password (a–z A–Z 0–9, ~95 bits) for --password-less flows.
 *
 *  Rejection sampling, not `byte % 62`. 256 is not a multiple of 62, so the
 *  modulo maps 0–7 five times over and 8–61 four times: the first eight
 *  characters of the alphabet come up 25% more often than the rest. The
 *  entropy loss is small — a fraction of a bit across sixteen characters — but
 *  this is the password that seeds the first admin and the one `am auth passwd`
 *  hands out during a breach, and "small enough not to matter" is not a claim
 *  worth making when the fix is to discard the 8 bytes that do not divide.
 *
 *  Exported for the test that measures the distribution; it is not am's API. */
export const _generatePassword = (): string => {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  // The largest multiple of 62 that fits in a byte: 248. A byte at or above it
  // is thrown away and redrawn, which costs 8/256 of the draws and buys an
  // exactly uniform alphabet.
  const limit = 256 - (256 % chars.length);
  let s = "";
  while (s.length < 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const b of bytes) {
      if (b >= limit) continue;
      s += chars[b % chars.length];
      if (s.length === 16) break;
    }
  }
  return s;
};

const generatePassword = _generatePassword;

const flag = (args: string[], name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

export async function cmdAuth(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const [sub, ...rest] = args;
  if (!sub) {
    usage(USAGE, flags);
    return;
  }

  // `--app` is a GLOBAL am flag; ignoring it here meant `am --app=other auth
  // add …` silently edited the CWD-inferred app's auth.db instead — writing
  // users into the wrong database. resolveAmAppId honours the flag and falls
  // back to the same inference chain every other command uses.
  const appId = resolveAmAppId(flags.app);
  const dbPath = appDirs(appId).authDb;
  try {
    Deno.statSync(dbPath);
  } catch {
    outError(
      `no auth.db for app "${appId}" (${dbPath}) — run the app once with ` +
        `auth: true, or check you're in the right project directory`,
      mode,
    );
    Deno.exit(1);
  }

  // Sessions live in the SAME auth.db. Binding them into the user store is
  // what makes `am auth passwd` a real breach-response command: the password
  // change itself revokes every session (and burns every outstanding reset /
  // verify / TOTP-pending token) instead of leaving the attacker logged in.
  // Opened lazily — listing users must not create a sessions table.
  const sessions: { store: SessionStore | null } = { store: null };
  const sessionStore =
    (): SessionStore => (sessions.store ??= openSessionStore(dbPath));
  const users: UserStore = openUserStore(dbPath, { sessions: sessionStore });
  const positional = rest.filter((a) => !a.startsWith("--"));
  const id = positional[0];
  const need = (what: string): string => {
    if (!id) {
      outError(`usage: am auth ${sub} <id>${what}`, mode);
      Deno.exit(1);
    }
    return id;
  };

  try {
    switch (sub) {
      case "users": {
        const rows = users.list().map((u) => ({
          id: u.id,
          role: u.role,
          email: u.email ?? "—",
          verified: u.verified,
          totp: u.totpEnabled,
          created: new Date(u.createdAt).toISOString().slice(0, 10),
        }));
        if (mode === "json") out(rows, mode);
        else if (rows.length === 0) out("no users yet", mode);
        else {
          for (const r of rows) {
            out(
              `${r.id.padEnd(24)} ${r.role.padEnd(8)} ${r.email.padEnd(28)} ` +
                `${r.verified ? "✓verified" : "unverified"}${
                  r.totp ? " 2FA" : ""
                }  ${r.created}`,
              mode,
            );
          }
        }
        return;
      }
      case "create": {
        need("");
        const password = flag(rest, "password") ?? generatePassword();
        const rec = await users.create(id!, password, {
          role: flag(rest, "role"),
          email: flag(rest, "email"),
        });
        out(
          mode === "json"
            ? {
              ...rec,
              password: flag(rest, "password") ? undefined : password,
            }
            : `created ${rec.id} (${rec.role})${
              flag(rest, "password") ? "" : ` — password: ${password}`
            }`,
          mode,
        );
        return;
      }
      case "passwd": {
        need("");
        const password = flag(rest, "password") ?? generatePassword();
        // setPassword is the one decider: new hash, lockout cleared, one-shot
        // tokens burned, every session revoked. Nothing to remember here.
        if (!(await users.setPassword(id!, password))) {
          outError(`no such user: ${id}`, mode);
          Deno.exit(1);
        }
        out(
          mode === "json"
            ? {
              ok: true,
              unlocked: true,
              sessionsRevoked: true,
              password: flag(rest, "password") ? undefined : password,
            }
            : `password set for ${id} (lockout cleared, sessions revoked)${
              flag(rest, "password") ? "" : ` — password: ${password}`
            }`,
          mode,
        );
        return;
      }
      case "role": {
        need(" <role>");
        const role = positional[1];
        if (!role) {
          outError(`usage: am auth role <id> <role>`, mode);
          Deno.exit(1);
        }
        if (!users.setRole(id!, role)) {
          outError(`no such user: ${id}`, mode);
          Deno.exit(1);
        }
        // Live sessions resolve their role from THIS row on every request
        // (sessions.ts `roleOf`), so a demotion is effective immediately —
        // including on already-open WebSockets, which revalidate. Said out
        // loud because the old behavior was the opposite: the role was frozen
        // at login time for up to the 30-day session TTL.
        out(
          mode === "json"
            ? { id, role, appliesToLiveSessions: true }
            : `${id} → role ${role} (live sessions included — no re-login)`,
          mode,
        );
        return;
      }
      case "totp": {
        need(" off");
        // The ONLY way back from a lost/stolen authenticator: enabling a
        // factor needs the account password (so a stolen session cannot enrol
        // one), and disabling needs it too — which leaves the operator, whose
        // credential is being able to read this app's data directory at all.
        // There are no user-held recovery codes; this is the recovery path.
        if (positional[1] !== "off") {
          outError(
            `usage: am auth totp <id> off  (there is no "on" — a user enrolls ` +
              `their own factor with their password)`,
            mode,
          );
          Deno.exit(1);
        }
        if (!users.get(id!)) {
          outError(`no such user: ${id}`, mode);
          Deno.exit(1);
        }
        const had = users.disableTotp(id!);
        // A pending TOTP login token outlives the factor it belongs to unless
        // it is burned here.
        users.purgeTokens(id!);
        out(
          mode === "json"
            ? { id, totp: false, cleared: had }
            : `${id} — second factor cleared${
              had ? "" : " (none was enrolled)"
            }`,
          mode,
        );
        return;
      }
      case "unlock": {
        need("");
        if (!users.unlock(id!)) {
          outError(`no such user: ${id}`, mode);
          Deno.exit(1);
        }
        out(`${id} unlocked`, mode);
        return;
      }
      case "verify": {
        need("");
        if (!users.markVerified(id!)) {
          outError(`no such user: ${id}`, mode);
          Deno.exit(1);
        }
        out(`${id} marked verified`, mode);
        return;
      }
      case "revoke": {
        need("");
        // The user must EXIST — its siblings (`unlock`, `rm`) already refuse a
        // name that is not there. `revoke` is the incident command: a typo'd
        // id reporting `{"sessionsRevoked":0}` and exit 0 reads as "done"
        // while the real account's sessions are still live.
        if (!users.get(id!)) {
          outError(`no such user: ${id}`, mode);
          Deno.exit(1);
        }
        const n = sessionStore().revokeUser(id!);
        // Sessions are not the only thing that authenticates: a reset token or
        // a TOTP `pending` captured before the revocation would mint a BRAND
        // NEW session afterwards. "Revoke everything" has to mean everything.
        const t = users.purgeTokens(id!);
        out(
          mode === "json"
            ? { id, sessionsRevoked: n, tokensBurned: t }
            : `revoked ${
              count(n, "session")
            } and ${t} pending token(s) for ${id}`,
          mode,
        );
        return;
      }
      case "rm": {
        need("");
        // `remove` IS the deletion: it revokes every session and burns every
        // outstanding one-shot token itself (the store is bound above), so
        // this command no longer repeats the rule. It used to — and the
        // programmatic door (`app.auth.remove`) was the copy that forgot.
        if (!users.remove(id!)) {
          outError(`no such user: ${id}`, mode);
          Deno.exit(1);
        }
        out(`${id} removed (sessions revoked)`, mode);
        return;
      }
      default:
        outError(`unknown auth subcommand: ${sub}\n\n${USAGE}`, mode);
        Deno.exit(1);
    }
  } finally {
    users.close();
    sessions.store?.close();
  }
}
