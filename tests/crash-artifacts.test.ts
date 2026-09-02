// The two artifacts that exist to explain a crash must actually be on disk.
//
// This invariant has broken twice, for unrelated reasons, and both times the
// feature was silently off at the moment it was needed:
//
//   • `logging: false` stopped writing the action log AND the crash checkpoint
//     (recorded in todo.md).
//   • the checkpoint writer never created its own directory, so a writer whose
//     log dir did not exist yet — or was archived out from under it by the next
//     app booting into the same data dir — failed every write and logged the
//     same NotFound line forever.
//
// Unit tests of the writer passed through the second one: they all mkdir first.
// This asserts the end state a developer actually depends on — boot an app,
// dispatch, stop, and find both files with content in them.
//
// Scope, checked by mutation rather than assumed: this catches a writer that
// silently stops writing (the first case above). It does NOT re-catch the
// second — on this path the logger has already created the log directory, so a
// writer that cannot create its own never notices. tests/diagnostics/
// checkpoint.test.ts covers that mechanism directly. Two tests, two different
// ways for the same artifact to go missing.
import { assert, assertEquals } from "@std/assert";

Deno.test("a booted app leaves the crash artifacts on disk", async () => {
  const { aio, cell } = await import("../mod.ts");
  const jobs = cell("crashartifacts", {
    state: { n: 0 },
    methods: {
      tick(s: { n: number }) {
        s.n++;
      },
    },
  });
  const dir = await Deno.makeTempDir({ prefix: "aio-artifacts-" });
  try {
    const app = await aio.run({
      cells: [jobs],
      appId: `artifacts-${Deno.pid}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port: 0,
      baseDir: dir,
      dbPath: ":memory:",
      diagnostics: { checkpoint: { debounce: 0 }, actionLog: true },
    } as never);
    jobs.tick();
    jobs.tick();
    await (app as unknown as { close?: () => Promise<void> }).close?.();

    // `<baseDir>/.aio/logs` — the layout for a baseDir app. An app given an
    // `appDir` instead writes `<appDir>/logs`; asserting the concrete path
    // means a silent relocation of these two files fails here rather than
    // being discovered by someone looking for a crash they cannot explain.
    const logs = `${dir}/.aio/logs`;
    const checkpoint = await Deno.readTextFile(`${logs}/checkpoint.json`)
      .catch(() => "");
    assert(
      checkpoint.length > 0,
      "no checkpoint.json — the artifact that explains a crash was not written",
    );
    const parsed = JSON.parse(checkpoint) as { state: Record<string, unknown> };
    assertEquals(
      (parsed.state.crashartifacts as { n: number }).n,
      2,
      "the checkpoint does not carry the state at the time it was written",
    );

    const actions = await Deno.readTextFile(`${logs}/actions.jsonl`)
      .catch(() => "");
    assert(
      actions.includes("crashartifacts:tick"),
      "no action log entry for a method that ran",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
