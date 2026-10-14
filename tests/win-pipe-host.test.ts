// A local endpoint that is hosted cannot be hosted a second time. On unix the
// bind says so (`AddrInUse`); a Windows pipe name can be hosted by any number
// of servers unless the FIRST instance asks to be the first
// (FILE_FLAG_FIRST_PIPE_INSTANCE), and then the refusal is a bare
// ERROR_ACCESS_DENIED — which `createInstance` (src/server/win-pipe.ts) names
// for what it is: the app is already running. Without it a second instance of
// an app takes every other connection of the first one's window.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  connectLocal,
  isPipePath,
  listenLocal,
  type LocalListener,
} from "../src/server/local-listen.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  listenBound,
  localEndpoint,
  localIdle,
} from "./local-endpoint-helper.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Answer every connection of `l` with `word`, then close it. */
function answering(l: LocalListener, word: string): Promise<void> {
  return (async () => {
    for await (const c of l) {
      const w = c.writable.getWriter();
      await w.write(enc.encode(word));
      await c.drain?.();
      c.close();
    }
  })();
}

/** Connect, and read to the end. */
async function ask(path: string): Promise<string> {
  const c = await connectLocal(path);
  let got = "";
  for await (const chunk of c.readable) got += dec.decode(chunk);
  return got;
}

Deno.test("a hosted endpoint cannot be hosted again: the second is refused, the first keeps serving, and the name is free once it closed", async () => {
  const dir = await tempDir("aio-pipe-host-");
  const path = localEndpoint(join(dir, "h.sock"));
  try {
    const first = await listenBound(path);
    const served = answering(first, "first");
    if (isPipePath(path)) {
      const { listenPipe } = await import("../src/server/win-pipe.ts");
      const e = assertThrows(() => listenPipe(path), Error);
      for (
        const part of [
          "the pipe name is taken: another instance of this app, another Windows user",
          "Win32 error 5 ERROR_ACCESS_DENIED",
          path,
        ]
      ) assert(e.message.includes(part), e.message);
      // The product's door: bound at once, the refusal is the first `next()`.
      const second = listenLocal(path);
      await assertRejects(
        () => second[Symbol.asyncIterator]().next(),
        Error,
        "the pipe name is taken",
      );
      second.close();
    } else {
      assertThrows(() => listenLocal(path), Deno.errors.AddrInUse);
    }
    // The refused one took nothing from the host: each connection is its own.
    assertEquals([await ask(path), await ask(path)], ["first", "first"]);
    first.close();
    await served;
    await localIdle();
    // A unix socket leaves its file behind; a pipe's name goes with its last
    // instance, so the next start hosts it with nothing to clean up.
    if (isPipePath(path)) {
      const again = await listenBound(path);
      const reserved = answering(again, "again");
      assertEquals(await ask(path), "again");
      again.close();
      await reserved;
      await localIdle();
    }
  } finally {
    await dropTempDir(dir);
  }
});
