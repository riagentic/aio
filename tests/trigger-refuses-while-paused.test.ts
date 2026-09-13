// `am trigger` must not report a click it knows cannot land.
//
// Under PAUSED time travel the click really happens in the page, and the
// action it dispatches is DROPPED by `dispatch.ts`. So the client answered "I
// clicked it" and the CLI printed `{"ok":true}` with exit 0, while the app's
// own log said `time travel is PAUSED — 'counter:increment' was not applied`
// and the state never moved.
//
// `am dispatch` refuses the same situation by name (`time travel is paused —
// action dropped, not applied`). The two disagreed about one fact, and the one
// CLAUDE.md tells agents to use for the observe→act→observe loop was the one
// that lied — a script chaining on `&&` walks straight past it. The verdict
// block in `am-cmd-inspect.ts` says this exact class was fixed; it was fixed
// only for a path MISS.
//
// The answer is known on the SERVER, before the frame is sent, so that is
// where the refusal belongs.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

Deno.test({
  name: "trojan trigger: refused while time travel is paused, not answered ok",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const counter = cell("ttcounter", {
      state: { n: 0 },
      methods: {
        inc(s: { n: number }) {
          s.n++;
        },
      },
    });
    const port = freePort();
    const dir = await tempDir("aio-tt-trigger-");
    const app = await aio.run({
      cells: [counter],
      appId: `tttrig-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port,
      baseDir: dir,
      dbPath: ":memory:",
      // deno-lint-ignore no-explicit-any
    } as any);
    const post = (route: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}/__aio/trojan/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-AIO": "1" },
        body: JSON.stringify(body),
      });
    try {
      // Running: a trigger is refused only for MISSING the element (there is
      // no UI client here), never for being paused.
      const live = await post("trigger/0", {
        path: "App:Btn",
        action: "click",
      });
      const liveBody = await live.text();
      assertEquals(
        live.status === 409,
        false,
        `an unpaused app must not answer the paused refusal: ${liveBody}`,
      );

      // Pause, and ask again.
      const paused = await post("tt", { cmd: "pause" });
      await paused.body?.cancel();

      const r = await post("trigger/0", { path: "App:Btn", action: "click" });
      const body = await r.text();
      assertEquals(
        r.status,
        409,
        `a trigger that cannot land must be REFUSED, not reported: ${body}`,
      );
      assert(
        /time travel is paused/i.test(body),
        `…and say why, the way \`am dispatch\` does: ${body}`,
      );
      assert(
        /resume/i.test(body),
        `…and how to get moving again: ${body}`,
      );
    } finally {
      await app.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
