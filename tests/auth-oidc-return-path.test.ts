// The OIDC post-login return path (`?redirect=`) ends up in a `Location`
// header. A header value is a ByteString — any code point above 0xFF makes
// `new Headers()` throw — so the sanitizer must emit a valid ByteString that
// is still a same-origin path, for EVERY input. Property-tested: a fuzzed
// alphabet of the interesting characters (slashes, backslashes, percent,
// controls, non-Latin-1, query/hash) never produces a header that throws, a
// Location that leaves the origin, or a raw non-ASCII byte.
import { assert, assertEquals } from "@std/assert";
import { _safeReturnPath } from "../src/server/auth-oidc.ts";

const ORIGIN = "https://app.example";

/** Every guarantee `_safeReturnPath` must hold, for one input. */
function assertSafe(input: string | null): string {
  const out = _safeReturnPath(input);
  const label = `input=${JSON.stringify(input)} → ${JSON.stringify(out)}`;
  // 1. A valid ByteString: constructing the header never throws.
  new Headers({ Location: out });
  // 2. Printable ASCII only — no raw non-ASCII, no controls, no DEL.
  for (let i = 0; i < out.length; i++) {
    const c = out.charCodeAt(i);
    assert(c >= 0x21 && c <= 0x7e, `${label}: byte 0x${c.toString(16)}`);
  }
  // 3. Same-site absolute path: leading "/", never protocol-relative.
  assert(out[0] === "/", label);
  assert(out[1] !== "/" && out[1] !== "\\", label);
  // 4. The browser's own resolver agrees it stays on this origin.
  assertEquals(new URL(out, ORIGIN).origin, ORIGIN, label);
  // 5. Idempotent — the value stored in the state token at /start is what the
  //    callback re-sanitizes; a second pass must not re-encode "%".
  assertEquals(_safeReturnPath(out), out, `${label} (idempotence)`);
  return out;
}

Deno.test("oidc return path: non-Latin-1 paths encode to a same-origin ByteString", () => {
  for (
    const [input, expected] of [
      ["/", "/"],
      ["/orders/7", "/orders/7"],
      ["/é", "/%C3%A9"], // Latin-1: always survived, must still round-trip
      ["/漢", "/%E6%BC%A2"], // > 0xFF: used to 500 the callback
      ["/文档/1", "/%E6%96%87%E6%A1%A3/1"],
      ["/🚀", "/%F0%9F%9A%80"],
      ["/a​b", "/a%E2%80%8Bb"], // zero-width space
      ["/x?q=漢#h", "/x?q=%E6%BC%A2#h"], // query + hash keep their shape
      ["/a b", "/a%20b"],
      ["/%E6%BC%A2", "/%E6%BC%A2"], // already encoded: untouched
      ["/a\\b", "/a/b"], // what the browser would do with it anyway
    ] as const
  ) {
    assertEquals(assertSafe(input), expected, `input=${input}`);
  }
});

Deno.test("oidc return path: open-redirect shapes still collapse to '/'", () => {
  for (
    const input of [
      null,
      "",
      "orders/7", // relative: ambiguous against the callback URL
      "https://evil.example/",
      "javascript:alert(1)",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example", // browser strips TAB → protocol-relative
      "/\n//evil",
      "/\r\n//evil",
      "/a\x01b", // any C0 control anywhere
      "/a\x7fb", // DEL
      " /a", // leading space the parser would trim
    ]
  ) {
    assertEquals(assertSafe(input), "/", `input=${JSON.stringify(input)}`);
  }
  // Percent-encoded slashes are NOT decoded by a browser's URL resolver, so
  // they are a same-origin path, not a protocol-relative URL.
  assertEquals(assertSafe("/%2F%2Fevil.example"), "/%2F%2Fevil.example");
  assertEquals(assertSafe("/%09/evil.example"), "/%09/evil.example");
});

Deno.test("oidc return path: property — every input yields a same-origin ByteString", () => {
  // Deterministic LCG so a failure reproduces from the seed in the message.
  let seed = 0x2225;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alphabet = [
    "/",
    "\\",
    "%",
    "2F",
    "?",
    "#",
    "&",
    "=",
    ".",
    " ",
    "a",
    "Z",
    "9",
    "-",
    "é",
    "ÿ",
    "漢",
    "文档",
    "🚀",
    "​",
    "﻿",
    "\t",
    "\n",
    "\r",
    "\x00",
    "\x1f",
    "\x7f",
    "\x80",
    "\xff",
    "evil.example",
    "https:",
    "javascript:",
  ];
  for (let i = 0; i < 3000; i++) {
    const len = rnd(9);
    let s = rnd(4) === 0 ? "" : "/";
    for (let j = 0; j < len; j++) s += alphabet[rnd(alphabet.length)];
    assertSafe(s);
  }
});

Deno.test("oidc callback: the redirect header is built BEFORE a session is minted", async () => {
  // Structural guard: if building the response could ever throw, it must do
  // so before `sessions.issue()` — otherwise a session row is created that no
  // browser will ever hold (orphaned) while the user sees a 500.
  const src = await Deno.readTextFile(
    new URL("../src/server/auth-oidc.ts", import.meta.url),
  );
  const body = src.slice(src.indexOf("export async function oidcCallback("));
  const location = body.indexOf("Location:");
  const issue = body.indexOf("sessions.issue(");
  assert(location > 0 && issue > 0, "both sites present");
  assert(
    location < issue,
    "oidcCallback: build the Location header before sessions.issue()",
  );
});
