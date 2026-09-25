// notify() across a real socket — the transport boundary the in-process
// harness cannot reach.
//
// A method on the SERVER emits the effect; a real WebSocket client
// (`connectCli`, the same client `am` and scripts use) receives the frame and
// prints the line. With nobody connected the server says so instead of
// dropping it. And the public handle's `loadSnapshot(json, { force })` —
// the door the `@served` rule opened — refuses a foreign cell set without
// the option and loads it with.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { aio, cell, notify } from "../mod.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { within } from "./within.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn };
  const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = push;
  console.info = push;
  console.warn = push;
  return {
    lines,
    restore: () => {
      console.log = orig.log;
      console.info = orig.info;
      console.warn = orig.warn;
    },
  };
}

Deno.test({
  name:
    "notify: a method's notification crosses a real WebSocket to a client, and is named when nobody is there",
  sanitizeOps: false, // aio-ok: a live server + a reconnecting client; closed explicitly below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const dir = await tempDir("aio-notify-loop");
    const appId = `nl-${crypto.randomUUID().slice(0, 8)}`;
    const cellId = `pinger${appId.slice(3)}`;
    const c = cell(cellId, {
      state: { n: 0 },
      methods: {
        ping(s) {
          s.n++;
          s.$do(notify({ title: `Ping ${s.n}`, body: "from a method" }));
        },
      },
    });
    const port = freePort();
    const cap = captureConsole();
    const app = await aio.run({
      cells: [c],
      appId,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      port,
      appDir: dir,
      baseDir: dir,
      persistDebounceMs: 10,
    });
    let cli: ReturnType<typeof connectCli> | null = null;
    try {
      // Nobody connected: the server says so, by title.
      await c.ping();
      await sleep(50);
      assert(
        cap.lines.some((l) =>
          /no UI client is connected/.test(l) && /Ping 1/.test(l)
        ),
        `expected the "nobody there" line:\n${cap.lines.join("\n")}`,
      );

      cli = connectCli(`ws://127.0.0.1:${port}/ws`);
      if (
        (await within(cli.ready, 5000, "TIMED OUT" as const)) === "TIMED OUT"
      ) {
        throw new Error("cli never became ready");
      }
      await c.ping();
      for (
        let i = 0;
        i < 100 && !cap.lines.some((l) => /notify: Ping 2/.test(l));
        i++
      ) {
        await sleep(20);
      }
      assert(
        cap.lines.some((l) => /notify: Ping 2 — from a method/.test(l)),
        `the client should have printed the notification:\n${
          cap.lines.slice(-12).join("\n")
        }`,
      );

      // loadSnapshot on the PUBLIC handle: refused without force, loaded with.
      const foreign = JSON.stringify({ somebodyElse: { x: 1 } });
      assertThrows(() => app.loadSnapshot!(foreign), Error);
      assertEquals(
        (app.getState() as Record<string, unknown>)[cellId] !== undefined,
        true,
        "untouched",
      );
      // Forced: loaded as a restart reads it — the undeclared cell is dropped.
      app.loadSnapshot!(foreign, { force: true });
      assertEquals(
        (app.getState() as Record<string, unknown>).somebodyElse,
        undefined,
      );
    } finally {
      cli?.close();
      await app.close();
      cap.restore();
      await Deno.remove(join(dir), { recursive: true }).catch(() => {});
    }
  },
});
