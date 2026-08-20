// `tls` as a CONFIG key (rimote R-7). `--no-tls` / `--tls-cert` / `--tls-key`
// were argv-only, so a COMPILED binary's transport could not be declared in
// deno.json — it depended on remembering a flag at launch, including inside a
// systemd unit the build itself generates. Same reasoning as `expose`: a
// service unit passes no shell flags, so "how this app serves" has to be
// expressible in code. The flags still win — the operator running the binary
// overrides the author.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { _tlsOf } from "../src/server/aio.ts";
import { _noTlsWarning } from "../src/server/aio-server.ts";
import {
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
} from "../src/server/config.ts";

Deno.test("_tlsOf: the three shapes", () => {
  // default and the explicit default are the same thing
  assertEquals(_tlsOf({}), { noTls: false });
  assertEquals(_tlsOf({ tls: "auto" }), { noTls: false });
  // opting out
  assertEquals(_tlsOf({ tls: false }), { noTls: true });
  // bringing your own
  assertEquals(
    _tlsOf({ tls: { cert: "/etc/ssl/a.pem", key: "/etc/ssl/a.key" } }),
    { cert: "/etc/ssl/a.pem", key: "/etc/ssl/a.key", noTls: false },
  );
});

Deno.test("_tlsOf: an unusable shape is refused at boot, naming the fix", () => {
  for (
    const bad of [
      { cert: "/a.pem" }, // half a pair — a cert with no key cannot serve
      { key: "/a.key" },
      { cert: "", key: "" },
      "off", // the spelling people guess for `false`
      true,
    ] as const
  ) {
    const e = assertThrows(
      // deno-lint-ignore no-explicit-any
      () => _tlsOf({ tls: bad as any }),
      Error,
    );
    // The message must carry all three legal shapes, not just "invalid".
    for (const want of ['"auto"', "false", "cert", "key"]) {
      if (!e.message.includes(want)) {
        throw new Error(`message must mention ${want}: ${e.message}`);
      }
    }
  }
});

Deno.test("tls is accepted by BOTH config surfaces (the 2-of-3 trap)", () => {
  // A key present in the type but absent from an allowlist is rejected at
  // runtime as a typo — the trap this project keeps a gate for.
  for (const set of [VALID_AIO_CONFIG_KEYS, VALID_FEATURES_CONFIG_KEYS]) {
    if (!set.has("tls")) throw new Error("tls missing from a config allowlist");
  }
});

// The warning has to name what the AUTHOR wrote. `--no-tls` and `tls: false`
// collapse into one decider (`cliNoTls`) on the way to the server, which lost
// the provenance — so an app that declared `tls: false` in deno.json was told
// to "Drop --no-tls for HTTPS", naming a flag absent from its invocation. The
// fix it hands you has to be a fix you can apply.
Deno.test("_noTlsWarning: names the mechanism that was actually used", () => {
  const flag = _noTlsWarning(true, "flag");
  assertStringIncludes(flag, "--no-tls");
  assertStringIncludes(flag, "Drop --no-tls for HTTPS");

  const config = _noTlsWarning(true, "config");
  assertStringIncludes(config, "`tls: false`");
  assertStringIncludes(config, 'Set `tls: "auto"` for HTTPS');
  assert(
    !config.includes("--no-tls"),
    `config wording must not send the reader after a flag: ${config}`,
  );
});

Deno.test("_noTlsWarning: both wordings still carry the danger", () => {
  // The point of the warning is the wire being readable; renaming the
  // mechanism must not quietly soften that.
  for (const source of ["flag", "config"] as const) {
    const w = _noTlsWarning(true, source);
    assertStringIncludes(w, "PLAIN HTTP/WS");
    assertStringIncludes(w, "readable and forgeable");
  }
});

Deno.test("_noTlsWarning: without --expose it says so, in either spelling", () => {
  assertStringIncludes(
    _noTlsWarning(false, "flag"),
    "--no-tls has no effect without --expose",
  );
  assertStringIncludes(
    _noTlsWarning(false, "config"),
    "`tls: false` has no effect without --expose",
  );
});
