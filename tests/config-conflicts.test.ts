// Couplings: two config keys that are each valid and wrong TOGETHER.
//
// A key allowlist answers "is this a real option"; ENUM_VALUES answers "is this
// a real value". Neither can answer "do these two contradict each other", and
// an audit found fourteen live instances of that class — every one silent. Two
// cost data outright (an unverifiable account that can never log in; a journal
// that resolves to null under `persist: false`), the rest invert intent or
// leave an option inert.
//
// `configConflicts` is PURE, so each one is a table row rather than a boot the
// test has to survive.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetConfigConflicts,
  type ConfigConflict,
  configConflicts,
  ENUM_VALUES,
  unknownBuildKeys as unknownBuildKeysSync,
  VALID_AIO_CONFIG_KEYS,
  validateConfig,
} from "../src/server/config.ts";

const keysOf = (cs: ConfigConflict[]) => cs.map((c) => c.keys.join("+"));
const one = (cfg: Record<string, unknown>): ConfigConflict => {
  const cs = configConflicts(cfg);
  assertEquals(
    cs.length,
    1,
    `expected exactly one conflict, got ${keysOf(cs)}`,
  );
  return cs[0]!;
};

Deno.test("a config with no coupling problem reports nothing", () => {
  assertEquals(configConflicts({}), []);
  assertEquals(
    configConflicts({
      appId: "x",
      client: "electron",
      transport: "uds",
      journal: true,
      auth: { ttlMs: 1000 },
      updates: { source: "https://r.example.com/app", auto: true, check: true },
    }),
    [],
  );
});

// ── The two that cost data ───────────────────────────────────────────

Deno.test("auth.requireVerified without sendMail is refused — it is a lockout AND a lie", () => {
  const c = one({ auth: { requireVerified: true } });
  assertEquals(c.level, "error");
  assertEquals(c.keys, ["auth.requireVerified", "auth.sendMail"]);
  // The message names the lie (signup claims it sent something) and the
  // permanence (login 403s forever) — both are the reason this is fatal.
  assertStringIncludes(c.what, "verificationSent: true");
  assertStringIncludes(c.what, "403");
  assertStringIncludes(c.fix, "auth.sendMail");
  // …and a transport present makes it legal again.
  assertEquals(
    configConflicts({ auth: { requireVerified: true, sendMail: () => {} } }),
    [],
  );
});

Deno.test("journal: true with nothing to journal into is refused", () => {
  const noPersist = one({ journal: true, persist: false });
  assertEquals(noPersist.level, "error");
  assertEquals(noPersist.keys, ["journal", "persist"]);
  assertStringIncludes(noPersist.what, "resolves to null");

  const memory = one({ journal: true, dbPath: ":memory:" });
  assertEquals(memory.keys, ["journal", "dbPath"]);
  assertStringIncludes(memory.fix, "dbPath");

  // A real file, persistence on → nothing to say.
  assertEquals(configConflicts({ journal: true, dbPath: "/tmp/a.db" }), []);
  assertEquals(configConflicts({ journal: true }), []);
  // …and journal: false is never the subject of either message.
  assertEquals(configConflicts({ journal: false, persist: false }), []);
});

// ── Intent inverted ──────────────────────────────────────────────────

Deno.test("include AND exclude on one filter: exclude is dropped, so it is refused", () => {
  for (const kind of ["visible", "ui", "persist"]) {
    const c = one({
      cellDefaults: { [kind]: { include: ["a"], exclude: ["b"] } },
    });
    assertEquals(c.level, "error");
    assertEquals(c.keys, [
      `cellDefaults.${kind}.include`,
      `cellDefaults.${kind}.exclude`,
    ]);
    assertStringIncludes(c.what, "include wins");
  }
  // The consequence is said correctly per filter: a dropped `persist.exclude`
  // WRITES a secret to disk; a dropped `visible.exclude` SENDS it to clients.
  assertStringIncludes(
    one({ cellDefaults: { persist: { include: ["a"], exclude: ["b"] } } }).what,
    "written to the database",
  );
  assertStringIncludes(
    one({ cellDefaults: { visible: { include: ["a"], exclude: ["b"] } } }).what,
    "sent to every client",
  );
  // One at a time is the normal, correct spelling.
  assertEquals(
    configConflicts({ cellDefaults: { visible: { include: ["a"] } } }),
    [],
  );
  assertEquals(
    configConflicts({ cellDefaults: { visible: { exclude: ["b"] } } }),
    [],
  );
});

Deno.test("a `long` method given an explicit per-method timeout is refused", () => {
  const cells = [{ __aio: { id: "builds", longMethods: ["compile"] } }];
  const c = one({
    cells,
    perfBudget: { methods: { "builds:compile": { timeout: 600_000 } } },
  });
  assertEquals(c.level, "error");
  assertStringIncludes(c.what, "the explicit timeout wins");
  assertStringIncludes(c.what, "`long` does nothing");

  // A budget WITHOUT a timeout tunes the warning threshold only — that is the
  // documented way to keep `long` and still see slow calls, so it is legal.
  assertEquals(
    configConflicts({
      cells,
      perfBudget: { methods: { "builds:compile": { effect: 5_000 } } },
    }),
    [],
  );
  // …and a timeout on a method that is NOT long is exactly how you set one.
  assertEquals(
    configConflicts({
      cells,
      perfBudget: { methods: { "builds:other": { timeout: 1000 } } },
    }),
    [],
  );
});

Deno.test("takeover with no lock to take over is refused", () => {
  assertEquals(one({ takeover: true, singleton: false }).keys, [
    "takeover",
    "singleton",
  ]);
  assertEquals(one({ takeover: true, libraryMode: true }).keys, [
    "takeover",
    "libraryMode",
  ]);
  assertStringIncludes(
    one({ takeover: true, singleton: false }).what,
    "nothing is killed",
  );
  assertEquals(configConflicts({ takeover: true }), []);
  assertEquals(configConflicts({ takeover: true, singleton: true }), []);
});

Deno.test("singleton: true under libraryMode is refused — libraryMode silently wins", () => {
  const cs = configConflicts({ singleton: true, libraryMode: true });
  assert(cs.some((c) => c.keys.join("+") === "singleton+libraryMode"));
  assertStringIncludes(
    cs.find((c) => c.keys[0] === "singleton")!.what,
    "libraryMode wins",
  );
});

Deno.test('transport: "uds" is honoured as written — so a client that cannot speak it is refused', () => {
  for (const client of ["browser", "cli", "server-only"]) {
    const c = one({ transport: "uds", client });
    assertEquals(c.level, "error");
    assertStringIncludes(c.what, "cannot connect to");
    assertStringIncludes(c.fix, 'transport: "ws"');
  }
  assertEquals(configConflicts({ transport: "uds", client: "electron" }), []);
  // "auto" DOES downgrade for a browser client, so it is never the subject.
  assertEquals(configConflicts({ transport: "auto", client: "browser" }), []);
  assertEquals(configConflicts({ client: "browser" }), []);
});

Deno.test('transport: "uds" with expose serves nothing on the network', () => {
  const c = one({ transport: "uds", expose: true });
  assertEquals(c.keys, ["transport", "expose"]);
  assertStringIncludes(c.what, "local by definition");
});

Deno.test("serverUrl launches Electron whatever `client` says, so the pair is refused", () => {
  const c = one({ serverUrl: "http://host:8000", client: "browser" });
  assertEquals(c.level, "error");
  assertStringIncludes(c.what, "launches Electron regardless");
  // `""` is MEANINGFUL (--connect opens the connect page), so it is checked
  // for presence, never truthiness — a validator using `if (cfg.serverUrl)`
  // would wave the --connect case through.
  assertEquals(one({ serverUrl: "", client: "cli" }).keys, [
    "serverUrl",
    "client",
  ]);
  assertEquals(
    configConflicts({ serverUrl: "http://h:1", client: "electron" }),
    [],
  );
  assertEquals(configConflicts({ client: "browser" }), []);
});

// ── Inert options: loud, not fatal ───────────────────────────────────

Deno.test("updates.auto with check:false never polls — warned, not refused", () => {
  const c = one({
    updates: { source: "https://r/x", check: false, auto: true },
  });
  assertEquals(c.level, "warn");
  assertStringIncludes(c.what, "will not update itself");
  // It is a warn and not an error precisely because a manual `updates.check()`
  // still auto-applies — the combination is odd, not broken.
  assertEquals(
    configConflicts({ updates: { source: "https://r/x", check: false } }),
    [],
  );
});

Deno.test("ui.width/height are inert only where no window is ever opened", () => {
  for (const client of ["cli", "server-only"]) {
    const c = one({ ui: { width: 900 }, client });
    assertEquals(c.level, "warn");
    assertStringIncludes(c.what, "opens no window");
  }
  // NOT "outside Electron": the browser shell emits them as metas and the
  // WS-transport Electron launcher reads them back, so both are legitimate.
  assertEquals(configConflicts({ ui: { width: 900 }, client: "browser" }), []);
  assertEquals(configConflicts({ ui: { width: 900 }, client: "electron" }), []);
  assertEquals(configConflicts({ ui: { width: 900 } }), []);
});

Deno.test("a git update source ignores every manifest-trust option", () => {
  const c = one({
    updates: {
      source: "https://github.com/owner/repo",
      allowUnsigned: true,
      prerelease: true,
    },
  });
  assertEquals(c.level, "warn");
  assertEquals(c.keys, ["updates.allowUnsigned", "updates.prerelease"]);
  assertStringIncludes(c.what, "nothing to sign");
  // A manifest source reads all of them — nothing to say.
  assertEquals(
    configConflicts({
      updates: { source: "https://r.example.com/app/x", allowUnsigned: true },
    }),
    [],
  );
  // An AMBIGUOUS source is not this validator's business: classifySource
  // refuses it a moment later with its own message, and pre-empting that would
  // either duplicate the refusal or guess a kind.
  assertEquals(
    configConflicts({
      updates: { source: "not a url at all", allowUnsigned: true },
    }),
    [],
  );
});

Deno.test("two session TTLs: both set is refused, one set is warned", () => {
  const both = one({ sessions: { ttlMs: 1000 }, auth: { ttlMs: 2000 } });
  assertEquals(both.level, "error");
  assertStringIncludes(both.what, "neither wins outright");
  assertStringIncludes(both.what, "Max-Age");

  // sessions-only under built-in auth: tokens honour it, the COOKIE falls back
  // to a hardcoded 30 days, so the browser outlives the session.
  const onlyStore = one({ sessions: { ttlMs: 1000 }, auth: true });
  assertEquals(onlyStore.level, "warn");
  assertStringIncludes(onlyStore.fix, "1000");

  // No built-in auth → nothing issues a cookie, so nothing diverges.
  assertEquals(configConflicts({ sessions: { ttlMs: 1000 } }), []);
  assertEquals(configConflicts({ auth: { ttlMs: 2000 } }), []);
});

// ── Every conflict says CAUSE and FIX ────────────────────────────────

Deno.test("every conflict names a cause and an actionable fix", () => {
  const samples: Record<string, unknown>[] = [
    { auth: { requireVerified: true } },
    { journal: true, persist: false },
    { journal: true, dbPath: ":memory:" },
    { cellDefaults: { visible: { include: ["a"], exclude: ["b"] } } },
    { updates: { source: "https://r/x", check: false, auto: true } },
    {
      cells: [{ __aio: { id: "c", longMethods: ["m"] } }],
      perfBudget: { methods: { "c:m": { timeout: 1 } } },
    },
    { takeover: true, singleton: false },
    { singleton: true, libraryMode: true },
    { transport: "uds", client: "browser" },
    { transport: "uds", expose: true },
    { serverUrl: "x", client: "cli" },
    { ui: { height: 1 }, client: "cli" },
    { sessions: { ttlMs: 1 }, auth: { ttlMs: 2 } },
    { sessions: { ttlMs: 1 }, auth: true },
    { updates: { source: "https://github.com/o/r", key: {} } },
  ];
  const seen = new Set<string>();
  for (const cfg of samples) {
    const cs = configConflicts(cfg);
    assert(cs.length > 0, `no conflict for ${JSON.stringify(cfg)}`);
    for (const c of cs) {
      assert(c.keys.length > 0, "a conflict names the keys involved");
      // Cause: a sentence, not a label.
      assert(c.what.length > 40, `cause too thin: ${c.what}`);
      // Fix: actionable, and never a restatement of the cause.
      assert(c.fix.length > 20, `fix too thin: ${c.fix}`);
      assert(c.fix !== c.what);
      seen.add(c.keys.join("+"));
    }
  }
  // Every sample produced a DISTINCT coupling — no check silently shadows
  // another by matching first.
  assertEquals(seen.size, 14);
});

// ── The reporting half ───────────────────────────────────────────────

Deno.test("validateConfig refuses an error-level conflict and boots past a warn", () => {
  _resetConfigConflicts();
  let exited: number | null = null;
  const exit = ((c: number) => {
    exited = c;
    throw new Error("exit");
  }) as (c: number) => never;

  try {
    validateConfig(
      { journal: true, persist: false },
      VALID_AIO_CONFIG_KEYS,
      "AioConfig",
      exit,
    );
  } catch { /* the exit stub */ }
  assertEquals(exited, 1);

  // A warn-level conflict boots.
  _resetConfigConflicts();
  exited = null;
  validateConfig(
    { ui: { width: 1 }, client: "cli" },
    VALID_AIO_CONFIG_KEYS,
    "AioConfig",
    exit,
  );
  assertEquals(exited, null);
});

Deno.test("the `ui` pass never answers a question about two keys", () => {
  _resetConfigConflicts();
  // `validateConfig(config.ui, …, "ui")` sees { width } with no `client` beside
  // it. Half a config must not get an opinion — the top-level pass owns it.
  const cs = configConflicts({ width: 900 });
  assertEquals(cs, []);
});

Deno.test("a conflict is reported ONCE per process, not once per validateConfig call", () => {
  _resetConfigConflicts();
  const cfg = { ui: { width: 1 }, client: "cli" as const };
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    // aio.run() validates the CellsConfig on the way in and the composed
    // AioConfig on the way through — the same boot, the same conflict, twice.
    validateConfig(cfg, VALID_AIO_CONFIG_KEYS, "AioConfig");
    validateConfig(cfg, VALID_AIO_CONFIG_KEYS, "AioConfig");
  } finally {
    console.warn = origWarn;
  }
  const hits = warns.filter((w) => w.includes("opens no window"));
  assertEquals(hits.length, 1);
});

// ── ENUM_VALUES covers every enum-valued option ──────────────────────

Deno.test("client, transport, persistMode and perfCheck are value-checked", () => {
  for (
    const k of [
      "client",
      "transport",
      "persistMode",
      "perfCheck",
      "chrome",
      "theme",
    ]
  ) {
    assert(ENUM_VALUES[k], `${k} has no value allowlist`);
  }
  // The motivating case: capital E passes the key check, fails the launcher's
  // `=== "electron"`, and used to start a BROWSER app with no message at all.
  let exited: number | null = null;
  const exit = ((c: number) => {
    exited = c;
    throw new Error("exit");
  }) as (c: number) => never;
  try {
    validateConfig(
      { client: "Electron" },
      VALID_AIO_CONFIG_KEYS,
      "AioConfig",
      exit,
    );
  } catch { /* the exit stub */ }
  assertEquals(exited, 1);
});

// ── The deno.json `build: {}` block: the last config object with no gate ──

Deno.test("unknownBuildKeys: a misspelled build key is named, with the near miss", () => {
  const unknownBuildKeys = unknownBuildKeysSync;
  // The motivating typo: singular `target`. It built the DEFAULT target set and
  // said nothing, which reads as `--targets` being broken.
  assertEquals(unknownBuildKeys({ target: ["server"] }), [
    'build.target (did you mean "targets"?)',
  ]);
  assertEquals(unknownBuildKeys({ platform: ["linux-x64"] }), [
    'build.platform (did you mean "platforms"?)',
  ]);
  // A key with no near miss is still named — silence is the failure mode.
  assertEquals(unknownBuildKeys({ zzz: 1 }), ["build.zzz"]);
  // Every real key passes.
  assertEquals(
    unknownBuildKeys({
      targets: ["server", "electron"],
      platforms: ["linux-x64"],
      out: "dist",
      server: "https://h",
      ui: "App.tsx",
    }),
    [],
  );
  // Absent / array / non-object → nothing to say. `build` is optional.
  assertEquals(unknownBuildKeys(undefined), []);
  assertEquals(unknownBuildKeys(["server"]), []);
});

Deno.test("unknownBuildKeys: the object form of targets is checked one level deeper", () => {
  // A misspelled `entry` inside a target override is the same silence one level
  // down: the target builds, from the wrong module.
  assertEquals(
    unknownBuildKeysSync({
      targets: { server: { entery: "src/relay.ts" } },
    }),
    ['build.targets.server.entery (did you mean "entry"?)'],
  );
  assertEquals(
    unknownBuildKeysSync({
      targets: {
        agent: {
          kind: "electron",
          entry: "a.ts",
          ui: "A.tsx",
          name: "x",
          platforms: [],
        },
      },
    }),
    [],
  );
  // A typo too far from any real key is still NAMED — `nearestOf` only offers
  // a suggestion within two edits, and silence is the failure mode, not a
  // missing hint.
  assertEquals(
    unknownBuildKeysSync({ targets: { server: { entrypoint: "a" } } }),
    [
      "build.targets.server.entrypoint",
    ],
  );
  // The ARRAY form has no overrides to check.
  assertEquals(unknownBuildKeysSync({ targets: ["server"] }), []);
});
