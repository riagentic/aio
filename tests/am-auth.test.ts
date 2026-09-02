// `am auth` — the operator console, and the only way back in.
//
// This command works directly on the app's auth.db with no server running,
// which is the whole point: it seeds the first admin before the app has ever
// booted, and it is what you reach for when you are locked out. It had NO test
// (26% covered), so every breach-response guarantee its comments state — "the
// password change itself revokes every session", "revoke everything has to mean
// everything", "a demotion is effective immediately" — was prose.
//
// The store beneath it is well covered (tests/auth-flows.test.ts and friends).
// What is asserted here is the CLI layer: that the operator's command actually
// reaches those guarantees, that it edits the app it was asked to, and that the
// generated password is one a person can be handed.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { _generatePassword, cmdAuth } from "../src/am/am-cmd-auth.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { openUserStore } from "../src/server/auth-users.ts";
import { openSessionStore } from "../src/server/sessions.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

type Run = { logs: string[]; errors: string[]; code: number | null };

/** `detectMode` answers "json" for a pipe, and a test is a pipe — so the JSON
 *  branch is what runs unless `tty` says otherwise. */
async function run(
  args: string[],
  opts: { app: string; tty?: boolean } = { app: "" },
): Promise<Run> {
  const logs: string[] = [], errors: string[] = [];
  const l = console.log, e = console.error, realExit = Deno.exit;
  const realIsTerminal = Deno.stdout.isTerminal;
  if (opts.tty) Deno.stdout.isTerminal = () => true;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  let code: number | null = null;
  try {
    await cmdAuth(args, { app: opts.app } as unknown as GlobalFlags);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    code = err.code;
  } finally {
    console.log = l;
    console.error = e;
    Deno.exit = realExit;
    Deno.stdout.isTerminal = realIsTerminal;
  }
  return { logs, errors, code };
}

const json = <T>(r: Run): T => JSON.parse(r.logs.join("\n")) as T;

/** A home with one app whose auth.db exists — the state `am auth` requires. */
async function withApp(
  fn: (appId: string) => Promise<void>,
  appIds: string[] = ["app-a"],
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "am-auth-" });
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", home);
  try {
    for (const id of appIds) {
      await Deno.mkdir(appDirs(id).data, { recursive: true });
      // Opening the store creates the file and its schema.
      openUserStore(appDirs(id).authDb).close();
    }
    await fn(appIds[0]!);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}

// ── the generated password ───────────────────────────────────

Deno.test("am auth: the generated password draws from a uniform alphabet", () => {
  // `byte % 62` maps 0–7 five times over and 8–61 four: the first eight
  // letters would come up ~25% more often. Sixteen characters is not enough to
  // see that in one password, so this counts a lot of them.
  const counts = new Map<string, number>();
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const pw = _generatePassword();
    assertEquals(pw.length, 16, "the password must be 16 characters");
    for (const c of pw) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  assertEquals(counts.size, 62, "some characters never appear");

  const expected = (N * 16) / 62;
  // A biased draw puts 'a'–'h' at 1.25× the rest. The band below is far wider
  // than sampling noise at this N (σ ≈ 0.4% of expected) and far tighter than
  // the bias it rejects.
  const biased = [...counts.entries()].filter(([, n]) =>
    n > expected * 1.12 || n < expected * 0.88
  );
  assertEquals(
    biased.map(([c, n]) => `${c}:${(n / expected).toFixed(2)}×`),
    [],
    "the alphabet is not uniform",
  );

  // …and the low eight in particular, which is where the modulo bias lands.
  const low = "abcdefgh".split("").reduce(
    (s, c) => s + (counts.get(c) ?? 0),
    0,
  );
  const rest = (N * 16) - low;
  const lowPer = low / 8, restPer = rest / 54;
  assert(
    lowPer / restPer < 1.08,
    `'a'–'h' appear ${(lowPer / restPer).toFixed(3)}× as often as the rest`,
  );
});

// ── it edits the app you asked for ───────────────────────────

Deno.test("am auth: --app decides which database is written", async () => {
  await withApp(async () => {
    // The recorded bug: `am --app=other auth create …` wrote into the app
    // inferred from the CWD instead.
    await run(["create", "alice", "--password=correct-horse-9"], {
      app: "app-b",
    });

    const b = openUserStore(appDirs("app-b").authDb);
    const a = openUserStore(appDirs("app-a").authDb);
    try {
      assertEquals(b.list().map((u) => u.id), ["alice"]);
      assertEquals(a.list().map((u) => u.id), [], "wrote into the wrong app");
    } finally {
      b.close();
      a.close();
    }
  }, ["app-a", "app-b"]);
});

Deno.test("am auth: an app with no auth.db is refused by name, with the fix", async () => {
  await withApp(async () => {
    const r = await run(["users"], { app: "never-booted" });
    assertEquals(r.code, 1);
    const said = r.logs.join("\n") + r.errors.join("\n");
    assertStringIncludes(said, "never-booted");
    assertStringIncludes(said, "auth: true");
  });
});

// ── the breach-response guarantees ───────────────────────────

Deno.test("am auth passwd: clears the lockout AND revokes every session", async () => {
  await withApp(async (appId) => {
    const dbPath = appDirs(appId).authDb;
    const sessions = openSessionStore(dbPath);
    const users = openUserStore(dbPath, { sessions: () => sessions });
    let sid: string;
    try {
      await users.create("alice", "correct-horse-9");
      // An attacker's live session.
      sid = sessions.issue({ id: "alice", role: "user" });
      assert(sessions.get(sid), "the session did not take");
    } finally {
      users.close();
      sessions.close();
    }

    const r = await run(["passwd", "alice"], { app: appId });
    const out = json<
      {
        ok: boolean;
        unlocked: boolean;
        sessionsRevoked: boolean;
        password?: string;
      }
    >(r);
    assertEquals(out.ok, true);
    assertEquals(out.unlocked, true);
    assertEquals(out.sessionsRevoked, true);
    assert(
      out.password && out.password.length === 16,
      "no password handed back",
    );

    const after = openSessionStore(dbPath);
    try {
      assertEquals(
        after.get(sid!),
        null,
        "the attacker's session survived the breach-response command",
      );
    } finally {
      after.close();
    }
  });
});

Deno.test("am auth passwd: a supplied password is never echoed back", async () => {
  await withApp(async (appId) => {
    const s = openUserStore(appDirs(appId).authDb);
    try {
      await s.create("alice", "correct-horse-9");
    } finally {
      s.close();
    }
    const r = await run(["passwd", "alice", "--password=hunter2-hunter2"], {
      app: appId,
    });
    const out = json<{ password?: string }>(r);
    assertEquals(
      out.password,
      undefined,
      "a password the operator typed was echoed back into the output",
    );
    assert(
      !r.logs.join("\n").includes("hunter2"),
      "the supplied password appears in the output",
    );
  });
});

Deno.test("am auth revoke: burns pending tokens as well as sessions", async () => {
  await withApp(async (appId) => {
    const dbPath = appDirs(appId).authDb;
    const sessions = openSessionStore(dbPath);
    const users = openUserStore(dbPath, { sessions: () => sessions });
    try {
      await users.create("alice", "correct-horse-9");
      sessions.issue({ id: "alice", role: "user" });
      sessions.issue({ id: "alice", role: "user" });
    } finally {
      users.close();
      sessions.close();
    }

    const out = json<{ sessionsRevoked: number; tokensBurned: number }>(
      await run(["revoke", "alice"], { app: appId }),
    );
    // "Revoke everything has to mean everything": a reset token captured
    // beforehand would otherwise mint a brand new session afterwards.
    assertEquals(out.sessionsRevoked, 2);
    assert(typeof out.tokensBurned === "number");
  });
});

Deno.test("am auth role: the change reaches live sessions, and says so", async () => {
  await withApp(async (appId) => {
    const s = openUserStore(appDirs(appId).authDb);
    try {
      await s.create("alice", "correct-horse-9");
    } finally {
      s.close();
    }
    const out = json<{ role: string; appliesToLiveSessions: boolean }>(
      await run(["role", "alice", "admin"], { app: appId }),
    );
    assertEquals(out.role, "admin");
    assertEquals(out.appliesToLiveSessions, true);

    const check = openUserStore(appDirs(appId).authDb);
    try {
      assertEquals(check.get("alice")?.role, "admin");
    } finally {
      check.close();
    }
  });
});

Deno.test("am auth totp: there is no `on`, and the refusal explains why", async () => {
  await withApp(async (appId) => {
    const s = openUserStore(appDirs(appId).authDb);
    try {
      await s.create("alice", "correct-horse-9");
    } finally {
      s.close();
    }
    const r = await run(["totp", "alice", "on"], { app: appId });
    assertEquals(r.code, 1);
    const said = r.logs.join("\n") + r.errors.join("\n");
    assertStringIncludes(said, "there is no");
    assertStringIncludes(said, "password");

    // …and `off` is the recovery path for a lost device.
    // `cleared` answers "was a factor removed", not "does this user exist".
    // It used to answer the latter, so a lost-device recovery reported a
    // second factor cleared on an account that never had one — implying the
    // account had been protected, at the worst possible moment to imply it.
    const ok = json<{ totp: boolean; cleared: boolean }>(
      await run(["totp", "alice", "off"], { app: appId }),
    );
    assertEquals(ok.totp, false);
    assertEquals(ok.cleared, false, "no factor was enrolled");
    assertStringIncludes(
      (await run(["totp", "alice", "off"], { app: appId, tty: true }))
        .logs.join("\n"),
      "none was enrolled",
    );

    // …and with a factor actually enrolled, it says the opposite.
    const store = openUserStore(appDirs(appId).authDb);
    try {
      store.setTotpSecret("alice", "JBSWY3DPEHPK3PXP");
      store.enableTotp("alice");
    } finally {
      store.close();
    }
    const had = json<{ cleared: boolean }>(
      await run(["totp", "alice", "off"], { app: appId }),
    );
    assertEquals(
      had.cleared,
      true,
      "an enrolled factor was not reported cleared",
    );
  });
});

Deno.test("am auth rm: removing a user revokes their sessions", async () => {
  await withApp(async (appId) => {
    const dbPath = appDirs(appId).authDb;
    const sessions = openSessionStore(dbPath);
    const users = openUserStore(dbPath, { sessions: () => sessions });
    let sid: string;
    try {
      await users.create("alice", "correct-horse-9");
      sid = sessions.issue({ id: "alice", role: "user" });
    } finally {
      users.close();
      sessions.close();
    }

    await run(["rm", "alice"], { app: appId });

    const s2 = openUserStore(dbPath);
    const sess2 = openSessionStore(dbPath);
    try {
      assertEquals(s2.get("alice"), null);
      assertEquals(sess2.get(sid!), null, "a deleted user kept a live session");
    } finally {
      s2.close();
      sess2.close();
    }
  });
});

// ── the plumbing ─────────────────────────────────────────────

Deno.test("am auth users: empty and populated, in both renderings", async () => {
  await withApp(async (appId) => {
    assertEquals(json<unknown[]>(await run(["users"], { app: appId })), []);

    const s = openUserStore(appDirs(appId).authDb);
    try {
      await s.create("alice", "correct-horse-9", { role: "admin" });
    } finally {
      s.close();
    }

    const rows = json<{ id: string; role: string }[]>(
      await run(["users"], { app: appId }),
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.id, "alice");
    assertEquals(rows[0]!.role, "admin");

    const human = await run(["users"], { app: appId, tty: true });
    assertStringIncludes(human.logs.join("\n"), "alice");
    assertStringIncludes(human.logs.join("\n"), "admin");
  });
});

Deno.test("am auth: every subcommand refuses a user that is not there", async () => {
  await withApp(async (appId) => {
    for (
      const args of [
        ["passwd", "ghost"],
        ["role", "ghost", "admin"],
        ["unlock", "ghost"],
        ["verify", "ghost"],
        ["totp", "ghost", "off"],
        ["rm", "ghost"],
      ]
    ) {
      const r = await run(args, { app: appId });
      assertEquals(r.code, 1, `\`am auth ${args.join(" ")}\` did not fail`);
      const said = r.logs.join("\n") + r.errors.join("\n");
      assertStringIncludes(said, "ghost");
    }
  });
});

Deno.test("am auth: an unknown subcommand prints the usage it belongs to", async () => {
  await withApp(async (appId) => {
    const r = await run(["promote", "alice"], { app: appId });
    assertEquals(r.code, 1);
    const said = r.logs.join("\n") + r.errors.join("\n");
    assertStringIncludes(said, "promote");
    assertStringIncludes(said, "am auth users");
  });
});

Deno.test("am auth: a subcommand that needs an id says so", async () => {
  await withApp(async (appId) => {
    const r = await run(["passwd"], { app: appId });
    assertEquals(r.code, 1);
    assertStringIncludes(
      r.logs.join("\n") + r.errors.join("\n"),
      "am auth passwd <id>",
    );
  });
});
