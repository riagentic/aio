// The local-peer policy, pure — every branch of the ONE decider that decides
// whether a same-machine process may talk to the app.
//
// The property that matters: a required gate NEVER returns null from an
// identity it could not read, and never lets a different pid through. A file
// (`control.key`), an env value or a PIN cannot do this — a same-user process
// reads them all — which is why the kernel's answer is the one that is used.
import { assert, assertEquals } from "@std/assert";
import { parseLstartUtc } from "../src/server/single-instance-lock.ts";
import {
  createLocalPeerGate,
  darwinProcessStart,
  decodeBsdInfoStart,
  foreignCtlAllowed,
  foreignHealthView,
  peerRefusal,
  requireLocalPeer,
  UNKNOWN_PEER,
} from "../src/server/local-peer.ts";

// The FFI library is a resource Deno's sanitizer tracks per test: open it
// here, before any case, so no case opens a library it does not close.
requireLocalPeer();

Deno.test("local-peer: an unreadable identity is refused when a pid is required", () => {
  const why = peerRefusal(null, {
    selfUid: 1000,
    allowedPid: 42,
    requirePid: true,
  });
  assertEquals(typeof why, "string");
});

Deno.test("local-peer: the unknown identity is refused when a pid is required", () => {
  assertEquals(
    typeof peerRefusal(UNKNOWN_PEER, {
      selfUid: 1000,
      allowedPid: 42,
      requirePid: true,
    }),
    "string",
  );
});

Deno.test("local-peer: another user is refused, and named as another user", () => {
  const why = peerRefusal({ pid: 42, uid: 1001, gid: 1001 }, {
    selfUid: 1000,
    allowedPid: 42,
    requirePid: true,
  });
  assertEquals(typeof why, "string");
  assertEquals(why!.includes("another user"), true);
});

Deno.test("local-peer: a different pid is refused, and named as not the window", () => {
  const why = peerRefusal({ pid: 7, uid: 1000, gid: 1000 }, {
    selfUid: 1000,
    allowedPid: 42,
    requirePid: true,
  });
  assertEquals(typeof why, "string");
  assertEquals(why!.includes("not this app's window"), true);
});

Deno.test("local-peer: an unarmed gate refuses even the right pid", () => {
  const why = peerRefusal({ pid: 42, uid: 1000, gid: 1000 }, {
    selfUid: 1000,
    allowedPid: null,
    requirePid: true,
  });
  assertEquals(typeof why, "string");
  assertEquals(why!.includes("has not registered"), true);
});

Deno.test("local-peer: the armed window's own pid is allowed", () => {
  assertEquals(
    peerRefusal({ pid: 42, uid: 1000, gid: 1000 }, {
      selfUid: 1000,
      allowedPid: 42,
      requirePid: true,
    }),
    null,
  );
});

Deno.test("local-peer: without a pid requirement, only the user is judged", () => {
  assertEquals(
    peerRefusal({ pid: 999, uid: 1000, gid: 1000 }, {
      selfUid: 1000,
      allowedPid: 42,
      requirePid: false,
    }),
    null,
  );
});

// ── pid + START TIME: a pid is a number the kernel hands out again ───────────

Deno.test("local-peer: the window's pid with ANOTHER start time is refused (pid reuse)", () => {
  const policy = {
    selfUid: 1000,
    allowedPid: 42,
    allowedStart: "1000",
    requirePid: true,
  };
  assertEquals(
    peerRefusal({ pid: 42, uid: 1000, gid: 1000 }, {
      ...policy,
      startOf: () => "1000",
    }),
    null,
    "the armed process itself",
  );
  const why = peerRefusal({ pid: 42, uid: 1000, gid: 1000 }, {
    ...policy,
    startOf: () => "2000",
  });
  assertEquals(why!.includes("reused"), true, String(why));
  // A process whose start cannot be read is not the armed one either.
  assertEquals(
    typeof peerRefusal({ pid: 42, uid: 1000, gid: 1000 }, {
      ...policy,
      startOf: () => null,
    }),
    "string",
  );
});

Deno.test("local-peer: where the platform has no start stamp, the pid decides", () => {
  assertEquals(
    peerRefusal({ pid: 42, uid: 1000, gid: 1000 }, {
      selfUid: 1000,
      allowedPid: 42,
      allowedStart: null,
      startOf: () => "anything",
      requirePid: true,
    }),
    null,
  );
});

// ── The gate: arm, disarm, and a refusal that is SAID ────────────────────────

function gateWith(starts: Record<number, string>) {
  const said: string[] = [];
  let t = 0;
  const gate = createLocalPeerGate({
    selfUid: 1000,
    startOf: (pid) => starts[pid] ?? null,
    warn: (m) => said.push(`WARN ${m}`),
    error: (m) => said.push(`ERROR ${m}`),
    now: () => t,
  });
  const peer = (pid: number) => ({
    peerIdentity: () => ({ pid, uid: 1000, gid: 1000 }),
  });
  return { gate, said, peer, tick: (ms: number) => t += ms };
}

Deno.test("local-peer gate: unarmed refuses, armed admits the window, disarmed refuses again", () => {
  const { gate, peer } = gateWith({ 42: "s42" });
  assertEquals(typeof gate.refusal(peer(42), "door"), "string");
  gate.arm(42);
  assertEquals(gate.refusal(peer(42), "door"), null);
  gate.disarm(42);
  assertEquals(
    typeof gate.refusal(peer(42), "door"),
    "string",
    "a window that exited is no longer trusted — its pid goes back to the kernel",
  );
});

Deno.test("local-peer gate: a late exit of the OLD window does not disarm its successor", () => {
  const { gate, peer } = gateWith({ 42: "a", 43: "b" });
  gate.arm(42);
  gate.arm(43); // the window was respawned
  gate.disarm(42); // …and only now does the old one's exit arrive
  assertEquals(gate.refusal(peer(43), "door"), null);
  assertEquals(typeof gate.refusal(peer(42), "door"), "string");
});

Deno.test("local-peer gate: a recycled pid is refused by its start time", () => {
  const starts: Record<number, string> = { 42: "boot+100" };
  const { gate, peer } = gateWith(starts);
  gate.arm(42);
  starts[42] = "boot+900"; // the window died; the kernel reused the number
  const why = gate.refusal(peer(42), "door");
  assertEquals(why!.includes("reused"), true, String(why));
});

Deno.test("local-peer gate: a refusal is logged with its REASON, once per peer and door per minute", () => {
  const { gate, peer, said, tick } = gateWith({ 42: "s" });
  gate.arm(42);
  for (let i = 0; i < 50; i++) gate.refusal(peer(7), "/run/app.sock", "NOTE.");
  assertEquals(said.length, 1, "a hammering peer must not flood the log");
  assertEquals(said[0]!.startsWith("WARN "), true);
  for (const part of ["/run/app.sock", "pid 7", "the window is 42", "NOTE."]) {
    assertEquals(said[0]!.includes(part), true, `${part} missing: ${said[0]}`);
  }
  gate.refusal(peer(7), "/run/app.http.sock");
  gate.refusal(peer(8), "/run/app.sock");
  assertEquals(said.length, 3, "another door and another peer are news");
  tick(60_000);
  gate.refusal(peer(7), "/run/app.sock");
  assertEquals(said.length, 4, "still knocking a minute later is said again");
  // A trusted connection says nothing.
  gate.refusal(peer(42), "/run/app.sock");
  assertEquals(said.length, 4);
});

Deno.test("local-peer gate: an unreadable identity is refused and said", () => {
  const { gate, said } = gateWith({});
  gate.arm(42);
  assertEquals(typeof gate.refusal({}, "door"), "string");
  assertEquals(
    typeof gate.refusal({ peerIdentity: () => UNKNOWN_PEER }, "d2"),
    "string",
  );
  assertEquals(said.length, 2);
  assertEquals(said[0]!.includes("could not be read"), true);
});

// ── What an untrusted peer may still ask over `ctl` ──────────────────────────

// The stop passes the DOOR only — the server answers it to this boot's
// control credential alone (local-peer-lockdown-e2e.test.ts pins that).
Deno.test("local-peer: the foreign ctl allow-list is GET /__aio/health and the stop, nothing else", () => {
  assertEquals(foreignCtlAllowed("GET", "/__aio/health"), true);
  assertEquals(foreignCtlAllowed("GET", "/__aio/health?x=1"), true);
  assertEquals(foreignCtlAllowed("POST", "/__aio/trojan/shutdown"), true);
  for (
    const [method, path] of [
      ["POST", "/__aio/health"],
      ["GET", "/__aio/health/"],
      ["GET", "/__aio/healthz"],
      ["GET", "/__aio/vitals"],
      ["GET", "/__aio/metrics"],
      ["GET", "/__aio/snapshot"],
      ["GET", "/__aio/trojan/state"],
      ["GET", "/__aio/trojan/shutdown"],
      ["POST", "/__aio/trojan/shutdown/"],
      ["POST", "/__aio/trojan/shutdownx"],
      ["POST", "/__aio/trojan/dispatch"],
      ["POST", "/__aio/trojan/sql"],
      ["POST", "//__aio/trojan/shutdown"],
      ["GET", "/"],
      ["GET", "/api/anything"],
      ["GET", "/ws"],
      ["GET", "//__aio/health"],
      ["GET", "/x/../__aio/health"],
    ] as const
  ) {
    assertEquals(foreignCtlAllowed(method, path), false, `${method} ${path}`);
  }
});

Deno.test("local-peer: the foreign health view is status + appId, whatever the document holds", () => {
  const full = JSON.stringify({
    status: "healthy",
    version: "1.0.0",
    appId: "myapp",
    pid: 4242,
    uptime: 12,
    cells: [{ id: "wallet", lastAction: "wallet:send" }],
    persist: { ok: false, error: "disk full at /home/someone/.myapp" },
  });
  assertEquals(JSON.parse(foreignHealthView(full)), {
    status: "healthy",
    appId: "myapp",
  });
  // Not the health document (an app route shadowing the path): nothing passes.
  assertEquals(foreignHealthView("plain text with a secret"), "{}");
  assertEquals(foreignHealthView('["a","b"]'), "{}");
  assertEquals(foreignHealthView("null"), "{}");
  assertEquals(
    foreignHealthView('{"status":{"nested":"secret"},"appId":7}'),
    "{}",
  );
});

// ── macOS: the window's start time, read from the kernel ────────────────────

/** `struct proc_bsdinfo` as `proc_pidinfo(46351, PROC_PIDTBSDINFO)` filled it
 *  on macOS 26 arm64 — a `deno` whose `ps -o lstart=` read 1791310976. (The
 *  macOS 14 x86_64 capture has the same layout.) */
const BSDINFO_46351 =
  "3040400002000000000000000fb500000eb50000f501000014000000f5010000" +
  "14000000f5010000140000000000000064656e6f0073657373696f6e00726100" +
  "64656e6f0073657373696f6e0072617070657200000000000000000000000000" +
  "190000000fb5000000000000ffffffff0000000005000000803cc56a00000000" +
  "258c070000000000";
const unhex = (h: string) =>
  Uint8Array.from(h.match(/../g)!, (b) => parseInt(b, 16));

Deno.test("local-peer: a captured proc_bsdinfo decodes to its start second and microsecond", () => {
  const buf = unhex(BSDINFO_46351);
  assertEquals(buf.length, 136);
  assertEquals(decodeBsdInfoStart(buf, 46351), "1791310976.494629");
  // A view into a larger buffer reads its own bytes, not the buffer's.
  const padded = new Uint8Array(200);
  padded.set(buf, 64);
  assertEquals(
    decodeBsdInfoStart(padded.subarray(64), 46351),
    "1791310976.494629",
  );
  // Anything that is not that struct, filled in for THAT pid, is "cannot say".
  assertEquals(decodeBsdInfoStart(buf, 46352), null, "another pid's struct");
  assertEquals(decodeBsdInfoStart(buf.subarray(0, 135), 46351), null, "short");
  assertEquals(decodeBsdInfoStart(new Uint8Array(136), 0), null, "unfilled");
  const badUsec = buf.slice();
  new DataView(badUsec.buffer).setBigUint64(128, 1_000_000n, true);
  assertEquals(decodeBsdInfoStart(badUsec, 46351), null, "not a microsecond");
});

Deno.test("local-peer: off macOS, and for a pid that cannot be one, there is no darwin start", () => {
  assertEquals(darwinProcessStart(Deno.pid, "linux"), null);
  assertEquals(darwinProcessStart(Deno.pid, "windows"), null);
  for (const pid of [0, -1, 1.5, NaN]) {
    assertEquals(darwinProcessStart(pid, "darwin"), null, String(pid));
  }
});

Deno.test({
  name:
    "local-peer: on macOS a process's start is stable, the same from another process, and its own",
  ignore: Deno.build.os !== "darwin", // proc_pidinfo is macOS's; Linux and Windows have processStartToken
  async fn() {
    const mine = darwinProcessStart(Deno.pid);
    assert(mine !== null && /^\d+\.\d{6}$/.test(mine), String(mine));
    assertEquals(darwinProcessStart(Deno.pid), mine, "two reads, one answer");

    // The second is the one `ps` prints — the layout is not merely plausible.
    const ps = await new Deno.Command("ps", {
      args: ["-o", "lstart=", "-p", String(Deno.pid)],
      env: { LC_ALL: "C", LANG: "C", TZ: "UTC" },
      stdout: "piped",
    }).output();
    assertEquals(
      Number(mine.split(".")[0]),
      parseLstartUtc(new TextDecoder().decode(ps.stdout)),
      "ps -o lstart= agrees on the second",
    );

    // Another process reads the SAME value for this pid, and its own differs.
    const mod = new URL("../src/server/local-peer.ts", import.meta.url).href;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { darwinProcessStart as s } from ${JSON.stringify(mod)};
         console.log(JSON.stringify([s(${Deno.pid}), s(Deno.pid)]));
         await Deno.stdin.read(new Uint8Array(1));`,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    const out = child.stdout.getReader();
    try {
      const line = (await out.read()).value;
      const [ofMe, ofItself] = JSON.parse(new TextDecoder().decode(line));
      assertEquals(ofMe, mine, "read from another process");
      assertEquals(darwinProcessStart(child.pid), ofItself, "and the reverse");
      assert(ofItself !== mine, "a different process, a different start");

      // The gate, on the real read: this process armed as the window is
      // admitted; the same PID recorded with another process's start is not.
      const peer = { peerIdentity: () => ({ pid: Deno.pid, uid: 0, gid: 0 }) };
      const gateOn = (startOf: (pid: number) => string | null) =>
        createLocalPeerGate({
          selfUid: 0,
          startOf,
          warn: () => {},
          error: () => {},
        });
      const real = gateOn(darwinProcessStart);
      real.arm(Deno.pid);
      assertEquals(real.refusal(peer, "door"), null);
      let armed = false;
      const recycled = gateOn((pid) =>
        armed ? darwinProcessStart(pid) : (armed = true, ofItself)
      );
      recycled.arm(Deno.pid);
      const why = recycled.refusal(peer, "door");
      assert(why?.includes("reused"), String(why));
    } finally {
      await child.stdin.close();
      await out.cancel();
      await child.status;
    }

    // A process this user does not own: the kernel does not answer, and that
    // is "cannot say" — the gate then keeps the pid alone, as before.
    assertEquals(darwinProcessStart(1), null, "launchd");
  },
});

// ── No peer credentials ⇒ no gate ⇒ no boot ─────────────────────────────────

Deno.test("local-peer: requireLocalPeer passes where credentials are readable", () => {
  // This suite runs with -A: the library opens. (The refusal itself needs a
  // process WITHOUT --allow-ffi — tests/local-peer-lockdown-e2e.test.ts.)
  assertEquals(requireLocalPeer(), undefined);
  // Windows reads the pid off the pipe handle and needs nothing from here.
  assertEquals(requireLocalPeer("windows"), undefined);
});

Deno.test({
  name:
    "local-peer: hardenLocalPeer makes the process unreadable to another process of the same user",
  ignore: Deno.build.os !== "linux", // a non-dumpable process, proven by reading its /proc entries
  async fn() {
    // The memory half of the lockdown: a non-dumpable process's `/proc`
    // entries are closed to everyone but root. Proven from OUTSIDE — this
    // process tries to list the child's descriptors — with a child that did
    // not harden itself as the control.
    const mod = new URL("../src/server/local-peer.ts", import.meta.url).href;
    const run = async (harden: boolean) => {
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `import { hardenLocalPeer } from ${JSON.stringify(mod)};
           console.log(${harden} ? hardenLocalPeer() : "skipped");
           await Deno.stdin.read(new Uint8Array(1));`,
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "inherit",
      }).spawn();
      try {
        const r = child.stdout.getReader();
        const said = new TextDecoder().decode((await r.read()).value).trim();
        r.releaseLock();
        let readable = true;
        try {
          for await (const _ of Deno.readDir(`/proc/${child.pid}/fd`)) break;
        } catch (e) {
          if (!(e instanceof Deno.errors.PermissionDenied)) throw e;
          readable = false;
        }
        return { said, readable };
      } finally {
        await child.stdin.close();
        await child.stdout.cancel();
        await child.status;
      }
    };
    assertEquals(await run(false), { said: "skipped", readable: true });
    assertEquals(await run(true), { said: "true", readable: false });
  },
});
