// `am auth revoke <id>` finds the account the way every other `am auth`
// subcommand does — NFC + trimmed (`normId`) — and must then revoke the
// sessions of THAT account. It passed the operator's raw spelling to
// `revokeUser`, an exact match on `sessions.user_id`, so `am auth revoke
// "alice "` (a stray space from a paste) found alice, revoked nothing, and
// reported `sessionsRevoked: 0` — the breach-response command saying "done"
// while every stolen session kept working.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assertEquals } from "@std/assert";
import { cmdAuth } from "../src/am/am-cmd-auth.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { openUserStore } from "../src/server/auth-users.ts";
import { openSessionStore } from "../src/server/sessions.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

Deno.test("am auth revoke: a padded id revokes the account's sessions", async () => {
  const home = await tempDir("am-auth-revoke-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", home);
  const appId = "app-revoke";
  try {
    await Deno.mkdir(appDirs(appId).data, { recursive: true });
    const dbPath = appDirs(appId).authDb;
    const sessions = openSessionStore(dbPath);
    const users = openUserStore(dbPath, { sessions: () => sessions });
    let tok = "";
    try {
      await users.create("alice", "correct-horse-9");
      tok = sessions.issue({ id: "alice", role: "user" });
    } finally {
      users.close();
      sessions.close();
    }

    const logs: string[] = [];
    const l = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      await cmdAuth(["revoke", "alice "], {
        app: appId,
        json: true,
      } as unknown as GlobalFlags);
    } finally {
      console.log = l;
    }
    const out = JSON.parse(logs.join("\n")) as { sessionsRevoked: number };
    assertEquals(out.sessionsRevoked, 1, "the one live session is revoked");

    const after = openSessionStore(dbPath);
    try {
      assertEquals(after.get(tok), null, "the session no longer resolves");
    } finally {
      after.close();
    }
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(home);
  }
});
