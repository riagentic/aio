// `tls` as a CONFIG key (R-7). `--no-tls` / `--tls-cert` / `--tls-key`
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
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { _noTlsWarning, _unusedCertWarning } from "../src/server/aio-server.ts";
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

// ── a cert pair that will not be used ────────────────────────────────────
//
// TLS is consulted only when a server is EXPOSED, so `--tls-cert=… --tls-key=…`
// on a loopback app is read by nothing: the files are never opened, so not even
// a missing file or a typo'd path is noticed. Measured before this landed —
// `--tls-cert=/nope/cert.pem --tls-key=/nope/key.pem` booted, served plain
// HTTP, and said nothing at all about either path.
//
// There is no wrong outcome (loopback is plain HTTP either way). The problem is
// the belief: someone who passed a cert thinks they are serving it, and the
// next step in that belief is trusting the same command line when it does
// reach a network. `--no-tls` has warned about exactly this since it was
// written — this is the other half of the same question.

Deno.test("_unusedCertWarning: names the spelling that was used", () => {
  const flag = _unusedCertWarning("flag");
  assertStringIncludes(flag, "--tls-cert/--tls-key");
  assertStringIncludes(flag, "--expose");
  const config = _unusedCertWarning("config");
  assertStringIncludes(config, "tls: { cert, key }");
  assert(!config.includes("--tls-cert"), "config form must not say the flags");
});

Deno.test("_unusedCertWarning: says the cert is never even read", () => {
  // The sharpest half: a wrong PATH is not noticed either, so "it booted" is
  // not evidence the cert is good.
  for (const src of ["flag", "config"] as const) {
    assertStringIncludes(_unusedCertWarning(src), "never even read");
  }
});

// ── a host this machine cannot bind ──────────────────────────────────────
//
// `--host=` is user input, and an unbindable value arrived as a raw
// `URIError: invalid host 'not..a..host': empty label found in FQDN` out of
// Deno's TLS internals with eight frames of aio stacked above it. The
// port-in-use case beside it in the same `catch` has been teachable for
// releases; this is the other way that one call fails, and it is the likelier
// typo (a non-loopback host is also treated as `--expose`, so it is not a
// harmless one).
Deno.test("a host that cannot be bound is explained, not dumped", async () => {
  const { createServer } = await import("../src/server/server.ts");
  const dir = await tempDir("aio-badhost-");
  try {
    const e = await (async () => {
      try {
        createServer({
          port: 0,
          host: "not..a..host",
          title: "t",
          getUIState: () => ({}),
          dispatch: () => {},
          baseDir: dir,
          debug: () => {},
          prod: true,
          // deno-lint-ignore no-explicit-any
        } as any);
        return null;
      } catch (err) {
        return err as Error;
      }
    })();
    assert(e instanceof Error, "an unbindable host must be refused");
    assertStringIncludes(e.message, "cannot bind not..a..host");
    assertStringIncludes(e.message, "--host=");
    assertStringIncludes(e.message, "0.0.0.0");
    // …and it must still carry what the platform said, not replace it.
    assertStringIncludes(e.message, "empty label");
  } finally {
    await dropTempDir(dir);
  }
});
