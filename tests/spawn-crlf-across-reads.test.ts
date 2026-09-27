// spawn(): `onLine` fires on `\r`, `\n` and `\r\n` (docs/clients/desktop-jobs.md
// "`\r` ends a line"). A `\r\n` is ONE line ending. When the child's `\r` and
// `\n` land in different pipe reads (a CRLF tool flushing between them, or a
// chunk boundary that happens to fall there), the `\r` was taken as a line end
// on the first chunk and the `\n` of the next chunk as a SECOND one — so the
// app's `onLine` saw a phantom empty line that the child never wrote.
import { assertEquals } from "@std/assert";
import { spawn } from "../src/server/spawn.ts";

Deno.test({
  name: "spawn: a \\r\\n split across two reads is one line end, not two",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const lines: string[] = [];
    const proc = await spawn("sh", {
      args: ["-c", `printf 'a\\r'; sleep 0.3; printf '\\nb\\n'`],
      onLine: (l, stream) => {
        if (stream === "stdout") lines.push(l);
      },
    });
    const st = await proc.status;
    assertEquals(st.code, 0);
    // Same bytes in one write give ["a", "b"]; split writes must agree.
    assertEquals(lines, ["a", "b"]);
  },
});
