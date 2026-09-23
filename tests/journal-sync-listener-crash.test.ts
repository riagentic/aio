// `journal: true` promises that a crash loses nothing acked — and that must
// hold for a `listensTo` REACTION as much as for the action itself.
//
// A sync op is durable in its cell's op-log the moment it is acked, but the
// reactions of the cells listening to it are not ops: a sync listener's is
// folded into its own snapshot up to 500 ms later, a KV listener's rides the
// next persist. Sync ops were never journalled (the op-log is their record),
// so a SIGKILL inside that window kept the op and lost every reaction to it.
// And a journalled line lived by ITS OWN cell's watermark only, so a KV
// action's line could be compacted away while a sync listener's fold of its
// reaction was still pending.
//
// Fixed by journalling the REACTION AS DATA: the reacted cells' stored
// slices on a time-travel line, which replay applies as absolute state past
// each cell's own watermark, and which lives (`JournalEntry.only`) until the
// last of them has saved it. The op itself is never journalled — its op-log
// is its record — so replay never re-runs a method (an idempotency guard in
// `notes.add` below would throw), and a build that predates `only` (an
// `am pin` downgrade) cannot fold it into `notes` a second time.
// Real SIGKILLs on a real disk, four kill points; each recovery is booted
// twice (a recovery that re-applies itself shows up on the second).
import { assert, assertEquals } from "@std/assert";
import {
  type JournalEntry,
  parseJournal,
  replayJournal,
  SYNC_REACTION_TYPE,
  TT_RESTORE_TYPE,
} from "../src/server/journal.ts";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const notes = cell("notes", {
  sync: true, version: 1, state: { items: [] },
  // An idempotency guard, as real apps write them: a replay that re-ran
  // this op on a state that already holds it would throw here.
  methods: { add(s, t) { if (s.items.includes(t)) throw new Error("dup " + t); s.items.push(t); } },
});
const tally = cell("tally", {
  state: { n: 0 }, methods: { onAdd(s) { s.n++; } },
  listensTo: { onAdd: notes.add },
});
const mirror = cell("mirror", {
  sync: true, version: 1, state: { got: [] },
  methods: { onAdd(s, t) { s.got.push(t); } },
  listensTo: { onAdd: notes.add },
});
const inbox = cell("inbox", {
  state: { posts: [] }, methods: { post(s, t) { s.posts.push(t); } },
});
const feed = cell("feed", {
  sync: true, version: 1, state: { seen: [] },
  methods: { onPost(s, t) { s.seen.push(t); } },
  listensTo: { onPost: inbox.post },
});
// A store-persisted listener with an onPersist SHAPE: its reaction is
// journalled as the stored shape and must come back as state.
const shaped = cell("shaped", {
  state: { n: 0 },
  onPersist: (s) => ({ saved: s.n }),
  onRestore: (s) => { if (typeof s.saved === "number") s.n = s.saved; delete s.saved; },
  methods: { onAdd(s) { s.n++; } },
  listensTo: { onAdd: notes.add },
});
const app = await aio.run({
  cells: [notes, tally, mirror, inbox, feed, shaped],
  appId: "sync-listener-journal-probe",
  client: "server-only",
  journal: true,
  // A phase whose point is the unsaved tail keeps the store from saving it
  // away before the kill (a loaded machine's 100 ms persist did, and the
  // reaction lines under test were gone — green for no reason).
  ...(Deno.env.get("PERSIST_MS")
    ? { persistDebounceMs: Number(Deno.env.get("PERSIST_MS")) }
    : {}),
  port: PORT,
  appDir: DIR,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = () => {
  const s = app.getState();
  return { notes: s.notes.items, tally: s.tally.n, mirror: s.mirror.got,
    inbox: s.inbox.posts, feed: s.feed.seen, shaped: s.shaped.n };
};
if (PHASE === "read") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(snap()));
  Deno.exit(0);
}
const trojan = async (type, arg) => {
  const res = await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify({ type, payload: { args: [arg] } }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(res.status + " " + text);
};
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const acks = new Set();
ws.onmessage = (e) => {
  try { const f = JSON.parse(e.data); if (f.t === "sync-ack") acks.add(f.d.opId); }
  catch { /* not a frame */ }
};
await new Promise((r) => (ws.onopen = r));
let n = 0;
/** One client sync op, acked. */
const op = async (cellName, action, arg) => {
  const id = "op-" + (++n);
  ws.send(JSON.stringify({ v: 2, t: "op", d: {
    id, hlc: [Date.now(), n, "c1"], cell: cellName, action,
    payload: { args: [arg] } } }));
  while (!acks.has(id)) await sleep(2);
};
/** Notes ops (the listeners react), each followed now and then by a DIRECT
 *  op on the sync listener itself — acked, in the op-log only, and after the
 *  reaction: recovery must keep both, in that order. */
const ops = async (k) => {
  for (let i = 0; i < k; i++) {
    await op("notes", "add", "n" + (n + 1));
    if (i % 2 === 0) await op("mirror", "onAdd", "d" + (n + 1));
  }
};
const posts = async (k) => {
  for (let i = 0; i < k; i++) {
    await trojan("inbox:post", "p" + (++n));
    if (i % 2 === 0) await op("feed", "onPost", "d" + (n + 1));
  }
};
const done = () => {
  Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(snap()));
  Deno.kill(Deno.pid, "SIGKILL");
};
if (PHASE === "before-fold") {
  await ops(10);
  await posts(5);
  done();
} else if (PHASE === "after-fold") {
  await ops(8);
  await posts(4);
  await sleep(1500); // folded, persisted, the journal compacted
  await ops(6);
  await trojan("notes:add", "srv-" + (++n)); // a server write with reactions
  await posts(3);
  done();
} else if (PHASE === "fold-lags-persist") {
  // The persist lands while a listener's fold is held back (its own writes
  // keep re-arming the debounce, up to the 500 ms max wait): the KV action's
  // line is past the app-wide watermark while its reaction is in no snapshot.
  await posts(1);
  for (let i = 0; i < 12; i++) {
    await trojan("feed:onPost", "x" + (++n));
    await sleep(25);
  }
  done();
} else if (PHASE === "streaming") {
  // Kill at a random-ish point in a stream: persists and folds land on their
  // own clocks while writes keep coming, so the kill falls between them.
  for (let r = 0; r < 12; r++) {
    await ops(2);
    await posts(1);
    await sleep(35);
  }
  // …then lets every armed save land, and ends on a write no save can reach
  // before the kill (the next one is a whole debounce away): the tail is
  // never empty of reactions, so the check below cannot pass vacuously.
  await sleep(1000);
  await ops(1);
  done();
}
`;

/** Phases whose point is the UNSAVED tail: no store save before the kill. */
const UNSAVED: Record<string, string> = {
  "before-fold": "999999",
  // Saves land during the stream (every 400 ms), never within the last write.
  streaming: "400",
};

async function runChild(
  dir: string,
  phase: string,
  config = CONFIG,
): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", config, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
      ...(UNSAVED[phase] ? { PERSIST_MS: UNSAVED[phase] } : {}),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase === "read" && !out.success) {
    throw new Error(`read child failed:\n${text}`);
  }
  return text;
}

type Snap = {
  notes: string[];
  tally: number;
  mirror: string[];
  inbox: string[];
  feed: string[];
  shaped: number;
};

async function crashAndRestart(phase: string) {
  const dir = await tempDir(`aio-sync-listener-journal-${phase}-`);
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const crashLog = await runChild(dir, phase);
    const journal = await Deno.readTextFile(join(dir, "data", "journal"))
      .catch(() => "");
    const expected = JSON.parse(
      await Deno.readTextFile(join(dir, "expected.json")).catch(() => {
        throw new Error(`${phase} child never reached its kill:\n${crashLog}`);
      }),
    ) as Snap;
    // Twice: the first boot's recovery must itself be durable, and must not
    // be applied again by the second.
    await runChild(dir, "read");
    const bootLog = await runChild(dir, "read");
    const recovered = JSON.parse(
      await Deno.readTextFile(join(dir, "recovered.json")),
    ) as Snap;
    return { expected, recovered, bootLog, journal };
  } finally {
    await dropTempDir(dir);
  }
}

for (
  const phase of ["before-fold", "after-fold", "fold-lags-persist", "streaming"]
) {
  Deno.test(`sync listener + journal: SIGKILL ${phase} keeps every acked reaction, once`, async () => {
    const { expected, recovered, bootLog, journal } = await crashAndRestart(
      phase,
    );
    if (phase === "before-fold" || phase === "streaming") {
      // Not vacuous: the tail holds a store-persisted listener's reaction
      // lines (a keyframe at least), which only the journal can restore.
      const kv = parseJournal(journal, { quiet: true }).filter((e) =>
        e.type === TT_RESTORE_TYPE &&
        (e.payload as { keyframes?: Record<string, unknown> }).keyframes
            ?.tally !== undefined
      );
      assert(kv.length > 0, `no tally keyframe in the tail:\n${journal}`);
    }
    assertEquals(expected.tally, expected.notes.length, "live: one each");
    assertEquals(expected.shaped, expected.notes.length, "live shaped");
    assertEquals(
      expected.mirror.filter((t) => !t.startsWith("d")),
      expected.notes,
      "live mirror",
    );
    if (expected.notes.length > 1) {
      assert(expected.mirror.some((t) => t.startsWith("d")), "direct ops ran");
    }
    assertEquals(
      expected.feed.filter((t) => t.startsWith("p")),
      expected.inbox,
      "live feed",
    );
    assertEquals(recovered, expected, bootLog);
  });
}

// The downgrade half: v1.0.9 ITSELF reads the tail this build left — the real
// tree, exported from the tag (read-only; `git archive`), not a model of it.
// It ignores the reaction lines (`__`-prefixed, no owner; `cells` left
// empty), and folds every sync op through its listeners again. With nothing
// saved before the kill (before-fold) that re-derives a store-persisted
// listener exactly; a sync listener keeps only its own ops (the guide says
// so). It must never drop an acked op or apply one twice.
async function exportTag(tag: string): Promise<string> {
  const dir = await tempDir("aio-old-tree-");
  const tar = join(dir, "tree.tar");
  const root = new URL("..", import.meta.url).pathname;
  const a = await new Deno.Command("git", {
    args: ["-C", root, "archive", "--format=tar", "-o", tar, tag],
    stderr: "piped",
  }).output();
  assert(
    a.success,
    `git archive ${tag}: ${new TextDecoder().decode(a.stderr)}`,
  );
  const x = await new Deno.Command("tar", {
    args: ["-xf", tar, "-C", dir],
    stderr: "piped",
  }).output();
  assert(x.success, new TextDecoder().decode(x.stderr));
  return dir;
}

Deno.test("sync listener + journal: v1.0.9 itself replays this build's tail without corrupting anything", async () => {
  const old = await exportTag("v1.0.9-beta");
  const dir = await tempDir("aio-sync-listener-downgrade-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const crashLog = await runChild(dir, "before-fold");
    const journal = await Deno.readTextFile(join(dir, "data", "journal"));
    const expected = JSON.parse(
      await Deno.readTextFile(join(dir, "expected.json")).catch(() => {
        throw new Error(`the child never reached its kill:\n${crashLog}`);
      }),
    ) as Snap;
    const lines = parseJournal(journal, { quiet: true });
    assert(
      !lines.some((e) => e.type.startsWith("notes:")),
      "a sync op is never journalled as an action — its op-log is its record",
    );
    assert(lines.some((e) => e.type === SYNC_REACTION_TYPE), "sync reactions");
    assert(lines.some((e) => e.type === TT_RESTORE_TYPE), "KV reactions");
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      CHILD.replace(MOD, new URL(`file://${join(old, "mod.ts")}`).href),
    );
    const log = await runChild(dir, "read", join(old, "deno.json"));
    const out = JSON.parse(
      await Deno.readTextFile(join(dir, "recovered.json")).catch(() => {
        throw new Error(`v1.0.9 did not boot:\n${log}`);
      }),
    ) as Snap;
    const direct = (xs: string[]) => xs.filter((t) => t.startsWith("d"));
    assertEquals(out.notes, expected.notes, "notes applied once");
    assertEquals(out.tally, expected.tally, `tally re-derived, once\n${log}`);
    assertEquals(out.shaped, expected.shaped, "shaped re-derived, once");
    assertEquals(out.inbox, expected.inbox);
    assertEquals(
      out.mirror,
      direct(expected.mirror),
      "mirror: every acked direct op kept, no reaction applied twice",
    );
    assertEquals(
      [...out.feed].sort(),
      [...expected.feed].sort(),
      "feed: nothing lost or doubled",
    );
  } finally {
    await dropTempDir(dir);
    await dropTempDir(old);
  }
});
