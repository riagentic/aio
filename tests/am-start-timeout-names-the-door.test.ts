// When `am start` runs out of patience, it must name the door it knocked on.
//
// The message was `not responding on port ${port}` — where `port` is am's OWN
// placeholder, not anything the child bound. For the default desktop shape
// (`--client=electron`) that placeholder is 0, so a healthy-but-slow app was
// reported as "not responding on port 0": a port no process can listen on,
// naming nothing, while the unix socket it really waited at went unmentioned.
// The 10s wait it blew was a real symptom; the address in the message was not.
import { assertEquals } from "@std/assert";
import { waitedAt } from "../src/am/am-cmd-process.ts";

Deno.test("waitedAt: a socket-only app is named by its socket, never 'port 0'", () => {
  assertEquals(
    waitedAt({ port: 0, socketPath: "/run/user/1000/aio/cc.sock" }, undefined),
    "on socket /run/user/1000/aio/cc.sock",
  );
});

Deno.test("waitedAt: a port app is named by the port its own lock records", () => {
  // Not the probed value — the lock is the child's own account of what it bound.
  assertEquals(waitedAt({ port: 4321 }, 9999), "on port 4321");
});

Deno.test("waitedAt: with no lock yet, the port we probed is the honest answer", () => {
  assertEquals(waitedAt(null, 4321), "on port 4321");
});

Deno.test("waitedAt: knowing no address says so, rather than inventing port 0", () => {
  // The old wording's failure mode, pinned: nothing here may render as "port 0".
  for (const lock of [null, { port: 0 }] as const) {
    const msg = waitedAt(lock, undefined);
    assertEquals(msg, "— it recorded neither a port nor a socket");
    assertEquals(msg.includes("port 0"), false);
  }
});
