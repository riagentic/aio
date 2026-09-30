// Regression pins for the 2026-09-29 audit round (env doors, bind labels,
// port spelling, `am record`'s binding lookup). Each assertion is red before
// its fix.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  cdpRequest,
  electronOnlyFlagRefusal,
  envDefaultPort,
  parseCli,
  portWasRequested,
} from "../src/server/aio-cli.ts";
import { isLoopbackBind, parentPidOf } from "../src/server/aio-lifecycle.ts";
import { envPort } from "../src/server/paths.ts";
import { exportedBindingFor } from "../src/am/record.ts";
import {
  DEFAULT_SOCKET_TIMEOUT_MS,
  socketTimeoutMsOf,
  tmplParentWatch,
  tmplSocketFetch,
} from "../src/electron/electron-shared.ts";

// ── AIO_CDP is the env spelling of --cdp (refused like the flag) ──────────
Deno.test("cdp: an env request is resolved, an invalid one is absent", () => {
  assertEquals(cdpRequest(undefined, "1"), true);
  assertEquals(cdpRequest(undefined, "true"), true);
  assertEquals(cdpRequest(undefined, "9333"), 9333);
  assertEquals(cdpRequest(undefined, "0"), undefined);
  assertEquals(cdpRequest(undefined, ""), undefined);
  assertEquals(cdpRequest(undefined, "abc"), undefined); // invalid → absent
  assertEquals(cdpRequest(9333, "1"), 9333); // flag beats env
});

Deno.test("electron-only: AIO_CDP is refused on a non-electron client, by name", () => {
  const fromEnv = electronOnlyFlagRefusal(
    parseCli([]),
    "browser",
    {},
    cdpRequest(undefined, "1"),
  );
  assert(fromEnv, "an AIO_CDP request on a browser client must be refused");
  assertStringIncludes(fromEnv!.message, "AIO_CDP");
  assertStringIncludes(fromEnv!.message, "electron");
  // …and the flag spelling still names the flag.
  assertStringIncludes(
    electronOnlyFlagRefusal(parseCli(["--cdp"]), "browser")!.message,
    "--cdp",
  );
  // A cdp request on an electron client is refused nothing.
  assertEquals(
    electronOnlyFlagRefusal(
      parseCli([]),
      "electron",
      {},
      cdpRequest(undefined, "1"),
    ),
    null,
  );
});

// ── portWasRequested: `0` means "pick one", so it is not a request ────────
Deno.test("portWasRequested: a named 0 does not count, on any rung", () => {
  assertEquals(portWasRequested(0, 0, 0), false);
  assertEquals(portWasRequested(undefined, undefined, undefined), false);
  assertEquals(portWasRequested(3000, undefined, undefined), true);
  assertEquals(portWasRequested(undefined, 3000, undefined), true);
  assertEquals(portWasRequested(undefined, 0, 8123), true);
});

// ── isLoopbackBind: one answer with _hostIsExposed, case-insensitively ────
Deno.test("bind: a host name is loopback in any case", () => {
  for (const h of ["localhost", "LOCALHOST", "LocalHost", " 127.0.0.1 "]) {
    assertEquals(isLoopbackBind(h), true, h);
  }
  for (const h of ["0.0.0.0", "192.168.1.5", "example.com"]) {
    assertEquals(isLoopbackBind(h), false, h);
  }
});

// ── envPort / envDefaultPort: decimal digits only, like --port ────────────
Deno.test("env ports: hexadecimal/exponent/signed spellings are refused, not coerced", () => {
  const prev = Deno.env.get("AIO_PORT");
  const prevDef = Deno.env.get("AIO_DEFAULT_PORT");
  try {
    for (const bad of ["0x1F90", "1e3", "+3000", "-1", "havoc"]) {
      Deno.env.set("AIO_PORT", bad);
      assertThrows(() => envPort(), Error, undefined, `AIO_PORT=${bad}`);
      Deno.env.set("AIO_DEFAULT_PORT", bad);
      assertThrows(() => envDefaultPort(), Error, undefined, `DEFAULT=${bad}`);
    }
    Deno.env.set("AIO_PORT", "3000");
    assertEquals(envPort(), 3000);
    Deno.env.set("AIO_PORT", "0");
    assertEquals(envPort(), 0, "0 is legal: pick a free one");
    Deno.env.delete("AIO_PORT");
    assertEquals(envPort(), undefined);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_PORT");
    else Deno.env.set("AIO_PORT", prev);
    if (prevDef === undefined) Deno.env.delete("AIO_DEFAULT_PORT");
    else Deno.env.set("AIO_DEFAULT_PORT", prevDef);
  }
});

// ── am record: a `$`-named binding is found (regex boundary + escaping) ───
Deno.test("am record: exportedBindingFor finds a $ identifier's export", () => {
  const text =
    `const cells$ = cell("x", { state: { n: 0 } });\n\nexport { cells$ };`;
  assertEquals(exportedBindingFor(text, text.indexOf("cell(")), "cells$");
  const plain = `const todo = cell("t", {});\nexport { todo };`;
  assertEquals(exportedBindingFor(plain, plain.indexOf("cell(")), "todo");
  const notExported = `const hidden = cell("h", {});`;
  assertEquals(
    exportedBindingFor(notExported, notExported.indexOf("cell(")),
    undefined,
  );
});

// ── AIO_DISCOVERY_PORT: decimal digits only, like AIO_PORT / --port ────────
Deno.test("discovery port: hexadecimal/exponent/signed spellings fall back to 8099", async () => {
  const { discoveryPortOf, DEFAULT_DISCOVERY_PORT } = await import(
    "../src/server/discovery.ts"
  );
  assertEquals(DEFAULT_DISCOVERY_PORT, 8099);
  assertEquals(discoveryPortOf(undefined), 8099);
  assertEquals(discoveryPortOf(""), 8099);
  assertEquals(discoveryPortOf("8123"), 8123);
  assertEquals(discoveryPortOf(" 8123 "), 8123);
  // The spellings Number() accepts and --port / AIO_PORT refuse:
  for (
    const bad of [
      "0x1F90",
      "1e3",
      "+8099",
      "0b111",
      "8099.5",
      "abc",
      "0",
      "65536",
    ]
  ) {
    assertEquals(discoveryPortOf(bad), 8099, bad);
  }
});

Deno.test("cdp: hexadecimal/exponent/signed AIO_CDP spellings are absent, like --cdp", () => {
  for (const bad of ["0x1F90", "1e3", "+9333", "0b111", "9333.5"]) {
    assertEquals(cdpRequest(undefined, bad), undefined, bad);
  }
});

// ── AIO_PARENT_PID: decimal digits only, like AIO_PORT / discovery ─────────
Deno.test("parent pid: hexadecimal/exponent/signed spellings are absent", () => {
  assertEquals(parentPidOf(undefined), undefined);
  assertEquals(parentPidOf(""), undefined);
  assertEquals(parentPidOf("4242"), 4242);
  assertEquals(parentPidOf(" 4242 "), 4242);
  for (
    const bad of [
      "0x1A2B",
      "1e3",
      "+42",
      "0b101",
      "42.5",
      "abc",
      "0",
      "-1",
    ]
  ) {
    assertEquals(parentPidOf(bad), undefined, bad);
  }
});

Deno.test("electron parent watch: generated main refuses hex/exponent/signed AIO_PARENT_PID", () => {
  const src = tmplParentWatch();
  assert(
    src.includes("/^\\d+$/") || src.includes("/^\d+$/"),
    "parent watch must refuse non-decimal spellings",
  );
  // Number() alone is the fail-open door this pin closes.
  assert(
    !/Number\(process\.env\.AIO_PARENT_PID/.test(src),
    "must not Number() the env raw — that accepts hex",
  );
});

// ── AIO_SOCKET_TIMEOUT_MS: decimal digits, else documented 30s ─────────────
Deno.test("socket timeout: hexadecimal/exponent/signed spellings fall back to 30s", () => {
  assertEquals(DEFAULT_SOCKET_TIMEOUT_MS, 30_000);
  assertEquals(socketTimeoutMsOf(undefined), 30_000);
  assertEquals(socketTimeoutMsOf(""), 30_000);
  assertEquals(socketTimeoutMsOf("500"), 500);
  assertEquals(socketTimeoutMsOf(" 500 "), 500);
  for (
    const bad of [
      "0x7530",
      "3e4",
      "+30000",
      "0b111",
      "30.5",
      "abc",
      "0",
      "-1",
    ]
  ) {
    assertEquals(socketTimeoutMsOf(bad), 30_000, bad);
  }
});

Deno.test("electron socketFetch: generated main refuses hex/exponent AIO_SOCKET_TIMEOUT_MS", () => {
  const src = tmplSocketFetch();
  assert(
    src.includes("/^\\d+$/") || src.includes("/^\d+$/"),
    "socketFetch timeout parse must refuse non-decimal spellings",
  );
  assert(
    !/Number\(process\.env\.AIO_SOCKET_TIMEOUT_MS\)/.test(src),
    "must not Number() the env raw — that accepts hex",
  );
});
