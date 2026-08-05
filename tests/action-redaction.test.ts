// Redaction is a promise about EVERY place aio records an action, or it is not
// a promise at all.
//
// The bug this file exists for: `journal: true` wrote a
// wallet's unlock passphrase to `vault.db.journal` in cleartext, next to the
// AES-GCM vault it opens and inside every backup of it. Redaction was added —
// to the journal. The same passphrase stayed in the in-memory timeline, which
// `am timeline` prints and which no lock-and-wipe can reach, and in
// `logs/actions.jsonl` if diagnostics had ever been on.
//
// So the load-bearing test here is not "the journal redacts". It is: after a
// redacted action, the secret appears in NO sink. A half-covered redaction is
// worse than none, because it is believed.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { makeRedactor, REDACTED } from "../src/diagnostics/redact.ts";
import { createJournal } from "../src/server/journal.ts";
import { createTimeline } from "../src/server/timeline.ts";
import { purgeDisabledArtifacts } from "../src/diagnostics/mod.ts";

const SECRET = "correct-horse-battery-staple";

// ── The predicate ────────────────────────────────────────────────────

Deno.test("redactor: exact types, prefix wildcard, and nothing by default", () => {
  const none = makeRedactor();
  assertEquals(none("vault:unlock"), false);
  assertEquals(makeRedactor([])("vault:unlock"), false);

  const exact = makeRedactor(["vault:unlock"]);
  assertEquals(exact("vault:unlock"), true);
  assertEquals(exact("vault:unlockWithFile"), false, "exact means exact");
  assertEquals(exact("other:unlock"), false);

  // The wildcard is the point: a list of individual method names is the list
  // that goes stale the day someone adds `unlockWithFile`, and a stale
  // redaction list fails OPEN, in silence.
  const wild = makeRedactor(["vault:*"]);
  assertEquals(wild("vault:unlock"), true);
  assertEquals(wild("vault:unlockWithFile"), true);
  assertEquals(wild("wallet:send"), false);

  const both = makeRedactor(["vault:*", "user:setPassword"]);
  assertEquals(both("vault:x"), true);
  assertEquals(both("user:setPassword"), true);
  assertEquals(both("user:setName"), false);
});

// ── Sink 1: the journal (disk) ───────────────────────────────────────

Deno.test("journal: a redacted action keeps its sequence, loses its payload", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-redact-j-" });
  try {
    const path = `${dir}/app.journal`;
    const j = createJournal(path, { redact: makeRedactor(["vault:*"]) });
    j.append({ type: "vault:unlock", payload: { args: [SECRET] } }, 1000);
    const seq = j.append(
      { type: "notes:add", payload: { args: ["hi"] } },
      1001,
    );

    const raw = await Deno.readTextFile(path);
    assert(!raw.includes(SECRET), `the secret reached disk:\n${raw}`);
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    // Replay ordering is the journal's whole job — redaction must not disturb it.
    assertEquals(lines.map((l) => l.seq), [1, 2]);
    assertEquals(seq, 2);
    assertEquals(lines[0].type, "vault:unlock", "the action still happened");
    assertEquals(lines[0].ts, 1000);
    assertEquals(lines[0].payload, REDACTED);
    assertEquals(
      lines[1].payload.args[0],
      "hi",
      "unlisted actions are untouched",
    );

    // Owner-only: a world-readable copy of recent payloads is a leak of its own.
    if (Deno.build.os !== "windows") {
      const mode = (await Deno.stat(path)).mode! & 0o777;
      assertEquals(mode, 0o600, "the journal must not be group/world readable");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Sink 2: the timeline (memory, `am timeline`) ─────────────────────

Deno.test("timeline: a redacted action loses its payload AND its diff values", () => {
  const tl = createTimeline(10, makeRedactor(["vault:*"]));
  tl.record(
    1,
    "vault:unlock",
    { args: [SECRET] },
    { vault: { key: null, open: false } },
    { vault: { key: SECRET, open: true } },
    1000,
  );
  tl.record(
    2,
    "notes:add",
    { args: ["hi"] },
    { notes: [] },
    { notes: ["hi"] },
    1001,
  );

  const [unlock, note] = tl.entries() as [
    ReturnType<typeof tl.entries>[number],
    ReturnType<typeof tl.entries>[number],
  ];
  const dump = JSON.stringify(tl.entries());
  assert(!dump.includes(SECRET), `the secret survived in the ring:\n${dump}`);

  // Redacting the payload alone would have been theatre: an unlock that stores
  // its passphrase leaves the same secret in the diff, in the same ring,
  // printed by the same command.
  assertEquals(unlock.payload, REDACTED);
  assertEquals(
    unlock.diff.map((d) => d.path).sort(),
    ["vault.key", "vault.open"],
    "the PATHS stay — 'what did it touch' is still answerable",
  );
  for (const d of unlock.diff) {
    assertEquals(d.before, REDACTED);
    assertEquals(d.after, REDACTED);
  }
  // …and an unlisted action is reported in full, or the timeline is useless.
  assertEquals(note.diff[0]?.after, "hi");
});

// ── Sink 3: the action log, and artifact lifecycle ───────────────────

Deno.test("diagnostics: turning a writer off removes what it wrote", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-redact-a-" });
  try {
    await Deno.writeTextFile(
      `${dir}/actions.jsonl`,
      `{"type":"vault:unlock"}\n`,
    );
    await Deno.writeTextFile(`${dir}/checkpoint.json`, `{"ts":0}`);

    // Flags ON: the artifacts belong to a live writer and must survive.
    assertEquals(
      purgeDisabledArtifacts(dir, { actionLog: true, checkpoint: true }),
      [],
    );
    assert((await Deno.stat(`${dir}/actions.jsonl`)).isFile);

    // Flags OFF: "off" has to mean the artifact does not exist. Disabling the
    // flag used to stop new writes and leave every line already written —
    // including, in one real case, a passphrase, world-readable, indefinitely.
    const removed = purgeDisabledArtifacts(dir, {
      actionLog: false,
      checkpoint: false,
    });
    assertEquals(removed.sort(), ["actions.jsonl", "checkpoint.json"]);
    await assertMissing(`${dir}/actions.jsonl`);
    await assertMissing(`${dir}/checkpoint.json`);

    // Idempotent: nothing to remove is not an error, and reports nothing.
    assertEquals(
      purgeDisabledArtifacts(dir, { actionLog: false, checkpoint: false }),
      [],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function assertMissing(path: string) {
  await Deno.stat(path).then(
    () => {
      throw new Error(`${path} should have been removed`);
    },
    () => {},
  );
}

// ── All of it, through a real boot ───────────────────────────────────

const vault = cell("vault", {
  state: { open: false, key: "" as string },
  methods: {
    unlockWith(s: { open: boolean; key: string }, passphrase: string) {
      s.open = true;
      s.key = passphrase; // a real unlock keeps the derived key in memory
    },
  },
});

const notes = cell("notes", {
  state: { items: [] as string[] },
  methods: {
    add(s: { items: string[] }, text: string) {
      s.items.push(text);
    },
  },
});

Deno.test("redactActions: the secret reaches no sink, and nothing else changes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-redact-e2e-" });
  try {
    await using srv = await testServer({
      cells: [vault, notes],
      persist: true,
      dbPath: `${dir}/state.db`,
      journal: true,
      redactActions: ["vault:*"],
    });

    await vault.unlockWith(SECRET);
    await notes.add("groceries");

    // 1. The journal on disk. Read WITHOUT waiting: once the persist debounce
    // fires, the journal compacts to the unpersisted tail and an empty file
    // would pass this trivially.
    const journalText = await Deno.readTextFile(`${dir}/state.db.journal`);
    assert(
      journalText.includes("vault:unlockWith"),
      `the action must still be journalled — its type, sequence and timestamp ` +
        `are what redaction promises to keep:\n${journalText}`,
    );
    assert(
      !journalText.includes(SECRET),
      `the passphrase is on disk:\n${journalText}`,
    );
    // NOT "journalled FOR REPLAY". The payload of a `cell:method` action IS its
    // arguments, so an entry without one cannot be re-reduced — replaying it
    // ran the method with none, which took the whole boot down and, with a
    // tolerant reducer, quietly recovered the wrong state. The entry carries a
    // refusal marker and replay skips it, loudly
    // (tests/journal-redacted-replay.test.ts).
    const vaultLine = journalText.trim().split("\n").map((l) => JSON.parse(l))
      .find((e) => e.type === "vault:unlockWith");
    assertEquals(vaultLine.redacted, true, "marked unreplayable, not offered");

    // 2. The timeline, read the way a developer reads it (`am timeline`).
    const res = await fetch(`${srv.url}/__aio/trojan/timeline`);
    const body = await res.text();
    assertEquals(res.status, 200, body);
    assert(
      !body.includes(SECRET),
      `the passphrase is in the timeline \`am timeline\` prints:\n${body}`,
    );
    assert(
      body.includes("vault:unlockWith"),
      "the action is still visible — redaction hides values, not history",
    );
    // The unlisted action is untouched: redaction that swallowed everything
    // would be indistinguishable from a broken timeline.
    assert(
      body.includes("groceries"),
      `an unlisted action lost its payload:\n${body}`,
    );

    // 3. And the app itself is unaffected — this is a recording concern only.
    assertEquals(vault.open, true);
    assertEquals(vault.key, SECRET);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("redactActions: without it, the same secret IS recorded (the control)", async () => {
  // A leak test that cannot observe a leak proves nothing. This is the same
  // app with the list removed: if this stops finding the passphrase, the test
  // above has quietly become a tautology and someone must find out why.
  const dir = await Deno.makeTempDir({ prefix: "aio-redact-ctl-" });
  try {
    await using srv = await testServer({
      cells: [vault, notes],
      persist: true,
      dbPath: `${dir}/state.db`,
      journal: true,
    });
    await vault.unlockWith(SECRET);

    const journalText = await Deno.readTextFile(`${dir}/state.db.journal`);
    assert(
      journalText.includes(SECRET),
      "the journal records payloads by default",
    );
    const body = await (await fetch(`${srv.url}/__aio/trojan/timeline`)).text();
    assert(body.includes(SECRET), "and so does the timeline");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
