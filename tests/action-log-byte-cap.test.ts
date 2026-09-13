// `logs/actions.jsonl` is bounded in BYTES, not only in lines.
//
// The rolling action log enforced `max` lines (1000 by default) and nothing
// else, so the bound held for small payloads only: an action carrying a 400 KB
// string made every line 400 KB, and a 1000-line cap was a 400 MB file on an
// always-on diagnostic. A line over the per-line cap keeps its place in the
// sequence with its payload elided (and says so); the file is cut back once it
// passes the byte cap.
import { assert, assertEquals } from "@std/assert";
import {
  ACTION_LOG_LINE_BYTES,
  createActionLog,
} from "../src/diagnostics/action-log.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("action log: an oversized payload is elided in place, and the file stays under its byte cap", async () => {
  const dir = await tempDir("aio-actionlog-bytes-");
  try {
    const path = `${dir}/actions.jsonl`;
    const maxBytes = 1024 * 1024;
    const alog = createActionLog(path, 1000, maxBytes);
    await alog.append("blob:set", { args: ["x".repeat(400_000)] });
    const first = JSON.parse((await Deno.readTextFile(path)).trim());
    assertEquals(first.type, "blob:set", "the action is still recorded");
    assert(
      String(first.payload._elided).includes("line cap"),
      `the elision is stated: ${JSON.stringify(first.payload)}`,
    );
    // Many lines just under the per-line cap: the line bound alone (1000)
    // would allow ~64 MB.
    const pad = "y".repeat(ACTION_LOG_LINE_BYTES - 200);
    for (let i = 0; i < 40; i++) await alog.append(`pad:${i}`, { pad });
    await alog.flush();
    const size = (await Deno.stat(path)).size;
    assert(size <= maxBytes, `actions.jsonl is ${size} bytes, cap ${maxBytes}`);
    const lines = (await Deno.readTextFile(path)).trim().split("\n");
    assertEquals(
      JSON.parse(lines.at(-1)!).type,
      "pad:39",
      "the newest line is kept",
    );
  } finally {
    await dropTempDir(dir);
  }
});
