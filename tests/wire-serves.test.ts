// Frame-kind × transport coverage — SERVES is pinned against the LIVE
// routers, in both directions, by parsing their `case "…":` labels. A kind
// added to FRAME_KINDS but routed nowhere (or routed but not recorded) is a
// red gate here, not a silent runtime drop. Plus the additive-extension
// reservation: kinds in IGNORABLE decode and are skipped silently by every
// router instead of being a per-frame protocol violation.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  dec,
  enc,
  FRAME_KINDS,
  IGNORABLE,
  isIgnorableKind,
  type Kind,
  SERVES,
} from "../src/protocol/envelope.ts";
import { createUDSListener } from "../src/server/aio.ts";
import {
  _clearClientDegraded,
  clientDegradedReport,
} from "../src/diagnostics/degraded.ts";

/** Every `case "<kind>":` label in `text` that names a known frame kind (or a
 *  reserved-ignorable one) — the same tokens the routers switch on. */
function caseKinds(text: string): Set<string> {
  const known = new Set<string>([...FRAME_KINDS, ...IGNORABLE]);
  const out = new Set<string>();
  for (const m of text.matchAll(/\bcase\s+"([a-z-]+)"\s*:/g)) {
    if (known.has(m[1]!)) out.add(m[1]!);
  }
  return out;
}

async function fileKinds(...paths: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of paths) {
    for (const k of caseKinds(await Deno.readTextFile(p))) out.add(k);
  }
  return out;
}

const sorted = (s: Iterable<string>) => [...s].sort();

Deno.test("SERVES.ws matches the WS server router's case labels", async () => {
  assertEquals(
    sorted(await fileKinds("src/server/server-ws.ts")),
    sorted(SERVES.ws),
    "server-ws.ts routes a different kind set than SERVES.ws records — " +
      "update BOTH (envelope.ts documents every deliberate omission)",
  );
});

Deno.test("SERVES.uds matches the UDS router's case labels", async () => {
  assertEquals(
    sorted(await fileKinds("src/server/uds.ts")),
    sorted(SERVES.uds),
    "uds.ts routes a different kind set than SERVES.uds records — " +
      "update BOTH (envelope.ts documents every deliberate omission)",
  );
});

Deno.test("SERVES.browser matches the client router's case labels", async () => {
  // The browser router is three cooperating switches: the transport demux,
  // the shared control-frame handler, and the command router.
  assertEquals(
    sorted(
      await fileKinds(
        "src/browser/browser-air-transport.ts",
        "src/browser/browser-shared.ts",
        "src/browser/browser-air-commands.ts",
      ),
    ),
    sorted(SERVES.browser),
    "the browser demux routes a different kind set than SERVES.browser — " +
      "update BOTH (envelope.ts documents every deliberate omission)",
  );
});

// The control client is a router like any other: it decodes frames off the
// same socket and acts on exactly one kind. Recording it here is what keeps
// `ctlr` from being a reply the catalog claims exists and nobody reads.
Deno.test("SERVES.am matches the control client's handled kinds", async () => {
  assertEquals(
    sorted(await fileKinds("src/am/am-uds.ts")),
    sorted(SERVES.am),
    "am-uds.ts names a different kind set than SERVES.am records — the " +
      "control client sends `ctl` and reads `ctlr`, nothing else",
  );
});

Deno.test("every frame kind is served by at least one transport", () => {
  const union = new Set<Kind>([
    ...SERVES.ws,
    ...SERVES.uds,
    ...SERVES.browser,
    ...SERVES.am,
  ]);
  const unrouted = FRAME_KINDS.filter((k) => !union.has(k));
  assertEquals(
    unrouted,
    [],
    "these kinds exist in the catalog but NO router handles them — a frame " +
      "of this kind is dead on every wire",
  );
});

Deno.test("SERVES only names catalogued kinds", () => {
  const kinds = new Set<string>(FRAME_KINDS);
  for (const [transport, set] of Object.entries(SERVES)) {
    for (const k of set) {
      assert(kinds.has(k), `SERVES.${transport} names unknown kind "${k}"`);
    }
  }
});

// ── The additive wire reservation ─────────────────────────────────────────

Deno.test("ignorable kinds decode; unknown kinds stay a violation", () => {
  // Reserved extension kind "x": well-formed by contract.
  assertEquals(dec('{"v":2,"t":"x"}'), { v: 2, t: "x" as Kind });
  assertEquals(dec('{"v":2,"t":"x","d":{"future":1}}'), {
    v: 2,
    t: "x" as Kind,
    d: { future: 1 },
  });
  // Anything NOT reserved is still a loud protocol violation (null).
  assertEquals(dec('{"v":2,"t":"nope"}'), null);
  // The reservation is not part of the routed catalog.
  assert(!(FRAME_KINDS as readonly string[]).includes("x"));
  assert(isIgnorableKind("x"));
  assert(!isIgnorableKind("state"));
  assert(!isIgnorableKind("nope"));
});

Deno.test("ignorable kinds never appear in SERVES (skipped, not routed)", () => {
  for (const [transport, set] of Object.entries(SERVES)) {
    for (const k of IGNORABLE) {
      assert(
        !set.has(k as Kind),
        `SERVES.${transport} routes ignorable kind "${k}" — ignorable means ` +
          `skipped silently, never handled`,
      );
    }
  }
});

// ── cdiag over UDS — behavioral (Electron speaks UDS; a renderer's health
//    escalation must reach /__aio/health, not the default-arm warn) ─────────

Deno.test("uds: cdiag frame records a client degradation", async () => {
  const socketPath = join(
    await Deno.makeTempDir({ prefix: "aio-uds-cdiag-" }),
    "s.sock",
  );
  const uds = createUDSListener(
    socketPath,
    () => ({}),
    () => {},
    () => {},
  );
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const name = `uds-cdiag-${crypto.randomUUID().slice(0, 8)}`;
  try {
    // Drain server frames so the write queue keeps moving.
    (async () => {
      const buf = new Uint8Array(65536);
      try {
        while ((await conn.read(buf)) !== null) { /* discard */ }
      } catch { /* closed */ }
    })();
    const frame = enc("cdiag", {
      name,
      kind: "down",
      failures: 7,
      since: Date.now(),
      lastError: "renderer subsystem failing forever",
    });
    await conn.write(new TextEncoder().encode(frame + "\n"));
    // Poll until the report shows it (frame handling is async).
    let seen = false;
    for (let i = 0; i < 100 && !seen; i++) {
      seen = clientDegradedReport().some((d) => d.name === name);
      if (!seen) await new Promise((r) => setTimeout(r, 20));
    }
    assert(seen, "cdiag over UDS never reached the client-degraded registry");
    const row = clientDegradedReport().find((d) => d.name === name)!;
    assertEquals(row.failures, 7);
  } finally {
    for (const c of uds.clients()) _clearClientDegraded(c.id);
    try {
      conn.close();
    } catch { /* already closed */ }
    uds.shutdown();
  }
});

Deno.test("uds: an ignorable extension frame is skipped without killing the connection", async () => {
  const socketPath = join(
    await Deno.makeTempDir({ prefix: "aio-uds-x-" }),
    "s.sock",
  );
  let dispatched: unknown = null;
  const uds = createUDSListener(
    socketPath,
    () => ({}),
    (a) => {
      dispatched = a;
    },
    () => {},
  );
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  try {
    (async () => {
      const buf = new Uint8Array(65536);
      try {
        while ((await conn.read(buf)) !== null) { /* discard */ }
      } catch { /* closed */ }
    })();
    // An extension frame FOLLOWED by a real action: if "x" were treated as a
    // violation that kills the line, the action would never dispatch.
    const lines = JSON.stringify({ v: 2, t: "x", d: { future: true } }) +
      "\n" + enc("action", { type: "noop:ping" }) + "\n";
    await conn.write(new TextEncoder().encode(lines));
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      ok = dispatched !== null;
      if (!ok) await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(
      (dispatched as { type?: string } | null)?.type,
      "noop:ping",
      "the action after an ignorable frame must still be routed",
    );
  } finally {
    try {
      conn.close();
    } catch { /* already closed */ }
    uds.shutdown();
  }
});
