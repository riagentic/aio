// The local-peer policy, pure — every branch of the ONE decider that decides
// whether a same-machine process may talk to the app.
//
// The property that matters: a required gate NEVER returns null from an
// identity it could not read, and never lets a different pid through. A file
// (`control.key`), an env value or a PIN cannot do this — a same-user process
// reads them all — which is why the kernel's answer is the one that is used.
import { assertEquals } from "@std/assert";
import { peerRefusal, UNKNOWN_PEER } from "../src/server/local-peer.ts";

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
