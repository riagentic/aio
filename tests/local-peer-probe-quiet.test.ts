// A second launch of the app must not read as an intrusion in its own log.
//
// Measured (strace, Linux; the same code path on macOS): a second launch
// asks "is the running instance's listener alive?" by connecting to its
// state socket and hanging up — `connect()`, `shutdown(SHUT_WR)`, `close()`
// inside 0.2 ms, ZERO bytes (`isSocketAlive`). The production lockdown
// treated that connection like any other foreign peer and wrote, every time:
//
//   WARN uds local-peer lockdown: refused a process on …/app.sock — it is not
//   this app's window (it is pid N; the window is M). It is given NO state …
//
// (macOS: "…this platform reported no pid for it", because LOCAL_PEERPID is
// answered only while the peer is still connected — ENOTCONN once it hung
// up.) One WARN per launch of an app that was already running.
//
// The rule: the REFUSAL is unchanged and immediate — the peer is given
// nothing. The LINE waits to learn whether the peer wanted anything: one that
// sent a byte, or stayed connected waiting to be told something (the server
// speaks first on this socket), is the warning it always was; one that
// connected and left is a probe, noted at debug level.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createLocalPeerGate,
  peerRefusal,
  PROBE_FLOOD,
  PROBE_GRACE_MS,
  requireLocalPeer,
} from "../src/server/local-peer.ts";
import { createUDSListener } from "../src/server/uds.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDirSync } from "../src/testing/temp-dir.ts";

// Opened before any case — the sanitizer counts an FFI library per test.
requireLocalPeer();

function gateWith() {
  const said: string[] = [];
  const clock = { t: 0 };
  const gate = createLocalPeerGate({
    selfUid: 1000,
    startOf: () => null,
    warn: (m) => said.push(`WARN ${m}`),
    error: (m) => said.push(`ERROR ${m}`),
    debug: (m) => said.push(`DEBUG ${m}`),
    now: () => clock.t,
  });
  gate.arm(42);
  const peer = (pid: number | null) => ({
    peerIdentity: () => ({ pid, uid: 1000, gid: 1000 }),
  });
  /** `n` silent connect-and-close probes on `door`, each from its own pid. */
  const probe = async (door: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const left = Promise.withResolvers<boolean>();
      gate.refusal(peer(1000 + i), door, "NOTE.", left.promise);
      left.resolve(false);
      await left.promise;
    }
  };
  return { gate, said, peer, clock, probe };
}

Deno.test("probe: a refused peer that hung up without a byte is a debug note, not a warning — and was refused at once", async () => {
  const { gate, said, peer } = gateWith();
  const asked = Promise.withResolvers<boolean>();
  const why = gate.refusal(peer(77), "door.sock", "NOTE.", asked.promise);
  // The refusal never waits for the answer.
  assertStringIncludes(why ?? "", "it is pid 77; the window is 42");
  assertEquals(said, [], "nothing is said before the peer's intent is known");
  asked.resolve(false);
  await asked.promise;
  assertEquals(said.length, 1);
  assert(said[0]!.startsWith("DEBUG "), said[0]);
  assertStringIncludes(said[0]!, "hung up without sending anything");
  assertStringIncludes(said[0]!, "door.sock");
  assertStringIncludes(said[0]!, "pid 77");
  assert(!said[0]!.includes("refused a process"), "not worded as an intrusion");
});

Deno.test("probe: a refused peer that SENT something is the warning it always was", async () => {
  const { gate, said, peer } = gateWith();
  const asked = Promise.withResolvers<boolean>();
  gate.refusal(peer(77), "door.sock", "NOTE.", asked.promise);
  asked.resolve(true);
  await asked.promise;
  assertEquals(said, [
    "WARN local-peer lockdown: refused a process on door.sock — it is not " +
    "this app's window (it is pid 77; the window is 42). NOTE.",
  ]);
});

Deno.test("probe: a door that cannot say whether the peer asked keeps the immediate warning", () => {
  const { gate, said, peer } = gateWith();
  gate.refusal(peer(77), "door.http.sock");
  assertEquals(said.length, 1);
  assert(said[0]!.startsWith("WARN local-peer lockdown: refused a process"));
});

Deno.test("probe: a peer with no readable pid is still REFUSED, and the reason says what that can mean", async () => {
  const why = peerRefusal({ pid: null, uid: 1000, gid: null }, {
    selfUid: 1000,
    allowedPid: 42,
    requirePid: true,
  });
  assertEquals(
    why,
    "no pid could be read for it (it had already disconnected, or this " +
      "platform reports none)",
  );
  // …through the gate: silent as a probe, loud once it has sent something.
  const { gate, said, peer } = gateWith();
  const left = Promise.withResolvers<boolean>();
  assertEquals(gate.refusal(peer(null), "d", undefined, left.promise), why);
  left.resolve(false);
  await left.promise;
  assert(said[0]!.startsWith("DEBUG "), said[0]);
  const sent = Promise.withResolvers<boolean>();
  assertEquals(gate.refusal(peer(null), "d", undefined, sent.promise), why);
  sent.resolve(true);
  await sent.promise;
  assert(said[1]!.startsWith("WARN local-peer lockdown: refused"), said[1]);
});

// ── A flood of probes leaves a trace; a second launch does not ──────────────
//
// Measured (strace on a real app): a second launch connects to the state
// socket once, an `am` command at most twice. With the probe demoted to a
// debug note, 10 000 foreign connect-and-close probes left NOTHING at the
// default log level, and with debug on, 10 000 notes.

Deno.test("probe flood: one debug note a minute per door, and ONE warning once a minute's count passes what a launch or `am` makes", async () => {
  const { said, clock, probe } = gateWith();
  // What an ordinary minute looks like: a few launches and checks.
  await probe("a.sock", PROBE_FLOOD);
  assertEquals(said.length, 1, said.join(" | "));
  assert(said[0]!.startsWith("DEBUG "), said[0]);
  assertStringIncludes(said[0]!, "hung up without sending anything");
  // One more is a flood — said at the default level, once, whatever follows.
  await probe("a.sock", 1);
  assertEquals(said.length, 2);
  assert(said[1]!.startsWith("WARN local-peer lockdown: more than"), said[1]);
  assertStringIncludes(said[1]!, `more than ${PROBE_FLOOD} connections`);
  assertStringIncludes(said[1]!, "a.sock");
  assertStringIncludes(said[1]!, "None was served");
  assert(!said[1]!.includes("refused a process"), "not one peer's refusal");
  await probe("a.sock", 5000);
  assertEquals(said.length, 2, "a flood must not flood the log");
  // Another door counts for itself.
  await probe("b.sock", 3);
  assertEquals(said.length, 3);
  assert(said[2]!.startsWith("DEBUG ") && said[2]!.includes("b.sock"));
  // A minute later the count starts again: quiet stays quiet…
  clock.t += 60_000;
  await probe("a.sock", PROBE_FLOOD);
  assertEquals(said.length, 4);
  assert(said[3]!.startsWith("DEBUG "), said[3]);
  // …and a flood that goes on is said again, once per minute.
  await probe("a.sock", 500);
  assertEquals(said.length, 5);
  assert(said[4]!.startsWith("WARN local-peer lockdown: more than"), said[4]);
});

Deno.test("probe flood: a peer that ASKED is never counted as a probe", async () => {
  const { gate, said, peer } = gateWith();
  for (let i = 0; i < PROBE_FLOOD + 5; i++) {
    const sent = Promise.withResolvers<boolean>();
    gate.refusal(peer(2000 + i), "a.sock", "NOTE.", sent.promise);
    sent.resolve(true);
    await sent.promise;
  }
  assertEquals(said.length, PROBE_FLOOD + 5, "each sender is its own line");
  assert(said.every((l) => l.includes("refused a process")), said[0]);
});

// ── The real door: createUDSListener, a real socket, the real logger ─────────

/** A production state socket whose window is some other process (pid 1), and
 *  every lockdown line the real logger is handed. */
async function withDoor(
  f: (
    sock: string,
    lines: string[],
    until: (what: string, f: () => boolean) => Promise<void>,
    dispatched: () => number,
  ) => Promise<void>,
): Promise<void> {
  const dir = tempDirSync("peer-probe-");
  const sock = `${dir}/app.sock`;
  const lines: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (msg.includes("local-peer lockdown")) lines.push(`${lvl} ${msg}`);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  let dispatched = 0;
  const handle = createUDSListener(
    sock,
    () => ({ secret: "kept" }),
    () => {
      dispatched++;
    },
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { required: true },
  );
  const until = async (what: string, f: () => boolean) => {
    for (let i = 0; i < 1000; i++) {
      if (f()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}: ${lines.join(" | ")}`);
  };
  try {
    handle.armPeerPid?.(1);
    await until("the listener to bind", () => {
      try {
        return Deno.lstatSync(sock).isSocket === true;
      } catch {
        return false; // aio-ok: not bound yet
      }
    });
    await f(sock, lines, until, () => dispatched);
  } finally {
    await handle.shutdown();
    setLogger(prev);
    await dropTempDir(dir);
  }
}

// Loud: a warning (an error when the peer descends from the armed pid — here
// pid 1, so every process does).
const loud = (l: string) => l.startsWith("warn ") || l.startsWith("error ");

Deno.test({
  name: "probe: on the real state socket, connect-and-close logs no warning",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withDoor(async (sock, lines, until) => {
      (await Deno.connect({ transport: "unix", path: sock })).close();
      await until(
        "the probe's debug note",
        () => lines.some((l) => l.includes("hung up without sending anything")),
      );
      // Past the grace a silent peer is given: the timer was cleared with
      // the connection, not left to speak later.
      await new Promise((r) => setTimeout(r, PROBE_GRACE_MS + 200));
      assertEquals(
        lines.filter((l) => !l.startsWith("debug ")),
        [],
        "a liveness probe must not be logged above debug",
      );
    });
  },
});

Deno.test({
  name:
    "probe: a foreign peer that sends a frame is refused loudly, and the frame goes nowhere",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withDoor(async (sock, lines, until, dispatched) => {
      const c = await Deno.connect({ transport: "unix", path: sock });
      try {
        const t0 = performance.now();
        await c.write(
          new TextEncoder().encode(
            JSON.stringify({ v: 2, t: "action", d: { type: "c:inc" } }) + "\n",
          ),
        );
        await until("the refusal line", () => lines.some(loud));
        assert(
          performance.now() - t0 < PROBE_GRACE_MS,
          "a peer that sent something is said at once, not after the grace",
        );
        const line = lines.find(loud)!;
        assertStringIncludes(line, "local-peer lockdown: refused a process on");
        assertStringIncludes(line, `it is pid ${Deno.pid}`);
        assertEquals(dispatched(), 0, "the refused frame reached dispatch");
      } finally {
        c.close();
      }
    });
  },
});

Deno.test({
  name:
    "probe: a foreign peer that connects and WAITS — sending nothing — is refused loudly too",
  ignore: Deno.build.os === "windows",
  async fn() {
    // The server speaks first on this socket: the app's own window, started
    // through a wrapper, connects and waits for the hello; so would a process
    // hoping to be handed state. Neither is a probe.
    await withDoor(async (sock, lines, until) => {
      const c = await Deno.connect({ transport: "unix", path: sock });
      try {
        await until("the refusal line", () => lines.some(loud));
        assertStringIncludes(
          lines.find(loud)!,
          "local-peer lockdown: refused a process on",
        );
        assert(
          !lines.some((l) => l.includes("hung up without sending anything")),
          "a peer still connected was taken for a probe",
        );
      } finally {
        c.close();
      }
    });
  },
});
