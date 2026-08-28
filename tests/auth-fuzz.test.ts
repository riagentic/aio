// Seeded auth state-machine fuzzer — against a REAL booted server.
//
// Sibling of proxy-differential and transport-chaos: instead of walking one
// known sequence, it generates thousands of orderings of the things an account
// actually does (sign up, log in, get it wrong five times, rotate the password,
// ask for a reset, complete it, replay the token, enrol 2FA, revoke
// everything, unlock) and holds the server to the invariants that must survive
// ALL of them. Nothing is mocked: real HTTP, real PBKDF2, real SQLite, real
// TOTP codes.
//
// The invariants (checked after EVERY step, not at the end):
//
//   I1  a dead token never authenticates
//   I2  a live token authenticates as its own user and no other
//   I3  a password change / reset kills every prior session
//   I4  a stale password is never 200
//   I5  the current password is 200 or 423 — never 401
//   I6  reset tokens and TOTP pendings are strictly single-use
//   I7  failures on account A never lock account B
//   I8  one account per id
//   I9  a VALID credential is served even while the client key is over its
//       abuse budget          (the whole-app DoS — see auth-hardening)
//   I10 a second factor cannot be ENABLED without password re-auth
//       (the stolen-session takeover)
//   I11 a completed reset ends a lockout (the rescue actually rescues)
//   I12 a role change reaches sessions that are already open
//   I13 a DELETED account authenticates nowhere — no session, no one-shot
//       token, no password
//
// I9–I13 are the newest findings; they are here so the class cannot come
// back through a different door than the one it came in by.
//
// I13's op (`account-rm`) is the one this machine could not previously
// express: every op mutated an account that went on existing, so the
// programmatic delete — `app.auth.remove(id)`, the offboarding/ban door — was
// never walked, and it left every session of the deleted account authenticating
// with the role cached at login for the rest of the 30-day TTL.
//
// Knobs (see fuzz-seed.ts — an unreadable knob THROWS, never defaults):
//   FUZZ_SEED, FUZZ_ROUNDS (seeds), FUZZ_STEPS (ops per seed).

import { assert, assertEquals } from "@std/assert";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { _resetTotpReplay, totpCode } from "../src/server/auth-totp.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0x5eed1e55) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 2, 1);
const STEPS = fuzzEnvInt("FUZZ_STEPS", 22, 1);

const OPS = [
  "signup",
  "login",
  "login-wrong",
  "logout",
  "changepw",
  "reset-request",
  "reset",
  "reset-replay",
  "totp-enroll",
  "totp-login",
  "burst-wrong",
  "unlock",
  "revoke-all",
  "role-flip",
  "account-rm",
] as const;
type Op = typeof OPS[number];

/** What the fuzzer believes about one account. Every assertion compares the
 *  SERVER against this model, so a divergence is a bug in one of the two. */
interface Acct {
  id: string;
  password: string;
  stale: string[];
  email: string;
  /** Consecutive failures, and whether the 5-in-a-row lockout is active. */
  fails: number;
  locked: boolean;
  totp: { secret: string; enabled: boolean } | null;
  /** Tokens we believe still authenticate. */
  live: Set<string>;
  /** Unused reset tokens (mail-delivered). */
  resets: string[];
  /** Unused TOTP pendings from a half-completed login. */
  pendings: string[];
  role: string;
}

Deno.test({
  name: "auth fuzz: the account state machine, seeded, against a real server",
  async fn(t) {
    const { cell, aio } = await import("../mod.ts");
    const port = freePort();
    const base = `http://127.0.0.1:${port}`;
    const mail: string[] = [];
    _resetAuthFails();
    const app = await aio.run({
      cells: [cell("fuzzcell", { state: { n: 0 }, methods: {} })],
      appId: `test-authfuzz-${Deno.pid}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      auth: {
        sendMail: (m: { text: string }) => {
          mail.push(m.text);
        },
      },
      port,
      baseDir: await Deno.makeTempDir(),
    });
    // deno-lint-ignore no-explicit-any
    const users = (app as any).auth;
    // deno-lint-ignore no-explicit-any
    const sessions = (app as any).sessions;

    const post = async (
      path: string,
      body?: unknown,
      token?: string,
      // deno-lint-ignore no-explicit-any
    ): Promise<{ status: number; body: any }> => {
      const r = await fetch(`${base}/__aio/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    const me = async (token: string): Promise<
      { id: string; role: string } | null
    > => {
      const r = await fetch(`${base}/__aio/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return (await r.json()).user;
    };
    /** Fresh code for a secret. The ±1-step replay memory is a real control
     *  (tested in auth-security-regression); here it only stands in for the
     *  passage of time, so it is cleared rather than worked around. */
    const code = async (secret: string): Promise<string> => {
      _resetTotpReplay();
      return await totpCode(secret);
    };

    let failures = 0;
    let ops = 0;
    try {
      for (let round = 0; round < ROUNDS; round++) {
        let seed = (SEED + round * 7919) & 0x7fffffff;
        const rnd = () =>
          (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const pick = <T>(xs: readonly T[]): T =>
          xs[Math.floor(rnd() * xs.length)]!;

        const accts: Acct[] = [];
        /** Ids minted this round — monotonic, so a deleted id is never reused. */
        let minted = 0;
        /** Accounts this round DELETED — nothing about them may still work. */
        const gone: Acct[] = [];
        const dead = new Map<string, string>(); // token → owner id
        const log: string[] = [];
        const note = (s: string) => log.push(s);

        /** A password change / reset / revoke kills every session AND every
         *  outstanding one-shot token of that account (I3, I6). */
        const rotate = (a: Acct, newPw?: string): void => {
          for (const tk of a.live) dead.set(tk, a.id);
          a.live.clear();
          a.resets.length = 0;
          a.pendings.length = 0;
          if (newPw !== undefined) {
            a.stale.push(a.password);
            a.password = newPw;
            // A password that has come BACK into use is not stale. (The
            // fuzzer's own bookkeeping, not the server's: without this, an op
            // that reuses a literal reports its own history as a violation.)
            a.stale = a.stale.filter((p) => p !== newPw);
            a.fails = 0;
            a.locked = false; // I11 — the rescue rescues
          }
        };

        const step = async (op: Op): Promise<void> => {
          const a = accts.length > 0 ? pick(accts) : null;
          switch (op) {
            case "signup": {
              // MONOTONIC, never `accts.length`: an id derived from the live
              // count is REUSED after a deletion, so a fresh account inherits
              // a dead one's name and every "is it really gone?" assertion
              // becomes a coin flip. (This is the fuzzer's own bookkeeping —
              // it showed up the moment `account-rm` joined the op set.)
              const id = `u${round}_${minted++}`;
              const pw = `password-${id}-1`;
              const r = await post("signup", {
                id,
                password: pw,
                email: `${id}@example.test`,
              });
              if (r.status === 429) return; // budget — not an account outcome
              assertEquals(r.status, 201, `signup ${id}: ${r.body?.error}`);
              const acct: Acct = {
                id,
                password: pw,
                stale: [],
                email: `${id}@example.test`,
                fails: 0,
                locked: false,
                totp: null,
                live: new Set([r.body.token]),
                resets: [],
                pendings: [],
                role: "user",
              };
              accts.push(acct);
              // I8 — a second signup on the same id is a conflict, never a
              // second account.
              const dup = await post("signup", { id, password: pw });
              assert(
                dup.status === 409 || dup.status === 429,
                `duplicate signup answered ${dup.status}`,
              );
              note(`signup ${id}`);
              return;
            }
            case "login": {
              if (!a) return;
              _resetAuthFails();
              const r = await post("login", { id: a.id, password: a.password });
              if (a.locked) {
                assertEquals(r.status, 423, `${a.id} locked → 423`);
                return;
              }
              // I5 — the CURRENT password is never 401.
              assertEquals(
                r.status,
                200,
                `${a.id} current password answered ${r.status} ${r.body?.error}`,
              );
              a.fails = 0;
              if (a.totp?.enabled) {
                assertEquals(r.body.totpRequired, true, "factor not bypassed");
                a.pendings.push(r.body.pending);
              } else {
                a.live.add(r.body.token);
              }
              note(`login ${a.id}`);
              return;
            }
            case "login-wrong": {
              if (!a) return;
              _resetAuthFails();
              const r = await post("login", {
                id: a.id,
                password: `wrong-${Math.floor(rnd() * 1e6)}`,
              });
              assertEquals(r.status, 401, "a wrong password is 401");
              if (!a.locked && ++a.fails >= 5) {
                a.fails = 0;
                a.locked = true;
              }
              note(`wrong ${a.id} (fails=${a.fails} locked=${a.locked})`);
              return;
            }
            case "logout": {
              if (!a || a.live.size === 0) return;
              const tk = pick([...a.live]);
              const r = await post("logout", undefined, tk);
              assertEquals(r.status, 200);
              a.live.delete(tk);
              dead.set(tk, a.id);
              note(`logout ${a.id}`);
              return;
            }
            case "changepw": {
              if (!a || a.live.size === 0 || a.locked) return;
              _resetAuthFails();
              const tk = pick([...a.live]);
              const next = `password-${a.id}-${Math.floor(rnd() * 1e6)}`;
              const r = await post("password", {
                old: a.password,
                new: next,
              }, tk);
              assertEquals(r.status, 200, `changepw: ${r.body?.error}`);
              rotate(a, next);
              a.live.add(r.body.token); // the caller keeps a fresh session
              note(`changepw ${a.id}`);
              return;
            }
            case "reset-request": {
              if (!a) return;
              _resetAuthFails();
              mail.length = 0;
              const r = await post("reset/request", { id: a.id });
              assertEquals(r.status, 200, "never enumerates");
              const tok = /aiot_[0-9a-f]+/.exec(mail.join("\n"))?.[0];
              if (tok) a.resets.push(tok);
              note(`reset-request ${a.id}`);
              return;
            }
            case "reset": {
              if (!a || a.resets.length === 0) return;
              const tok = a.resets.shift()!;
              const next = `password-${a.id}-r${Math.floor(rnd() * 1e6)}`;
              const r = await post("reset", { token: tok, password: next });
              assertEquals(r.status, 200, `reset: ${r.body?.error}`);
              rotate(a, next);
              dead.set(`used-reset:${tok}`, a.id); // remembered below
              // I6 — the token is spent.
              const again = await post("reset", {
                token: tok,
                password: "another-password-9",
              });
              assertEquals(again.status, 401, "a reset token is single-use");
              // I11 — the lockout is over, right now, with the new password.
              _resetAuthFails();
              const li = await post("login", { id: a.id, password: next });
              assert(
                li.status === 200,
                `a completed reset must end the lockout, got ${li.status}`,
              );
              if (a.totp?.enabled) a.pendings.push(li.body.pending);
              else a.live.add(li.body.token);
              note(`reset ${a.id}`);
              return;
            }
            case "reset-replay": {
              if (!a || a.resets.length === 0) return;
              // A token that was invalidated by a later rotation must be dead
              // even though it was never used.
              const tok = a.resets[0]!;
              const replayed = `password-${a.id}-x${Math.floor(rnd() * 1e6)}`;
              const r = await post("reset", { token: tok, password: replayed });
              assert(
                r.status === 200 || r.status === 401,
                `reset answered ${r.status}`,
              );
              a.resets.shift();
              if (r.status === 200) rotate(a, replayed);
              note(`reset-replay ${a.id} → ${r.status}`);
              return;
            }
            case "totp-enroll": {
              if (!a || a.live.size === 0 || a.totp?.enabled || a.locked) {
                return;
              }
              const tk = pick([...a.live]);
              _resetAuthFails();
              const s = await post("totp/setup", undefined, tk);
              if (s.status !== 200) return;
              const secret = s.body.secret as string;
              // I10 — a session alone cannot turn the factor on.
              const noPw = await post("totp/enable", {
                code: await code(secret),
              }, tk);
              assert(
                noPw.status !== 200,
                "enabling a factor must require the password",
              );
              const wrongPw = await post("totp/enable", {
                code: await code(secret),
                password: "definitely-not-it",
              }, tk);
              assert(
                wrongPw.status !== 200,
                "a wrong password must not enable a factor",
              );
              const ok = await post("totp/enable", {
                code: await code(secret),
                password: a.password,
              }, tk);
              // BOTH probes above are real password verifies, and the model
              // has to move with them or it drifts out of step with the
              // server: the wrong one feeds the SAME per-account counter a
              // failed login feeds (locking at the 5th, counter back to 0),
              // and the correct one CLEARS that counter. Tracking neither
              // left the model predicting a lockout the server had already
              // reset — a false "u_ locked → 423" that only appears on long
              // walks (found at FUZZ_STEPS=60, invisible at the default 22).
              if (wrongPw.status !== 200 && !a.locked && ++a.fails >= 5) {
                a.fails = 0;
                a.locked = true;
              }
              if (ok.status === 200) {
                a.totp = { secret, enabled: true };
                a.fails = 0;
              }
              note(`totp-enroll ${a.id} → ${ok.status}`);
              return;
            }
            case "totp-login": {
              if (!a || a.pendings.length === 0 || !a.totp) return;
              const pending = a.pendings.shift()!;
              const r = await post("totp", {
                pending,
                code: await code(a.totp.secret),
              });
              assertEquals(r.status, 200, `totp: ${r.body?.error}`);
              a.live.add(r.body.token);
              // I6 — the pending is spent.
              const again = await post("totp", {
                pending,
                code: await code(a.totp.secret),
              });
              assertEquals(again.status, 401, "a pending is single-use");
              note(`totp-login ${a.id}`);
              return;
            }
            case "burst-wrong": {
              if (!a) return;
              // Enough failures to exhaust the per-IP budget as well as the
              // account's own counter.
              for (let i = 0; i < 12; i++) {
                const r = await post("login", {
                  id: a.id,
                  password: `burst-${i}-${Math.floor(rnd() * 1e6)}`,
                });
                assert(
                  r.status === 401 || r.status === 429,
                  `burst answered ${r.status}`,
                );
                if (r.status === 401 && !a.locked && ++a.fails >= 5) {
                  a.fails = 0;
                  a.locked = true;
                }
              }
              // I9 — with the budget exhausted, a credential the victim
              // ALREADY holds still works. (This is the whole-app DoS.)
              for (const other of accts) {
                for (const tk of other.live) {
                  const r = await fetch(base + "/", {
                    headers: { authorization: `Bearer ${tk}` },
                  });
                  await r.body?.cancel();
                  assertEquals(
                    r.status,
                    200,
                    "a valid session must be served over budget",
                  );
                }
              }
              const anon = await fetch(base + "/");
              await anon.body?.cancel();
              assertEquals(anon.status, 200, "the public shell stays public");
              _resetAuthFails();
              note(`burst-wrong ${a.id} (locked=${a.locked})`);
              return;
            }
            case "unlock": {
              if (!a) return;
              users.unlock(a.id);
              a.fails = 0;
              a.locked = false;
              note(`unlock ${a.id}`);
              return;
            }
            case "revoke-all": {
              if (!a) return;
              sessions.revokeUser(a.id);
              users.purgeTokens(a.id);
              rotate(a);
              note(`revoke-all ${a.id}`);
              return;
            }
            case "role-flip": {
              if (!a || a.live.size === 0) return;
              // I12 — resolved from the users row at USE time, so an open
              // session inherits it without re-login.
              const next = a.role === "admin" ? "user" : "admin";
              users.setRole(a.id, next);
              a.role = next;
              for (const tk of a.live) {
                const who = await me(tk);
                assertEquals(who?.role, next, "live session sees the new role");
              }
              note(`role-flip ${a.id} → ${next}`);
              return;
            }
            case "account-rm": {
              // The offboarding / ban door, taken PROGRAMMATICALLY
              // (`app.auth.remove`) — not through `am auth rm`, which had
              // always remembered to revoke afterwards and so hid this.
              // Deleting an account ends it: sessions dead, one-shot tokens
              // burned, password useless (I13, and I1 for the tokens).
              if (!a || accts.length < 2) return; // keep one account alive
              assert(users.remove(a.id), `remove ${a.id}`);
              for (const tk of a.live) dead.set(tk, a.id);
              a.live.clear();
              a.resets.length = 0;
              a.pendings.length = 0;
              accts.splice(accts.indexOf(a), 1);
              gone.push(a);
              note(`account-rm ${a.id}`);
              return;
            }
          }
        };

        /** The invariants that hold after EVERY step. */
        const check = async (): Promise<void> => {
          // I1 — dead tokens are dead, forever.
          for (const [tk, owner] of dead) {
            if (tk.startsWith("used-reset:")) continue;
            assertEquals(await me(tk), null, `dead token of ${owner} revived`);
          }
          for (const a of accts) {
            // I2 — a live token is that user, and only that user.
            for (const tk of a.live) {
              const who = await me(tk);
              assertEquals(who?.id, a.id, `token of ${a.id} resolved wrong`);
              assertEquals(who?.role, a.role);
            }
            // I8 — one row per id, always.
            assertEquals(users.get(a.id)?.id, a.id);
          }
          assertEquals(
            users.count(),
            accts.length,
            "one account per id — no duplicates, no ghosts",
          );
          // I13 — a deleted account authenticates NOWHERE. Its sessions are
          // covered by I1 above (they are in `dead`); this is the rest of it:
          // no row, and its password cannot log in again.
          for (const g of gone) {
            assertEquals(users.get(g.id), null, `${g.id} came back`);
            _resetAuthFails();
            const r = await post("login", { id: g.id, password: g.password });
            assertEquals(
              r.status,
              401,
              `a deleted account (${g.id}) still logs in`,
            );
          }
          // I4 — a stale password is never accepted (checked on one account
          // per step to keep the PBKDF2 cost sane).
          const a = accts.length ? pick(accts) : null;
          if (a && a.stale.length) {
            _resetAuthFails();
            const r = await post("login", {
              id: a.id,
              password: pick(a.stale),
            });
            assert(
              r.status === 401,
              `a stale password answered ${r.status} for ${a.id}`,
            );
            // The probe is itself a failed login — model it, or the account
            // lockout the NEXT assertion predicts will be off by one.
            if (!a.locked && ++a.fails >= 5) {
              a.fails = 0;
              a.locked = true;
            }
          }
          // I7 — a lockout is per account: an unlocked account still works.
          const free = accts.find((x) => !x.locked && x !== a);
          if (free) {
            _resetAuthFails();
            const r = await post("login", {
              id: free.id,
              password: free.password,
            });
            assertEquals(
              r.status,
              200,
              `${free.id} was collateral damage of another account's failures`,
            );
            free.fails = 0; // a success clears the counter, server-side too
            if (free.totp?.enabled) free.pendings.push(r.body.pending);
            else free.live.add(r.body.token);
          }
        };

        for (let i = 0; i < STEPS; i++) {
          const op: Op = accts.length === 0 ? "signup" : pick(OPS);
          try {
            await step(op);
            await check();
            ops++;
          } catch (e) {
            failures++;
            throw new Error(
              `seed ${SEED + round * 7919} step ${i} op=${op}\n` +
                `history:\n  ${log.join("\n  ")}\n\n${
                  e instanceof Error ? e.message : e
                }`,
              { cause: e },
            );
          }
        }
        // Clean slate between seeds: every account of this round is removed so
        // the next round's model starts from an empty store. `remove` revokes
        // the sessions itself — this used to say so twice, and the copy that
        // mattered (`app.auth.remove`) said it nowhere.
        for (const a of accts) users.remove(a.id);
      }
      await t.step(`${ops} ops over ${ROUNDS} seed(s), 0 violations`, () => {
        assertEquals(failures, 0);
      });
    } finally {
      _resetAuthFails();
      _resetTotpReplay();
      await app.close();
    }
  },
});
