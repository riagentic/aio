// `access` gates method CALLS; `visible` gates what the state broadcast CARRIES.
//
// Those are two different facts and neither is derived from the other — "only
// admins may edit, everyone may read" is a legitimate design. But an author who
// declares a cell restricted and never mentions `visible` has decided only half of
// it, and the half they did not decide defaults to "broadcast everything to
// every socket, authenticated or not". These tests pin both halves: the real
// wire behaviour (so nobody mistakes the warning below for an access check),
// and the boot warning that makes the author decide.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { log } from "../src/diagnostics/logger.ts";

/** Capture everything log.warn emits while `fn` runs. */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  // deno-lint-ignore no-explicit-any
  const orig = (log as any).warn;
  // deno-lint-ignore no-explicit-any
  (log as any).warn = (...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (log as any).warn = orig;
  }
  return out;
}

/** Connect, resolve the first `state` frame's decoded payload, then close. */
function firstState(
  port: number,
  token: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("ws timeout waiting for state frame"));
    }, 8000);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string);
      if (m.t !== "state" && m.type !== "state") return;
      clearTimeout(t);
      ws.close();
      resolve(typeof m.d === "string" ? JSON.parse(m.d) : (m.d ?? m.payload));
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });
}

Deno.test("access does NOT hide state — ui does (wire truth, both directions)", async () => {
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();

  // Declares itself restricted, says nothing about `ui` → fully readable.
  const gated = cell("gatedRead", {
    state: { note: "VISIBLE-ANYWAY" },
    access: "admin",
    visible: "all", // explicit: this test asserts the wire, not the warning
    methods: {
      edit(s: { note: string }) {
        s.note = "edited";
      },
    },
  });
  // Same access rule, plus the `ui` that actually hides it.
  const hidden = cell("hiddenRead", {
    state: { note: "TRULY-HIDDEN" },
    access: "admin",
    visible: "none",
    methods: {},
  });

  const app = await aio.run({
    cells: [gated, hidden],
    appId: "test-access-vs-ui",
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
    users: { "tok-view": { id: "eve", role: "viewer" } },
  });

  try {
    const seen = await firstState(port, "tok-view");
    // A non-admin DOES receive an access-gated cell's state. This is the
    // documented boundary, asserted so it can never become an accident: if a
    // future change makes `access` gate reads, that is a real semantic change
    // and this test must be updated deliberately, not discovered in the field.
    assertEquals(
      (seen.gatedRead as { note: string })?.note,
      "VISIBLE-ANYWAY",
      "access gates CALLS, not reads — a viewer still receives the state",
    );
    // `visible: "none"` is the mechanism that actually withholds it.
    assertEquals(
      seen.hiddenRead,
      undefined,
      'visible: "none" must withhold the cell entirely',
    );
  } finally {
    await app.close();
  }
});

Deno.test("boot warns when a cell restricts access but never decides ui", async () => {
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();

  const warnings = await captureWarnings(async () => {
    const secrets = cell("undecidedSecrets", {
      state: { internalNotes: "n", ledger: [1] },
      access: false, // "no client may call its methods"
      // visible: NOT specified — the read side was never decided
      methods: {},
    });
    const app = await aio.run({
      cells: [secrets],
      appId: "test-access-undecided",
      appVersion: "0.0.0",
      client: "server-only",
      persist: false,
      libraryMode: true,
      port,
      baseDir: await Deno.makeTempDir(),
    });
    await app.close();
  });

  const hit = warnings.find((w) => w.includes("undecidedSecrets"));
  assert(
    hit,
    `expected a visibility warning naming the cell; got:\n${
      warnings.join("\n")
    }`,
  );
  // The message must name what leaks and how to fix it — a warning that says
  // "check your config" costs the reader the whole investigation.
  assertStringIncludes(hit, "does NOT hide state");
  assertStringIncludes(hit, '"internalNotes"');
  assertStringIncludes(hit, '"ledger"');
  assertStringIncludes(hit, 'visible: "none"');
  assertStringIncludes(hit, 'visible: "all"'); // the acknowledgement escape hatch
});

Deno.test("an explicit visible is an answer — no warning, including visible: 'all'", async () => {
  const { cell, aio } = await import("../mod.ts");

  // Every explicit `visible` shape must silence it. `visible: "all"` is the important one:
  // it means "yes, everyone may read this", and an author who has said so must
  // never be nagged again — otherwise the warning becomes noise and gets muted
  // wholesale, taking the real findings with it.
  const shapes: [
    string,
    "all" | "none" | { exclude: string[] } | {
      include: string[];
    },
  ][] = [
    ["all", "all"],
    ["none", "none"],
    ["exclude", { exclude: ["internalNotes"] }],
    ["include", { include: ["ledger"] }],
  ];
  for (const [label, ui] of shapes) {
    const port = freePort();
    const warnings = await captureWarnings(async () => {
      const c = cell(`decided-${label}`, {
        state: { internalNotes: "n", ledger: [1] },
        access: "admin",
        // deno-lint-ignore no-explicit-any
        visible: ui as any,
        methods: {},
      });
      const app = await aio.run({
        cells: [c],
        appId: `test-access-decided-${label}`,
        appVersion: "0.0.0",
        client: "server-only",
        persist: false,
        libraryMode: true,
        port,
        baseDir: await Deno.makeTempDir(),
      });
      await app.close();
    });
    const nag = warnings.find((w) =>
      w.includes(`decided-${label}`) && w.includes("does NOT hide state")
    );
    assertEquals(
      nag,
      undefined,
      `visible: ${
        JSON.stringify(ui)
      } is an explicit answer and must silence the ` +
        `warning, got: ${nag}`,
    );
  }
});

Deno.test("no access rule → no warning (the guard is scoped to restricted cells)", async () => {
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const warnings = await captureWarnings(async () => {
    const plain = cell("plainCell", {
      state: { items: [1, 2] },
      methods: {},
    });
    const app = await aio.run({
      cells: [plain],
      appId: "test-access-none",
      appVersion: "0.0.0",
      client: "server-only",
      persist: false,
      libraryMode: true,
      port,
      baseDir: await Deno.makeTempDir(),
    });
    await app.close();
  });
  assertEquals(
    warnings.find((w) =>
      w.includes("plainCell") && w.includes("does NOT hide state")
    ),
    undefined,
    "a cell with no access rule has nothing to contradict — stay quiet",
  );
});

Deno.test("a sync cell is told the truth: its reads CANNOT be narrowed", async () => {
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();

  // A sync cell that hides state is REFUSED at boot (CRDT replicates to every
  // peer, so a visible filter cannot hold). Telling its author to "add visible: none"
  // would therefore be advice that hard-fails the next boot — the warning has
  // to know the difference and offer the two options that actually exist.
  const warnings = await captureWarnings(async () => {
    const shared = cell("syncedRestricted", {
      state: { rows: [1, 2] },
      access: "admin",
      sync: true,
      // visible: NOT specified
      methods: {},
    });
    const app = await aio.run({
      cells: [shared],
      appId: "test-access-sync",
      appVersion: "0.0.0",
      client: "server-only",
      persist: false,
      libraryMode: true,
      port,
      baseDir: await Deno.makeTempDir(),
    });
    await app.close();
  });

  const hit = warnings.find((w) =>
    w.includes("syncedRestricted") && w.includes("does NOT hide state")
  );
  assert(hit, `expected the warning; got:\n${warnings.join("\n")}`);
  assertStringIncludes(hit, "cannot be narrowed");
  assertStringIncludes(hit, 'visible: "all"');
  // The dead-end advice must NOT appear — it is refused at boot for this cell.
  assert(
    !hit.includes('visible: "none"'),
    `a sync cell must not be told to use visible: "none" — composition refuses it:\n${hit}`,
  );
});
