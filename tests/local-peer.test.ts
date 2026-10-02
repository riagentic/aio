// The local-peer policy, pure — every branch of the ONE decider that decides
// whether a same-machine process may talk to the app.
//
// The property that matters: a required gate NEVER returns null from an
// identity it could not read, and never lets a different pid through. A file
// (`control.key`), an env value or a PIN cannot do this — a same-user process
// reads them all — which is why the kernel's answer is the one that is used.
import { assertEquals } from "@std/assert";
import {
  createLocalPeerGate,
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
  ignore: Deno.build.os !== "linux",
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
