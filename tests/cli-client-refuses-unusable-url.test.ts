// cli-client-refuses-unusable-url.test.ts — `connectCli` refuses, at the call,
// a URL no retry can ever connect to.
//
// `new URL("localhost:8000")` parses as protocol `localhost:` with an EMPTY
// host, so the client dialled `ws:///ws` and logged "still retrying" forever
// while `await app.ready` never returned; `ftp://host:port` was quietly dialled
// as `ws://`. A typo turned into an apparent hang.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { connectCli } from "../src/server/cli-client.ts";

Deno.test("connectCli: a bare host:port is refused with the spelling that works", () => {
  const e = assertThrows(() => connectCli("localhost:8000"), TypeError);
  assertStringIncludes(e.message, '"localhost:8000" is not an app URL');
  assertStringIncludes(e.message, 'connectCli("http://localhost:8000")');
});

Deno.test("connectCli: a scheme a client cannot connect with is refused", () => {
  const e = assertThrows(() => connectCli("ftp://localhost:8000"), TypeError);
  assertStringIncludes(e.message, '"ftp:"');
  assertStringIncludes(e.message, "http:, https:, ws: or wss:");
});

Deno.test("connectCli: the four real schemes still construct", () => {
  for (
    const u of [
      "http://127.0.0.1:9",
      "https://127.0.0.1:9",
      "ws://127.0.0.1:9/ws",
      "wss://127.0.0.1:9",
    ]
  ) {
    const app = connectCli(u);
    assertEquals(typeof app.bind, "function", u);
    app.close();
  }
});
