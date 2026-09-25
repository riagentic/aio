// docs/auth/auth.md: "everything aio prints … names the address it actually
// bound". The plain-HTTP warning said "serving on 0.0.0.0" for an app bound
// with `--host=127.0.0.1`, contradicting the boot line printed beside it.
import { assert, assertStringIncludes } from "@std/assert";
import { _noTlsWarning } from "../src/server/aio-server.ts";

Deno.test("_noTlsWarning: names the host actually bound, not a hard-coded 0.0.0.0", () => {
  const w = _noTlsWarning(true, "config", "192.168.1.20");
  assertStringIncludes(w, "serving on 192.168.1.20 over PLAIN HTTP/WS");
  assert(!w.includes("0.0.0.0"), w);
  // The wildcard bind still reads as the wildcard.
  assertStringIncludes(
    _noTlsWarning(true, "flag", "0.0.0.0"),
    "serving on 0.0.0.0",
  );
});
