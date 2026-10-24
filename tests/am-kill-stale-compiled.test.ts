// `am kill --stale` and a COMPILED app's orphan.
//
// The check that keeps `am` from signalling a stranger accepted a process
// only when its command line said `deno` or `aio`. A compiled app runs under
// its own name, so its orphan was spared by every `am kill --stale`, for
// good. The name is not widened: a process with another name is accepted
// only when the OS says THAT pid holds the listening socket the aio health
// answer came from.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { listenerPids, stalePidRefusal } from "../src/am/am-cmd-process.ts";
import { freePort } from "../src/testing/server-test.ts";

const none = new Map<number, { appId: string; dir: string }>();

Deno.test("listenerPids: each OS's own answer, parsed", () => {
  const ss =
    `LISTEN 0 511 127.0.0.1:8123 0.0.0.0:* users:(("notes",pid=4242,fd=9),("notes",pid=4243,fd=9))\n`;
  const notes = () => "notes";
  assertEquals(listenerPids(8123, "linux", () => ss, notes), [4242, 4243]);
  // The NAME in that line is its owner's to choose. A listener called
  // `pid=1`, or one whose name closes the quote and writes an entry of its
  // own, names nobody: only its real pid is answered.
  const names: Record<number, string> = {
    42: "pid=1",
    43: '",pid=1,fd=3),(',
    1: "systemd",
  };
  for (const pid of [42, 43]) {
    const spoof = `LISTEN 0 511 127.0.0.1:8123 0.0.0.0:* users:(("${
      names[pid]
    }",pid=${pid},fd=9))\n`;
    assertEquals(
      listenerPids(8123, "linux", () => spoof, (p) => names[p] ?? null),
      [pid],
      spoof,
    );
  }
  // A pid whose name cannot be read is not proven.
  assertEquals(listenerPids(8123, "linux", () => ss, () => null), []);
  assertEquals(listenerPids(8123, "darwin", () => "4242\n4250\n"), [
    4242,
    4250,
  ]);
  const netstat = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:8123         0.0.0.0:0              LISTENING       4242",
    "  TCP    127.0.0.1:18123        0.0.0.0:0              LISTENING       7",
    "  TCP    127.0.0.1:8123         127.0.0.1:50000        ESTABLISHED     9",
    "  TCP    [::1]:8123             [::]:0                 LISTENING       4244",
  ].join("\r\n");
  assertEquals(listenerPids(8123, "windows", () => netstat), [4242, 4244]);
  // netstat translates the state word; a listener is told by its foreign
  // port 0, which no language changes.
  const de = netstat.replaceAll("LISTENING", "ABHÖREN")
    .replace("ESTABLISHED", "HERGESTELLT");
  assertEquals(listenerPids(8123, "windows", () => de), [4242, 4244]);
  // No tool, no answer: nothing is proven.
  for (const os of ["linux", "darwin", "windows"]) {
    assertEquals(listenerPids(8123, os, () => null), []);
  }
});

/** A process that is NOT called deno or aio and listens on `port`. */
function standIn(port: number): Deno.ChildProcess {
  return Deno.build.os === "windows"
    ? new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        `$l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, ${port}); $l.Start(); 'UP'; Start-Sleep -Seconds 120`,
      ],
      stdout: "piped",
      stderr: "null",
    }).spawn()
    : new Deno.Command("python3", {
      args: [
        "-c",
        `import socket,time,sys\ns=socket.socket()\ns.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\ns.bind(("127.0.0.1",${port}))\ns.listen(1)\nprint("UP",flush=True)\ntime.sleep(120)`,
      ],
      // Out of any directory whose path could itself read as "aio".
      cwd: "/",
      stdout: "piped",
      stderr: "null",
    }).spawn();
}

async function up(p: Deno.ChildProcess): Promise<void> {
  const r = p.stdout.getReader();
  let seen = "";
  while (!seen.includes("UP")) {
    const { value, done } = await r.read();
    if (done) break;
    seen += new TextDecoder().decode(value);
  }
  r.releaseLock();
  assert(seen.includes("UP"), "the stand-in never listened");
}

async function end(p: Deno.ChildProcess): Promise<void> {
  try {
    p.kill("SIGKILL");
  } catch { /* aio-ok: already gone */ }
  await p.stdout.cancel().catch(() => {});
  await p.status;
}

Deno.test("kill --stale: a process under its own name is accepted only when it holds the port that answered", async () => {
  const port = freePort();
  const app = standIn(port);
  const other = standIn(freePort()); // a stranger: alive, ours, another port
  try {
    await up(app);
    await up(other);
    // The OS names the stand-in as the listener — and not the stranger.
    assert(listenerPids(port).includes(app.pid), `${listenerPids(port)}`);
    assert(!listenerPids(port).includes(other.pid));

    // By name alone: refused, as ever.
    assertStringIncludes(
      stalePidRefusal(app.pid, none) ?? "",
      "is not an aio process",
    );
    // With the evidence: it IS the app that answered on `port`.
    assertEquals(
      stalePidRefusal(
        app.pid,
        none,
        () => listenerPids(port).includes(app.pid),
      ),
      null,
    );
    // A pid the listener merely NAMED — the attack the check exists for —
    // does not hold that socket, and stays refused.
    assertStringIncludes(
      stalePidRefusal(
        other.pid,
        none,
        () => listenerPids(port).includes(other.pid),
      ) ?? "",
      "is not an aio process",
    );
  } finally {
    await end(app);
    await end(other);
  }
});
