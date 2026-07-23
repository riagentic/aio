// `am auth` — operator console for the built-in auth (AUTH-2/3).
//
//   am auth users                     list accounts (role, email, 2FA, locked)
//   am auth create <id> [--password=…] [--role=admin] [--email=…]
//   am auth passwd <id> [--password=…]     (omit --password → generate + print)
//   am auth role <id> <role>
//   am auth unlock <id>               clear a lockout (the rescue path)
//   am auth verify <id>               mark the email verified by hand
//   am auth revoke <id>               kill every session of a user
//   am auth rm <id>
//
// Works directly on the app's auth.db (data dir) — no running server needed,
// which is the whole point: this is how you get back in when you're locked
// out or seeding the first admin before the app ever boots.

import { join } from "@std/path";
import { resolveAmAppId } from "./am-utils.ts";
import { resolveDataDir } from "../server/paths.ts";
import { openUserStore, type UserStore } from "../server/auth-users.ts";
import { openSessionStore } from "../server/sessions.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";

const USAGE = `am auth — manage the built-in auth (auth: true) of this app

  am auth users                     list accounts
  am auth create <id> [--password=…] [--role=…] [--email=…]
  am auth passwd <id> [--password=…]
  am auth role <id> <role>
  am auth unlock <id>               clear a lockout
  am auth verify <id>               mark email verified
  am auth revoke <id>               revoke every session of a user
  am auth rm <id>

Omitting --password generates a strong one and prints it once.`;

/** Random 16-char password (a–z A–Z 0–9, ~95 bits) for --password-less flows. */
const generatePassword = (): string => {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += chars[b % chars.length];
  return s;
};

const flag = (args: string[], name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

export async function cmdAuth(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const [sub, ...rest] = args;
  if (!sub) {
    out(USAGE, mode);
    return;
  }

  // `--app` is a GLOBAL am flag; ignoring it here meant `am --app=other auth
  // add …` silently edited the CWD-inferred app's auth.db instead — writing
  // users into the wrong database. resolveAmAppId honours the flag and falls
  // back to the same inference chain every other command uses.
  const appId = resolveAmAppId(flags.app);
  const dbPath = join(resolveDataDir(appId), "auth.db");
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

  const users: UserStore = openUserStore(dbPath);
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
        if (!(await users.setPassword(id!, password))) {
          outError(`no such user: ${id}`, mode);
          Deno.exit(1);
        }
        users.unlock(id!); // a fresh password also clears any lockout
        out(
          mode === "json"
            ? {
              ok: true,
              password: flag(rest, "password") ? undefined : password,
            }
            : `password set for ${id}${
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
        out(`${id} → role ${role}`, mode);
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
        const sessions = openSessionStore(dbPath);
        try {
          const n = sessions.revokeUser(id!);
          out(`revoked ${n} session(s) for ${id}`, mode);
        } finally {
          sessions.close();
        }
        return;
      }
      case "rm": {
        need("");
        if (!users.remove(id!)) {
          outError(`no such user: ${id}`, mode);
          Deno.exit(1);
        }
        const sessions = openSessionStore(dbPath);
        try {
          sessions.revokeUser(id!);
        } finally {
          sessions.close();
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
  }
}
