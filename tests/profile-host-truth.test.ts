// 50audits §8: `am profile` handed out the machine's LAN IP for a loopback-only
// app.
//
//   $ am config    {"port":53128,"expose":false, …}   # bind 127.0.0.1
//   $ am profile   {"aio":1,"host":"192.168.88.151","port":53128, …}
//
// `profile.ts` was `host: lanIP()`, unconditionally. The resulting `.aioapp`
// cannot connect — nothing is listening on that address — and it puts this
// machine's LAN address into a file whose whole purpose is to be handed to
// someone else. `cmdProfile`'s own error text already names the requirement
// ("start it (with --expose) first"), so the command knew the rule and did not
// enforce it.
//
// The lock is the decider: `discovery` is written ONLY for an `--expose`d
// instance.
import { assert, assertEquals } from "@std/assert";
import { buildLocalProfile } from "../src/server/profile.ts";
import { removeLock, writeLock } from "../src/server/single-instance-lock.ts";
import { tempDirSync } from "../src/testing/temp-dir.ts";

function withLock(
  appId: string,
  discovery: { title?: string; tls: boolean; needsAuth: boolean } | undefined,
  fn: () => void,
): void {
  const tmp = tempDirSync("aio-profile-host-");
  const prev = Deno.env.get("XDG_DATA_HOME");
  Deno.env.set("XDG_DATA_HOME", tmp);
  try {
    writeLock({
      appId,
      pid: Deno.pid,
      port: 8123,
      startedAt: Date.now(),
      status: "started",
      cwd: Deno.cwd(),
      ...(discovery ? { discovery } : {}),
    });
    fn();
  } finally {
    removeLock(appId);
    if (prev === undefined) Deno.env.delete("XDG_DATA_HOME");
    else Deno.env.set("XDG_DATA_HOME", prev);
  }
}

Deno.test("profile: a LOOPBACK-only app names 127.0.0.1, never the LAN IP", () => {
  withLock("loopback-app", undefined, () => {
    const p = buildLocalProfile("loopback-app")!;
    assert(p, "profile built");
    assertEquals(
      p.host,
      "127.0.0.1",
      "nothing is listening on the LAN address of an app bound to loopback",
    );
    assertEquals(p.port, 8123);
  });
});

Deno.test("profile: an EXPOSED app gets a reachable address", () => {
  withLock("exposed-app", { tls: false, needsAuth: false }, () => {
    const p = buildLocalProfile("exposed-app")!;
    // Either a real LAN IPv4, or undefined on a host with no non-loopback
    // interface (CI in a network namespace) — never 127.0.0.1, which would
    // mean the loopback branch had swallowed the exposed one.
    assert(
      p.host === undefined || !p.host.startsWith("127."),
      `exposed app got ${p.host}`,
    );
  });
});
