// Bug hunt r10 (ui): route matching is case-sensitive in the hex of the two
// escapes it keeps (`%2F` / `%25`) — and only those.
//
// src/air/router-core.ts `_pathForMatch` decodes every percent-escape for
// comparison EXCEPT `%2F` and `%25`, which it keeps "as written". Every other
// escape therefore compares case-insensitively (`%c3%a9` ≡ `%C3%A9` ≡ `é`,
// because both decode), but `%2f` vs `%2F` — the same octet (RFC 3986
// §6.2.2.1: hex digits in an escape are case-insensitive) — compare as two
// different strings. The browser keeps whatever case the link was written
// with, so a url `/files/a%2fb` fails `<Route path="/files/a%2Fb">`, and the
// NavLink to one spelling is never active on the other spelling's page.
import { assertEquals, assertNotEquals } from "@std/assert";
import { _normalizeRoutePath, matchPath } from "../src/air/router-core.ts";

Deno.test("matchPath: %2f and %2F are the same escape (as %c3%a9 and %C3%A9 already are)", () => {
  // Control: any other escape already matches regardless of hex case.
  assertEquals(matchPath("/caf%C3%A9", "/caf%c3%a9"), {});
  // The kept escapes must too.
  assertNotEquals(
    matchPath("/files/a%2Fb", "/files/a%2fb"),
    null,
    "static segment a%2Fb must match the url a%2fb",
  );
  assertEquals(
    _normalizeRoutePath("/files/a%2fb"),
    _normalizeRoutePath("/files/a%2Fb"),
    "Link active state compares these normalised paths",
  );
});
