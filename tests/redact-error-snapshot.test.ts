// A crash report's state snapshot obeys `redactActions` too.
//
// The error box (console → app.log/debug.log/error.log) and the structured
// error record both carried `err.stateSnapshot` raw. With
// `redactActions: ["vault"]`, the passphrase an unlock method had stored in its
// cell landed in all three log files on the first crash after it — while the
// journal, the timeline, the action log and the checkpoint all withheld it.
import { assert, assertStringIncludes } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("redactActions: a crash's state snapshot never reaches the log files", async () => {
  const dir = await tempDir("aio-redact-err-");
  const snapshots: unknown[] = [];
  try {
    const vault = cell("vlterr", {
      state: { key: "" },
      methods: {
        unlockWith(s: { key: string }, pass: string) {
          s.key = pass;
        },
        crash(_s: { key: string }) {
          (null as Any).x = 1; // a bug, not a refusal: the full error box
        },
      },
    });
    const other = cell("plainerr", { state: { n: 7 }, methods: {} });
    _resetAioRuntime();
    const app = await aio.run({
      cells: [vault, other],
      appId: "redacterr",
      dbPath: `${dir}/data.db`,
      libraryMode: true,
      client: "server-only",
      baseDir: dir,
      logging: { level: "debug", dir: `${dir}/logs` },
      redactActions: ["vlterr"],
      onError: (e: Any) => snapshots.push(e.stateSnapshot),
    } as Any);
    await (vault as Any).unlockWith("hunter2-passphrase");
    await (vault as Any).crash().catch(() => {});
    await app.close();
    _resetAioRuntime();

    let all = "";
    for (const f of ["app.log", "debug.log", "error.log"]) {
      const text = await Deno.readTextFile(`${dir}/logs/${f}`);
      assert(
        !text.includes("hunter2-passphrase"),
        `${f} holds a redacted cell's state:\n${text}`,
      );
      all += text;
    }
    // The report is still there, and still useful: the other cells' state
    // is shown, the redacted slice is named as withheld.
    assertStringIncludes(all, "Cannot set properties of null");
    assertStringIncludes(all, `"plainerr":{"n":7}`);
    assertStringIncludes(all, `"vlterr":"[redacted]"`);
    // The app's own hook still receives the error whole.
    assert(
      JSON.stringify(snapshots).includes("hunter2-passphrase"),
      "onError keeps the full snapshot",
    );
  } finally {
    await dropTempDir(dir);
  }
});
