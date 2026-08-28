// The Host allowlist, fuzzed — because "is this a name this server answers to"
// is a security question answered by a PARSER, and parsers are where the
// example-based tests all agree with each other and with the bug.
//
// Found by exactly this: `evil.com:80:80`. `_hostnameOfHeader` took everything
// before the LAST colon, yielding `evil.com:80`, and `_isIpLiteral` was
// "contains a colon ⇒ IPv6, and an IP literal cannot be the product of DNS".
// So an attacker-controlled domain was read as an address and allowed — the
// allowlist bypassed by a header any proxy or non-browser client can send. The
// unit tests passed: none of them had two colons in a Host.
//
// The property below is the one that matters and the one a table of examples
// cannot state: NO string built around a domain the app does not know may be
// allowed, however it is decorated.
import { assert, assertEquals } from "@std/assert";
import { _hostnameOfHeader, hostAllowed } from "../src/server/server-auth.ts";

const OPTS = {
  bindHost: "0.0.0.0",
  allowedOrigins: ["app.example.com", "https://ui.example.com"],
};

/** Decorations an attacker controls, applied around a hostname. Each is a
 *  shape a Host header can carry — ports, brackets, dots, case, whitespace. */
const DECORATIONS: ((h: string) => string)[] = [
  (h) => h,
  (h) => `${h}:80`,
  (h) => `${h}:80:80`,
  (h) => `${h}::`,
  (h) => `${h}:x`,
  (h) => `${h}:x:y`,
  (h) => `${h}.`,
  (h) => `${h}..`,
  (h) => ` ${h} `,
  (h) => h.toUpperCase(),
  (h) => `[${h}]`,
  (h) => `[${h}`,
  (h) => `${h}]`,
  (h) => `${h}:`,
  (h) => `:${h}`,
  (h) => `${h}%00`,
  (h) => `${h}\t`,
  (h) => `${h}:65536`,
  (h) => `${h}:-1`,
  (h) => `${h}.localhost.evil`,
];

/** Domains this app is NOT served as. None may be allowed, however decorated. */
const HOSTILE = [
  "evil.com",
  "app.example.com.evil.com",
  "notapp.example.com",
  "sub.app.example.com",
  "example.com",
  "ui.example.com.evil.net",
  "xn--pple-43d.com",
];

Deno.test("hostAllowed: no decoration of a foreign domain is ever allowed", () => {
  const leaked: string[] = [];
  for (const host of HOSTILE) {
    for (const dec of DECORATIONS) {
      const h = dec(host);
      // `*.localhost` is allowed BY DESIGN (RFC 6761 reserves it and resolvers
      // map it to loopback, so it names this machine, not the attacker's).
      // That is the one decoration that legitimately flips the answer.
      if (_hostnameOfHeader(h).endsWith(".localhost")) continue;
      if (hostAllowed(h, OPTS)) leaked.push(h);
    }
  }
  assertEquals(
    leaked,
    [],
    `a foreign domain was allowed through the Host allowlist — the check is ` +
      `what stands between a page on that domain and same-origin access to ` +
      `this app's raw state`,
  );
});

Deno.test("hostAllowed: every name the app IS served as survives decoration", () => {
  // The other half. A security control that refuses the developer who owns the
  // machine gets turned off, and then it protects nothing.
  const cases: [string, string][] = [
    ["localhost", "the default"],
    ["localhost.", "the root-label form a browser sends if you type it"],
    ["localhost:3000", "with a port"],
    ["localhost.:3000", "both"],
    ["app.example.com", "an allowedOrigins entry"],
    ["app.example.com.", "…with the root dot"],
    ["APP.EXAMPLE.COM", "…in any case"],
    ["ui.example.com", "an allowedOrigins entry written as a full origin"],
    ["127.0.0.1", "an IPv4 literal — no DNS in the loop"],
    ["127.0.0.1:8080", "…with a port"],
    ["10.0.0.5", "a LAN address, which is what --expose serves on"],
    ["[::1]", "an IPv6 literal, bracketed as RFC 7230 wants"],
    ["[::1]:8080", "…with a port"],
    ["::1", "…and bare, which is malformed but unambiguous"],
    ["dev.localhost", "*.localhost is reserved and maps to loopback"],
  ];
  const refused = cases.filter(([h]) => !hostAllowed(h, OPTS));
  assertEquals(
    refused.map(([h, why]) => `${h} (${why})`),
    [],
    "a name this app really is reached as must not be refused",
  );
});

Deno.test("_hostnameOfHeader: a port is digits, and nothing else is a port", () => {
  // The parse that the bypass came through. Stated as a table so the next
  // reader can see what "malformed" resolves to rather than infer it.
  assertEquals(_hostnameOfHeader("app.example.com:8080"), "app.example.com");
  assertEquals(_hostnameOfHeader("app.example.com."), "app.example.com");
  assertEquals(_hostnameOfHeader("[::1]:8080"), "::1");
  assertEquals(_hostnameOfHeader("::1"), "::1");
  assertEquals(_hostnameOfHeader("2001:db8::1"), "2001:db8::1");
  // Two colons and not an address: NOT split into a fragment that could pass
  // for one. It comes back whole, and matches nothing.
  assertEquals(_hostnameOfHeader("evil.com:80:80"), "evil.com:80");
  assert(!hostAllowed("evil.com:80:80", OPTS));
  assertEquals(_hostnameOfHeader("evil.com:x"), "evil.com:x");
  assertEquals(_hostnameOfHeader(""), "");
});
