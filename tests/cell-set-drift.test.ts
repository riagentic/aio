// A cell in the BUNDLE that the server never booted must say so.
//
// Field report (a chat-app report #8): a `ui` cell was added to a running dev app
// and the browser reloaded. The client bundle is fetched fresh, so the new
// controls rendered — but the server process was still the old one and had no
// `ui` cell, so every dispatch went nowhere. From the UI it looked like three
// dead buttons. The only place the truth appeared was `am`:
//
//     {"error":"unknown cell \"ui\" — not booted (cells: conn, chat)."}
//
// which their words call "excellent, and the only place the truth appears. A
// person who does not think to ask `am` sees a UI that renders and does not
// work."
//
// Both halves are knowable at the client: the server's booted set rides the
// `cfg` frame, the bundle's set is the local cell registry. The drift is now
// stated where it is felt.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

Deno.test("cell-set drift: a bundle cell the server never booted is reported", async () => {
  _resetAioRuntime();
  const g = globalThis as Record<string, unknown>;
  const hadWindow = "window" in g;
  if (!hadWindow) g.window = g;
  const lines: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const mod = await import(
      `../src/browser/browser-protocol.ts#${crypto.randomUUID()}`
    );
    // The bundle registers three cells…
    cell("conn", { state: { n: 0 }, methods: { noop(_s: unknown) {} } });
    cell("chat", { state: { n: 0 }, methods: { noop(_s: unknown) {} } });
    cell("ui", { state: { n: 0 }, methods: { noop(_s: unknown) {} } });
    // …the server booted only two.
    (mod as {
      _applyServerConfig: (c: Record<string, unknown>) => void;
    })._applyServerConfig({ bootedCells: ["conn", "chat"] });

    const all = lines.join("\n");
    assert(
      all.includes("ui"),
      `the missing cell must be named: ${all}`,
    );
    assert(
      /did NOT boot|not booted/i.test(all),
      `the message must say the server does not have it: ${all}`,
    );
    assert(
      /[Rr]estart/.test(all),
      `the message must name the fix: ${all}`,
    );
  } finally {
    console.error = origError;
    if (!hadWindow) delete g.window;
    _resetAioRuntime();
  }
});

Deno.test("cell-set drift: agreement is silent, and an old server is not guessed at", async () => {
  _resetAioRuntime();
  const g = globalThis as Record<string, unknown>;
  const hadWindow = "window" in g;
  if (!hadWindow) g.window = g;
  const lines: string[] = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const mod = await import(
      `../src/browser/browser-protocol.ts#${crypto.randomUUID()}`
    );
    const apply = (mod as {
      _applyServerConfig: (c: Record<string, unknown>) => void;
    })._applyServerConfig;
    cell("conn2", { state: { n: 0 }, methods: { noop(_s: unknown) {} } });

    apply({ bootedCells: ["conn2"] }); // agreement
    assertEquals(
      lines.filter((l) => l.includes("cell-set") || l.includes("did NOT boot"))
        .length,
      0,
      `no drift ⇒ no noise: ${lines.join(" | ")}`,
    );

    // A server too old to send the field must not be reported as having
    // booted nothing — absence of information is not evidence of drift.
    apply({});
    assertEquals(
      lines.filter((l) => l.includes("did NOT boot")).length,
      0,
      `an older server must not trigger a false alarm: ${lines.join(" | ")}`,
    );
  } finally {
    console.error = origError;
    console.warn = origWarn;
    if (!hadWindow) delete g.window;
    _resetAioRuntime();
  }
});
