// A recording whose window goes away while a command is in flight ends LOST
// — and leaves nothing running behind it.
//
// The rejected command waits for the socket's own verdict, up to 200 ms. The
// wait was a race against a timer nobody cleared: the socket's close won and
// the timer ran on — a leak in `tests/am-shot-video.test.ts` about one run in
// twenty (measured, 2 of 44), whenever the close landed inside the command.
import { assertEquals } from "@std/assert";
import { recordScreencast } from "../src/media/screencast.ts";
import type { CdpSession } from "../src/media/cdp.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("recordScreencast: a window gone while the screencast starts is LOST, with no timer left behind", async () => {
  const dir = await tempDir("screencast-lost-");
  const closed = Promise.withResolvers<void>();
  const cdp: CdpSession = {
    call: (method) => {
      if (method === "Page.captureScreenshot") {
        return Promise.resolve({ data: btoa("jpeg") });
      }
      // The window closes under the command: it rejects, then the socket
      // says so.
      queueMicrotask(() => closed.resolve());
      return Promise.reject(new Error("socket closed"));
    },
    on: () => () => {},
    close: () => Promise.resolve(),
    closed: closed.promise,
  };
  try {
    // The test sanitizer is the assert: a timer still pending fails it.
    const rec = await recordScreencast(cdp, dir, new Promise(() => {}));
    assertEquals(rec.lost, true);
    assertEquals(rec.frames.length, 1);
  } finally {
    await dropTempDir(dir);
  }
});
