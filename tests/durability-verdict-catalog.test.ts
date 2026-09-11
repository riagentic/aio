// THE DURABILITY-VERDICT CATALOG.
//
// The project's recurring bug class — alpha76's "the thing that reported
// success", alpha77's shutdown-drain loss — is a door that answers `ok: true`
// / exit 0 / "persisted" / "loaded" after a WRITE without waiting on the
// verdict that says the write actually landed. There is ONE verdict:
// `PersistenceManager.lastCycleError()` (src/server/persistence.ts), read back
// after `flushPersist()` — the manager never rejects, so a caller that
// promises the disk has to ask.
//
// This file lists every door that reports success after a write and pins, per
// door, that it consults the verdict — structurally (the source names the
// verdict where the answer is written) and, where a fake app can stand in,
// behaviourally (the command exits and prints what the verdict says). A door
// added without a verdict is a missing row here, and the rows that exist stop
// being true the moment someone routes around one.
//
// Doors that are NOT rows, and why:
//   • `am timetravel` / trojan `tt` — moves state in memory only; persistence
//     pauses during time-travel by documented design (how-it-works.md), and the
//     app-manager doc says so at the verb.
//   • trojan `sql` — read-only by construction (SELECT/WITH only, DDL/DML
//     refused); trojan `pair` — mints a PIN in memory, writes nothing.
//   • `am auth`, `am pin`, `am fix`, `am publish`, `am create`, `am remove`,
//     `am upgrade`, `am snapshot save` — plain file / SQLite writes whose
//     verdict IS the syscall: they throw, `am.ts`'s one catch turns a throw
//     into `{error}` + exit 1, and tests/am-failure-exits pins that nothing
//     prints an error and then returns. No debounce, no second decider.
//   • the diagnostics checkpoint — observe-only by design (a crash aid, not
//     the durability promise); a failed write is logged once per distinct
//     error, never silent (checkpoint.ts `reportWriteError`).
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { codeMask } from "../src/diagnostics/code-mask.ts";
import { PERSIST_REFUSED } from "../src/server/server-trojan.ts";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";
import { cmdDispatch, cmdSnapshot } from "../src/am/am-cmd-state.ts";
import { cmdStop } from "../src/am/am-cmd-process.ts";

// ── the catalog ──────────────────────────────────────────────────────────────

const ROOT = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFile(new URL(p, ROOT));

/** The source with its COMMENTS blanked and its strings kept.
 *
 *  A comment that describes the verdict is not a door that reads it — and
 *  this file's own subject is wording, so the string literals have to stay
 *  visible (`codeText` blanks those too). Built on `codeMask`, the repo's one
 *  decider for "is this offset code": a comment opens where `//` or `/*` sit
 *  on code offsets and the body behind them does not, so a `//` inside a URL
 *  string or a `/*` inside a regex is never mistaken for one. Offsets and
 *  newlines are preserved. */
function stripComments(src: string): string {
  const mask = codeMask(src);
  const out = src.split("");
  for (let i = 0; i + 1 < src.length; i++) {
    if (mask[i] !== 1 || src[i] !== "/" || mask[i + 1] !== 1) continue;
    const body = i + 2 < src.length ? mask[i + 2] : 0;
    if (src[i + 1] === "/" && (body === 0 || src[i + 2] === "\n")) {
      for (; i < src.length && src[i] !== "\n"; i++) out[i] = " ";
    } else if (src[i + 1] === "*" && body === 0) {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (; i < stop; i++) if (src[i] !== "\n") out[i] = " ";
    }
  }
  return out.join("");
}
const code = async (p: string) => stripComments(await read(p));

/** The body of `function name(…)` — its block, braces counted on CODE
 *  offsets only, so a `{` inside a message string cannot unbalance it. The
 *  block opens at the first code `{` that ends its line (a return-type
 *  annotation's `{ a: string }` sits mid-line). */
function fnBody(src: string, name: string): string {
  const mask = codeMask(src);
  const at = src.search(new RegExp(`function ${name}\\b`));
  assert(at >= 0, `${name} is gone — the catalog names it`);
  let open = -1;
  for (let i = at; i < src.length; i++) {
    if (mask[i] === 1 && src[i] === "{" && src[i + 1] === "\n") {
      open = i;
      break;
    }
  }
  assert(open >= 0, `${name}: no block`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (mask[i] !== 1) continue;
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${name}: unbalanced braces`);
}

type Row = {
  door: string;
  writes: string;
  verdict: string;
  check: () => Promise<void>;
};

const CATALOG: Row[] = [
  {
    door: "trojan POST persist  (am persist)",
    writes: "the whole state (flush)",
    verdict: "forcePersist = awaited flush → lastCycleError() rethrown → 500",
    check: async () => {
      const trojan = await code("src/server/server-trojan.ts");
      const body = fnBody(trojan, "_persistVerdict");
      assertMatch(body, /await trojan\.forcePersist\(\)/);
      assertMatch(body, /catch \(e\)/);
      // The persist route answers THROUGH the one reader, and a refusal is a
      // 500 — never `ok: true` with a refusal beside it.
      const route = trojan.slice(trojan.indexOf('route === "persist"'));
      assertMatch(route, /const unsaved = await _persistVerdict\(trojan\)/);
      assertMatch(route, /if \(unsaved\) return err\(unsaved, 500\)/);
      // …and the flush it awaits reads the verdict back (aio.ts): the manager
      // never rejects on its own.
      // aio.ts has TWO flushes: the shutdown one (logs the verdict — its
      // own row below) and the trojan one, which is the door this row is
      // about and the one that rethrows it.
      const aio = await code("src/server/aio.ts");
      const flushes = [...aio.matchAll(/flushPersist: async \(\) => \{/g)]
        .map((m) => aio.slice(m.index!, m.index! + 900));
      assertEquals(
        flushes.length,
        2,
        "the shutdown flush and the trojan flush",
      );
      assert(
        flushes.some((b) =>
          /const failed = persistence\.lastCycleError\(\);\s*if \(failed\) throw failed;/
            .test(b)
        ),
        "the trojan flush must rethrow lastCycleError()",
      );
    },
  },
  {
    door: "am persist",
    writes: "the whole state (flush)",
    verdict: "the persist route's 500 → exit 1",
    check: async () => {
      const src = await code("src/am/am-cmd-state.ts");
      const body = fnBody(src, "cmdPersist");
      assertMatch(body, /trojanPost\(port, "persist"/);
      assertMatch(body, /if \(!result\.ok\) \{[^}]*Deno\.exit\(1\)/);
    },
  },
  {
    door: "GET /__aio/health",
    writes: "nothing — but it CLAIMS 'healthy'",
    verdict: "lastPersistError() → persist: { ok }, status: degraded",
    check: async () => {
      const src = await code("src/server/aio-server.ts");
      assertMatch(src, /const persistErr = deps\.lastPersistError\?\.\(\)/);
      // The PROPERTY — a persist error participates in the degraded verdict —
      // not one spelling of the expression. This read
      // `/persistErr\s*\?\s*"degraded"/` and went red the day another
      // condition joined the same ternary (`budgets?.ok === false`), which is
      // a gate failing on a change it exists to permit.
      const status = src.slice(src.indexOf("status:"));
      const decision = status.slice(0, status.indexOf('"healthy"'));
      assertMatch(decision, /persistErr/);
      assertMatch(decision, /"degraded"/);
      // One value, every door: the trojan flush and health read the SAME
      // getter (aio.ts wires both from `persistence.lastCycleError`).
      const aio = await code("src/server/aio.ts");
      assertMatch(
        aio,
        /lastPersistError: \(\) => persistence\.lastCycleError\(\)/,
      );
    },
  },
  {
    door: "am stop  (and stop --all)",
    writes: "the final flush, on the way down",
    verdict: "finalPersistVerdict BEFORE the shutdown POST → unsaved → exit 1",
    check: async () => {
      const src = await code("src/am/am-cmd-process.ts");
      const stop = fnBody(src, "stopOne");
      const verdictAt = stop.indexOf("finalPersistVerdict(");
      const shutdownAt = stop.indexOf('trojanPost(port, "shutdown"');
      assert(verdictAt >= 0 && shutdownAt >= 0);
      assert(
        verdictAt < shutdownAt,
        "the verdict is taken BEFORE the door closes — after it, there is " +
          "nobody left to ask",
      );
      const cmd = fnBody(src, "cmdStop");
      assertMatch(cmd, /if \(r\.unsaved\) Deno\.exit\(1\)/);
      assertMatch(
        cmd,
        /if \(failed\.length \|\| lost\.length\) Deno\.exit\(1\)/,
      );
      // The wording am matches is the wording the route emits — a key in two
      // of three surfaces is the trap; this row is the third surface.
      const fpv = fnBody(src, "finalPersistVerdict");
      const m = /\/([^/]+)\/\.test\(r\.error\)/.exec(fpv);
      assert(m, "finalPersistVerdict reads the route's wording by regex");
      assertEquals(m![1], PERSIST_REFUSED);
    },
  },
  {
    door: "am restart  (and am watch → restart)",
    writes: "the final flush, on the way down",
    verdict: "stopOne's unsaved → printed, restart proceeds, exit 1 LAST",
    check: async () => {
      const src = await code("src/am/am-cmd-process.ts");
      const app = fnBody(src, "restartApp");
      // Not `cmdStop(…, { quiet: true })`: that exited 1 INSIDE the restart,
      // silently (quiet), with the app stopped and never started again.
      assert(!/\bcmdStop\(/.test(app), "restartApp must not route via cmdStop");
      assertMatch(app, /await stopOne\(t\.target/);
      assertMatch(app, /unsaved = stopped\.unsaved/);
      assertMatch(app, /NOT SAVED/);
      const startAt = app.indexOf("await cmdStart(");
      const unsavedAt = app.indexOf("unsaved = stopped.unsaved");
      assert(unsavedAt < startAt, "the verdict is taken before the start");
      assert(
        !/Deno\.exit\(1\)[^]*return unsaved/.test(app.slice(startAt)),
        "restartApp returns the verdict; exiting is the caller's",
      );
      const cmd = fnBody(src, "cmdRestart");
      assertMatch(cmd, /const lost = await restartAll\(args, flags\)/);
      assertMatch(cmd, /if \(lost\.length\) Deno\.exit\(1\)/);
      // The watcher keeps watching — it calls the one that does not exit.
      const watch = fnBody(src, "cmdWatch");
      assertMatch(watch, /await restartAll\(\[\], flags\)/);
      assert(!/\bcmdRestart\(/.test(watch), "am watch must not die on it");
    },
  },
  {
    door: "trojan POST snapshot | snapshot/force  (am snapshot load)",
    writes: "the whole state, replaced, then flushed",
    verdict: "_persistVerdict after loadSnapshot → unsaved in the reply",
    check: async () => {
      const trojan = await code("src/server/server-trojan.ts");
      const from = trojan.indexOf(
        'route === "snapshot" || route === "snapshot/force"',
      );
      const route = trojan.slice(from, trojan.indexOf('route === "tt"', from));
      const loadAt = route.indexOf("deps.loadSnapshot(body");
      const verdictAt = route.indexOf("await _persistVerdict(trojan)");
      assert(loadAt >= 0 && verdictAt > loadAt, "load, THEN the verdict");
      assertMatch(
        route,
        /json\(\{ ok: true, \.\.\.\(unsaved \? \{ unsaved \} : \{\}\) \}\)/,
      );
      const am = await code("src/am/am-cmd-state.ts");
      const snap = fnBody(am, "cmdSnapshot");
      assertMatch(snap, /\.unsaved/);
      assertMatch(snap, /if \(unsaved\) Deno\.exit\(1\)/);
    },
  },
  {
    door: "trojan POST dispatch  (am dispatch)",
    writes: "one action — acked when APPLIED, by design",
    verdict:
      "the server's lastPersistError in the reply (`unsaved`, no flush) — or health's persist.ok from an older server → NOT SAVED (exit stays 0)",
    check: async () => {
      // Server side: the dispatch reply carries the verdict itself, read from
      // the same `lastPersistError` health uses, never a forced flush.
      const trojan = await code("src/server/server-trojan.ts");
      const reply = trojan.slice(
        trojan.indexOf('if (route === "dispatch")'),
        trojan.indexOf(
          "invalid JSON",
          trojan.indexOf('if (route === "dispatch")'),
        ),
      );
      assertMatch(reply, /deps\.lastPersistError\b/);
      assertMatch(reply, /unsaved: persistErr/);
      assert(!/forcePersist/.test(reply), "a dispatch is applied, not flushed");
      // Client side: the reply's verdict when present, health when absent —
      // an older server is a second request, never a wrong answer.
      const am = await code("src/am/am-cmd-state.ts");
      const d = fnBody(am, "cmdDispatch");
      assertMatch(d, /"unsaved" in data/);
      assertMatch(d, /await persistRefusal\(port, appId\)/);
      assertMatch(d, /NOT SAVED/);
      assert(
        !/if \(unsaved\) Deno\.exit/.test(d),
        "the exit code is the method's",
      );
      const probe = fnBody(am, "persistRefusal");
      assertMatch(probe, /httpGet\(port, "\/__aio\/health", appId\)/);
      assertMatch(probe, /persist\?\.ok === false/);
      // Never a forced flush: a dispatch is applied, not persisted, and the
      // probe must not turn it into something else.
      assert(!/"persist"/.test(probe), "the probe asks, it does not flush");
      // …and the DOC says what the ack means. The wording IS the fix here.
      const doc = await read("docs/clients/app-manager.md");
      assertStringIncludes(doc, "means APPLIED, not on disk");
      assertStringIncludes(
        doc,
        "`am persist` is the door that answers for durability",
      );
    },
  },
  {
    door: "journal append  (journal: true)",
    writes: "one line per committed action",
    verdict:
      "PERSIST_ERROR + an immediate flush (verdict → lastCycleError) + degraded(journal) → health",
    check: async () => {
      const aio = await code("src/server/aio.ts");
      const body = fnBody(aio, "_journalAppend");
      assertMatch(body, /createAioError\("PERSIST_ERROR"/);
      assertMatch(body, /persistence\.flushPersist\(\)/);
      assertMatch(body, /_journalHealth\.fail\(e\)/);
      assertMatch(body, /_journalHealth\.ok\(\)/);
      // The compensating flush's rejection handler is LOUD — flushPersist
      // never rejects by contract, so a rejection there is a broken contract
      // and the one thing it must not be is `.catch(() => {})`.
      assert(
        !/\.catch\(\(\) => \{\}\)/.test(body),
        "no silent catch in the journal path",
      );
      assertMatch(body, /\.catch\(\(err\) => \{[^]*log\.error\(/);
      assertMatch(
        aio,
        /degraded\(`journal:\$\{resolveAppId\(config\.appId\)\}`, \{\s*after: 1,?\s*\}\)/,
      );
    },
  },
  {
    door: "the shutdown flush  (app.close / SIGTERM / am stop's server half)",
    writes: "the final flush",
    verdict:
      "lastCycleError() → log.error (the exit code is NOT it — see the report)",
    check: async () => {
      const aio = await code("src/server/aio.ts");
      const at = aio.indexOf("createShutdownOrchestrator({");
      const flush = aio.slice(at, at + 1600);
      assertMatch(flush, /const failed = persistence\.lastCycleError\(\);/);
      assertMatch(flush, /FINAL persist was refused/);
    },
  },
  {
    door: "updates apply  (updates-runtime.ts)",
    writes: "a staged artifact, the pending marker, the swap",
    verdict:
      "the marker is written BEFORE the first rename (swapArtifact owns the order); every swallowed promise is observe-only or a cleanup beside a throw that carries the reason",
    check: async () => {
      const src = await code("src/server/updates-runtime.ts");
      // The two `.catch(() => {})` on cell reporting are bracketed by a
      // sentence saying reporting never breaks the thing it reports on; the
      // rest sit on `Deno.remove` cleanups directly beside a `throw` that
      // carries the real reason. Structurally: none of them guards the swap
      // or the marker.
      for (const m of src.matchAll(/\.catch\(\(\) => \{\s*\}\)/g)) {
        // What the swallowed promise IS — the call it hangs off, within the
        // 160 characters before it: a `Deno.remove` (cleanup) or a cell
        // report (`setProgress` / `setPhase` / `setBackupPath`). Anything
        // else here would be a swap or a marker answering ok while refused.
        const before = src.slice(Math.max(0, m.index! - 160), m.index!);
        assert(
          /Deno\.remove\(|setProgress|setPhase|setBackupPath/.test(before),
          `a swallowed promise in updates-runtime that is neither a cleanup ` +
            `nor cell reporting: …${
              src.slice(Math.max(0, m.index! - 80), m.index! + 20)
            }`,
        );
      }
      assertMatch(src, /await swapArtifact\(\{[^]*pending,\s*\}\);/);
    },
  },
];

Deno.test("durability verdict catalog: every door consults the verdict", async (t) => {
  // The catalog IS the gate: these are the doors that answer after a write.
  // A door added to the framework gets a row here, and a row removed from
  // here is a decision — never a silent shrink.
  assertEquals(CATALOG.map((r) => (r.door.split("  ")[0] ?? "").trim()), [
    "trojan POST persist",
    "am persist",
    "GET /__aio/health",
    "am stop",
    "am restart",
    "trojan POST snapshot | snapshot/force",
    "trojan POST dispatch",
    "journal append",
    "the shutdown flush",
    "updates apply",
  ]);
  for (const row of CATALOG) {
    await t.step(
      `${row.door} — writes ${row.writes}; verdict: ${row.verdict}`,
      row.check,
    );
  }
});

// ── behaviour: the trojan snapshot door ──────────────────────────────────────

async function withTrojan(
  cfg: {
    forcePersist?: () => Promise<void>;
    loadSnapshot?: (json: string) => void;
  },
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const dir = await tempDir("dvc-trojan-");
  await Deno.writeTextFile(join(dir, "App.tsx"), "export default () => null");
  const port = freePort();
  const server = createServer({
    port,
    title: "DVC",
    getUIState: () => ({}),
    dispatch: () => {},
    getSnapshot: () => "{}",
    loadSnapshot: cfg.loadSnapshot ?? (() => {}),
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      ...(cfg.forcePersist ? { forcePersist: cfg.forcePersist } : {}),
      startedAt: Date.now(),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
}

const postSnapshot = (url: string, force = false) =>
  fetch(`${url}/__aio/trojan/snapshot${force ? "/force" : ""}`, {
    method: "POST",
    headers: { "X-AIO": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ c: { n: 1 } }),
  });

Deno.test("trojan snapshot: 'loaded' waits for the write, and a refused one rides back as `unsaved`", async () => {
  // Refused: the load happened (state replaced), the write did not — the
  // reply is ok (the restore IS in memory and broadcast) and says NOT SAVED.
  const order: string[] = [];
  await withTrojan({
    loadSnapshot: () => order.push("load"),
    forcePersist: () => {
      order.push("flush");
      return Promise.reject(new Error("t.v: NOT NULL constraint failed"));
    },
  }, async (url) => {
    for (const force of [false, true]) {
      order.length = 0;
      const r = await postSnapshot(url, force);
      assertEquals(r.status, 200);
      const body = await r.json() as { ok: boolean; unsaved?: string };
      assertEquals(body.ok, true);
      assertEquals(
        body.unsaved,
        `${PERSIST_REFUSED} t.v: NOT NULL constraint failed`,
      );
      assertEquals(order, ["load", "flush"], "load first, then the verdict");
    }
  });

  // Landed: the reply is byte-for-byte what it was — additive only.
  let resolved = false;
  await withTrojan({
    forcePersist: () =>
      new Promise((r) =>
        setTimeout(() => {
          resolved = true;
          r();
        }, 80)
      ),
  }, async (url) => {
    const r = await postSnapshot(url);
    assertEquals(await r.json(), { ok: true });
    assert(resolved, "the reply must not leave before the flush resolves");
  });

  // No persistence at all (persist: false / an older app): nothing to ask,
  // nothing claimed — the reply is unchanged.
  await withTrojan({}, async (url) => {
    const r = await postSnapshot(url);
    assertEquals(await r.json(), { ok: true });
  });
});

// ── behaviour: the am doors, against a fake control plane ────────────────────

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/** Run `fn` with Deno.exit stubbed; the exit code, or null when the command
 *  returned normally (claimed success). Output is captured beside it. */
async function runAm(
  fn: () => Promise<void>,
): Promise<{ code: number | null; logs: string[]; errors: string[] }> {
  const realExit = Deno.exit;
  const l = console.log, e = console.error;
  const logs: string[] = [], errors: string[] = [];
  let code: number | null = null;
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    code = err.code;
  } finally {
    Deno.exit = realExit;
    console.log = l;
    console.error = e;
  }
  return { code, logs, errors };
}

/** A fake app: health + the trojan write doors, with a switchable verdict. */
function fakeApp(appId: string) {
  const state = { refusing: false };
  const reason = "c.scratch: BigInt is not JSON";
  const json = (d: unknown, status = 200) =>
    new Response(JSON.stringify(d), {
      status,
      headers: { "content-type": "application/json" },
    });
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const p = new URL(req.url).pathname;
      if (p === "/__aio/health") {
        return json({
          status: state.refusing ? "degraded" : "healthy",
          appId,
          persist: state.refusing ? { ok: false, error: reason } : { ok: true },
        });
      }
      if (req.method !== "POST") return json({ error: "not found" }, 404);
      if (p === "/__aio/trojan/persist") {
        return state.refusing
          ? json({ error: `${PERSIST_REFUSED} ${reason}` }, 500)
          : json({ ok: true });
      }
      if (p === "/__aio/trojan/shutdown") return json({ ok: true });
      if (p === "/__aio/trojan/dispatch") return json({ ok: true });
      if (p === "/__aio/trojan/snapshot") {
        return json(
          state.refusing
            ? { ok: true, unsaved: `${PERSIST_REFUSED} ${reason}` }
            : { ok: true },
        );
      }
      return json({ error: "not found" }, 404);
    },
  );
  return {
    state,
    reason,
    port: server.addr.port,
    close: () => server.shutdown(),
  };
}

const flagsFor = (port: number, app: string): GlobalFlags =>
  ({ json: true, port, app }) as GlobalFlags;

Deno.test("am stop: a refused final write is `unsaved` + exit 1; a landed one is silent about it", async () => {
  const appId = "dvc-stop";
  const app = fakeApp(appId);
  try {
    app.state.refusing = true;
    const r = await runAm(() => cmdStop([], flagsFor(app.port, appId)));
    assertEquals(r.code, 1, `exit 1 through data loss, got ${r.code}`);
    const doc = JSON.parse(r.logs.at(-1)!) as {
      unsaved?: string;
      status?: string;
    };
    assertEquals(doc.status, "stopping");
    assertEquals(doc.unsaved, `${PERSIST_REFUSED} ${app.reason}`);

    app.state.refusing = false;
    const ok = await runAm(() => cmdStop([], flagsFor(app.port, appId)));
    assertEquals(ok.code, null);
    assert(
      !("unsaved" in JSON.parse(ok.logs.at(-1)!)),
      "no field when nothing was lost",
    );
  } finally {
    await app.close();
  }
});

Deno.test("am snapshot load: 'loaded' over a refused write says NOT SAVED and exits 1", async () => {
  const appId = "dvc-load";
  const app = fakeApp(appId);
  const dir = await tempDir("dvc-load-");
  const file = join(dir, "snap.json");
  await Deno.writeTextFile(file, JSON.stringify({ c: { n: 1 } }));
  try {
    app.state.refusing = true;
    const r = await runAm(() =>
      cmdSnapshot(["load", file], flagsFor(app.port, appId))
    );
    assertEquals(r.code, 1);
    const doc = JSON.parse(r.logs.at(-1)!) as {
      status: string;
      unsaved?: string;
    };
    assertEquals(doc.status, "loaded");
    assertEquals(doc.unsaved, `${PERSIST_REFUSED} ${app.reason}`);

    app.state.refusing = false;
    const ok = await runAm(() =>
      cmdSnapshot(["load", file], flagsFor(app.port, appId))
    );
    assertEquals(ok.code, null);
    assertEquals(JSON.parse(ok.logs.at(-1)!), { file, status: "loaded" });
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});

Deno.test("am dispatch: applied is applied — and a refusing write path is said, without a flush", async () => {
  const appId = "dvc-dispatch";
  const app = fakeApp(appId);
  try {
    app.state.refusing = true;
    const r = await runAm(() =>
      cmdDispatch(["c:add", "1"], flagsFor(app.port, appId))
    );
    // The method ran: the exit code is the method's, not the disk's…
    assertEquals(r.code, null);
    // …and the reply says the disk is refusing, in the same words as stop.
    const doc = JSON.parse(r.logs.at(-1)!) as { ok: boolean; unsaved?: string };
    assertEquals(doc.ok, true);
    assertEquals(doc.unsaved, `${PERSIST_REFUSED} ${app.reason}`);

    // Healthy: byte-for-byte the reply the route sent.
    app.state.refusing = false;
    const ok = await runAm(() =>
      cmdDispatch(["c:add", "1"], flagsFor(app.port, appId))
    );
    assertEquals(ok.code, null);
    assertEquals(ok.logs.at(-1), '{"ok":true}');
  } finally {
    await app.close();
  }
});
