// IPv6: ONE CLIENT IS A /64, NOT ONE ADDRESS.
//
// Every per-client budget (signup cap, PBKDF2 work meter, failure budget, WS
// denylist) keys on the exact address string. An IPv6 host is routinely
// handed a whole /64 — 2^64 addresses it can source from at will — so a
// per-address bucket is no bound at all: the SIGNUP cap (10 accounts / hour
// per client) is unlimited anonymous account creation from one machine.
// pairing.ts names this exact bypass ("a rotating source is free (an IPv6
// /64 …)") and fixed it only for the PIN.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";

Deno.test("auth: signup cap holds across addresses of one IPv6 /64", async () => {
  _resetAuthFails();
  await using srv = await testServer({
    cells: [
      cell("r13b_v6", { state: { n: 0 }, visible: "all", methods: {} }),
    ],
    auth: true,
    trustProxyHeader: "x-forwarded-for",
  });
  const statuses: number[] = [];
  for (let i = 1; i <= 12; i++) {
    const r = await fetch(`${srv.url}/__aio/auth/signup`, {
      method: "POST",
      // The proxy appended the real client — a different host bits each time,
      // same /64.
      headers: { "x-forwarded-for": `2001:db8:1:2::${i.toString(16)}` },
      body: JSON.stringify({ id: `v6user${i}`, password: "pw-long-enough-1" }),
    });
    statuses.push(r.status);
    await r.body?.cancel();
  }
  _resetAuthFails();
  assertEquals(
    statuses.filter((s) => s === 429).length > 0,
    true,
    `12 signups from ONE /64 (2001:db8:1:2::/64) were all admitted: ${
      statuses.join(",")
    } — the 10/hour account cap is per ADDRESS, so an IPv6 client rotates ` +
      `past it for free`,
  );
});

Deno.test("abuseBucket: IPv4 as is, IPv6 by /64, mapped IPv4 unwrapped, loopback kept", async () => {
  const { abuseBucket } = await import("../src/server/server-auth.ts");
  const { assertEquals } = await import("@std/assert");
  assertEquals(abuseBucket("1.2.3.4"), "1.2.3.4");
  assertEquals(abuseBucket("::1"), "::1");
  assertEquals(abuseBucket("::ffff:10.0.0.1"), "10.0.0.1");
  assertEquals(abuseBucket("2001:db8:1:2::c"), "2001:db8:1:2::/64");
  assertEquals(
    abuseBucket("[2001:DB8:1:2:3:4:5:6]"),
    abuseBucket("2001:db8:1:2:ffff::"),
  );
  assertEquals(abuseBucket(undefined), "*");
  // The hex spelling of a mapped IPv4 is the same client.
  assertEquals(abuseBucket("::ffff:0a00:0001"), "10.0.0.1");
  // A trusted hop: RFC 7239 `for=`, quotes, brackets and a per-connection
  // source port never mint a fresh bucket.
  assertEquals(
    abuseBucket(`for="[2001:db8:1:2::1]:4711";proto=https`),
    "2001:db8:1:2::/64",
  );
  assertEquals(abuseBucket("[2001:db8:1:2::9]:80"), "2001:db8:1:2::/64");
  assertEquals(abuseBucket("for=1.2.3.4"), "1.2.3.4");
  assertEquals(abuseBucket("1.2.3.4:5678"), "1.2.3.4");
  assertEquals(abuseBucket("for=unknown"), "for=unknown");
  assertEquals(abuseBucket("not:an:address:zz"), "not:an:address:zz");
});
