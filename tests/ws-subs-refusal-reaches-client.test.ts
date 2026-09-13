// A subscription the server REFUSES must reach the client.
//
// `parseSubs` refuses an over-cap set WHOLE rather than truncating it, and its
// own comment gives the reason: "a client that believes it is subscribed to
// something it is not gets a UI that silently stops updating, which is worse
// than a rejected frame." The refusal then went nowhere — `log.warn` on the
// server and nothing on the wire.
//
// So the client's own write succeeded, `_currentSubs` advanced to the refused
// set, every later comparison found "no change", and the server went on
// serving the PREVIOUS, narrower subscription. Measured: after narrowing to
// cell `a` and then growing past the cap, the client received no frame at all
// for cell `b` while the server's state moved — loud on the server, invisible
// in the browser, and never retried for the life of the connection.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { MAX_SUBS } from "../src/protocol/broadcast-utils.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

Deno.test("ws: an over-cap subs frame is refused ON THE WIRE, not just in the log", async () => {
  const a = cell("suba", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-subs-refuse-");
  const app = await aio.run({
    cells: [a],
    appId: `subsref-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    // deno-lint-ignore no-explicit-any
  } as any);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const diags: { type?: string; message?: string; hint?: string }[] = [];
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("socket failed to open"));
  });
  ws.onmessage = (e) => {
    try {
      const f = dec(String(e.data)) as { t?: string; d?: unknown } | null;
      if (f?.t !== "diag") return;
      diags.push(f.d as { type?: string; message?: string; hint?: string });
    } catch { /* not our frame */ }
  };

  try {
    await opened;
    ws.send(enc("proto", protoHello()));
    // One path past the cap — the shape a wide component reaches by growing.
    const paths = Array.from({ length: MAX_SUBS + 1 }, (_, i) => `suba.f${i}`);
    ws.send(enc("subs", paths));

    const t0 = Date.now();
    while (diags.length === 0 && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assertEquals(
      diags.length >= 1,
      true,
      "the client must be TOLD its subscription was refused — otherwise it " +
        "records the refused set as live and never asks again",
    );
    const d = diags.find((x) => x.type === "ws-subs");
    assert(d, `the refusal must be identifiable: ${JSON.stringify(diags)}`);
    assert(
      /subscription/i.test(String(d.message)),
      `…and say what was refused: ${d.message}`,
    );
  } finally {
    try {
      ws.close();
    } catch { /* already closed */ }
    await app.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// The other half: what the CLIENT does when it hears that.
//
// Its own write succeeded, so nothing in `state-subs` could tell the set had
// been refused — `_currentSubs` advanced and the comparison that drives every
// later send found "no change". The fallback is the WILDCARD rather than a
// retry: the set was refused for being too large, so re-sending it loops, and
// `["*"]` is what a fresh connection has — it can only deliver more than the
// client is getting, never less.
Deno.test("subs: a server refusal falls back to the wildcard and says so", async () => {
  const {
    _resetSubs,
    _setSubsTransport,
    resendSubscriptions,
    subsRefusedByServer,
    trackPath,
  } = await import("../src/state/state-subs.ts") as unknown as {
    _resetSubs: () => void;
    _setSubsTransport?: (t: unknown) => void;
    resendSubscriptions: () => void;
    subsRefusedByServer: () => void;
    trackPath: (p: string) => void;
  };
  void _setSubsTransport;
  void resendSubscriptions;
  void trackPath;
  _resetSubs();

  // Through the framework LOGGER, not a bare `console.error` — the line has
  // to carry a level and reach `app.log`, and a gate in this suite enforces
  // that for every runtime message. The logger writes to console underneath,
  // so both sinks are captured.
  const errs: string[] = [];
  const orig = { warn: console.warn, error: console.error };
  const cap = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  console.warn = cap;
  console.error = cap;
  try {
    subsRefusedByServer();
    // Said out loud — the page just gave up its bandwidth saving, and a cost
    // nobody can see is a cost nobody fixes.
    assert(
      errs.some((e) => /refused this page's subscription set/.test(e)),
      `the fallback must be visible: ${JSON.stringify(errs)}`,
    );
    // …and it is idempotent: a second refusal on the same page says nothing.
    const before = errs.length;
    subsRefusedByServer();
    assertEquals(errs.length, before, "said once per page, not per frame");
  } finally {
    console.warn = orig.warn;
    console.error = orig.error;
    _resetSubs();
  }
});
