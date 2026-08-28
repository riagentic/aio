// "Same machine" has more than one spelling, and the control plane only knew
// one of them.
//
// The trojan (raw state, arbitrary SQL, shutdown) is same-machine-only by
// design — `_isLocalRequest` is the whole gate. It matched `127.0.0.1`, `::1`
// and `localhost`. But on a dual-stack listener (`--host=::`) an IPv4 loopback
// client arrives as `::ffff:127.0.0.1`, the IPv4-mapped form — measured, not
// assumed — so `am` could not drive an app bound to `::` from the very machine
// it was running on. A control plane refusing its own machine.
//
// Accepting the other spellings loosens nothing: a packet arriving on a real
// interface with a loopback source address is a martian and is dropped by the
// kernel, so "loopback source" means "same machine" however it is written.
import { assert, assertEquals } from "@std/assert";
import { _isLocalRequest, _isLoopbackAddr } from "../src/server/server.ts";

Deno.test("_isLoopbackAddr: every spelling the kernel can hand us", () => {
  const local = [
    "127.0.0.1",
    "127.0.0.2", // a per-service alias is an ordinary Linux setup
    "127.1.2.3",
    "::1",
    "[::1]",
    "localhost",
    "::ffff:127.0.0.1", // the one that was refused: dual-stack, IPv4 client
    "::FFFF:127.0.0.1", // case is not a property of an address
    "::ffff:127.0.0.5",
    "::127.0.0.1", // the deprecated IPv4-compatible form
  ];
  const refused = local.filter((h) => !_isLoopbackAddr(h));
  assertEquals(refused, [], "these all name this machine");
});

Deno.test("_isLoopbackAddr: nothing else is loopback", () => {
  const remote = [
    "10.0.0.5",
    "192.168.1.4",
    "128.0.0.1", // one bit off the loopback block
    "126.255.255.255",
    "0.0.0.0",
    "::",
    "::ffff:10.0.0.5", // a mapped address that is NOT loopback
    "::ffff:192.168.0.1",
    "evil.com",
    "127.0.0.1.evil.com", // a NAME that merely starts like one
    "not-an-address",
    "",
    "999.0.0.1",
    "127.0.0.256",
  ];
  const leaked = remote.filter((h) => _isLoopbackAddr(h));
  assertEquals(
    leaked,
    [],
    "the trojan is same-machine-only; anything reachable from elsewhere must " +
      "never satisfy this",
  );
});

Deno.test("_isLocalRequest: transports, and failing closed", () => {
  // A Unix socket is same-machine by construction — there is no network.
  assert(_isLocalRequest({ transport: "unix", path: "/tmp/x.sock" }));
  assert(_isLocalRequest({
    transport: "tcp",
    hostname: "::ffff:127.0.0.1",
    port: 1,
  }));
  assert(
    !_isLocalRequest({
      transport: "tcp",
      hostname: "10.0.0.5",
      port: 1,
    }),
  );
  // No address at all is not a reason to trust it.
  assert(!_isLocalRequest(undefined));
});
